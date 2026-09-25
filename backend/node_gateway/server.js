/**
 * Ocean Temperature Forecasting - Node.js Express API Gateway
 * Strict REST implementation adhering to OceanData contract,
 * JWT authentication, 5-degree grid validation, and Redis TTL caching.
 */

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import dotenv from 'dotenv';

import { authenticateJWT } from './middleware/auth.js';
import { loginHandler } from './controllers/auth_controller.js';
import { validateCoordinates } from './utils/coordinate_validator.js';
import { redisCache } from './redis_client.js';

dotenv.config({ path: '../.env' });

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard' }
  }
});

const app = express();
const PORT = process.env.PORT || 3000;
const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8001';

app.use(cors());
app.use(express.json());

// Trace ID & Structured Request Logging Middleware
app.use((req, res, next) => {
  const traceId = req.headers['x-trace-id'] || uuidv4();
  req.traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  req.startTime = Date.now();

  res.on('finish', () => {
    const elapsedMs = Date.now() - req.startTime;
    logger.info({
      trace_id: traceId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration_ms: elapsedMs,
      ip: req.ip,
    }, 'HTTP Request Completed');
  });

  next();
});

// =========================================================================
// Routes: Authentication
// =========================================================================
app.post('/api/v1/auth/login', loginHandler);

// =========================================================================
// Routes: System Health
// =========================================================================
app.get('/api/v1/health', async (req, res) => {
  try {
    let pythonModelLoaded = false;
    try {
      const pyHealth = await axios.get(`${PYTHON_SERVICE_URL}/internal/v1/health`, {
        headers: { 'x-trace-id': req.traceId },
        timeout: 2000,
      });
      pythonModelLoaded = Boolean(pyHealth.data?.model_loaded);
    } catch (_) {
      pythonModelLoaded = false;
    }

    res.status(200).json({
      status: 'ok',
      version: '1.0.0',
      model_loaded: pythonModelLoaded,
      service: 'ocean-node-gateway',
      trace_id: req.traceId,
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      version: '1.0.0',
      model_loaded: false,
      error: err.message,
      trace_id: req.traceId,
    });
  }
});

// =========================================================================
// Routes: Ocean Forecasting (Protected by JWT)
// =========================================================================

/**
 * Primary Profile Endpoint:
 * GET /api/v1/ocean/profile?lat={float}&lon={float}&date={YYYY-MM-DD}
 */
