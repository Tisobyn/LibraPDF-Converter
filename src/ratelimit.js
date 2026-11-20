// Rate limit per caller, counted in Upstash Redis (so all server copies share the same counters).
// Two windows: per minute and per day. Fixed windows: simple and cheap (1 request to Redis per check).

export const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

/**
 * Builds the limiter from settings. Throws a clear error if the settings are missing or wrong.
 * Set RATE_LIMIT_DISABLED=true to run without it (local testing only).
 */
export function createRateLimiterFromEnv(env = process.env) {
  if (env.RATE_LIMIT_DISABLED === "true") {
    console.warn("WARNING: rate limit is OFF (RATE_LIMIT_DISABLED=true). Do not use this in production.");
    return null;
  }
  const url = (env.UPSTASH_REDIS_REST_URL || "").trim();
  const token = (env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required (or set RATE_LIMIT_DISABLED=true for local testing).");
  }
  return createRateLimiter({
    url, token,
    perMinute: Number(env.RATE_LIMIT_PER_MINUTE || 10),
    perDay: Number(env.RATE_LIMIT_PER_DAY || 500),
  });
}

export function createRateLimiter({ url, token, perMinute = 10, perDay = 500, prefix = "rl", timeoutMs = 3000 }) {
  let base;
  try {
    base = new URL(url);
  } catch {
    throw new Error("UPSTASH_REDIS_REST_URL is not a valid URL");
  }
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) {
    throw new Error("UPSTASH_REDIS_REST_URL must start with https://");
  }
  if (!(perMinute > 0) || !(perDay > 0)) throw new Error("Rate limits must be positive numbers");
  const endpoint = (path) => `${base.origin}${path}`;

  async function redis(path, commands) {
    const res = await fetch(endpoint(path), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
    return res.json();
  }

  return {
    limits: { perMinute, perDay },

    /** Throws if Redis cannot be reached or the token is wrong. Call once at startup. */
    async ping() {
      const out = await redis("", ["PING"]);
      if (out?.result !== "PONG") throw new Error("Redis did not answer PONG");
    },

    /**
     * Counts one request for this caller.
     * Returns { allowed: true } or { allowed: false, retryAfter: seconds }.
     * Throws if Redis fails (the caller should then refuse with 503).
     */
    async hit(callerId, now = Date.now()) {
      const minute = Math.floor(now / 60_000), day = Math.floor(now / 86_400_000);
      const kMin = `${prefix}:${callerId}:m:${minute}`, kDay = `${prefix}:${callerId}:d:${day}`;
      const out = await redis("/pipeline", [
        ["INCR", kMin], ["EXPIRE", kMin, 120, "NX"],
        ["INCR", kDay], ["EXPIRE", kDay, 172_800, "NX"],
      ]);
      const countMin = out?.[0]?.result, countDay = out?.[2]?.result;
      if (!Number.isInteger(countMin) || !Number.isInteger(countDay)) throw new Error("Unexpected answer from Redis");
      if (countMin > perMinute) return { allowed: false, retryAfter: Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000)) };
      if (countDay > perDay) return { allowed: false, retryAfter: Math.max(1, Math.ceil(((day + 1) * 86_400_000 - now) / 1000)) };
      return { allowed: true };
    },
  };
}
