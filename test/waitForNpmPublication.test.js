const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const scriptPath = path.resolve(__dirname, '../scripts/wait-for-npm-publication.mjs');
const version = '2.5.1';
const metadataUrl = `https://registry.npmjs.org/codex-overleaf-link/${version}`;
const tarballUrl = `https://registry.npmjs.org/codex-overleaf-link/-/codex-overleaf-link-${version}.tgz`;
const archive = Buffer.from('verified release artifact bytes');
const expectedIntegrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
const metadata = {
  name: 'codex-overleaf-link',
  version,
  dist: { integrity: expectedIntegrity, tarball: tarballUrl }
};

async function harness(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-publication-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tarballPath = path.join(dir, 'release.tgz');
  fs.writeFileSync(tarballPath, archive);
  const { waitForNpmPublication } = await import(pathToFileURL(scriptPath).href);
  let clock = 0;
  const waits = [];
  const logs = [];
  const requests = [];
  const options = {
    version,
    tarballPath,
    timeoutMs: 100,
    requestTimeoutMs: 30,
    initialDelayMs: 5,
    maxDelayMs: 12,
    now: () => clock,
    sleepImpl: async (ms) => { waits.push(ms); clock += ms; },
    log: (line) => logs.push(line),
    ...overrides
  };
  return {
    dir, waits, logs, requests,
    advance: (ms) => { clock += ms; },
    run: (fetchImpl, extra = {}) => waitForNpmPublication({
      ...options,
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return fetchImpl(url, init);
      },
      ...extra
    })
  };
}

function json(value) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

function sequence(values) {
  let index = 0;
  return async () => {
    assert.ok(index < values.length, 'unexpected extra registry request');
    const value = values[index++];
    if (value instanceof Error) throw value;
    return value;
  };
}

test('public verification waits for metadata and tarball, with one capped backoff schedule', async (t) => {
  const h = await harness(t);
  const result = await h.run(sequence([
    new Response('', { status: 404 }),
    json({ name: metadata.name, version }),
    json(metadata), new Response('', { status: 503 }),
    json(metadata), new Response(archive)
  ]));
  assert.deepEqual(result, { version, integrity: expectedIntegrity, attempts: 4, elapsedMs: 27 });
  assert.deepEqual(h.waits, [5, 10, 12]);
  assert.deepEqual(h.requests.map(({ url }) => url), [metadataUrl, metadataUrl, metadataUrl, tarballUrl, metadataUrl, tarballUrl]);
  for (const { init } of h.requests) {
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['Cache-Control'], 'no-cache');
    assert.equal(Object.keys(init.headers).some((key) => key.toLowerCase() === 'authorization'), false);
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test('temporary registry HTTP statuses retry and permanent HTTP statuses fail immediately', async (t) => {
  for (const status of [404, 408, 425, 429, 500, 503]) {
    await t.test(`HTTP ${status} retries`, async (t) => {
      const h = await harness(t);
      const result = await h.run(sequence([new Response('', { status }), json(metadata), new Response(archive)]));
      assert.equal(result.attempts, 2);
      assert.deepEqual(h.waits, [5]);
    });
  }
  for (const status of [301, 400, 401, 403]) {
    await t.test(`HTTP ${status} fails`, async (t) => {
      const h = await harness(t);
      await assert.rejects(h.run(sequence([new Response('', { status })])), new RegExp(`HTTP ${status}`));
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.waits, []);
    });
  }
});

test('connection failures, aborts and incomplete JSON can recover; unexpected errors fail immediately', async (t) => {
  const h = await harness(t);
  const result = await h.run(sequence([
    new TypeError('fetch failed'),
    new DOMException('aborted', 'AbortError'),
    new DOMException('request expired', 'TimeoutError'),
    new Response('{"name":'),
    json(metadata), new Response(archive)
  ]));
  assert.equal(result.attempts, 5);
  assert.deepEqual(h.waits, [5, 10, 12, 12]);
  const unexpected = new Error('unexpected fetch implementation failure');
  await assert.rejects(h.run(async () => { throw unexpected; }), (error) => error === unexpected);
});

test('identity, metadata integrity, URL and downloaded bytes must all match the verified artifact', async (t) => {
  const cases = [
    { name: 'package name', value: { ...metadata, name: 'another-package' }, error: /identity does not match/ },
    { name: 'package version', value: { ...metadata, version: '2.5.0' }, error: /identity does not match/ },
    { name: 'metadata integrity', value: { ...metadata, dist: { ...metadata.dist, integrity: 'sha512-wrong' } }, error: /integrity does not match.*Do not republish/ },
    { name: 'download registry', value: { ...metadata, dist: { ...metadata.dist, tarball: 'https://example.com/release.tgz' } }, error: /tarball URL does not match/ }
  ];
  for (const { name, value, error } of cases) {
    await t.test(name, async (t) => {
      const h = await harness(t);
      await assert.rejects(h.run(sequence([json(value)])), error);
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.waits, []);
    });
  }
  const h = await harness(t);
  await assert.rejects(h.run(sequence([json(metadata), new Response('different bytes')])), /Downloaded npm tarball does not match.*Do not republish/);
  assert.deepEqual(h.waits, []);
});