app.get('/api/v1/ocean/profile', authenticateJWT, async (req, res) => {
  const { lat: rawLat, lon: rawLon, date } = req.query;
  const asyncMode = req.query.async === 'true';
  const traceId = req.traceId;

  // 1. Enforce 5-degree grid validation
  const coordCheck = validateCoordinates(rawLat, rawLon);
  if (!coordCheck.isValid) {
    logger.warn({ trace_id: traceId, rawLat, rawLon, error: coordCheck.message }, 'Coordinate validation failed');
    return res.status(coordCheck.status).json({
      error_code: coordCheck.errorCode,
      message: coordCheck.message,
      trace_id: traceId,
    });
  }

  const { lat, lon } = coordCheck;

  // 2. Date format validation (YYYY-MM-DD)
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      error_code: 'INVALID_DATE_FORMAT',
      message: 'Date must be formatted as YYYY-MM-DD.',
      trace_id: traceId,
    });
  }

  try {
    // 3. Check Redis Cache
    const cachedProfile = await redisCache.getProfile(lat, lon, date, traceId);
    if (cachedProfile) {
      return res.status(200).json({
        ...cachedProfile,
        cached: true,
        trace_id: traceId,
      });
    }

    // 4. Cache MISS -> Proxy to Python ML Service
    logger.info({ trace_id: traceId, lat, lon, date }, 'Cache MISS - Requesting profile from Python ML engine');

    const pythonUrl = `${PYTHON_SERVICE_URL}/internal/v1/ocean/profile`;
    const pyResponse = await axios.get(pythonUrl, {
      params: { lat, lon, date, async: asyncMode },
      headers: { 'x-trace-id': traceId },
      timeout: 60000,
    });

    const profileData = pyResponse.data;

    if (asyncMode && profileData.task_id) {
       return res.status(200).json({
         ...profileData,
         cached: false,
         trace_id: traceId
       });
    }

    // 5. Asynchronously persist to Redis with dynamic TTL (1h for today, 7d for historical)
    redisCache.setProfile(lat, lon, date, profileData, traceId).catch((err) => {
      logger.error({ trace_id: traceId, error: err.message }, 'Failed background Redis caching');
    });

    return res.status(200).json({
      ...profileData,
      cached: false,
      trace_id: traceId,
    });

  } catch (error) {
    if (error.response) {
      const { status, data } = error.response;
      logger.warn({
        trace_id: traceId,
        status,
        upstream_error: data?.error_code || 'UPSTREAM_ERROR',
        message: data?.message,
      }, 'Python ML upstream returned error');

      return res.status(status).json({
        error_code: data?.error_code || 'UPSTREAM_ERROR',
        message: data?.message || 'Upstream ML service error.',
        trace_id: traceId,
      });
    }

    logger.error({ trace_id: traceId, error: error.message }, 'Downstream connection error to Python ML service');
    return res.status(502).json({
      error_code: 'DOWNSTREAM_UNAVAILABLE',
      message: 'Python ML inference engine is currently unreachable.',
      trace_id: traceId,
    });
  }
});

/**
 * Async Task Status Endpoint:
 * GET /api/v1/ocean/task/:taskId
 */
app.get('/api/v1/ocean/task/:taskId', authenticateJWT, async (req, res) => {
  const { taskId } = req.params;
  const { lat, lon, date } = req.query; // Need these to cache the result!
  const traceId = req.traceId;

  try {
    const pyResponse = await axios.get(`${PYTHON_SERVICE_URL}/internal/v1/ocean/task/${taskId}`, {
      headers: { 'x-trace-id': traceId },
      timeout: 5000,
    });
    
    const taskData = pyResponse.data;
    
    if (taskData.status === 'completed' && lat && lon && date) {
      redisCache.setProfile(lat, lon, date, taskData.result, traceId).catch(err => {
         logger.error({ trace_id: traceId, error: err.message }, 'Failed background Redis caching of async task');
      });
    }
    
    return res.status(200).json(taskData);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.status(404).json({ error_code: 'TASK_NOT_FOUND', message: 'Task not found' });
    }
    logger.error({ trace_id: traceId, error: error.message }, 'Error fetching async task status');
    return res.status(502).json({
      error_code: 'DOWNSTREAM_ERROR',
      message: 'Failed to retrieve task status from ML service.',
      trace_id: traceId,
    });
  }
});

/**
 * Available Dates Endpoint:
 * GET /api/v1/ocean/available-dates?lat={float}&lon={float}
 */
app.get('/api/v1/ocean/available-dates', authenticateJWT, async (req, res) => {
  const { lat: rawLat, lon: rawLon } = req.query;
  const traceId = req.traceId;

  const coordCheck = validateCoordinates(rawLat, rawLon);
  if (!coordCheck.isValid) {
    return res.status(coordCheck.status).json({
      error_code: coordCheck.errorCode,
      message: coordCheck.message,
      trace_id: traceId,
    });
  }

  const { lat, lon } = coordCheck;

  try {
    const pyResponse = await axios.get(`${PYTHON_SERVICE_URL}/internal/v1/ocean/available-dates`, {
      params: { lat, lon },
      headers: { 'x-trace-id': traceId },
      timeout: 5000,
    });

    return res.status(200).json({
      available_dates: pyResponse.data.available_dates,
      lat,
      lon,
      trace_id: traceId,
    });
  } catch (error) {
    logger.error({ trace_id: traceId, error: error.message }, 'Error fetching available dates');
    return res.status(502).json({
      error_code: 'DOWNSTREAM_ERROR',
      message: 'Failed to retrieve available dates from ML service.',
      trace_id: traceId,
    });
  }
});

