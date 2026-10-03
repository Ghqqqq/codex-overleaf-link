'use strict';

// Synthetic stdio peer: all files, processes and Codex homes belong to the test.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const fixtureRoot = process.env.CODEX_TEST_TERMINAL_ROOT;
if (!fixtureRoot || !path.isAbsolute(fixtureRoot)) throw new Error('Missing isolated fixture root');
fs.appendFileSync(path.join(fixtureRoot, 'pids.jsonl'), `${process.pid}\n`);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const threadId = 'terminal-thread';
const turnId = 'terminal-turn';
let workspacePath = '';
let watcher = null;
const guard = setTimeout(() => process.exit(92), 10000);
const terminal = fields => send({ method: 'turn/completed', params: {
  threadId, turn: { id: turnId, ...fields }
} });

function finishWorker() {
  fs.writeFileSync(path.join(workspacePath, 'main.tex'), 'Synthetic worker edit.\n');
  send({ method: 'item/completed', params: { threadId, turnId,
    item: { id: 'answer', type: 'agentMessage', text: 'Synthetic answer.' }
  } });
  if (process.env.CODEX_TEST_TERMINAL_EXPLICIT_ERROR === '1') {
    send({ method: 'error', params: { threadId, turnId, error: { message: process.env.CODEX_TEST_TERMINAL_ERROR_MESSAGE } } });
  }
  terminal(JSON.parse(process.env.CODEX_TEST_TERMINAL_FIELDS));
}

function startParent() {
  const queueRoot = path.join(workspacePath, '.codex-overleaf-subagents');
  const receipt = path.join(queueRoot, 'results', 'terminal-worker.json');
  const maybeFinish = () => {
    if (!fs.existsSync(receipt)) return;
    watcher?.close();
    watcher = null;
    // The broker's atomic receipt is the completion barrier, never a delay.
    JSON.parse(fs.readFileSync(receipt, 'utf8'));
    terminal({ status: 'completed' });
  };
  watcher = fs.watch(path.dirname(receipt), maybeFinish);
  const job = { id: 'terminal-worker', task: 'Synthetic worker: edit the owned file', files: ['main.tex'] };
  const temporary = path.join(queueRoot, 'jobs', '.tmp-worker');
  fs.writeFileSync(temporary, JSON.stringify(job));
  fs.renameSync(temporary, path.join(queueRoot, 'jobs', 'terminal-worker.json'));
  maybeFinish();
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) return;
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    workspacePath = message.params.cwd;
    const relative = path.relative(fixtureRoot, workspacePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Workspace outside fixture');
    send({ id: message.id, result: { thread: { id: threadId } } });
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    if (process.env.CODEX_TEST_TERMINAL_MODE === 'abort') return;
    if (process.env.CODEX_TEST_TERMINAL_MODE === 'broker' && JSON.stringify(message.params.input).includes('SYNTHETIC_TERMINAL_PARENT')) startParent();
    else finishWorker();
  } else if (message.method === 'skills/list') {
    send({ id: message.id, result: { data: [] } });
  } else {
    send({ id: message.id, result: {} });
  }
});
process.on('SIGTERM', () => {
  watcher?.close();
  clearTimeout(guard);
  process.exit(0);
});
