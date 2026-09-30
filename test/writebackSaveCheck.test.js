'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Controller = require('../extension/src/content/writebackController');
const Intent = require('../extension/src/shared/writebackIntent');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const owner = { projectId: 'example', accountScopeId: 'account', sessionId: 'session', runId: 'run' };
const binary = Buffer.from([0, 255, 128, 13, 10, 1]);
const snapshot = files => ({ id: owner.projectId, files,
  capabilities: { fullProjectSnapshot: true, method: 'overleaf-zip', skipped: [] } });
const savedBinary = () => ({ path: 'figure.png', kind: 'binary', source: 'overleaf-zip', contentBase64: binary.toString('base64') });
const binaryCheck = () => ({ ...owner, files: [{ path: 'figure.png', sha256: digest(binary), kind: 'binary' }] });
const confirm = (check, readSnapshot) => Controller.confirmSaveCheck(check, { assertCurrent() {}, readSnapshot });

test('binary save checks hash actual server bytes and survive persistence', async () => {
  const check = await Controller.buildSaveCheck({ applied: [{ operation: {
    type: 'binary-create', path: 'figure.png', sha256: digest(binary)
  }, result: { ok: true } }] }, {}, owner);
  assert.equal(check.files[0].kind, 'binary');
  const restored = Intent.normalizeSaveCheck(JSON.parse(JSON.stringify(check)));
  assert.equal(restored.files[0].kind, 'binary');
  const requests = [];
  const result = await confirm(restored, async params => { requests.push(params); return snapshot([savedBinary()]); });
  assert.equal(result.state, 'verified_saved');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].serverOnly, true);
  assert.equal(requests[0].includeBinaryFiles, true);
  assert.equal(requests[0].allowEditorNavigation, false);
});

test('legacy digest-only binary checks remain recoverable', async () => {
  const check = binaryCheck();
  delete check.files[0].kind;
  assert.equal((await confirm(Intent.normalizeSaveCheck(check), async () => snapshot([savedBinary()]))).ok, true);
});

test('inline binary uploads can create durable checks without retaining their payload', async () => {
  const check = await Controller.buildSaveCheck({ applied: [{ operation: {
    type: 'overwrite-binary', path: 'figure.png', contentBase64: binary.toString('base64')
  }, result: { ok: true } }] }, {}, owner);
  assert.equal(check.files[0].sha256, digest(binary));
  assert.equal(JSON.stringify(check).includes('contentBase64'), false);
});

test('empty text and empty binary files are valid distinct save-check inputs', async () => {
  for (const kind of ['text', 'binary']) {
    const operation = kind === 'text' ? { type: 'create', path: 'empty.tex', content: '' }
      : { type: 'binary-create', path: 'empty.bin', contentBase64: '', size: 0 };
    const check = await Controller.buildSaveCheck({ applied: [{ operation, result: { ok: true } }] }, {}, owner);
    assert.equal(check.files[0].sha256, digest(Buffer.alloc(0)));
    assert.equal(check.files[0].kind, kind);
    const file = { path: operation.path, kind, source: 'overleaf-zip',
      ...(kind === 'text' ? { content: '' } : { contentBase64: '' }) };
    assert.equal((await confirm(check, async () => snapshot([file]))).ok, true);
  }
});

for (const [name, read] of [
  ['different server bytes', () => snapshot([{ ...savedBinary(), contentBase64: 'AA==' }])],
  ['missing binary bytes', () => snapshot([{ path: 'figure.png', source: 'overleaf-zip', sha256: digest(binary) }])],
  ['malformed base64', () => snapshot([{ ...savedBinary(), contentBase64: '%%%' }])],
  ['editor-derived content', () => snapshot([{ ...savedBinary(), source: 'active-editor' }])],
  ['another project', () => ({ ...snapshot([savedBinary()]), id: 'other' })],
  ['partial snapshot', () => ({ ...snapshot([savedBinary()]), capabilities: { method: 'overleaf-zip', fullProjectSnapshot: false } })],
  ['failed snapshot with otherwise matching bytes', () => ({ ...snapshot([savedBinary()]), ok: false })],
  ['missing files array', () => ({ ...snapshot([]), files: undefined })]
]) {
  test('save checks do not accept ' + name, async () => {
    let reads = 0;
    const result = await confirm(binaryCheck(), async () => { reads++; return read(); });
    assert.equal(result.ok, false);
    assert.equal(reads, 3);
  });
}

test('text expectations cannot be confirmed with a same-hash binary representation', async () => {
  const check = { ...owner, files: [{ path: 'empty.tex', kind: 'text', sha256: digest('') }] };
  assert.equal((await confirm(check, async () => snapshot([{ path: 'empty.tex', source: 'overleaf-zip', contentBase64: '' }]))).ok, false);
});

test('read-only save checks recover transient reads without dispatching writes', async () => {
  let reads = 0;
  const result = await confirm(binaryCheck(), async () => {
    if (++reads === 1) throw new Error('Temporary connection loss');
    return snapshot([savedBinary()]);
  });
  assert.equal(result.ok, true);
  assert.equal(reads, 2);
});

for (const code of ['codex_cancelled', 'aborted_project_changed']) {
  test(code + ' interrupts a save check without retry', async () => {
    let reads = 0;
    await assert.rejects(confirm(binaryCheck(), async () => {
      reads++;
      throw Object.assign(new Error(code), { code });
    }), { code });
    assert.equal(reads, 1);
  });
}

test('cancellation after a matching response cannot confirm saving', async () => {
  let current = true, reads = 0;
  await assert.rejects(Controller.confirmSaveCheck(binaryCheck(), {
    assertCurrent() { if (!current) throw Object.assign(new Error('cancelled'), { code: 'codex_cancelled' }); },
    async readSnapshot() { reads++; current = false; return snapshot([savedBinary()]); }
  }), { code: 'codex_cancelled' });
  assert.equal(reads, 1);
});

test('save-check retries share one total deadline', async () => {
  let time = 0;
  const requests = [];
  const result = await Controller.confirmSaveCheck(binaryCheck(), {
    now: () => time, assertCurrent() {},
    async readSnapshot(params) { requests.push(params); time += params.zipTimeoutMs; throw new Error('timeout'); }
  });
  assert.equal(result.ok, false);
  assert.equal(time, 90000);
  assert.equal(requests.length, 3);
});

test('an empty expected set is never treated as proof of saving', async () => {
  const result = await confirm({ ...owner, files: [] }, () => { throw new Error('No snapshot should be read'); });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expected_content_unavailable');
});

test('skipped ZIP entries prevent an absence claim', async () => {
  const check = { ...owner, files: [{ path: 'removed.bin', absent: true }] };
  const incomplete = snapshot([]);
  incomplete.capabilities.skipped = [{ path: 'removed.bin', reason: 'binary_file_too_large' }];
  assert.equal((await confirm(check, async () => incomplete)).ok, false);
  assert.equal((await confirm(check, async () => snapshot([]))).ok, true);
});

test('stored save checks reject unknown file kinds', () => {
  const check = binaryCheck();
  check.files[0].kind = 'remote';
  assert.equal(Intent.normalizeSaveCheck(check), null);
});
