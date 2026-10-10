'use strict';

// Synthetic app-server. This process never spawns children or accesses a real
// account/provider. A parent-created latch is required for every late write.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = process.env.CODEX_TEST_EXIT_ROOT;
const mode = process.env.CODEX_TEST_EXIT_MODE;
if (!root || !path.isAbsolute(root)) throw new Error('Missing isolated fixture root');
const rootReal = fs.realpathSync(root);
const write = (name, value) => {
  const temporary = path.join(root, '.tmp-' + name);
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, path.join(root, name));
};
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const threadId = 'synthetic-exit-thread', turnId = 'synthetic-exit-turn';
let workspace, termSeen = false, lateWritten = false;
let watcher;
const guard = setTimeout(() => exit(92, 'fixture-self-exit-limit'), 8000);
write('peer.json', { pid: process.pid, mode, root: rootReal });

function exit(code, reason) {
  watcher?.close(); clearTimeout(guard);
  write('exit-intent.json', { pid: process.pid, code, reason });
  process.exit(code);
}
function inside(candidate) {
  const relative = path.relative(rootReal, fs.realpathSync(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function checkLatches() {
  if (fs.existsSync(path.join(root, 'shutdown.json'))) return exit(0, 'explicit-cleanup-latch');
  if (mode !== 'hold-success' || !termSeen || lateWritten || !workspace
    || !fs.existsSync(path.join(root, 'write-after-result.json'))) return;
  const latch = JSON.parse(fs.readFileSync(path.join(root, 'write-after-result.json'), 'utf8'));
  if (latch.pid !== process.pid || latch.nativeResultReceived !== true) throw new Error('Invalid late-write latch');
  if (!inside(workspace)) throw new Error('Late-write workspace escaped temporary fixture');
  const content = 'Late synthetic output after Native result.\n';
  fs.writeFileSync(path.join(workspace, 'main.tex'), content);
  lateWritten = true;
  write('late-write.json', { pid: process.pid, content, nativeResultReceived: true });
}
// Expand Windows TEMP's 8.3 aliases before libuv compares event paths.
watcher = fs.watch(fs.realpathSync.native(root), checkLatches);
process.on('SIGTERM', () => {
  termSeen = true;
  write('sigterm-received.json', { pid: process.pid });
  if (mode === 'hold-success') checkLatches();
  else exit(0, 'sigterm-normal-exit');
});

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) return;
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    workspace = message.params.cwd;
    if (!inside(workspace)) throw new Error('Workspace escaped temporary fixture');
    write('workspace.json', { pid: process.pid, workspace });
    send({ id: message.id, result: { thread: { id: threadId } } });
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    const content = 'Stable synthetic output before completion.\n';
    fs.writeFileSync(path.join(workspace, 'main.tex'), content);
    write('initial-write.json', { pid: process.pid, content });
    const turn = { id: turnId, status: mode === 'failed' ? 'failed' : 'completed', items: [
      { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Synthetic final answer.' }
    ] };
    if (mode === 'failed') turn.error = { message: 'Synthetic terminal failure' };
    send({ method: 'turn/completed', params: { threadId, turn } });
  } else if (message.method === 'skills/list') {
    send({ id: message.id, result: { data: [] } });
  } else {
    send({ id: message.id, result: {} });
  }
});
