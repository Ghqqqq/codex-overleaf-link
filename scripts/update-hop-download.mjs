import fs from 'node:fs';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

export async function downloadReleaseAsset(tag, name, target, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const repository = options.repository || 'Ghqqqq/codex-overleaf-link';
  const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!result.ok) {
        const error = new Error(
          `Unable to download ${name}: HTTP ${result.status}`,
        );
        error.retryable = isRetryableStatus(result.status);
        throw error;
      }

      const bytes = Buffer.from(await result.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_ASSET_BYTES) {
        const error = new Error(`Downloaded asset has an invalid size: ${name}`);
        error.retryable = false;
        throw error;
      }
      fs.writeFileSync(target, bytes);
      return;
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable !== false;
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }
      await wait(delayMs * attempt);
    }
  }

  throw lastError;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function wait(delayMs) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, delayMs));
}
