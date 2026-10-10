import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const output = path.resolve('.local-diagnostic');
fs.mkdirSync(output, { recursive: true });
const results = [];
function run(label, file, env = {}) {
  console.log(`::group::${label}`);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', file], {
    env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: 650000, windowsHide: true
  });
  const stdout = result.stdout || '', stderr = result.stderr || '';
  process.stdout.write(stdout); process.stderr.write(stderr);
  fs.writeFileSync(path.join(output, label + '.log'), stdout + '\n' + stderr);
  results.push({ label, file, status: result.status, signal: result.signal,
    error: result.error?.code, elapsedMs: Date.now() - startedAt });
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`::endgroup::`);
}
run('helper-baseline', 'test/nativeHelperShutdown.test.js');
run('helper-system32-path-control', 'test/nativeHelperShutdown.test.js', { CODEX_TEST_HELPER_SYSTEM_TOOLS: '1' });
const remaining = fs.readdirSync('test').filter(name => name.endsWith('.test.js')
  && name.localeCompare('nativeHelperShutdown.test.js') > 0).sort((a, b) => a.localeCompare(b));
for (const name of remaining) run(name.replace(/\.test\.js$/, ''), 'test/' + name);
const failed = results.filter(result => result.status !== 0);
console.log(JSON.stringify({ diagnosticOnly: true, files: results.length, failed }, null, 2));
// Diagnostic runs preserve every failure and cannot serve as release gates.
process.exitCode = failed.length ? 1 : 0;
