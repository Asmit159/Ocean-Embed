/**
 * Ocean Temperature Forecasting - Compressed Binary Redis Cache Client
 * Implements high-throughput binary caching with zlib gzip compression
 * supporting dynamic TTL based on forecast date:
 * - Current date (today): 1-hour TTL (3,600s)
 * - Historical dates: 7-day TTL (604,800s)
 */

import Redis from 'ioredis';
import zlib from 'node:zlib';
import pino from 'pino';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard' }
  }
});

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DISABLE_REDIS = process.env.DISABLE_REDIS === 'true';
const PROFILE_KEY_PREFIX = 'ocean:profile:';
const TTL_HISTORICAL = 7 * 86400; // 7 days (604,800s)
const TTL_CURRENT_DAY = 3600;      // 1 hour (3,600s)

export class OceanRedisClient {
  constructor() {
    if (DISABLE_REDIS) {
      logger.info('Redis caching is completely DISABLED via environment variables.');
      this.redis = null;
      return;
    }

    this.redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy(times) {
        const delay = Math.min(times * 100, 3000);
        logger.warn({ attempt: times, nextDelayMs: delay }, 'Redis reconnecting...');
        return delay;
      }
    });

    this.redis.on('connect', () => {
      logger.info({ redisUrl: REDIS_URL }, 'Connected to Redis cache server');
    });

    this.redis.on('error', (err) => {
      logger.error({ error: err.message }, 'Redis connection error');
    });
  }

  getProfileKey(lat, lon, date) {
    return `${PROFILE_KEY_PREFIX}lat:${lat}:lon:${lon}:date:${date}`;
  }

  calculateTtl(dateStr) {
    const today = new Date().toISOString().slice(0, 10);
    return dateStr === today ? TTL_CURRENT_DAY : TTL_HISTORICAL;
  }

  async getProfile(lat, lon, date, traceId) {
    if (DISABLE_REDIS || !this.redis) return null;

    const key = this.getProfileKey(lat, lon, date);
    try {
      const startMs = Date.now();
      const compressedBuffer = await this.redis.getBuffer(key);

      if (!compressedBuffer) {
        return null;
      }

      const decompressed = zlib.gunzipSync(compressedBuffer).toString('utf-8');
      const data = JSON.parse(decompressed);
      const elapsedMs = Date.now() - startMs;

      logger.info({
        trace_id: traceId,
        cache_status: 'HIT',
        key,
        elapsed_ms: elapsedMs,
      }, 'Cache HIT - Served ocean profile from Redis');

      return data;
    } catch (error) {
      logger.warn({
        trace_id: traceId,
        key,
        error: error.message
      }, 'Failed to read/decompress cached profile from Redis');
      return null;
    }
  }

  async setProfile(lat, lon, date, data, traceId) {
    if (DISABLE_REDIS || !this.redis) return;

    const key = this.getProfileKey(lat, lon, date);
    const ttl = this.calculateTtl(date);
    try {
      const rawString = JSON.stringify(data);
      const compressed = zlib.gzipSync(rawString, { level: 6 });

      await this.redis.set(key, compressed, 'EX', ttl);

      logger.info({
        trace_id: traceId,
        key,
        ttl_seconds: ttl,
        ttl_mode: ttl === TTL_CURRENT_DAY ? '1h_current' : '7d_historical',
        raw_bytes: Buffer.byteLength(rawString),
        compressed_bytes: compressed.length,
      }, 'Successfully cached ocean profile in Redis');
    } catch (error) {
      logger.error({
        trace_id: traceId,
        key,
        error: error.message
      }, 'Failed to cache ocean profile in Redis');
    }
  }

  async ping() {
    if (DISABLE_REDIS || !this.redis) return 'PONG (Bypassed)';
    return this.redis.ping();
  }

  async quit() {
    if (DISABLE_REDIS || !this.redis) return;
    return this.redis.quit();
  }
}

export const redisCache = new OceanRedisClient();
