/**
 * Retry Neon / pg pool operations on transient DNS or connection errors.
 * Usage: import { withNeonRetry, createPool } from "./_neon_retry.mjs";
 */

const RETRYABLE = new Set(["ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"]);

export function isRetryableNeonError(err) {
  if (!err) return false;
  const code = err.code ?? err.errno;
  if (code && RETRYABLE.has(String(code))) return true;
  const msg = String(err.message ?? err);
  return /ENOTFOUND|ECONNRESET|connection timeout|Connection terminated/i.test(msg);
}

export async function withNeonRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 2500;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (!isRetryableNeonError(e) || attempt === maxAttempts) throw e;
      const delay = baseDelayMs * attempt;
      console.warn(
        `[neon-retry] attempt ${attempt}/${maxAttempts} failed (${e.code ?? e.message}); retry in ${delay}ms`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export function createPool(pg, connectionString, poolOpts = {}) {
  return new pg.Pool({
    connectionString,
    connectionTimeoutMillis: poolOpts.connectionTimeoutMillis ?? 20000,
    query_timeout: poolOpts.query_timeout ?? 120000,
    ...poolOpts,
  });
}
