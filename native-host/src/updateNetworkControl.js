'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { updateError } = require('./updateTrust');
const controllers = new Map();
const validId = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(value || ''));
const marker = (context, id) => path.join(context.updatesRoot, 'cancel-' + id);

function assertActive(context, id) {
  if (!id) return;
  if (!validId(id)) throw updateError('update_operation_invalid', 'Update operation identity is invalid.');
  if (fs.existsSync(marker(context, id))) throw updateError('update_network_cancelled', 'This update operation was cancelled.');
}

async function run(context, id, action, callerSignal) {
  assertActive(context, id);
  // Retain cancellation tombstones beyond the lifetime of bounded requests.
  for (const name of fs.readdirSync(context.updatesRoot)) {
    if (!name.startsWith('cancel-') || !validId(name.slice(7))) continue;
    const file = path.join(context.updatesRoot, name);
    try { if (Date.now() - fs.statSync(file).mtimeMs > 86400000) fs.rmSync(file, { force: true }); } catch (_) {}
  }
  const key = context.updatesRoot + ':' + id;
  const controller = new AbortController();
  const entries = controllers.get(key) || new Set();
  entries.add(controller);
  controllers.set(key, entries);
  const abort = () => controller.abort(updateError('update_network_cancelled', 'This update operation was cancelled.'));
  const poll = setInterval(() => { if (fs.existsSync(marker(context, id))) abort(); }, 200);
  poll.unref?.();
  if (callerSignal?.aborted) abort();
  else callerSignal?.addEventListener('abort', abort, { once: true });
  try {
    assertActive(context, id);
    controller.signal.throwIfAborted();
    return await action(controller.signal);
  } finally {
    clearInterval(poll);
    callerSignal?.removeEventListener('abort', abort);
    entries.delete(controller);
    if (!entries.size) controllers.delete(key);
  }
}

function readLock(context) {
  try { return JSON.parse(fs.readFileSync(path.join(context.updatesRoot, 'mutation.lock'), 'utf8')); }
  catch (_) { return null; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function cancel(context, id) {
  if (!validId(id)) throw updateError('update_operation_invalid', 'Update operation identity is invalid.');
  // A marker also stops an operation queued in another host or delivered late.
  const descriptor = fs.openSync(marker(context, id), 'a', 0o600);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  for (const controller of controllers.get(context.updatesRoot + ':' + id) || []) {
    controller.abort(updateError('update_network_cancelled', 'This update operation was cancelled.'));
  }
  const deadline = Date.now() + 10000;
  while (true) {
    const lock = readLock(context);
    if (lock?.operationId !== id || !alive(Number(lock.pid))) return { operationId: id, state: 'cancelled' };
    if (Date.now() >= deadline) {
      throw updateError('update_cancel_unconfirmed', 'The download has been interrupted; update cleanup has not finished yet.');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

module.exports = { assertActive, run, cancel, readLock, validId };