/**
 * Region Summary Endpoint:
 * GET /api/v1/ocean/region-summary?region={bob|as}&date={YYYY-MM-DD}
 */
app.get('/api/v1/ocean/region-summary', authenticateJWT, async (req, res) => {
  const { region, date } = req.query;
  const traceId = req.traceId;

  const normalizedRegion = String(region || '').toLowerCase();
  if (normalizedRegion !== 'bob' && normalizedRegion !== 'as') {
    return res.status(400).json({
      error_code: 'INVALID_REGION',
      message: 'Region must be either "bob" (Bay of Bengal) or "as" (Arabian Sea).',
      trace_id: traceId,
    });
  }

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      error_code: 'INVALID_DATE_FORMAT',
      message: 'Date must be formatted as YYYY-MM-DD.',
      trace_id: traceId,
    });
  }

  try {
    const pyResponse = await axios.get(`${PYTHON_SERVICE_URL}/internal/v1/ocean/region-summary`, {
      params: { region: normalizedRegion, date },
      headers: { 'x-trace-id': traceId },
      timeout: 60000,
    });

    return res.status(200).json({
      region: normalizedRegion,
      date,
      cells: pyResponse.data.cells,
      trace_id: traceId,
    });
  } catch (error) {
    logger.error({ trace_id: traceId, error: error.message }, 'Error fetching region summary');
    return res.status(502).json({
      error_code: 'DOWNSTREAM_ERROR',
      message: 'Failed to retrieve region summary.',
      trace_id: traceId,
    });
  }
});

/**
 * Historical Time Series Endpoint:
 * GET /api/v1/ocean/historical?lat={float}&lon={float}&metric={SST}&end_date={YYYY-MM-DD}
 */
app.get('/api/v1/ocean/historical', authenticateJWT, async (req, res) => {
  const { lat: rawLat, lon: rawLon, metric = 'SST', end_date } = req.query;
  const traceId = req.traceId;

  const coordCheck = validateCoordinates(rawLat, rawLon);
  if (!coordCheck.isValid) {
    return res.status(coordCheck.status).json({
      error_code: coordCheck.errorCode,
      message: coordCheck.message,
      trace_id: traceId,
    });
  }

  const { lat, lon } = coordCheck;

  if (!end_date || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
    return res.status(400).json({
      error_code: 'INVALID_DATE_FORMAT',
      message: 'end_date must be formatted as YYYY-MM-DD.',
      trace_id: traceId,
    });
  }

  try {
    const pyResponse = await axios.get(`${PYTHON_SERVICE_URL}/internal/v1/ocean/historical`, {
      params: { lat, lon, metric, end_date },
      headers: { 'x-trace-id': traceId },
      timeout: 60000,
    });

    return res.status(200).json({
      lat,
      lon,
      metric,
      end_date,
      time_series: pyResponse.data.time_series,
      trace_id: traceId,
    });
  } catch (error) {
    logger.error({ trace_id: traceId, error: error.message }, 'Error fetching historical data');
    return res.status(502).json({
      error_code: 'DOWNSTREAM_ERROR',
      message: 'Failed to retrieve historical time series.',
      trace_id: traceId,
    });
  }
});

// 404 Handler for undefined routes
app.use((req, res) => {
  res.status(404).json({
    error_code: 'NOT_FOUND',
    message: `Cannot ${req.method} ${req.originalUrl}`,
    trace_id: req.traceId,
  });
});

// Start listening
const server = app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV }, 'Ocean Node.js REST API Gateway running');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down Node Gateway server...');
  server.close(async () => {
    await redisCache.quit();
    logger.info('Gateway server shut down cleanly.');
    process.exit(0);
  });
});
