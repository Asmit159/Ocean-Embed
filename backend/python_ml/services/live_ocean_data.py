"""
Live Data Fetcher (NASA Earthdata & Copernicus)
Uses robust temporary file downloads and spatial interpolation syncing with training logic.
"""

import asyncio
import logging
import os
import tempfile
import re
from typing import Dict, Any, List

import numpy as np
import xarray as xr
import earthaccess
import copernicusmarine
import requests
from datetime import datetime, timedelta
from scipy.interpolate import interp1d

logger = logging.getLogger("ocean_ml.live_data")

def authenticate_apis():
    try:
        logger.info("Authenticating with NASA Earthdata...")
        earthaccess.login(strategy="environment", persist=True)
        logger.info("NASA Earthdata authentication successful.")
    except Exception as e:
        logger.error(f"NASA auth failed: {e}")

    try:
        logger.info("Authenticating with Copernicus Marine...")
        copernicusmarine.login(
            username=os.getenv("COPERNICUS_USER"),
            password=os.getenv("COPERNICUS_PASS")
        )
        logger.info("Copernicus Marine authentication successful.")
    except Exception as e:
        logger.error(f"Copernicus auth failed: {e}")

def extract_variable(ds: xr.Dataset, fallbacks: List[str]) -> str:
    """Dynamically extracts a variable using fallback names."""
    for var in fallbacks:
        if var in ds.variables or var in ds.data_vars:
            return var
    raise ValueError(f"Could not find any of {fallbacks} in dataset variables: {list(ds.variables.keys())}")

def process_grid(ds: xr.Dataset, var_name: str, lat: float, lon: float, date_str: str, k2c: bool = False) -> List[List[float]]:
    """Interpolates array and applies exact offline script logic (lon wrapping, time masking, k2c)."""
    da = ds[var_name]

    if "time" in ds.coords or "time" in da.dims:
        try:
            time_strs = ds.time.dt.strftime('%Y-%m-%d').values
        except Exception:
            time_strs = np.array([str(t)[:10] for t in np.atleast_1d(ds.time.values)])
            
        if time_strs.ndim == 0:
            time_strs = np.array([time_strs])
            
        if date_str in time_strs:
            mask = (time_strs == date_str)
            if ds.time.ndim > 0:
                da = da.isel(time=mask).mean(dim="time", keep_attrs=True)

    lat_dim = next((d for d in da.dims if 'lat' in str(d).lower() or str(d).lower() == 'y'), None)
    lon_dim = next((d for d in da.dims if 'lon' in str(d).lower() or str(d).lower() == 'x'), None)
    
    if not lat_dim or not lon_dim: 
        # Fallback to defaults or return empty
        logger.warning(f"Could not find strict lat/lon dims in {var_name}")
        lat_dim, lon_dim = da.dims[-2], da.dims[-1]
    
    lon_vals = np.asarray(da[lon_dim].values, dtype=np.float64)
    if np.nanmax(lon_vals) > 180:
        lon_vals = ((lon_vals + 180) % 360) - 180
        da = da.assign_coords({lon_dim: lon_vals})
        
    _, index = np.unique(da[lon_dim].values, return_index=True)
    da = da.isel({lon_dim: index})
    da = da.sortby(lat_dim).sortby(lon_dim)
    
    allowed_dims = [lat_dim, lon_dim]
    for d in list(da.dims):
        if d not in allowed_dims:
            da = da.isel({d: 0})
            
    target_lat = np.linspace(lat, lat + 4.75, 20, dtype=np.float32)
    target_lon = np.linspace(lon, lon + 4.75, 20, dtype=np.float32)
    
    da = da.interp({lat_dim: target_lat, lon_dim: target_lon}, method="linear", kwargs={"fill_value": "extrapolate"})
    
    arr = np.asarray(da.transpose(lat_dim, lon_dim).values, dtype=np.float32)
    if k2c:
        arr = arr - 273.15
        
    grid = np.nan_to_num(arr, nan=0.0).tolist()
    return grid

