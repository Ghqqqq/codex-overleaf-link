'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only the install/uninstall script's explicit registry command is redirected.
// Other subprocesses, package installation and manifest I/O remain real.
function isolatedRegistryCommand(root, { manifestPath, initiallyRegistered = false }) {
  const commandPath = path.join(root, 'isolated-registry.cjs');
  const logPath = path.join(root, 'isolated-registry.jsonl');
  const statePath = path.join(root, 'isolated-registry-state.json');
  const registryKey = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.codex.overleaf';
  fs.writeFileSync(statePath, JSON.stringify({ registered: initiallyRegistered, manifestPath }));
  fs.writeFileSync(commandPath, [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    `const fixture = ${JSON.stringify({ registryKey, manifestPath, logPath, statePath })};`,
    'const args = process.argv.slice(2);',
    "assert.ok(['add', 'delete'].includes(args[0]), 'unexpected registry operation');",
    "const expected = args[0] === 'add'",
    "  ? ['add', fixture.registryKey, '/ve', '/t', 'REG_SZ', '/d', fixture.manifestPath, '/f']",
    "  : ['delete', fixture.registryKey, '/f'];",
    'assert.deepEqual(args, expected);',
    "const prior = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));",
    'assert.equal(prior.manifestPath, fixture.manifestPath);',
    "if (args[0] === 'delete') assert.equal(prior.registered, true, 'only the fixture registration may be deleted');",
    "fs.appendFileSync(fixture.logPath, JSON.stringify(args) + '\\n');",
    "fs.writeFileSync(fixture.statePath, JSON.stringify({ registered: args[0] === 'add', manifestPath: fixture.manifestPath }));",
    ''
  ].join('\n'));
  return {
    registryKey,
    env: { CODEX_OVERLEAF_REG_EXE: process.execPath, CODEX_OVERLEAF_REG_EXE_ARGS_JSON: JSON.stringify([commandPath]) },
    calls: () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    state: () => JSON.parse(fs.readFileSync(statePath, 'utf8'))
  };
}

module.exports = { isolatedRegistryCommand };
