'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  assert.deepEqual(process.argv.slice(2), ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-']);
  const configPath = path.join(process.env.CODEX_HOME, 'config.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  const values = new Map(config.trim().split(/\r?\n/).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator).trim(), JSON.parse(line.slice(separator + 1))];
  }));
  assert.equal(values.get('model'), process.env.CODEX_TEST_MODEL);
  assert.equal(values.get('model_providers.codex_overleaf_custom.name'), process.env.CODEX_TEST_PROVIDER);
  assert.equal(values.get('model_providers.codex_overleaf_custom.wire_api'), 'responses');
  assert.match(values.get('model_providers.codex_overleaf_custom.base_url'), /^http:\/\/127\.0\.0\.1:/);
  assert.equal(values.get('model_providers.codex_overleaf_custom.requires_openai_auth'), false);
  assert.ok(process.env[values.get('model_providers.codex_overleaf_custom.env_key')]);
  assert.equal(config.includes(process.env.CODEX_OVERLEAF_PROVIDER_API_KEY), false);
  assert.equal(config.includes('synthetic-provider-secret'), false);
  assert.equal(values.get('features.prefer_mxc'), process.platform === 'win32' ? true : undefined);
  assert.equal(values.has('windows.sandbox'), false, 'do not force an unsupported sandbox backend');
  assert.match(prompt, /Use the shell tool to read provider-step-one\.txt/);
  assert.match(prompt, /separate shell tool call/);
  const catalogPath = values.get('model_catalog_json');
  assert.equal(JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models[0].slug, process.env.CODEX_TEST_MODEL);
  if (process.platform !== 'win32') assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  fs.writeFileSync(process.env.CODEX_TEST_REPORT, JSON.stringify({
    pid: process.pid, home: process.env.CODEX_HOME, workspace: process.cwd(), catalogPath
  }));
  if (process.env.CODEX_TEST_WAIT === '1') {
    setInterval(() => {}, 1000);
    return;
  }
  const secondFile = fs.readFileSync('provider-step-one.txt', 'utf8').trim();
  process.stdout.write(fs.readFileSync(secondFile, 'utf8'));
});