def fetch_copernicus_sync(dataset_id: str, lat: float, lon: float, date_str: str, temp_dir: str, fallbacks: List[str], k2c: bool = False) -> List[List[float]]:
    file_name = f"{dataset_id.replace('/', '_')}.nc"
    file_path = os.path.join(temp_dir, file_name)
    
    try:
        copernicusmarine.subset(
            dataset_id=dataset_id,
            minimum_longitude=lon,
            maximum_longitude=lon+5.0,
            minimum_latitude=lat,
            maximum_latitude=lat+5.0,
            start_datetime=f"{date_str} 00:00:00",
            end_datetime=f"{date_str} 23:59:59",
            minimum_depth=0.0,
            maximum_depth=1.0,
            output_filename=file_path,
            force_download=True
        )
    except Exception as e:
        err_str = str(e)
        if "exceed the dataset coordinates" in err_str:
            match = re.search(r"exceed the dataset coordinates \[.*?, (\d{4}-\d{2}-\d{2})", err_str)
            if match:
                fallback_date = match.group(1)
                logger.info(f"Date {date_str} exceeds bounds for {dataset_id}. Retrying with {fallback_date}")
                try:
                    copernicusmarine.subset(
                        dataset_id=dataset_id,
                        minimum_longitude=lon,
                        maximum_longitude=lon+5.0,
                        minimum_latitude=lat,
                        maximum_latitude=lat+5.0,
                        start_datetime=f"{fallback_date} 00:00:00",
                        end_datetime=f"{fallback_date} 23:59:59",
                        minimum_depth=0.0,
                        maximum_depth=1.0,
                        output_filename=file_path,
                        force_download=True
                    )
                except Exception as inner_e:
                    raise ValueError(f"Copernicus dataset {dataset_id} unavailable after fallback to {fallback_date}: {inner_e}")
            else:
                raise ValueError(f"Copernicus dataset {dataset_id} unavailable for {date_str}: {e}")
        else:
            raise ValueError(f"Copernicus dataset {dataset_id} unavailable for {date_str}: {e}")
            
    with xr.open_dataset(file_path) as ds:
        var_name = extract_variable(ds, fallbacks)
        grid = process_grid(ds, var_name, lat, lon, date_str, k2c=k2c)
        
    try:
        os.remove(file_path)
    except:
        pass
        
    return grid

def fetch_copernicus_vector_sync(dataset_id: str, lat: float, lon: float, date_str: str, temp_dir: str, u_fallbacks: List[str], v_fallbacks: List[str]) -> Dict[str, Any]:
    file_name = f"{dataset_id.replace('/', '_')}.nc"
    file_path = os.path.join(temp_dir, file_name)
    
    try:
        copernicusmarine.subset(
            dataset_id=dataset_id,
            minimum_longitude=lon,
            maximum_longitude=lon+5.0,
            minimum_latitude=lat,
            maximum_latitude=lat+5.0,
            start_datetime=f"{date_str} 00:00:00",
            end_datetime=f"{date_str} 23:59:59",
            minimum_depth=0.0,
            maximum_depth=1.0,
            output_filename=file_path,
            force_download=True
        )
    except Exception as e:
        err_str = str(e)
        if "exceed the dataset coordinates" in err_str:
            match = re.search(r"exceed the dataset coordinates \[.*?, (\d{4}-\d{2}-\d{2})", err_str)
            if match:
                fallback_date = match.group(1)
                logger.info(f"Date {date_str} exceeds bounds for {dataset_id}. Retrying with {fallback_date}")
                try:
                    copernicusmarine.subset(
                        dataset_id=dataset_id,
                        minimum_longitude=lon,
                        maximum_longitude=lon+5.0,
                        minimum_latitude=lat,
                        maximum_latitude=lat+5.0,
                        start_datetime=f"{fallback_date} 00:00:00",
                        end_datetime=f"{fallback_date} 23:59:59",
                        minimum_depth=0.0,
                        maximum_depth=1.0,
                        output_filename=file_path,
                        force_download=True
                    )
                except Exception as inner_e:
                    raise ValueError(f"Copernicus dataset {dataset_id} unavailable after fallback to {fallback_date}: {inner_e}")
            else:
                raise ValueError(f"Copernicus dataset {dataset_id} unavailable for {date_str}: {e}")
        else:
            raise ValueError(f"Copernicus dataset {dataset_id} unavailable for {date_str}: {e}")
            
    with xr.open_dataset(file_path) as ds:
        u_var = next((v for v in u_fallbacks if v in ds.variables), None)
        v_var = next((v for v in v_fallbacks if v in ds.variables), None)
        
        if not u_var or not v_var:
            raise ValueError(f"Could not find U/V variables in dataset {dataset_id}. Available: {list(ds.variables.keys())}")
            
        u_grid = process_grid(ds, u_var, lat, lon, date_str)
        v_grid = process_grid(ds, v_var, lat, lon, date_str)
        
    try:
        os.remove(file_path)
    except:
        pass
        
    return {"u": u_grid, "v": v_grid}

