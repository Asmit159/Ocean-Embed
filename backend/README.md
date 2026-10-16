# Ocean Temperature Forecasting System - Decoupled REST Architecture

Enterprise-grade, decoupled microservices architecture designed for extreme speed and minimal frontend latency.
Built with **Node.js (Express API Gateway, Auth, Caching)** and **Python (FastAPI, PyTorch ModelSingleton Inference Engine)**.

---

## 🏛 System Architecture & Decoupled Design

```mermaid
graph TD
    Client["React Frontend Client"]
    Gateway["Node.js Express API Gateway (:3000)"]
    Redis[("Redis Compressed Cache (:6379)")]
    ML["Python ML Inference Engine (:8000)"]
    Postgres[("PostgreSQL User Auth & Catalog (:5432)")]
    MinIO[("MinIO NetCDF/Zarr Data Lake (:9000)")]

    Client -->|1. POST /auth/login| Gateway
    Gateway -->|2. Verify Credentials & Issue JWT| Client
    Client -->|3. GET /ocean/profile Bearer JWT| Gateway
    Gateway -->|4. 5-Degree Grid Validation 422 if invalid| Gateway
    Gateway -->|5. Check Compressed Cache| Redis
    Redis -.->|Cache HIT| Gateway
    Gateway -->|6. Cache MISS: Internal REST Proxy with X-Trace-Id| ML
    ML -->|7. ModelSingleton PyTorch Inference & Landmask| ML
    ML -.->|404 LANDMASS if land| Gateway
    ML -.->|404 NO_DATA_FOR_DATE if unavailable| Gateway
    ML -->|8. Complete OceanData JSON Payload| Gateway
    Gateway -->|9. Dynamic TTL Cache (7d vs 1h)| Redis
    Gateway -->|10. Return JSON to Client| Client
```

---

## 🔐 Authentication & Security

All `/api/v1/ocean/*` routes are protected by a JWT Bearer token authentication middleware.

### 1. Authenticate & Obtain Token
```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "admin@oceanembed.ai",
  "password": "OceanEmbed2024!"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "user": {
    "id": "usr_01HXYZ789",
    "email": "admin@oceanembed.ai",
    "name": "OceanEmbed Administrator",
    "role": "admin"
  },
  "trace_id": "3ec41c41-3c58-4685-8564-79e9634717e0"
}
```

---

## 🌊 REST API Contract (`/api/v1`)

### 1. Primary Profile Endpoint
`GET /api/v1/ocean/profile?lat={float}&lon={float}&date={YYYY-MM-DD}`
- **Headers**: `Authorization: Bearer <token>`
- **Validation**: `lat` and `lon` must be strict multiples of 5 (e.g. `10.0`, `85.0`).
- **Cache Strategy**:
  - Historical dates: **7-Day TTL** (`604,800s`)
  - Current date (today): **1-Hour TTL** (`3,600s`)
  - Compression: Gzip binary storage in Redis reducing 1.5MB to ~200KB.

