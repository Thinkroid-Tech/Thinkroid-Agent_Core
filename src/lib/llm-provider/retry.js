export const modelCallTimestamps = new Map();

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStatus(error) {
  return error?.status || error?.statusCode || error?.response?.status;
}

function getRetryAfterMs(error) {
  const retryAfterMs = error?.headers?.['retry-after-ms'] ?? error?.response?.headers?.['retry-after-ms'];
  if (retryAfterMs !== undefined && retryAfterMs !== null) {
    const milliseconds = Number.parseInt(retryAfterMs, 10);
    if (Number.isFinite(milliseconds)) {
      return Math.max(0, milliseconds);
    }
  }

  const retryAfter = error?.headers?.['retry-after'] ?? error?.response?.headers?.['retry-after'];
  if (!retryAfter) return null;

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const retryDate = Date.parse(retryAfter);
  if (Number.isFinite(retryDate)) {
    return Math.max(0, retryDate - Date.now());
  }

  return null;
}

function isRetryable(error) {
  const status = getStatus(error);
  return (
    status === 429 ||
    (status >= 500 && status < 600) ||
    error?.code === 'ECONNRESET' ||
    error?.code === 'ETIMEDOUT'
  );
}

export async function waitForRateLimit(model, {
  getRateLimit = () => 0,
  timestamps = modelCallTimestamps,
  label = 'ai',
} = {}) {
  const rpm = getRateLimit(model);
  if (!model || !rpm || rpm <= 0) return;

  if (!timestamps.has(model)) {
    timestamps.set(model, []);
  }

  const calls = timestamps.get(model);
  const windowMs = 60_000;
  const now = Date.now();
  while (calls.length > 0 && calls[0] <= now - windowMs) {
    calls.shift();
  }

  if (calls.length >= rpm) {
    const waitMs = calls[0] + windowMs - now + 100;
    if (waitMs > 0) {
      console.log(`[rate-limit] ${label} ${model} at ${rpm} RPM, waiting ${Math.round(waitMs / 1000)}s...`);
      await sleep(waitMs);
      return waitForRateLimit(model, { getRateLimit, timestamps, label });
    }
  }

  calls.push(Date.now());
}

export async function callWithRetry(fn, {
  maxRetries = 3,
  baseDelay = 2000,
  label = 'ai',
  model = '',
  getRateLimit,
  onRetry,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      if (model && typeof getRateLimit === 'function') {
        await waitForRateLimit(model, { getRateLimit, label });
      }
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === maxRetries) {
        throw error;
      }

      const status = getStatus(error) || error?.code;
      const retryAfterMs = getRetryAfterMs(error);
      const jitter = baseDelay > 0 ? Math.random() * baseDelay : 0;
      const delay = retryAfterMs ?? (baseDelay * (2 ** attempt) + jitter);

      if (typeof onRetry === 'function') {
        await onRetry({
          error,
          status,
          attempt: attempt + 1,
          maxRetries,
          delay,
          label,
          model,
        });
      }

      await sleep(delay);
    }
  }

  throw lastError;
}
