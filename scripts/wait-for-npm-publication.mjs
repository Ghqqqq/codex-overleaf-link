import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const PACKAGE_NAME = 'codex-overleaf-link';
const REGISTRY = 'https://registry.npmjs.org';

function integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export async function waitForNpmPublication({
  version,
  tarballPath,
  timeoutMs = 10 * 60 * 1000,
  requestTimeoutMs = 30 * 1000,
  initialDelayMs = 5 * 1000,
  maxDelayMs = 30 * 1000,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  now = () => performance.now(),
  log = console.log
} = {}) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('PACKAGE_VERSION must identify a stable numeric version.');
  }
  if (typeof tarballPath !== 'string' || !tarballPath) {
    throw new Error('LOCAL_TGZ must identify the verified release tarball.');
  }
  for (const [name, value] of Object.entries({ timeoutMs, requestTimeoutMs, initialDelayMs, maxDelayMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }

  const expectedIntegrity = integrity(readFileSync(tarballPath));
  const metadataUrl = `${REGISTRY}/${PACKAGE_NAME}/${version}`;
  const tarballUrl = `${REGISTRY}/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${version}.tgz`;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let delayMs = Math.min(initialDelayMs, maxDelayMs);
  let attempt = 0;
  let lastPending = 'public package metadata is not available yet';

  async function readRegistry(url, binary = false) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { pending: 'publication deadline reached' };
    const signal = AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, Math.ceil(remainingMs))));
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { 'Cache-Control': 'no-cache', Accept: binary ? 'application/octet-stream' : 'application/json' },
        signal,
        redirect: 'error'
      });
    } catch (error) {
      if (!(error instanceof TypeError) && !['AbortError', 'TimeoutError'].includes(error?.name)) throw error;
      return { pending: signal.aborted ? 'registry request timed out' : 'registry connection unavailable' };
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([404, 408, 425, 429].includes(response.status) || response.status >= 500) {
        return { pending: `registry returned HTTP ${response.status}` };
      }
      throw new Error(`Public npm verification failed with HTTP ${response.status}; check registry access before resuming.`);
    }
    try {
      return { value: binary ? Buffer.from(await response.arrayBuffer()) : await response.json() };
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError) && !['AbortError', 'TimeoutError'].includes(error?.name)) throw error;
      return { pending: 'registry response was incomplete or timed out' };
    }
  }

  while (now() < deadline) {
    attempt += 1;
    const metadata = await readRegistry(metadataUrl);
    if (metadata.pending) {
      lastPending = metadata.pending;
    } else {
      const pkg = metadata.value;
      if (pkg?.name !== PACKAGE_NAME || pkg?.version !== version) {
        throw new Error('Public npm package identity does not match the release.');
      }
      if (!pkg.dist?.integrity || !pkg.dist?.tarball) {
        lastPending = 'public package metadata is still incomplete';
      } else {
        if (pkg.dist.integrity !== expectedIntegrity) {
          throw new Error('Published npm integrity does not match the verified release tarball. Do not republish this version.');
        }
        if (pkg.dist.tarball !== tarballUrl) {
          throw new Error('Public npm tarball URL does not match the expected package and registry.');
        }
        const archive = await readRegistry(tarballUrl, true);
        if (archive.pending) {
          lastPending = `package tarball is not ready: ${archive.pending}`;
        } else {
          if (integrity(archive.value) !== expectedIntegrity) {
            throw new Error('Downloaded npm tarball does not match the verified release tarball. Do not republish this version.');
          }
          if (now() < deadline) {
            const elapsedMs = Math.ceil(now() - startedAt);
            log(`Verified ${PACKAGE_NAME}@${version}: public metadata and downloaded tarball match (${Math.ceil(elapsedMs / 1000)}s).`);
            return { version, integrity: expectedIntegrity, attempts: attempt, elapsedMs };
          }
          lastPending = 'public package verification exceeded the deadline';
        }
      }
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    const waitMs = Math.min(delayMs, remainingMs);
    log(`Waiting for npm processing, attempt ${attempt}: ${lastPending}. Retrying in ${Math.ceil(waitMs / 1000)}s; ${Math.ceil(remainingMs / 1000)}s remaining.`);
    await sleepImpl(waitMs);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }

  throw new Error(
    `Public npm verification for ${PACKAGE_NAME}@${version} timed out after ${Math.ceil(timeoutMs / 1000)}s: ${lastPending}. ` +
    'npm may already have accepted the upload. Keep the GitHub draft and original assets; inspect the public package before resuming. ' +
    'Do not republish the version, move its tag, or blindly rerun the upload workflow.'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await waitForNpmPublication({
      version: process.env.PACKAGE_VERSION,
      tarballPath: process.env.LOCAL_TGZ
    });
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `### npm publication verified\n\n${PACKAGE_NAME}@${result.version}: public metadata and downloaded tarball match the verified release artifact.\n`);
    }
  } catch (error) {
    console.error(error.message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `### npm publication needs attention\n\n${error.message}\n\nThe GitHub release remains a draft. No automatic republish is attempted.\n`);
    }
    process.exitCode = 1;
  }
}