#### Success Response (`OceanData` Interface):
```json
{
  "latitude_range": "10°N - 15°N",
  "longitude_range": "80°E - 85°E",
  "surface_inputs": {
    "SST_celsius": 29.4,
    "SSS_psu": 34.2,
    "SSH_meters": 0.45,
    "currents_vector_grid": [
      [{"u": 0.12, "v": -0.05}, ... /* 20x20 grid elements */]
    ],
    "winds_vector_grid": [
      [{"u": 5.4, "v": 2.1}, ... /* 20x20 grid elements */]
    ]
  },
  "ai_predictions": [
    {"depth": 0, "temps_celsius": 29.4, "argo_temps_celsius": 29.28},
    {"depth": 5, "temps_celsius": 29.1, "argo_temps_celsius": 29.02},
    {"depth": 10, "temps_celsius": 28.7, "argo_temps_celsius": 28.65},
    {"depth": 20, "temps_celsius": 28.0, "argo_temps_celsius": 27.91},
    {"depth": 30, "temps_celsius": 26.5, "argo_temps_celsius": 26.34},
    {"depth": 50, "temps_celsius": 23.8, "argo_temps_celsius": 23.55},
    {"depth": 75, "temps_celsius": 20.2, "argo_temps_celsius": 19.98},
    {"depth": 100, "temps_celsius": 17.5, "argo_temps_celsius": 17.32},
    {"depth": 125, "temps_celsius": 15.1, "argo_temps_celsius": 15.01},
    {"depth": 150, "temps_celsius": 13.4, "argo_temps_celsius": 13.25},
    {"depth": 200, "temps_celsius": 11.2, "argo_temps_celsius": 11.08},
    {"depth": 300, "temps_celsius": 9.5, "argo_temps_celsius": 9.42},
    {"depth": 500, "temps_celsius": 7.1, "argo_temps_celsius": 7.03},
    {"depth": 700, "temps_celsius": 5.4, "argo_temps_celsius": 5.34},
    {"depth": 1000, "temps_celsius": 3.8, "argo_temps_celsius": 3.8}
  ],
  "validation_metrics": {
    "RMSE": 0.162,
    "correlation": 0.999,
    "bias": 0.125
  },
  "cached": false,
  "trace_id": "ebc273c7-169d-45d2-b62f-3773a2d4cbeb"
}
```

#### Mandatory Error Codes:
- **422 Unprocessable Entity**:
  ```json
  {
    "error_code": "INVALID_COORDINATES",
    "message": "Coordinates must be strictly aligned to 5-degree grid intervals (lat: 12, lon: 80).",
    "trace_id": "..."
  }
  ```
- **404 Not Found (Landmass)**:
  ```json
  {
    "error_code": "LANDMASS",
    "message": "Coordinate cell (25, 80) is situated over a continental landmass.",
    "trace_id": "..."
  }
  ```
- **404 Not Found (No Data For Date)**:
  ```json
  {
    "error_code": "NO_DATA_FOR_DATE",
    "message": "No forecast model output exists for date: 2018-05-01",
    "trace_id": "..."
  }
  ```

---

### 2. Available Dates
`GET /api/v1/ocean/available-dates?lat={float}&lon={float}`
- Returns catalog array of valid `YYYY-MM-DD` strings for the given coordinate cell.

### 3. Region Summary
`GET /api/v1/ocean/region-summary?region={bob|as}&date={YYYY-MM-DD}`
- Region: `bob` (Bay of Bengal) or `as` (Arabian Sea).
- Returns array of 5° cells with `lat`, `lon`, `is_ocean`, and `has_data` flags.

### 4. Historical Time Series
`GET /api/v1/ocean/historical?lat={float}&lon={float}&metric=SST&end_date={YYYY-MM-DD}`
- Returns a 14-day time series array `[ { "date": "...", "value": ... }, ... ]` for area chart rendering.

### 5. Health Check
`GET /api/v1/health`
- Returns: `{ "status": "ok", "version": "1.0.0", "model_loaded": true }`

---

## 🚀 Running Locally (Without Docker)

You can spin up the entire architecture locally across three terminal windows:

**1. Python ML Engine**
```bash
cd python_ml
.\.venv\Scripts\activate   # (Or `source .venv/bin/activate` on Mac/Linux)
uvicorn main:app --port 8000
```

**2. Node.js API Gateway**
```bash
cd node_gateway
npm run dev
```

**3. React Frontend**
```bash
cd ../ocean-embed
npm run dev
```

---

## 🐳 Running with Docker Compose

---

## 🧪 Testing & Verification

Run the integration and contract test suite:
```bash
cd node_gateway
npm test
```
All tests verify coordinate validation, JWT security, 404 LANDMASS / NO_DATA_FOR_DATE, and OceanData payload integrity.
