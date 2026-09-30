/**
 * A tiny in-memory fixed-window rate limiter — no dependency, no Redis.
 *
 * Board task #86: `POST /api/auth/register` is public, so it must be bounded
 * before it can hammer the database (or create rows). One fixed window per key
 * (the client IP): the first `max` requests inside `windowMs` pass, everything
 * after is refused until the window resets.
 *
 * Deliberately simple and per-process: the pilot runs one API process, and this
 * is a pilot-grade guard, not a shared quota. A rejected request still consumes
 * nothing from the database — the caller checks before it validates or writes.
 *
 * Pure ESM + JSDoc types: unit-testable with `node --test` and an injected clock
 * (`now`), so the window boundary is deterministic in tests.
 */

/**
 * @param {{ windowMs?: number, max?: number, now?: () => number, maxKeys?: number }} [options]
 * @returns {{
 *   check: (key: string) => { allowed: boolean, remaining: number, retryAfterSeconds: number, resetAt: number },
 *   size: () => number,
 *   reset: () => void,
 * }}
 */
export function createRateLimiter(options = {}) {
  const windowMs = typeof options.windowMs === 'number' && options.windowMs > 0 ? options.windowMs : 15 * 60 * 1000;
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : 10;
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxKeys = Number.isInteger(options.maxKeys) && options.maxKeys > 0 ? options.maxKeys : 10_000;

  /** @type {Map<string, { resetAt: number, count: number }>} */
  const buckets = new Map();

  /**
   * Drop finished windows.
   * @param {number} nowMs
   */
  function prune(nowMs) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= nowMs) buckets.delete(key);
    }
  }

  /**
   * Keep the map bounded so a flood of distinct keys cannot grow it without
   * limit (oldest-first; Map iteration is insertion order). The entry just
   * added is the newest, so it is never the one dropped.
   */
  function trim() {
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  }

  return {
    /**
     * Count one hit for `key` and decide.
     * @param {string} key
     */
    check(key) {
      const nowMs = clock();
      const bucketKey = typeof key === 'string' && key.length > 0 ? key : 'unknown';
      prune(nowMs);
      let bucket = buckets.get(bucketKey);
      if (!bucket || bucket.resetAt <= nowMs) {
        bucket = { resetAt: nowMs + windowMs, count: 0 };
        buckets.set(bucketKey, bucket);
      }
      bucket.count += 1;
      trim();
      const allowed = bucket.count <= max;
      return {
        allowed,
        remaining: Math.max(0, max - bucket.count),
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000)),
        resetAt: bucket.resetAt,
      };
    },

    /** How many windows are tracked (a test/inspection hook). */
    size() {
      return buckets.size;
    },

    /** Forget every window (a test hook). */
    reset() {
      buckets.clear();
    },
  };
}
