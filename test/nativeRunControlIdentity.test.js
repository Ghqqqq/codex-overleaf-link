'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { nativeRunControlFixture } = require('./_helpers/nativeRunControlFixture');
for (const id of [0, 7, 'run-normal']) test('valid native ID keeps steer/cancel and live lock ownership: ' + JSON.stringify(id), async t => {
  const h = nativeRunControlFixture(t), pending = h.start(id); await h.entered;
  try {
    const steer = await h.handle({ id: 'steer-call', method: 'codex.steer', params: { requestId: id,
      threadId: 'thread-one', expectedTurnId: 'turn-one', text: 'Safe extra guidance' } });
    assert.equal(steer.ok, true); assert.equal(h.calls.steers.length, 1);
    const cancel = await h.handle({ id: 'cancel-call', method: 'codex.cancel', params: { requestId: id } });
    assert.equal(cancel.result.cancelled, true); assert.equal(cancel.result.requestId, id); assert.equal(h.calls.signal.aborted, true);
    const forced = await h.handle({ id: 'force-call', method: 'codex.cancel', params: { projectKey: 'project-one', force: true } });
    assert.equal(forced.result.cancelled, true); assert.notEqual(forced.result.lockReleased, true);
    const competing = await h.start('competing'); assert.equal(competing.error.code, 'project_locked');
  } finally { h.finish(); await pending; }
});
for (const id of [undefined, null, '', {}, false, Infinity]) test('invalid native run identity is rejected before execution: ' + String(id), async t => {
  const h = nativeRunControlFixture(t), pending = h.start(id); h.finish();
  const result = await pending; assert.equal(result.ok, false); assert.equal(result.error.code, 'native_request_id_invalid');
  assert.equal(h.calls.runs, 0);
  const next = await h.start('valid-after-invalid'); assert.equal(next.ok, true); assert.equal(h.calls.runs, 1);
});
test('zero ID supports project cancellation after page refresh', async t => {
  const h = nativeRunControlFixture(t), pending = h.start(0); await h.entered;
  try { const answer = await h.handle({ id: 'cancel-project', method: 'codex.cancel', params: { projectKey: 'project-one', force: true } });
    assert.equal(answer.result.cancelled, true); assert.equal(answer.result.requestId, 0); assert.notEqual(answer.result.lockReleased, true);
    assert.equal(h.calls.signal.aborted, true);
  } finally { h.finish(); await pending; }
});
