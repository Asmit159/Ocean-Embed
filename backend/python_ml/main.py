"""
Ocean Temperature Forecasting - High-Performance Python ML Internal Service
FastAPI microservice executing TorchScript Swin/Embedding inference,
fetching live OPeNDAP subsets from NASA and Copernicus,
and serving strictly typed OceanData REST JSON payloads to the Node.js API Gateway.
"""

import json
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query, Response, status, BackgroundTasks, Request
import uuid
import asyncio
import torch

# Prevent PyTorch OpenMP from spawning too many threads and silently crashing constrained laptops
torch.set_num_threads(1)

TASK_STORE = {}

async def run_profile_task(task_id: str, lat: float, lon: float, date: str, trace_id: str):
    TASK_STORE[task_id] = {"status": "processing", "progress": 5}
    try:
        def update_progress(inc):
            if task_id in TASK_STORE:
                TASK_STORE[task_id]["progress"] += inc

        live_data = await fetch_live_surface_inputs(lat, lon, date, progress_cb=update_progress)
        
        TASK_STORE[task_id]["progress"] = 80
        
        model = ModelSingleton.get_model()
        device = ModelSingleton.get_device()
        
        profile_data = await asyncio.to_thread(
            generate_profile_payload,
            lat=lat,
            lon=lon,
            date_str=date,
            live_data=live_data,
            model=model,
            device=device,
        )
        
        TASK_STORE[task_id]["progress"] = 100
        TASK_STORE[task_id]["status"] = "completed"
        TASK_STORE[task_id]["result"] = profile_data
    except Exception as e:
        import traceback
        traceback.print_exc()
        logger.error(f"Async task {task_id} failed: {e}", extra={"trace_id": trace_id})
        TASK_STORE[task_id] = {
            "status": "failed",
            "progress": 100,
            "error": str(e)
        }
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from model_singleton import ModelSingleton
from tensor_utils import (
    LandmassException,
    NoDataForDateException,
    generate_profile_payload,
    get_available_dates_for_cell,
    get_historical_time_series,
    get_region_summary_cells,
    is_cell_landmass,
)

from services.live_ocean_data import authenticate_apis, fetch_live_surface_inputs

load_dotenv()

MODEL_PATH = os.getenv("MODEL_PATH", "./models/oceanembed_sih_prototype.pt")

# -------------------------------------------------------------------------
# Structured JSON Logging Setup
# -------------------------------------------------------------------------
class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        log_obj = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "message": record.getMessage(),
            "logger": record.name,
        }
        if hasattr(record, "trace_id"):
            log_obj["trace_id"] = record.trace_id
        if hasattr(record, "metrics"):
            log_obj["metrics"] = record.metrics
        return json.dumps(log_obj)

logger = logging.getLogger("ocean_ml")
logger.setLevel(logging.INFO)
handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(JsonFormatter())
logger.handlers = [handler]


# Silence noisy third-party SDK logs
logging.getLogger("copernicusmarine").setLevel(logging.WARNING)
logging.getLogger("earthaccess").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)

# Disable all tqdm progress bars globally to prevent terminal freezing/spam
try:
    import tqdm
    from functools import partialmethod
    tqdm.tqdm.__init__ = partialmethod(tqdm.tqdm.__init__, disable=True)
except ImportError:
    pass



