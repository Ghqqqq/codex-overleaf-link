'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const barrier = require('../native-host/src/processStopBarrier');
const { getApplyGate, applyStagedUpdate, scheduleStagedActivation } = require('../native-host/src/updateManager');

test('update safety gates reject a known stop barrier after current work counters clear', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-update-barrier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let stopped = false;
  barrier.record('finished-request', root, { processId: 123, isStopped: () => stopped });
  const file = path.join(root, 'finished-request', '.codex-stop-barrier.json');
  const bytes = fs.readFileSync(file);
  const options = { getWorkState: () => ({ projectLocks: 0, runControllers: 0,
    processStopBarriers: barrier.getBlockedProjectCount(root) }) };
  assert.equal(getApplyGate(options).idle, false);
  assert.ok(getApplyGate(options).blockers.includes('native_process_stop_unconfirmed'));
  assert.throws(() => applyStagedUpdate({}, {}, options), { code: 'update_native_busy' });
  assert.throws(() => scheduleStagedActivation({}, {}, options), { code: 'update_native_busy' });
  assert.deepEqual(fs.readFileSync(file), bytes, 'read-only update inventory does not rewrite project quarantine');
  stopped = true;
  assert.equal(getApplyGate(options).idle, true, 'positive owned exit evidence restores idle');
  assert.equal(barrier.isBlocked('finished-request', root), false);
});

test('stop-barrier inventory treats missing roots as empty and unreadable records as busy', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-update-barrier-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(barrier.getBlockedProjectCount(path.join(root, 'absent')), 0);
  fs.mkdirSync(path.join(root, 'project'));
  fs.writeFileSync(path.join(root, 'project', '.codex-stop-barrier.json'), '[null]');
  assert.equal(barrier.getBlockedProjectCount(root), 1);
  const obstruction = path.join(root, 'not-a-directory');
  fs.writeFileSync(obstruction, 'blocked');
  assert.equal(barrier.getBlockedProjectCount(obstruction), 1);
});