test('metadata and archive share the total deadline, including response-body completion', async (t) => {
  for (const phase of ['metadata', 'archive']) {
    await t.test(phase, async (t) => {
      const h = await harness(t);
      await assert.rejects(h.run(async (url) => {
        if (url === metadataUrl) {
          h.advance(phase === 'metadata' ? 101 : 80);
          return json(metadata);
        }
        h.advance(21);
        return new Response(archive);
      }), /timed out.*Keep the GitHub draft.*Do not republish/);
      assert.deepEqual(h.waits, []);
      assert.equal(h.requests.length, phase === 'metadata' ? 1 : 2);
    });
  }
});

test('the final retry delay is truncated to the remaining shared budget', async (t) => {
  const h = await harness(t, { timeoutMs: 21, initialDelayMs: 8, maxDelayMs: 10 });
  await assert.rejects(h.run(async () => new Response('', { status: 404 })), /timed out/);
  assert.deepEqual(h.waits, [8, 10, 3]);
  assert.equal(h.requests.length, 3);
});

test('real fetch aborts metadata and archive bodies that stall after response headers', async (t) => {
  for (const phase of ['metadata', 'archive']) {
    await t.test(phase, { timeout: 10000 }, async (t) => {
      const h = await harness(t);
      let stalledBodies = 0;
      const server = http.createServer((request, response) => {
        if (phase === 'archive' && !request.url.endsWith('.tgz')) {
          response.end(JSON.stringify(metadata));
          return;
        }
        stalledBodies += 1;
        response.writeHead(200);
        response.write(phase === 'metadata' ? '{"name":' : 'partial archive');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
      const origin = `http://127.0.0.1:${server.address().port}`;
      await assert.rejects(h.run((url, init) => fetch(`${origin}${new URL(url).pathname}`, init), {
        now: () => performance.now(),
        timeoutMs: 1500,
        requestTimeoutMs: 300,
        initialDelayMs: 5,
        maxDelayMs: 10,
        sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      }), /timed out.*Keep the GitHub draft/);
      assert.ok(stalledBodies >= 1);
    });
  }
});

test('invalid release inputs fail before any registry request', async (t) => {
  const h = await harness(t);
  for (const extra of [{ version: '2.5.1-rc.1' }, { tarballPath: '' }, { timeoutMs: 0 }, { requestTimeoutMs: -1 }, { initialDelayMs: 1.5 }, { maxDelayMs: NaN }]) {
    await assert.rejects(h.run(async () => { throw new Error('must not fetch'); }, extra), /must/);
  }
  assert.equal(h.requests.length, 0);
});

test('CLI failure exits nonzero and records that the prepared release remains a draft', async (t) => {
  const h = await harness(t);
  const summary = path.join(h.dir, 'summary.md');
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, PACKAGE_VERSION: 'invalid', LOCAL_TGZ: '', GITHUB_STEP_SUMMARY: summary }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PACKAGE_VERSION must identify a stable numeric version/);
  assert.match(fs.readFileSync(summary, 'utf8'), /GitHub release remains a draft.*No automatic republish is attempted/);
});