@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI Lifespan: loads model into global memory once at startup via ModelSingleton,
    and authenticates NASA/Copernicus API sessions.
    """
    logger.info("Starting Python ML Service. Initializing ModelSingleton...")
    ModelSingleton.initialize(MODEL_PATH)
    logger.info("ModelSingleton initialized successfully.")
    
    logger.info("Authenticating OPeNDAP APIs...")
    authenticate_apis()
    
    yield
    logger.info("Python ML Service shutting down.")


app = FastAPI(
    title="Ocean Temperature Internal ML Service",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    openapi_url="/openapi.json"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/internal/v1/health")
async def health_check():
    """Service and model health endpoint."""
    return {
        "status": "ok",
        "version": "1.0.0",
        "model_loaded": ModelSingleton.is_loaded(),
        "device": ModelSingleton.get_device(),
    }


@app.get("/internal/v1/ocean/profile")
async def get_ocean_profile(
    request: Request,
    background_tasks: BackgroundTasks,
    lat: float = Query(..., description="Latitude (multiple of 5)"),
    lon: float = Query(..., description="Longitude (multiple of 5)"),
    date: str = Query(..., regex=r"^\d{4}-\d{2}-\d{2}$", description="Forecast date YYYY-MM-DD"),
    async_mode: bool = Query(False, alias="async"),
    x_trace_id: Optional[str] = Header(None, alias="x-trace-id"),
):
    """
    Primary Profile Endpoint:
    Returns full OceanData JSON payload by fetching live OPeNDAP subsets
    from NASA and Copernicus, running PyTorch inference, and generating metrics.
    """
    trace_id = x_trace_id or f"py-{int(time.time()*1000)}"
    start_time = time.perf_counter()

    if await request.is_disconnected():
        logger.warning("Client disconnected before request processing started.", extra={"trace_id": trace_id})
        return Response(status_code=499)

    logger.info(
        f"Processing ocean profile request: lat={lat}, lon={lon}, date={date}",
        extra={"trace_id": trace_id},
    )

    try:
        year = int(date.split("-")[0])
        if year < 2020 or year > 2026:
            raise NoDataForDateException(f"No forecast model output exists for date: {date}")

        if async_mode:
            task_id = str(uuid.uuid4())
            TASK_STORE[task_id] = {"status": "queued", "progress": 0}
            background_tasks.add_task(run_profile_task, task_id, lat, lon, date, trace_id)
            return {"task_id": task_id, "status": "processing", "progress": 0}

        model = ModelSingleton.get_model()
        device = ModelSingleton.get_device()

        try:
            live_data = await fetch_live_surface_inputs(lat, lon, date)
        except ValueError as ve:
            logger.error(f"Missing Granule: {ve}", extra={"trace_id": trace_id})
            raise HTTPException(status_code=404, detail=f"Dataset Unavailable: {ve}")
        except Exception as e:
            logger.error(f"Live data fetch failed: {e}", extra={"trace_id": trace_id})
            raise HTTPException(status_code=504, detail="Gateway Timeout - Earthdata/Copernicus API is slow or unavailable")

        profile_data = generate_profile_payload(
            lat=lat,
            lon=lon,
            date_str=date,
            live_data=live_data,
            model=model,
            device=device,
        )

        elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)
        logger.info(
            f"Generated profile in {elapsed_ms}ms",
            extra={"trace_id": trace_id, "metrics": {"total_ms": elapsed_ms}},
        )

        return profile_data

    except HTTPException:
        raise
    except LandmassException as land_err:
        logger.warn(f"Landmass rejected: {land_err}", extra={"trace_id": trace_id})
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={
                "error_code": "LANDMASS",
                "message": str(land_err),
                "trace_id": trace_id,
            },
        )
    except NoDataForDateException as no_data_err:
        logger.warn(f"No data for date: {no_data_err}", extra={"trace_id": trace_id})
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={
                "error_code": "NO_DATA_FOR_DATE",
                "message": str(no_data_err),
                "trace_id": trace_id,
            },
        )
    except Exception as exc:
        logger.error(f"Inference pipeline unhandled failure: {exc}", extra={"trace_id": trace_id})
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error_code": "INTERNAL_INFERENCE_ERROR",
                "message": str(exc),
                "trace_id": trace_id,
            },
        )


@app.get("/internal/v1/ocean/task/{task_id}")
async def get_task_status(task_id: str):
    task_data = TASK_STORE.get(task_id)
    if not task_data:
        raise HTTPException(status_code=404, detail="Task not found")
    return task_data

@app.get("/internal/v1/ocean/available-dates")
async def get_available_dates(
    lat: float = Query(...),
    lon: float = Query(...),
    x_trace_id: Optional[str] = Header(None, alias="x-trace-id"),
):
    trace_id = x_trace_id or f"py-{int(time.time()*1000)}"
    if is_cell_landmass(lat, lon):
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error_code": "LANDMASS", "message": "Selected coordinates are over land.", "trace_id": trace_id},
        )
    dates = get_available_dates_for_cell(lat, lon)
    return {"available_dates": dates}


@app.get("/internal/v1/ocean/region-summary")
async def get_region_summary(
    region: str = Query(...),
    date: str = Query(...),
    x_trace_id: Optional[str] = Header(None, alias="x-trace-id"),
):
    cells = get_region_summary_cells(region.lower(), date)
    return {"cells": cells}


@app.get("/internal/v1/ocean/historical")
async def get_historical(
    lat: float = Query(...),
    lon: float = Query(...),
    metric: str = Query("SST"),
    end_date: str = Query(...),
    x_trace_id: Optional[str] = Header(None, alias="x-trace-id"),
):
    trace_id = x_trace_id or f"py-{int(time.time()*1000)}"
    if is_cell_landmass(lat, lon):
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error_code": "LANDMASS", "message": "Selected coordinates are over land.", "trace_id": trace_id},
        )
    import asyncio
    series = await asyncio.to_thread(get_historical_time_series, lat, lon, metric, end_date, 14)
    return {"time_series": series}
