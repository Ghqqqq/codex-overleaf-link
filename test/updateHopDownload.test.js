const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('release asset download retries transient network failures', async () => {
  const { downloadReleaseAsset } = await import(
    '../scripts/update-hop-download.mjs'
  );
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-overleaf-update-download-'),
  );
  const target = path.join(tempRoot, 'asset.zip');
  let attempts = 0;

  try {
    await downloadReleaseAsset('v2.2.1', 'asset.zip', target, {
      delayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error('socket reset');
          error.code = 'ECONNRESET';
          throw error;
        }
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from('release asset'),
        };
      },
    });

    assert.equal(attempts, 3);
    assert.equal(fs.readFileSync(target, 'utf8'), 'release asset');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('release asset download does not retry deterministic client errors', async () => {
  const { downloadReleaseAsset } = await import(
    '../scripts/update-hop-download.mjs'
  );
  let attempts = 0;

  await assert.rejects(
    downloadReleaseAsset('v2.2.1', 'missing.zip', '/unused', {
      delayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        return {
          ok: false,
          status: 404,
          arrayBuffer: async () => Buffer.alloc(0),
        };
      },
    }),
    /HTTP 404/,
  );
  assert.equal(attempts, 1);
});
