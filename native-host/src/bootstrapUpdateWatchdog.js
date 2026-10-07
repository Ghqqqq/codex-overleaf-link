'use strict';

// Independent of the browser worker being replaced. The Native update lock
// serializes timeout recovery with normal health confirmation.
const fs = require('node:fs');
const path = require('node:path');
const [nativeRoot, extensionRoot, transactionId, token] = process.argv.slice(2);
const { recoverBootstrapTransaction } = require('./updateManager');
if (typeof recoverBootstrapTransaction !== 'function') throw new Error('Bootstrap recovery entry is unavailable.');
const env = { ...process.env, CODEX_OVERLEAF_MANAGED: '1',
  CODEX_OVERLEAF_MANAGED_NATIVE_ROOT: nativeRoot, CODEX_OVERLEAF_MANAGED_EXTENSION_ROOT: extensionRoot };
let busy = false;
let failures = 0;
function heartbeat() {
  const directory = path.join(nativeRoot, 'updates', 'bootstrap-migrations', transactionId);
  const temporary = path.join(directory, 'watchdog-' + process.pid + '.tmp');
  fs.writeFileSync(temporary, JSON.stringify({ transactionId, token, pid: process.pid, at: Date.now() }), { mode: 0o600 });
  fs.renameSync(temporary, path.join(directory, 'watchdog.json'));
}
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(nativeRoot, 'updates', 'transaction.json'), 'utf8'));
    if (journal.id !== transactionId || journal.bootstrapMigration?.watchdogToken !== token
      || ['committed', 'superseded'].includes(journal.state)
      || journal.state === 'rolled_back' && !journal.sourceActivationPending) {
      clearInterval(timer); return;
    }
    heartbeat();
    if (journal.sourceActivationPending || journal.bootstrapMigration?.deadline && Date.now() >= journal.bootstrapMigration.deadline) {
      await recoverBootstrapTransaction({ env }, transactionId, token);
      clearInterval(timer);
    }
  } catch (_) {
    // Retry boundedly if a filesystem/lock is temporarily unavailable. Recovery
    // material remains durable for the next Native start or popup recovery probe.
    if (++failures >= 20) clearInterval(timer);
  } finally { busy = false; }
}, 500);
const initial = JSON.parse(fs.readFileSync(path.join(nativeRoot, 'updates', 'transaction.json'), 'utf8'));
if (initial.id !== transactionId || initial.bootstrapMigration?.watchdogToken !== token) throw new Error('Bootstrap recovery identity changed.');
heartbeat();
process.send?.({ type: 'ready', token, pid: process.pid });
