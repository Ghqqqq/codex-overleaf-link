'use strict';

// This owned fixture never spawns other processes or accesses network/accounts.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = process.env.CODEX_TEST_DISCONNECT_ROOT;
const mode = process.env.CODEX_TEST_DISCONNECT_MODE;
if (!root || !path.isAbsolute(root)) throw new Error('Missing fixture root');
const realRoot = fs.realpathSync(root);
const record = (name, value) => {
  const temp = path.join(root, '.peer-' + name);
  fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, at: Date.now(), ...value }));
  fs.renameSync(temp, path.join(root, name));
};
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const threadId = 'disconnect-test-thread', turnId = 'disconnect-test-turn';
let workspace, interrupted = false, failed = false, lateWritten = false;
let watcher;
const guard = setTimeout(() => exit(92, 'self-exit-limit'), 10000);
record('peer.json', { root: realRoot, mode });
function exit(code, reason) {
  watcher?.close(); clearTimeout(guard);
  record('peer-exit.json', { code, reason });
  process.exit(code);
}
function inside(candidate) {
  const relative = path.relative(realRoot, fs.realpathSync(candidate));
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function check() {
  if (fs.existsSync(path.join(root, 'shutdown.json'))) return exit(0, 'owned-cleanup');
  if (workspace && mode === 'connected-failure' && !failed && fs.existsSync(path.join(root, 'fail-now.json'))) {
    failed = true;
    send({ method: 'turn/completed', params: { threadId, turn: {
      id: turnId, status: 'failed', error: { message: 'Synthetic failure for stop control' }, items: []
    } } });
  }
  if (!workspace || !['ignore-disconnect', 'stalled-stop'].includes(mode) || !interrupted || lateWritten
    || !fs.existsSync(path.join(root, 'write-after-host-exit.json'))) return;
  const gate = JSON.parse(fs.readFileSync(path.join(root, 'write-after-host-exit.json'), 'utf8'));
  if (gate.pid !== process.pid || gate.hostExited !== true || !inside(workspace)) throw new Error('Invalid owned causal latch');
  const content = 'Synthetic writer still active after Native Host exited.\n';
  fs.writeFileSync(path.join(workspace, 'main.tex'), content);
  lateWritten = true;
  record('late-write.json', { content, hostExited: true, hostPid: gate.hostPid });
}
watcher = fs.watch(root, check);
process.on('SIGTERM', () => {
  record('term.json', {});
  if (mode === 'cooperative-disconnect') exit(0, 'cooperative-term');
});
process.stdin.on('end', () => record('peer-stdin-end.json', {}));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) return;
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    workspace = message.params.cwd;
    if (!inside(workspace)) throw new Error('Workspace outside isolated root');
    record('workspace.json', { workspace });
    send({ id: message.id, result: { thread: { id: threadId } } });
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    record('turn-started.json', {});
    check();
  } else if (message.method === 'turn/interrupt') {
    interrupted = true;
    record('interrupt.json', { threadId: message.params.threadId, turnId: message.params.turnId });
    if (mode === 'cooperative-disconnect') send({ id: message.id, result: {} });
    check();
  } else if (message.method === 'skills/list') send({ id: message.id, result: { data: [] } });
  else send({ id: message.id, result: {} });
});
