const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = parseInt(process.env.REDIS_CACHE_TTL_SECONDS || '300', 10);
const REDIS_ENABLED = process.env.REDIS_ENABLED === 'true';
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

let redisClient = null;
let redisReady = false;
let redisError = null;
let connectAttempted = false;
let startupLogged = false;

const memoryStore = new Map();
const memoryRegistry = new Map();

function logStartupOnce(message) {
  if (startupLogged) return;
  startupLogged = true;
  console.log(message);
}

function hashPayload(payload) {
  const normalized = { ...payload };
  delete normalized.refresh;
  delete normalized._refresh;
  const keys = Object.keys(normalized).sort();
  const sorted = {};
  for (const key of keys) {
    sorted[key] = normalized[key];
  }
  return crypto.createHash('md5').update(JSON.stringify(sorted)).digest('hex');
}

function buildCacheKey(endpoint, payload) {
  return `case-api:${endpoint}:${hashPayload(payload)}`;
}

function buildRegistryKey(caseId) {
  return `case-api:registry:${caseId}`;
}

function disableRedisClient(reason) {
  redisReady = false;
  redisError = reason;

  if (redisClient) {
    try {
      redisClient.removeAllListeners();
      redisClient.disconnect();
    } catch {
      // ignore cleanup errors
    }
    redisClient = null;
  }
}

async function getRedisClient() {
  if (connectAttempted) return redisClient;
  connectAttempted = true;

  if (!REDIS_ENABLED) {
    redisError = 'disabled (REDIS_ENABLED=false)';
    logStartupOnce('Cache: in-memory mode (set REDIS_ENABLED=true when Redis is running)');
    return null;
  }

  try {
    const Redis = require('ioredis');
    redisClient = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: () => null,
    });

    redisClient.on('error', () => {
      // Swallow runtime Redis errors — we fall back to memory cache.
    });

    await redisClient.connect();

    redisReady = true;
    redisError = null;
    logStartupOnce(`Cache: Redis connected at ${REDIS_HOST}:${REDIS_PORT}`);
  } catch (error) {
    disableRedisClient(error.message);
    logStartupOnce(`Cache: Redis unavailable (${error.message}) — using in-memory fallback`);
  }

  return redisClient;
}

function getFromMemory(key) {
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryStore.delete(key);
    return null;
  }
  return entry;
}

function setInMemory(key, data, ttlSeconds, caseId) {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  memoryStore.set(key, { data, expiresAt, cachedAt: Date.now() });

  if (caseId) {
    if (!memoryRegistry.has(caseId)) memoryRegistry.set(caseId, new Set());
    memoryRegistry.get(caseId).add(key);
  }
}

function invalidateMemoryCase(caseId) {
  const keys = memoryRegistry.get(caseId);
  if (!keys) return 0;
  let count = 0;
  for (const key of keys) {
    if (memoryStore.delete(key)) count += 1;
  }
  memoryRegistry.delete(caseId);
  return count;
}

function wrapCachedResponse(data, meta) {
  return {
    ...data,
    _cache: {
      fromCache: meta.fromCache,
      source: meta.source,
      cachedAt: meta.cachedAt,
      expiresAt: meta.expiresAt,
      ttlSeconds: meta.ttlSeconds,
    },
  };
}

async function cacheGet(endpoint, payload) {
  await getRedisClient();
  const key = buildCacheKey(endpoint, payload);

  if (redisReady && redisClient) {
    try {
      const raw = await redisClient.get(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const ttl = await redisClient.ttl(key);
      return {
        data: parsed.data,
        meta: {
          fromCache: true,
          source: 'redis',
          cachedAt: parsed.cachedAt,
          expiresAt: Date.now() + Math.max(ttl, 0) * 1000,
          ttlSeconds: Math.max(ttl, 0),
        },
      };
    } catch (error) {
      disableRedisClient(error.message);
    }
  }

  const entry = getFromMemory(key);
  if (!entry) return null;

  return {
    data: entry.data,
    meta: {
      fromCache: true,
      source: 'memory',
      cachedAt: entry.cachedAt,
      expiresAt: entry.expiresAt,
      ttlSeconds: Math.max(Math.floor((entry.expiresAt - Date.now()) / 1000), 0),
    },
  };
}

async function cacheSet(endpoint, payload, data, caseId, ttlSeconds = DEFAULT_TTL_SECONDS) {
  await getRedisClient();
  const key = buildCacheKey(endpoint, payload);
  const cachedAt = Date.now();
  const envelope = { data, cachedAt };

  if (redisReady && redisClient) {
    try {
      await redisClient.setex(key, ttlSeconds, JSON.stringify(envelope));
      if (caseId) {
        await redisClient.sadd(buildRegistryKey(caseId), key);
        await redisClient.expire(buildRegistryKey(caseId), ttlSeconds + 60);
      }
      return;
    } catch (error) {
      disableRedisClient(error.message);
    }
  }

  setInMemory(key, data, ttlSeconds, caseId);
}

async function invalidateCaseCache(caseId) {
  if (!caseId) return { deleted: 0 };

  await getRedisClient();
  let deleted = 0;

  if (redisReady && redisClient) {
    try {
      const registryKey = buildRegistryKey(caseId);
      const keys = await redisClient.smembers(registryKey);
      if (keys.length > 0) {
        deleted = await redisClient.del(...keys);
      }
      await redisClient.del(registryKey);
    } catch (error) {
      disableRedisClient(error.message);
    }
  }

  deleted += invalidateMemoryCase(caseId);
  return { deleted };
}

async function getCacheStatus() {
  await getRedisClient();
  return {
    enabled: true,
    redisEnabled: REDIS_ENABLED,
    redisConnected: redisReady,
    redisHost: REDIS_HOST,
    redisPort: REDIS_PORT,
    redisError,
    fallback: redisReady ? null : 'memory',
    defaultTtlSeconds: DEFAULT_TTL_SECONDS,
    memoryKeys: memoryStore.size,
  };
}

async function withCache({ endpoint, payload, caseId, skipCache, fetchFn, ttlSeconds }) {
  if (!skipCache) {
    const cached = await cacheGet(endpoint, payload);
    if (cached) {
      return wrapCachedResponse(cached.data, cached.meta);
    }
  }

  const fresh = await fetchFn();
  await cacheSet(endpoint, payload, fresh, caseId, ttlSeconds);

  const expiresAt = Date.now() + (ttlSeconds || DEFAULT_TTL_SECONDS) * 1000;
  return wrapCachedResponse(fresh, {
    fromCache: false,
    source: redisReady ? 'redis' : 'memory',
    cachedAt: Date.now(),
    expiresAt,
    ttlSeconds: ttlSeconds || DEFAULT_TTL_SECONDS,
  });
}

module.exports = {
  cacheGet,
  cacheSet,
  invalidateCaseCache,
  getCacheStatus,
  withCache,
  wrapCachedResponse,
  DEFAULT_TTL_SECONDS,
};
