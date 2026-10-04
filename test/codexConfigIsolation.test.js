'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { preparePluginCodexHome } = require('../native-host/src/codexHome');

function prepare(config, options = {}, sameHome = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-isolation-'));
  const userHome = path.join(home, 'user-codex');
  const pluginHome = sameHome ? userHome : path.join(home, 'plugin-codex');
  try {
    fs.mkdirSync(userHome, { recursive: true });
    fs.writeFileSync(path.join(userHome, 'config.toml'), config);
    preparePluginCodexHome({ HOME: home, CODEX_OVERLEAF_USER_CODEX_HOME: userHome, CODEX_OVERLEAF_CODEX_HOME: pluginHome }, options);
    assert.equal(fs.readFileSync(path.join(userHome, 'config.toml'), 'utf8'), config, 'source config stays unchanged');
    return fs.readFileSync(path.join(pluginHome, 'config.toml'), 'utf8');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const prefix = '# Keep user comments\nmodel = "example-model"\n';
const suffix = 'model_reasoning_effort = "high"\n[features]\nmulti_agent = true\n[model_providers.example]\nbase_url = "https://example.invalid/v1"\n';
const cases = [
  ['multi-line array with comments', 'notify = [ # opening comment\n  "notify-tool", # closing characters here: ] }\n  "turn-ended",\n]\n'],
  ['quoted bracket, hash, equals and escape characters', String.raw`notify = [
  "[brackets] # text = data",
  "escaped quote: \" and backslash: \\",
  'literal ] # \\',
]
`],
  ['nested arrays and inline tables', 'notify = [\n  ["nested", ["]"]],\n  { arg = "# ]", nested = { value = "[" } },\n]\n'],
  ['multiline basic and literal strings', String.raw`notify = [
  """embedded configuration-looking text:
[features]
notify = [
escaped delimiter: \"""
still in the string""",
  '''literal configuration-looking text:
[plugins.example]
notify = [
still literal''',
]
`],
  ['four- and five-quote multiline endings', 'notify = [\n  """ends with a quote"""",\n  """ends with two quotes""""",\n  \'\'\'one quote\'\'\'\',\n  \'\'\'two quotes\'\'\'\'\',\n]\n'],
  ['empty array and trailing comment', 'notify = [\n  # empty command list\n] # closure\n'],
  ['double-quoted notify key', '"notify" = [\n "notify-tool",\n]\n'],
  ['literal-quoted notify key', "'notify' = [\n 'notify-tool',\n]\n"]
];

for (const [name, assignment] of cases) {
  test('isolated config removes the complete notify value: ' + name, () => {
    assert.equal(prepare(prefix + assignment + suffix, { loadCodexLocalSkills: false }), prefix + suffix);
  });
}

test('isolated config normalizes CRLF without consuming the following setting or section', () => {
  const config = (prefix + cases[0][1] + suffix).replace(/\n/g, '\r\n');
  assert.equal(prepare(config, { loadCodexLocalSkills: false }), prefix + suffix);
});

test('isolated config preserves unrelated multiline string contents and whitespace', () => {
  const preserved = String.raw`description = """Instructions with an escaped delimiter: \"""
personality = "quoted prose"
notify = [
[plugins.example]


last line"""
literal = '''
personality = "literal prose"
notify = [
[skills]
'''
`;
  assert.equal(prepare(prefix + preserved + cases[0][1] + suffix, { loadCodexLocalSkills: false }), prefix + preserved + suffix);
});

test('isolated config removes a selected section until a real following header, ignoring headers inside its multiline value', () => {
  const removed = '[plugins.example]\ndescription = """\n[features]\npretend = true\n"""\nenabled = true\n';
  const nextSection = '[features]\nmulti_agent = true\n';
  assert.equal(prepare(prefix + removed + nextSection, { loadCodexLocalSkills: false }), prefix + nextSection);
});

test('root notify and personality are distinct from identically named fields in retained tables', () => {
  const provider = '[model_providers."example]name"]\nnotify = [\n "provider-value",\n]\npersonality = "provider-personality"\n';
  const personality = '"personality" = """\nprivate value\n"""\n';
  assert.equal(prepare(prefix + personality + cases[0][1] + provider, { loadCodexLocalSkills: false }), prefix + provider);
});

test('skill isolation preserves ordinary single-line config and deletes only the selected assignment', () => {
  assert.equal(prepare(prefix + 'notify = ["notify-tool"] # trailing comment\n' + suffix, { loadCodexLocalSkills: false }), prefix + suffix);
});

test('enabled and default local-skill settings preserve multiline notify', () => {
  const config = prefix + cases[0][1] + suffix;
  assert.equal(prepare(config, { loadCodexLocalSkills: true }), config);
  assert.equal(prepare(config), config);
});

test('shared user and plugin home bypass config isolation without modifying its contents', () => {
  const config = prefix + cases[0][1] + suffix;
  assert.equal(prepare(config, { loadCodexLocalSkills: false }, true), config);
});

test('unselected config retains empty files, whitespace, and a missing final newline', () => {
  for (const config of ['', '\n\n# comment only\n\n', 'model = "example-model"']) {
    assert.equal(prepare(config, { loadCodexLocalSkills: false }), config);
  }
});

for (const [name, brokenValue] of [
  ['array', 'notify = [\n "command",\n'],
  ['string', 'notify = ["""unterminated\n'],
  ['mismatched container', 'notify = [{ arg = "value" ]\n']
]) {
  test('broken ' + name + ' aborts preparation without replacing an existing plugin config', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-broken-'));
    const userHome = path.join(home, 'user-codex');
    const pluginHome = path.join(home, 'plugin-codex');
    const original = 'model = "previous-plugin-config"\n';
    const input = prefix + brokenValue + '[features]\nmulti_agent = true\n';
    try {
      fs.mkdirSync(userHome, { recursive: true });
      fs.mkdirSync(pluginHome, { recursive: true });
      fs.writeFileSync(path.join(userHome, 'config.toml'), input);
      fs.writeFileSync(path.join(pluginHome, 'config.toml'), original);
      assert.throws(() => preparePluginCodexHome({ HOME: home,
        CODEX_OVERLEAF_USER_CODEX_HOME: userHome, CODEX_OVERLEAF_CODEX_HOME: pluginHome
      }, { loadCodexLocalSkills: false }), /unterminated or mismatched TOML value/);
      assert.equal(fs.readFileSync(path.join(userHome, 'config.toml'), 'utf8'), input);
      assert.equal(fs.readFileSync(path.join(pluginHome, 'config.toml'), 'utf8'), original);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
