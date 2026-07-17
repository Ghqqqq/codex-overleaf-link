const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildReadProgressRules,
  createReadProgressGuard,
  extractBoundedRange
} = require('../native-host/src/readProgressGuard');
const { runCodexAppServerSession } = require('../native-host/src/codexSessionRunner');

test('parses bounded sed and head reads without treating a broad cat as trustworthy coverage', () => {
  assert.deepEqual(extractBoundedRange("sed -n '274,497p' /tmp/project/main.tex"), {
    startLine: 274,
    endLine: 497,
    path: '/tmp/project/main.tex'
  });
  assert.deepEqual(extractBoundedRange('head -n 120 "sections/proof.tex"'), {
    startLine: 1,
    endLine: 120,
    path: 'sections/proof.tex'
  });
  assert.equal(extractBoundedRange('cat /tmp/project/main.tex'), null);
});

test('steers after consecutive high-overlap reads while allowing a long non-overlapping scan', () => {
  const workspacePath = '/tmp/project';
  const guard = createReadProgressGuard({ workspacePath });
  const ranges = [
    [274, 497],
    [500, 700],
    [700, 960],
    [958, 1245],
    [1243, 1600],
    [154, 275],
    [733, 822],
    [1361, 1540]
  ];
  const decisions = ranges.map(([start, end]) => guard.observe(readItem(
    `sed -n '${start},${end}p' ${workspacePath}/main.tex`,
    `${workspacePath}/main.tex`
  )));

  assert.equal(decisions.slice(0, -1).every(decision => decision.action === 'none'), true);
  assert.equal(decisions.at(-1).action, 'steer');
  assert.equal(decisions.at(-1).evidence.file, 'main.tex');
  assert.equal(decisions.at(-1).evidence.overlapRatio, 1);

  const cleanGuard = createReadProgressGuard({ workspacePath });
  for (let index = 0; index < 14; index += 1) {
    const start = index * 100 + 1;
    const decision = cleanGuard.observe(readItem(
      `sed -n '${start},${start + 99}p' ${workspacePath}/main.tex`,
      `${workspacePath}/main.tex`
    ));
    assert.equal(decision.action, 'none');
  }
});

test('aborts after a model ignores steering and repeats two more covered ranges', () => {
  const workspacePath = '/tmp/project';
  const guard = createReadProgressGuard({
    workspacePath,
    minReadCommands: 2,
    redundantStreak: 1,
    postSteerRedundantStreak: 2
  });
  guard.observe(readItem("sed -n '1,100p' /tmp/project/main.tex", '/tmp/project/main.tex'));
  assert.equal(
    guard.observe(readItem("sed -n '1,100p' /tmp/project/main.tex", '/tmp/project/main.tex')).action,
    'steer'
  );
  assert.equal(
    guard.observe(readItem("sed -n '1,100p' /tmp/project/main.tex", '/tmp/project/main.tex')).action,
    'none'
  );
  assert.equal(
    guard.observe(readItem("sed -n '1,100p' /tmp/project/main.tex", '/tmp/project/main.tex')).action,
    'abort'
  );
});

test('app-server runner steers a repeated-read turn and preserves its final answer', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-read-progress-'));
  const events = [];
  try {
    const fakeCodex = writeFakeCodexRepeatedReads(tempDir);
    const result = await Promise.race([
      runCodexAppServerSession({
        task: buildReadProgressRules(),
        mode: 'ask',
        workspacePath: tempDir,
        env: {
          CODEX_OVERLEAF_ENV_READY: '1',
          CODEX_OVERLEAF_CODEX_PATH: fakeCodex,
          PATH: process.env.PATH
        },
        emit: event => events.push(event)
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('read progress integration timed out')), 5000))
    ]);

    assert.equal(result.assistantMessage, 'Synthesized after the progress correction.');
    const steerEvent = events.find(event => event.type === 'codex.no_progress.steered');
    assert.ok(steerEvent);
    assert.equal(steerEvent.detail.file, 'main.tex');
    assert.equal(steerEvent.detail.guardAction, 'steer');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function readItem(command, filePath) {
  return {
    id: `command-${command}`,
    type: 'commandExecution',
    status: 'completed',
    command,
    cwd: path.dirname(filePath),
    commandActions: [{
      type: 'read',
      command,
      name: path.basename(filePath),
      path: filePath
    }]
  };
}

function writeFakeCodexRepeatedReads(tempDir) {
  const scriptPath = path.join(tempDir, 'fake-codex-read-progress.js');
  const projectFile = path.join(tempDir, 'main.tex');
  fs.writeFileSync(scriptPath, [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
    `const projectFile = ${JSON.stringify(projectFile)};`,
    "const ranges = [[274,497],[500,700],[700,960],[958,1245],[1243,1600],[154,275],[733,822],[1361,1540]];",
    "function item(start, end, index) {",
    "  const command = `sed -n '${start},${end}p' ${projectFile}`;",
    "  return { id: `cmd-${index}`, type: 'commandExecution', status: 'completed', command, cwd: require('node:path').dirname(projectFile), commandActions: [{ type: 'read', command, name: 'main.tex', path: projectFile }] };",
    "}",
    "rl.on('line', line => {",
    "  const message = JSON.parse(line);",
    "  if (message.id && message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
    "  if (message.method === 'initialized') return;",
    "  if (message.id && message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-1' } } }); return; }",
    "  if (message.id && message.method === 'turn/start') {",
    "    send({ id: message.id, result: { turn: { id: 'turn-1' } } });",
    "    send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });",
    "    ranges.forEach(([start, end], index) => send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: item(start, end, index) } }));",
    "    return;",
    "  }",
    "  if (message.id && message.method === 'turn/steer') {",
    "    if (!String(message.params?.input?.[0]?.text || '').includes('Stop issuing inspection commands')) process.exit(4);",
    "    send({ id: message.id, result: {} });",
    "    send({ method: 'item/agentMessage/delta', params: { itemId: 'msg-1', delta: 'Synthesized after the progress correction.' } });",
    "    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });",
    "  }",
    "});",
    "process.on('SIGTERM', () => process.exit(0));",
    ''
  ].join('\n'), 'utf8');
  if (process.platform === 'win32') {
    const commandPath = path.join(tempDir, 'codex.cmd');
    fs.writeFileSync(commandPath, ['@echo off', `"${process.execPath}" "${scriptPath}" %*`, ''].join('\r\n'));
    return commandPath;
  }
  const commandPath = path.join(tempDir, 'codex');
  fs.writeFileSync(commandPath, ['#!/usr/bin/env node', `require(${JSON.stringify(scriptPath)});`, ''].join('\n'));
  fs.chmodSync(commandPath, 0o755);
  return commandPath;
}
