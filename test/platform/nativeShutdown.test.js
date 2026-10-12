'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { decodeFrames } = require('../../native-host/src/nativeMessaging');
const repo = path.resolve(__dirname, '../..'), helper = path.join(__dirname, '../fixtures/native-helper-shutdown/helper.cjs');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(fn, ms = 7000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('condition timeout'); await sleep(10); } }
test('Host disconnect stops its helper without cancelling unrelated work', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-helper-shutdown-'));
  let child, pid, exited = false, cancelResponse, output = Buffer.alloc(0);
  t.after(async () => { if (pid && alive(pid)) { process.kill(pid, 'SIGKILL'); await until(() => !alive(pid)).catch(() => {}); } if (child && !exited) child.kill('SIGKILL'); fs.rmSync(root, { recursive: true, force: true }); });
  const command = path.join(root, process.platform === 'win32' ? 'synthetic.cmd' : 'synthetic-codex');
  fs.writeFileSync(command, process.platform === 'win32' ? `@"${process.execPath}" "${helper}" %*\r\n` : `#!${process.execPath}\nrequire(${JSON.stringify(helper)});\n`, { mode: 0o755 });
  const userHome = path.join(root, 'user');fs.mkdirSync(userHome);
  const env = { HOME: root, USERPROFILE: root, TMPDIR: root, PATH: root, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
    CODEX_TEST_DISCONNECT_ROOT: root, CODEX_TEST_REPOSITORY_ROOT: repo,
    CODEX_OVERLEAF_ENV_READY: '1', CODEX_OVERLEAF_CODEX_PATH: command,
    CODEX_OVERLEAF_CODEX_HOME: path.join(root, 'plugin'), CODEX_OVERLEAF_USER_CODEX_HOME: userHome,
    CODEX_OVERLEAF_PROVIDER_STORE_DIR: path.join(root, 'providers'), CODEX_OVERLEAF_MIRROR_ROOT: path.join(root, 'mirrors'),
    CODEX_OVERLEAF_AGENT_FILE: process.execPath, CODEX_OVERLEAF_AGENT_ARGS_JSON: JSON.stringify([helper]) };
  child = spawn(process.execPath, ['--require', path.join(__dirname, '../fixtures/native-disconnect-settlement/host-preload.cjs'), path.join(repo, 'native-host/src/index.js')], { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('exit', () => { exited = true; });child.stderr.resume();child.stdin.on('error', () => {});
  child.stdout.on('data', chunk => {
    const decoded = decodeFrames(Buffer.concat([output, chunk]));
    output = decoded.remainder;
    for (const message of decoded.messages) {
      if (message.id === 'cancel' && !message.event) cancelResponse = message;
    }
  });
  const request = { id: 'task', method: 'task.run', params: { mode: 'ask' } };
  const payload = Buffer.from(JSON.stringify(request)), header = Buffer.alloc(4);header.writeUInt32LE(payload.length);child.stdin.write(Buffer.concat([header, payload]));
  await until(() => fs.existsSync(path.join(root, 'heartbeat')) || exited);assert.equal(exited, false);
  pid = JSON.parse(fs.readFileSync(path.join(root, 'helper-pid.json'))).pid;
  // Ordinary run cancellation must not become global helper cancellation.
  const cancel = Buffer.from(JSON.stringify({ id: 'cancel', method: 'codex.cancel', params: { projectKey: 'unrelated', force: true } }));header.writeUInt32LE(cancel.length);child.stdin.write(Buffer.concat([header, cancel]));
  await until(() => cancelResponse || exited);
  assert.equal(cancelResponse?.ok, true, 'Native must acknowledge the unrelated cancel');
  assert.equal(alive(pid), true, 'acknowledged unrelated cancellation must leave the helper alive');
  child.stdin.end();await until(() => exited);assert.equal(alive(pid), false, 'helper must be gone when Host reports exit');
  const stopEvents = fs.readFileSync(path.join(root, 'stop.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const hostExit = JSON.parse(fs.readFileSync(path.join(root, 'host-exit.jsonl'), 'utf8').trim());
  assert.equal(stopEvents.some(event => event.event === 'rejected'), false, 'Host exit cannot substitute for a successful explicit stop');
  assert.ok(stopEvents.some(event => event.event === 'resolved' && event.at <= hostExit.at), 'owned stop must finish before Host exit');
  const bytes = fs.statSync(path.join(root, 'heartbeat')).size;await sleep(80);assert.equal(fs.statSync(path.join(root, 'heartbeat')).size, bytes);
});