def fetch_copernicus_wind_vector_sync(dataset_id: str, lat: float, lon: float, date_str: str, temp_dir: str, u_fallbacks: List[str], v_fallbacks: List[str]) -> Dict[str, Any]:
    file_name = f"{dataset_id.replace('/', '_')}.nc"
    file_path = os.path.join(temp_dir, file_name)
    
    try:
        copernicusmarine.subset(
            dataset_id=dataset_id,
            minimum_longitude=lon,
            maximum_longitude=lon+5.0,
            minimum_latitude=lat,
            maximum_latitude=lat+5.0,
            start_datetime=f"{date_str} 12:00:00",
            end_datetime=f"{date_str} 12:00:00",
            output_filename=file_path,
            force_download=True
        )
    except Exception as e:
        err_str = str(e)
        if "exceed the dataset coordinates" in err_str:
            match = re.search(r"exceed the dataset coordinates \[.*?, (\d{4}-\d{2}-\d{2})", err_str)
            if match:
                fallback_date = match.group(1)
                logger.info(f"Date {date_str} exceeds bounds for {dataset_id}. Retrying with {fallback_date}")
                try:
                    copernicusmarine.subset(
                        dataset_id=dataset_id,
                        minimum_longitude=lon,
                        maximum_longitude=lon+5.0,
                        minimum_latitude=lat,
                        maximum_latitude=lat+5.0,
                        start_datetime=f"{fallback_date} 12:00:00",
                        end_datetime=f"{fallback_date} 12:00:00",
                        output_filename=file_path,
                        force_download=True
                    )
                except Exception as inner_e:
                    raise ValueError(f"Copernicus dataset {dataset_id} unavailable after fallback to {fallback_date}: {inner_e}")
            else:
                raise ValueError(f"Copernicus dataset {dataset_id} unavailable for {date_str}: {e}")
        else:
            raise ValueError(f"Copernicus dataset {dataset_id} unavailable for {date_str}: {e}")
            
    with xr.open_dataset(file_path) as ds:
        u_var = next((v for v in u_fallbacks if v in ds.variables), None)
        v_var = next((v for v in v_fallbacks if v in ds.variables), None)
        
        if not u_var or not v_var:
            raise ValueError(f"Could not find U/V variables in dataset {dataset_id}. Available: {list(ds.variables.keys())}")
            
        u_grid = process_grid(ds, u_var, lat, lon, date_str)
        v_grid = process_grid(ds, v_var, lat, lon, date_str)
        
    try:
        os.remove(file_path)
    except:
        pass
        
    return {"u": u_grid, "v": v_grid}

def fetch_argo_erddap_sync(lat: float, lon: float, date_str: str) -> List[float]:
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        start_time = (dt - timedelta(days=3)).strftime("%Y-%m-%dT00:00:00Z")
        end_time = (dt + timedelta(days=3)).strftime("%Y-%m-%dT23:59:59Z")
        
        url = "https://erddap.ifremer.fr/erddap/tabledap/ArgoFloats.json"
        query_str = f"latitude,longitude,time,pres,temp&latitude>={lat-2.5}&latitude<={lat+2.5}&longitude>={lon-2.5}&longitude<={lon+2.5}&time>={start_time}&time<={end_time}&pres>=0&pres<=1000"
        
        resp = requests.get(f"{url}?{query_str}", timeout=10)
        if resp.status_code != 200:
            return None
            
        data = resp.json()
        rows = data.get('table', {}).get('rows', [])
        if not rows:
            return None
            
        # Group by platform+time to get a single vertical profile
        profile_dict = {}
        # Columns: [lat, lon, time, pres, temp]
        first_time = rows[0][2]
        
        for r in rows:
            t = r[2]
            if t == first_time:
                pres = r[3]
                temp = r[4]
                if pres is not None and temp is not None:
                    profile_dict[pres] = temp
                    
        if len(profile_dict) < 3:
            return None
            
        # Sort by pressure
        sorted_pres = sorted(list(profile_dict.keys()))
        sorted_temp = [profile_dict[p] for p in sorted_pres]
        
        # Interpolate to strictly 15 layers
        FIXED_DEPTH_LEVELS = [0, 5, 10, 20, 30, 50, 75, 100, 125, 150, 200, 300, 500, 700, 1000]
        # Use fill_value="extrapolate" to handle boundaries
        f_interp = interp1d(sorted_pres, sorted_temp, kind='linear', fill_value="extrapolate")
        
        interpolated_temps = []
        for d in FIXED_DEPTH_LEVELS:
            interpolated_temps.append(round(float(f_interp(d)), 2))
            
        return interpolated_temps
    except Exception as e:
        logger.warning(f"ERDDAP ARGO fetch failed: {e}")
        return None

