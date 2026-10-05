'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { rebaseCodexConfigPaths } = require('../native-host/src/codexConfigPaths');

test('relocated config preserves canonical anchors of root, table, inline and array paths', () => {
  const anchor = path.resolve('synthetic-canonical');
  const cases = [
    ['sqlite_home = "../database"\n', 'sqlite_home = ' + JSON.stringify(path.resolve(anchor, '../database')) + '\n'],
    ["model_catalog_json = 'models.json' # keep\n", 'model_catalog_json = ' + JSON.stringify(path.join(anchor, 'models.json')) + ' # keep\n'],
    ['"model_instructions_file"="instructions.txt"\n', '"model_instructions_file"=' + JSON.stringify(path.join(anchor, 'instructions.txt')) + '\n'],
    ['[profiles.quick]\nexperimental_compact_prompt_file="compact.md"\n', '[profiles.quick]\nexperimental_compact_prompt_file=' + JSON.stringify(path.join(anchor, 'compact.md')) + '\n'],
    ['agents.worker={config_file="worker.toml",description="keep"}\n', 'agents.worker={config_file=' + JSON.stringify(path.join(anchor, 'worker.toml')) + ',description="keep"}\n'],
    ['[[skills.config]]\npath="my-skill/SKILL.md"\nenabled=false\n', '[[skills.config]]\npath=' + JSON.stringify(path.join(anchor, 'my-skill/SKILL.md')) + '\nenabled=false\n'],
    ['sandbox_workspace_write={writable_roots=["../work", "./cache"]}\n', 'sandbox_workspace_write={writable_roots=[' + JSON.stringify(path.resolve(anchor, '../work')) + ', ' + JSON.stringify(path.join(anchor, 'cache')) + ']}\n'],
    ['[model_providers.example.auth]\ncwd="auth-helper"\n', '[model_providers.example.auth]\ncwd=' + JSON.stringify(path.join(anchor, 'auth-helper')) + '\n'],
    ['[otel.exporter."otlp-http".tls]\nca-certificate="ca.pem"\n', '[otel.exporter."otlp-http".tls]\nca-certificate=' + JSON.stringify(path.join(anchor, 'ca.pem')) + '\n']
  ];
  for (const [input, expected] of cases) assert.equal(rebaseCodexConfigPaths(input, anchor), expected);
});

test('unselected values, absolute paths, comments and literal dotted keys retain their text', () => {
  const source = '# original\nmodel="model/name"\nmodel_catalog_json=' + JSON.stringify(path.resolve('models.json')) + '\n"profiles.quick.model_instructions_file"="literal key"\n"skills.config.path"="literal path"\n"sandbox_workspace_write.writable_roots"=["literal root"]\n[model_providers.example]\nbase_url="https://example.invalid/v1"\n';
  assert.equal(rebaseCodexConfigPaths(source, path.resolve('elsewhere')), source);
});

test('tilde paths keep the CLI home expansion independent of the config directory', () => {
  const input = 'sqlite_home="~/.state"\nmodel_instructions_file="~/instructions.md"\n';
  assert.equal(rebaseCodexConfigPaths(input, path.resolve('synthetic-canonical')), input);
});

test('MCP legacy app-path cwd is retained rather than treated as a config-layer absolute path', () => {
  const input = '[mcp_servers.example]\ncwd="server"\nenabled=false\n';
  assert.equal(rebaseCodexConfigPaths(input, path.resolve('synthetic-canonical')), input);
});

test('escaped and multiline path strings retain their decoded meaning', () => {
  const anchor = path.resolve('synthetic-canonical');
  assert.equal(rebaseCodexConfigPaths('model_instructions_file="notes\\u002emd"\n', anchor), 'model_instructions_file=' + JSON.stringify(path.join(anchor, 'notes.md')) + '\n');
  assert.equal(rebaseCodexConfigPaths('model_instructions_file="""\nnotes.md"""\n', anchor), 'model_instructions_file=' + JSON.stringify(path.join(anchor, 'notes.md')) + '\n');
});