def fetch_nasa_sync(short_names: List[str], lat: float, lon: float, date_str: str, temp_dir: str, u_falls: List[str], v_falls: List[str]) -> Dict[str, List[List[float]]]:
    results = None
    for short_name in short_names:
        results = earthaccess.search_data(
            short_name=short_name,
            temporal=(f"{date_str}T00:00:00", f"{date_str}T23:59:59"),
            bounding_box=(lon, lat, lon+5.0, lat+5.0),
            count=1
        )
        if results:
            break
            
    if not results:
        raise ValueError(f"No NASA granules found for {short_names} on {date_str} at coordinates.")
        
    downloaded_files = earthaccess.download(results, local_path=temp_dir)
    if not downloaded_files:
        raise ValueError("Failed to download NASA granule.")
        
    with xr.open_dataset(downloaded_files[0]) as ds:
        u_var = extract_variable(ds, u_falls)
        v_var = extract_variable(ds, v_falls)
        u_grid = process_grid(ds, u_var, lat, lon, date_str)
        v_grid = process_grid(ds, v_var, lat, lon, date_str)
        
    os.remove(downloaded_files[0])
    return {"u": u_grid, "v": v_grid}


async def fetch_live_surface_inputs(lat: float, lon: float, date_str: str, progress_cb=None) -> Dict[str, Any]:
    """Main orchestrator: downloads 5 datasets concurrently to a temp dir and interpolates them."""
    logger.info(f"Initiating concurrent fetch for cell {lat}, {lon} on {date_str}")
    
    sst_fallbacks = ["analysed_sst", "sst", "thetao", "temp"]
    sss_fallbacks = ["sos", "sss", "so"]
    ssh_fallbacks = ["sla", "ssh", "zos"]
    u_fallbacks = ["u", "uo", "u_current", "u_surf", "U", "uwnd", "u10", "U_wind", "eastward_wind"]
    v_fallbacks = ["v", "vo", "v_current", "v_surf", "V", "vwnd", "v10", "V_wind", "northward_wind"]

    import tempfile
    temp_dir_obj = tempfile.TemporaryDirectory()
    temp_dir = temp_dir_obj.name
    
    async def run_with_progress(task_coro):
        res = await task_coro
        if progress_cb:
            progress_cb(13)
        return res

    try:
        # Run concurrently since Uvicorn is now stable without --reload
        print("[FETCH] Starting fetches concurrently...", flush=True)
        results = await asyncio.gather(
            run_with_progress(asyncio.to_thread(fetch_copernicus_sync, "METOFFICE-GLO-SST-L4-NRT-OBS-SST-V2", lat, lon, date_str, temp_dir, sst_fallbacks, True)),
            run_with_progress(asyncio.to_thread(fetch_copernicus_sync, "cmems_obs-mob_glo_phy-sss_nrt_multi_P1D", lat, lon, date_str, temp_dir, sss_fallbacks, False)),
            run_with_progress(asyncio.to_thread(fetch_copernicus_sync, "cmems_obs-sl_glo_phy-ssh_nrt_allsat-l4-duacs-0.125deg_P1D", lat, lon, date_str, temp_dir, ssh_fallbacks, False)),
            run_with_progress(asyncio.to_thread(fetch_copernicus_wind_vector_sync, "cmems_obs-wind_glo_phy_nrt_l4_0.125deg_PT1H", lat, lon, date_str, temp_dir, u_fallbacks, v_fallbacks)),
            run_with_progress(asyncio.to_thread(fetch_copernicus_vector_sync, "cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m", lat, lon, date_str, temp_dir, u_fallbacks, v_fallbacks)),
            run_with_progress(asyncio.to_thread(fetch_argo_erddap_sync, lat, lon, date_str))
        )
        print("[FETCH] All datasets fetched successfully.", flush=True)
        sst_grid = results[0]
        sss_grid = results[1]
        ssh_grid = results[2]
        winds = results[3]
        curr = results[4]
        argo_profile = results[5]
        
        return {
            "SST_grid": sst_grid,
            "SSS_grid": sss_grid,
            "SSH_grid": ssh_grid,
            "U_curr_grid": curr["u"],
            "V_curr_grid": curr["v"],
            "U_wind_grid": winds["u"],
            "V_wind_grid": winds["v"],
            "argo_profile": argo_profile,
        }
    except Exception as e:
        logger.error(f"Live API fetch failed: {e}")
        raise e
    finally:
        temp_dir_obj.cleanup()