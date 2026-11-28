'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { handleRequest } = require('../native-host/src/taskRunnerRuntime');
const { getProjectMirror } = require('../native-host/src/mirrorWorkspace');
const WritingStyleRuntime = require('../native-host/src/writingStyleRuntime');
const {
  decideAntigravityPermission,
  isAntigravityAuthError,
  probeAntigravityCliVersion,
  selectPermissionOutcome
} = require('../native-host/src/antigravityRuntime');
const ContextUsage = require('../extension/src/shared/contextUsage');
const Compatibility = require('../extension/src/shared/compatibility');

const FAKE_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy', 'fake-agy.js');
if (process.platform !== 'win32') {
  fs.chmodSync(FAKE_AGY_BIN, 0o755);
}

function createTestHarness(t, overrides = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-agy-test-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const mirrorRoot = path.join(tempRoot, 'mirrors');
  const providerStoreDir = path.join(tempRoot, 'provider-store');
  const antigravityHome = path.join(tempRoot, 'agy-gemini-home');
  const stateFile = path.join(tempRoot, 'fake-agy-state.json');
  fs.mkdirSync(mirrorRoot, { recursive: true });
  fs.mkdirSync(providerStoreDir, { recursive: true });

  const env = {
    HOME: tempRoot,
    PATH: process.env.PATH || '/usr/bin:/bin',
    CODEX_OVERLEAF_ENV_READY: '1',
    CODEX_OVERLEAF_DISABLE_SHELL_ENV: '1',
    CODEX_OVERLEAF_CODEX_PATH: '',
    CODEX_OVERLEAF_CODEX_RUNTIME_JSON: JSON.stringify({
      schemaVersion: 1,
      selected: null,
      candidates: [],
      multipleInstallations: false,
      selectedBy: 'explicit-path'
    }),
    CODEX_OVERLEAF_MIRROR_ROOT: mirrorRoot,
    CODEX_OVERLEAF_PROVIDER_STORE_DIR: providerStoreDir,
    CODEX_OVERLEAF_ANTIGRAVITY_HOME: antigravityHome,
    CODEX_OVERLEAF_ANTIGRAVITY_BIN: FAKE_AGY_BIN,
    FAKE_AGY_STATE_FILE: stateFile,
    ...overrides
  };

  const readFakeState = () => (fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : {});

  return { tempRoot, mirrorRoot, providerStoreDir, antigravityHome, stateFile, env, readFakeState };
}

function buildFullProjectSnapshot(content = '\\documentclass{article}\n\\begin{document}\nOriginal text.\n\\end{document}\n') {
  return {
    id: 'proj-agy-1',
    projectId: 'proj-agy-1',
    activePath: 'main.tex',
    capabilities: {
      fullProjectSnapshot: true,
      pathIdentityComplete: true,
      contentComplete: true,
      method: 'overleaf-zip'
    },
    files: [
      {
        path: 'main.tex',
        kind: 'text',
        content
      }
    ]
  };
}

function seedVerifiedWritingStyleBundle({ tempRoot, accountScopeId, projectId }) {
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const styleRootBase = path.join(tempRoot, '.codex-overleaf', 'writing-styles');
  const projectStyleRoot = path.join(styleRootBase, sha(accountScopeId).slice(0, 32), projectId);
  const version = '11111111-2222-4333-8444-555555555555';
  const versionDir = path.join(projectStyleRoot, 'versions', version);
  fs.mkdirSync(path.join(versionDir, 'references'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(versionDir, 'corpus'), { recursive: true, mode: 0o700 });

  const files = {
    'SKILL.md': '# Project writing style\nRead references/writing-style.md for traits.\n',
    'references/writing-style.md': '## Trait 1\nConcise academic transitions.\n',
    'references/source-index.json': JSON.stringify({ documents: [] }),
    'corpus/source-1.txt': 'Sample corpus line.'
  };
  const hashes = {};
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(versionDir, rel);
    fs.writeFileSync(abs, text, { mode: 0o400 });
    hashes[rel] = sha(text);
  }
  const manifest = {
    schemaVersion: 1,
    evidenceVersion: 3,
    profileKind: 'expression-traits',
    version,
    accountHash: sha(accountScopeId),
    projectId,
    label: 'Seeded Style',
    createdAt: '2026-11-27T00:00:00.000Z',
    model: 'gemini-3.8-flash',
    reasoningEffort: 'low',
    sources: [],
    traits: [],
    sections: [],
    files: hashes
  };
  const rawManifest = JSON.stringify(manifest);
  fs.writeFileSync(path.join(versionDir, 'manifest.json'), rawManifest, { mode: 0o400 });
  fs.writeFileSync(
    path.join(projectStyleRoot, 'config.json'),
    JSON.stringify({ revision: 1, enabled: true, version }),
    { mode: 0o600 }
  );
  return {
    versionDir,
    skillFile: path.join(versionDir, 'SKILL.md'),
    snapshot: {
      accountScopeId,
      projectId,
      version,
      bundleHash: sha(rawManifest),
      label: 'Seeded Style'
    }
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

test('Ask mode rejects edits, emits permission decision, sets default mode explicitly, and leaves mirror unchanged', async t => {
  const outsideTarget = path.join(os.tmpdir(), `outside-ask-${process.pid}-${Date.now()}.txt`);
  t.after(() => fs.rmSync(outsideTarget, { force: true }));
  const { env, mirrorRoot, antigravityHome, readFakeState } = createTestHarness(t, {
    FAKE_AGY_SCENARIO: 'edit_and_boundary',
    FAKE_AGY_OUTSIDE_TARGET: outsideTarget
  });

  const originalContent = '\\documentclass{article}\n\\begin{document}\nKeep untouched in Ask.\n\\end{document}\n';
  const events = [];
  const response = await handleRequest({
    id: 'ask-1',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Inspect main.tex only.',
      project: buildFullProjectSnapshot(originalContent)
    }
  }, env, event => events.push(event));

  assert.equal(response.ok, true);
  assert.deepEqual(response.result.syncChanges, []);
  assert.match(response.result.threadId, /^agy:sess-/);
  assert.match(response.result.assistantMessage, /Read-only inspection completed/);

  const mirror = getProjectMirror('proj-agy-1', { rootDir: mirrorRoot });
  assert.equal(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), originalContent);
  assert.equal(fs.existsSync(outsideTarget), false);

  const state = readFakeState();
  assert.equal(state.invocations[0].geminiDir, antigravityHome);
  assert.deepEqual(state.permissionResults, {
    insideAllowed: false,
    outsideAllowed: false,
    reservedAllowed: false
  });
  assert.deepEqual(
    state.configUpdates.map(item => [item.configId, item.value]),
    [
      ['mode', 'default'],
      ['model', 'gemini-3.8-flash'],
      ['thought_level', 'low']
    ]
  );
  assert.match(state.prompts[0].prompt[0].text, /<developer_instructions>/);
  assert.match(state.prompts[0].prompt[0].text, /Prefer your built-in file read, list, and search tools/);
  assert.match(state.prompts[0].prompt[0].text, /\bfind\b/);
  assert.match(state.prompts[0].prompt[0].text, /not at all in Ask mode/);

  const approvalEvents = events.filter(event => event.type === 'codex.session.request');
  assert.equal(approvalEvents.length, 3);
  assert.ok(approvalEvents.every(event => event.detail.decision === 'decline'));

  const bound = events.find(event => event.type === 'codex.turn.bound');
  assert.ok(bound);
  const usageEvents = events
    .map(event => ContextUsage.fromEvent(event, {
      runId: 'run-1',
      threadId: bound.detail.threadId,
      turnId: bound.detail.turnId,
      providerId: 'antigravity',
      providerRevision: 0,
      model: 'gemini-3.8-flash'
    }))
    .filter(Boolean);
  assert.ok(usageEvents.length >= 1);
  assert.equal(usageEvents.at(-1).usedTokens, 3456);
  assert.equal(usageEvents.at(-1).contextWindow, 1048576);
});

test('Auto mode allows in-mirror edits and returns syncChanges while rejecting outside-mirror and attachment-dir edits', async t => {
  const { env, tempRoot, readFakeState } = createTestHarness(t, {
    FAKE_AGY_SCENARIO: 'edit_and_boundary'
  });
  const outsideTarget = path.join(tempRoot, 'outside-auto.txt');
  env.FAKE_AGY_OUTSIDE_TARGET = outsideTarget;

  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  const events = [];
  const response = await handleRequest({
    id: 'auto-1',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'auto',
      model: 'gemini-4-neon',
      reasoningEffort: 'xhigh',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Update main.tex based on the attached diagram.',
      attachments: [
        {
          name: 'diagram.png',
          mimeType: 'image/png',
          size: pngBytes.length,
          contentBase64: pngBytes.toString('base64')
        }
      ],
      project: buildFullProjectSnapshot()
    }
  }, env, event => events.push(event));

  assert.equal(response.ok, true);
  assert.equal(response.result.syncChanges.length, 1);
  assert.equal(response.result.syncChanges[0].path, 'main.tex');
  assert.equal(response.result.syncChanges[0].type, 'write');
  assert.match(response.result.syncChanges[0].content, /Updated by Antigravity/);
  assert.equal(fs.existsSync(outsideTarget), false);

  const state = readFakeState();
  assert.deepEqual(state.permissionResults, {
    insideAllowed: true,
    outsideAllowed: false,
    reservedAllowed: false
  });
  const imageBlocks = state.prompts[0].prompt.filter(block => block.type === 'image');
  assert.equal(imageBlocks.length, 1);
  assert.equal(imageBlocks[0].mimeType, 'image/png');
  assert.equal(imageBlocks[0].data, pngBytes.toString('base64'));

  const decisions = events
    .filter(event => event.type === 'codex.session.request')
    .map(event => event.detail.decision);
  assert.deepEqual(decisions, ['accept', 'decline', 'decline']);
});

test('Permission policy enforces command allowlist, mirror-only reads, and rejects unknown permission kinds', async t => {
  const { env, tempRoot, readFakeState } = createTestHarness(t, {
    FAKE_AGY_SCENARIO: 'permission_matrix'
  });
  const outsideFile = path.join(tempRoot, 'outside-secret.txt');
  fs.writeFileSync(outsideFile, 'secret\n', 'utf8');
  env.FAKE_AGY_OUTSIDE_TARGET = outsideFile;

  const askRes = await handleRequest({
    id: 'matrix-ask',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Run permission matrix in Ask mode.',
      project: buildFullProjectSnapshot()
    }
  }, env);
  assert.equal(askRes.ok, true);

  const autoRes = await handleRequest({
    id: 'matrix-auto',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'auto',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Run permission matrix in Auto mode.',
      project: buildFullProjectSnapshot()
    }
  }, env);
  assert.equal(autoRes.ok, true);

  const [askMatrix, autoMatrix] = readFakeState().matrix;
  const expectedMatrix = {
    rg_cmd: true,
    find_safe_cmd: true,
    find_name_cmd: true,
    find_exec_cmd: false,
    find_execdir_cmd: false,
    find_ok_cmd: false,
    find_okdir_cmd: false,
    find_delete_cmd: false,
    find_fprint_cmd: false,
    find_fprint0_cmd: false,
    find_fprintf_cmd: false,
    find_fls_cmd: false,
    find_outside_cmd: false,
    latexmk_cmd: false,
    redirect_cmd: false,
    rm_cmd: false,
    background_chain_cmd: false,
    newline_chain_cmd: false,
    output_file_cmd: false,
    path_executable_cmd: false,
    outside_path_cmd: false,
    read_inside: true,
    read_outside: false,
    fetch_unknown: false,
    mcp_unknown: false
  };
  assert.deepEqual(askMatrix, expectedMatrix);
  assert.deepEqual(autoMatrix, expectedMatrix);
});

test('Path boundary hardening checks workspace root + cwd, args/overflow, path-like keys, unsafe syntax, and case-insensitive reserved dirs', t => {
  const { tempRoot, env } = createTestHarness(t);
  const workspacePath = path.join(tempRoot, 'ws');
  const subDir = path.join(workspacePath, 'chapters');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, 'main.tex'), 'root\n', 'utf8');
  fs.writeFileSync(path.join(subDir, 'intro.tex'), 'intro\n', 'utf8');

  const opts = [
    { optionId: 'allow-1', kind: 'allow_once' },
    { optionId: 'reject-1', kind: 'reject_once' }
  ];
  const check = (toolCall, mode = 'auto') => decideAntigravityPermission({
    mode,
    workspacePath,
    toolCall,
    options: opts,
    env
  });

  // 1a. Relative path checked against workspace root AND cwd; multiple cwds rejected
  assert.equal(check({
    kind: 'edit',
    rawInput: { Path: '.git/config', cwd: subDir }
  }).allowed, false);
  assert.equal(check({
    kind: 'edit',
    rawInput: { Path: 'intro.tex', cwd: workspacePath, workingDirectory: subDir }
  }).reason, 'multiple_cwds_forbidden');

  // 1b. Collect from toolCall.args; fail closed when args without rawInput disagrees with locations; depth > 6 overflows
  assert.equal(check({
    kind: 'edit',
    args: { path: path.resolve(tempRoot, 'outside.txt') }
  }).allowed, false);
  assert.equal(check({
    kind: 'edit',
    args: { path: 'main.tex' },
    locations: [{ path: path.join(subDir, 'intro.tex') }]
  }).reason, 'conflicting_tool_locations');
  assert.equal(check({
    kind: 'edit',
    args: { path: 'main.tex' },
    locations: [{ path: path.join(workspacePath, 'main.tex') }]
  }).allowed, true);
  assert.equal(check({
    kind: 'edit',
    rawInput: { a: { b: { c: { d: { e: { f: { g: { path: 'main.tex' } } } } } } } }
  }).reason, 'tool_arguments_too_large');

  // 1c. Path-like keys (`target`, `dst`, `src`, `old_path`, `new_path`, `origin`, `dir`) & missing target; edit_file Target text allowed
  for (const field of ['target', 'dst', 'src', 'old_path', 'new_path', 'origin', 'dir', 'directory']) {
    const outside = path.join(tempRoot, 'outside-field.txt');
    assert.equal(check({ kind: 'move', rawInput: { [field]: outside, path: 'main.tex' } }).allowed, false, `field ${field}`);
  }
  assert.equal(check({ kind: 'delete', rawInput: {} }).reason, 'missing_target_path');
  assert.equal(check({ kind: 'edit', rawInput: { note: 'no path key' }, locations: [{ path: path.join(workspacePath, 'main.tex') }] }).reason, 'missing_target_path');
  assert.equal(check({
    kind: 'edit',
    rawInput: { Path: 'main.tex', Target: '$x_1$ 50% Fig.~1 a..b', Replacement: '$x_2$' }
  }).allowed, true);

  // 1d. Reject ~other, $, %, Windows drive-relative C:foo, and any `..` segment
  for (const unsafePath of ['~other/secret.tex', '~/../escape.tex', '$HOME/main.tex', '%APPDATA%/main.tex', 'C:relative.tex', 'chapters/../main.tex', '../outside.tex']) {
    assert.equal(check({ kind: 'read', rawInput: { path: unsafePath } }, 'ask').allowed, false, `unsafe path ${unsafePath}`);
  }

  // 1e. Case-insensitive reserved workspace directories
  for (const reserved of ['.GIT/config', '.Codex-Overleaf-Attachments/a.png', '.CODEX-OVERLEAF-SUBAGENTS/q.json']) {
    assert.equal(check({ kind: 'edit', rawInput: { path: reserved } }).reason, 'reserved_workspace_directory');
  }

  // 2. selectPermissionOutcome uses only allow_once / reject_once and falls back to cancelled
  assert.deepEqual(selectPermissionOutcome(true, [{ optionId: 'aa', kind: 'allow_always' }]), {
    allowed: false,
    response: { outcome: { outcome: 'cancelled' } }
  });
  assert.deepEqual(selectPermissionOutcome(false, [{ optionId: 'ra', kind: 'reject_always' }]), {
    allowed: false,
    response: { outcome: { outcome: 'cancelled' } }
  });
});

test('Session config defaults model to gemini-4-neon and fails before session/prompt with antigravity_mode_unavailable if mode is not default', async t => {
  const { env: defaultModelEnv, readFakeState: readDefaultModelState } = createTestHarness(t, {
    FAKE_AGY_INITIAL_MODEL: 'claude-sonnet-4-5'
  });

  // Omitting params.model explicitly selects gemini-4-neon
  const defaultRun = await handleRequest({
    id: 'default-model-run',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Use default Gemini model.',
      project: buildFullProjectSnapshot()
    }
  }, defaultModelEnv);
  assert.equal(defaultRun.ok, true);
  assert.ok(readDefaultModelState().configUpdates.some(u => u.configId === 'model' && u.value === 'gemini-4-neon'));

  // Server failing to confirm mode === 'default' aborts before session/prompt with antigravity_mode_unavailable
  const { env: badModeEnv, readFakeState: readBadModeState } = createTestHarness(t, {
    FAKE_AGY_IGNORE_MODE_SET: '1'
  });
  const badModeEvents = [];
  const badModeRun = await handleRequest({
    id: 'bad-mode-run',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      model: 'gemini-3.8-flash',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Must not reach session/prompt.',
      project: buildFullProjectSnapshot()
    }
  }, badModeEnv, e => badModeEvents.push(e));
  assert.equal(badModeRun.ok, false);
  assert.equal(badModeRun.error.code, 'antigravity_mode_unavailable');
  assert.equal(readBadModeState().prompts, undefined);
  assert.equal(badModeEvents.some(e => e.type === 'codex.turn.bound'), false);

  // Non-Gemini and missing-Gemini models pass through codex.run with specific provider error codes
  const nonGeminiRes = await handleRequest({
    id: 'non-gemini-run',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      model: 'claude-sonnet-4-5',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Reject non-Gemini.',
      project: buildFullProjectSnapshot()
    }
  }, defaultModelEnv);
  assert.equal(nonGeminiRes.ok, false);
  assert.equal(nonGeminiRes.error.code, 'provider_model_not_configured');

  const missingGeminiRes = await handleRequest({
    id: 'missing-gemini-run',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      model: 'gemini-9-nonexistent',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Reject unavailable Gemini.',
      project: buildFullProjectSnapshot()
    }
  }, defaultModelEnv);
  assert.equal(missingGeminiRes.ok, false);
  assert.equal(missingGeminiRes.error.code, 'provider_model_not_found');
});

test('Error mapping checks context limit first, maps rate limits, avoids bare -32000 auth false-positives, and redacts secrets', async t => {
  // Bare -32000 without auth evidence is NOT an auth error
  assert.equal(isAntigravityAuthError({ rpcCode: -32000, message: 'Internal execution failure' }), false);
  assert.equal(isAntigravityAuthError({ rpcCode: -32000, message: 'Server error', rpcData: { authMethods: [{ id: 'oauth-personal' }] } }), true);

  const runWithPromptError = async (id, errorSpec, extraEnv = {}) => {
    const { env } = createTestHarness(t, {
      ...(errorSpec ? { FAKE_AGY_PROMPT_RPC_ERROR_JSON: JSON.stringify(errorSpec) } : {}),
      ...extraEnv
    });
    return handleRequest({
      id,
      method: 'codex.run',
      params: {
        projectId: 'proj-agy-1',
        mode: 'ask',
        model: 'gemini-3.8-flash',
        reasoningEffort: 'low',
        providerSelection: { providerId: 'antigravity', providerRevision: 0 },
        task: 'Trigger error mapping.',
        project: buildFullProjectSnapshot()
      }
    }, env);
  };

  // Bare -32000 maps to codex_run_failed (not antigravity_auth_required) and redacts Bearer/api_key
  const generic32000 = await runWithPromptError('err-32000', {
    error: { code: -32000, message: 'Upstream failure Bearer ya29.secret_tok_123 api_key=AIzaSecret999' }
  });
  assert.equal(generic32000.ok, false);
  assert.equal(generic32000.error.code, 'codex_run_failed');
  assert.doesNotMatch(generic32000.error.message, /ya29\.secret_tok_123|AIzaSecret999/);
  assert.match(generic32000.error.message, /\[redacted\]/);

  // Context limit checked before other mappings -> codex_context_limit
  const ctxLimit = await runWithPromptError('err-ctx', {
    error: { code: -32000, message: 'Request exceeds the maximum context window limit for this model (token=tok_ctx_secret)' }
  });
  assert.equal(ctxLimit.ok, false);
  assert.equal(ctxLimit.error.code, 'codex_context_limit');
  assert.doesNotMatch(ctxLimit.error.message, /tok_ctx_secret/);

  // Quota / 429 rate limit -> antigravity_rate_limited
  const rateLimited = await runWithPromptError('err-rate', {
    error: { code: -32000, message: 'HTTP 429 RESOURCE_EXHAUSTED: quota exceeded Bearer ya29.rate_secret', data: { status: 429 } }
  });
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimited.error.code, 'antigravity_rate_limited');
  assert.doesNotMatch(rateLimited.error.message, /ya29\.rate_secret/);

  // Unattributed JSON-RPC error frame with id: null fails pending request cleanly and redacts secrets
  const nullIdErr = await runWithPromptError('err-null-id', {
    nullIdFrame: true,
    error: { code: -32603, message: 'Transport parse failure Bearer ya29.null_secret' }
  });
  assert.equal(nullIdErr.ok, false);
  assert.doesNotMatch(nullIdErr.error.message, /ya29\.null_secret/);

  // Stderr tail on unexpected process exit is sanitized
  const stderrExit = await runWithPromptError('err-stderr', null, {
    FAKE_AGY_STDERR_EXIT: 'Fatal crash Authorization: Bearer ya29.stderr_secret_xyz'
  });
  assert.equal(stderrExit.ok, false);
  assert.doesNotMatch(stderrExit.error.message, /ya29\.stderr_secret_xyz/);
  assert.match(stderrExit.error.message, /\[redacted\]/);
});

test('Interleaved messageId chunks stay intact, denied tools emit declined without completed fileChange, and writing-style bundle is read-only', async t => {
  const { env, tempRoot, readFakeState } = createTestHarness(t, {
    FAKE_AGY_SCENARIO: 'interleaved_and_declined'
  });
  const accountScopeId = 'user-scope-style-1';
  const styleSeed = seedVerifiedWritingStyleBundle({
    tempRoot,
    accountScopeId,
    projectId: 'proj-agy-1'
  });
  // Sanity-check WritingStyleRuntime.resolveForRun accepts our seeded bundle
  const resolvedStyle = WritingStyleRuntime.resolveForRun(styleSeed.snapshot, {
    accountScopeId,
    projectId: 'proj-agy-1'
  }, env);
  assert.equal(resolvedStyle.bundleRoot, styleSeed.versionDir);

  env.FAKE_AGY_STYLE_SKILL_FILE = styleSeed.skillFile;
  env.FAKE_AGY_OUTSIDE_TARGET = path.join(tempRoot, 'outside-declined.txt');

  const events = [];
  const res = await handleRequest({
    id: 'interleaved-style-run',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      accountScopeId,
      mode: 'auto',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      writingStyle: styleSeed.snapshot,
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Polish prose using writing style.',
      project: buildFullProjectSnapshot()
    }
  }, env, event => events.push(event));

  assert.equal(res.ok, true);
  // Item 5: earlier and later chunks sharing messageId `m-interleaved` are concatenated intact across thoughts & tool calls
  assert.equal(res.result.assistantMessage, 'Prefix before tools; suffix after tools.');

  // Item 6: every declined tool (edit, execute, fetch) emitted item/completed with status === 'declined' and never a completed fileChange
  const completedItems = events
    .filter(e => e.type === 'codex.session.event' && e.detail?.method === 'item/completed')
    .map(e => e.detail.params.item);
  const declinedWriteItems = completedItems.filter(item => item.id === 'declined-write-1');
  assert.equal(declinedWriteItems.length, 1);
  assert.equal(declinedWriteItems[0].type, 'fileChange');
  assert.equal(declinedWriteItems[0].status, 'declined');
  assert.equal(completedItems.some(item => item.type === 'fileChange' && item.status === 'completed'), false);
  assert.equal(completedItems.find(item => item.id === 'declined-exec-1')?.status, 'declined');
  assert.equal(completedItems.find(item => item.id === 'declined-fetch-1')?.status, 'declined');

  // Item 7: writing-style SKILL.md readable via read & cat, never writable, never allowed as cwd
  assert.deepEqual(readFakeState().interleavedOutcomes, {
    declinedWriteAllowed: false,
    declinedExecAllowed: false,
    declinedFetchAllowed: false,
    styleReadAllowed: true,
    styleCatAllowed: true,
    styleEditAllowed: false,
    styleCwdAllowed: false
  });
});

test('Setup timeout aborts before codex.turn.bound and session/prompt, turn text is bounded at 1 MiB, and version probe is async/skippable', async t => {
  // 8a + 8d: Timeout during session/new setup aborts before codex.turn.bound and session/prompt, and skips slow --version probe
  const { env: setupTimeoutEnv, readFakeState: readTimeoutState } = createTestHarness(t, {
    CODEX_OVERLEAF_CODEX_TIMEOUT_MS: '60',
    FAKE_AGY_SETUP_DELAY_MS: '500',
    FAKE_AGY_OMIT_INIT_VERSION: '1',
    FAKE_AGY_VERSION_DELAY_MS: '5000'
  });
  const timeoutEvents = [];
  const startedAt = Date.now();
  const timeoutRes = await handleRequest({
    id: 'setup-timeout-1',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-timeout',
      mode: 'ask',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Should time out in setup.',
      project: buildFullProjectSnapshot()
    }
  }, setupTimeoutEnv, e => timeoutEvents.push(e));
  const elapsedMs = Date.now() - startedAt;
  assert.equal(timeoutRes.ok, false);
  assert.ok(elapsedMs < 3000, `expected fast abort without 5s version probe, took ${elapsedMs}ms`);
  assert.equal(timeoutEvents.some(e => e.type === 'codex.turn.bound'), false);
  assert.equal(readTimeoutState().prompts, undefined);

  // Async version probe resolves version cleanly and respects timeoutMs when hung
  assert.equal(await probeAntigravityCliVersion(FAKE_AGY_BIN, setupTimeoutEnv, { timeoutMs: 120 }), null);
  const { env: fastProbeEnv } = createTestHarness(t);
  assert.equal(await probeAntigravityCliVersion(FAKE_AGY_BIN, fastProbeEnv, { timeoutMs: 1500 }), '1.5.18');

  // 8c: > 1 MiB streamed message chunks are capped at 1 MiB
  const { env: floodEnv } = createTestHarness(t, {
    FAKE_AGY_SCENARIO: 'interleaved_and_declined',
    FAKE_AGY_FLOOD_BYTES: String(1300 * 1024)
  });
  const floodRes = await handleRequest({
    id: 'flood-run-1',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-flood',
      mode: 'ask',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Stream > 1 MiB.',
      project: buildFullProjectSnapshot()
    }
  }, floodEnv);
  assert.equal(floodRes.ok, true);
  assert.ok(Buffer.byteLength(floodRes.result.assistantMessage, 'utf8') <= 1024 * 1024);
});

test('Cancellation sends session/cancel, rejects steer, resolves as codex_cancelled, and terminates the child process', async t => {
  const { env, readFakeState } = createTestHarness(t, {
    FAKE_AGY_SCENARIO: 'hang_until_cancel'
  });

  let boundEvent = null;
  let notifyBound;
  const boundReady = new Promise(resolve => { notifyBound = resolve; });
  const runPromise = handleRequest({
    id: 'cancel-run-1',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-cancel',
      mode: 'ask',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Wait until cancelled.',
      project: buildFullProjectSnapshot()
    }
  }, env, event => {
    if (event.type === 'codex.turn.bound') {
      boundEvent = event;
      notifyBound();
    }
  });

  await boundReady;
  assert.ok(boundEvent);

  // Steer during an active Antigravity run must fail with antigravity_unsupported_operation
  const steerRes = await handleRequest({
    id: 'steer-1',
    method: 'codex.steer',
    params: {
      requestId: 'cancel-run-1',
      threadId: boundEvent.detail.threadId,
      expectedTurnId: boundEvent.detail.turnId,
      text: 'Try steering'
    }
  }, env);
  assert.equal(steerRes.ok, false);
  assert.equal(steerRes.error.code, 'antigravity_unsupported_operation');

  // Wait briefly so fake-agy parks on session/request_permission before cancel
  await new Promise(resolve => setTimeout(resolve, 60));
  const cancelRes = await handleRequest({
    id: 'cancel-req-1',
    method: 'codex.cancel',
    params: { requestId: 'cancel-run-1' }
  }, env);
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.result.cancelled, true);

  const finalRes = await runPromise;
  assert.equal(finalRes.ok, false);
  assert.equal(finalRes.error.code, 'codex_cancelled');

  const state = readFakeState();
  assert.ok(Array.isArray(state.cancels) && state.cancels.length === 1);
  assert.equal(isProcessAlive(state.lastPid), false);
});

test('Auto-continues up to 2 times after declined permissions, keeps turnId, accumulates last non-empty answer, and never continues after cancel', async t => {
  // 1. Single blocked command ends cycle silently -> second prompt in same session produces answer & notice
  const { env: recoverEnv, readFakeState: readRecoverState } = createTestHarness(t, {
    FAKE_AGY_SCENARIO: 'reject_then_continue',
    FAKE_AGY_BLOCK_CYCLES: '1'
  });
  const recoverEvents = [];
  const recoverRes = await handleRequest({
    id: 'continue-recover-1',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'auto',
      model: 'gemini-4-neon',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'First run `find . -maxdepth 1 | head`, then describe main.tex.',
      project: buildFullProjectSnapshot()
    }
  }, recoverEnv, event => recoverEvents.push(event));

  assert.equal(recoverRes.ok, true);
  assert.equal(recoverRes.result.assistantMessage, 'Recovered answer after continuation.');
  const boundEvents = recoverEvents.filter(e => e.type === 'codex.turn.bound');
  assert.equal(boundEvents.length, 1);
  const continuedNotices = recoverEvents.filter(e => e.type === 'antigravity.turn.continued');
  assert.equal(continuedNotices.length, 1);
  assert.equal(continuedNotices[0].status, 'warning');
  assert.equal(continuedNotices[0].detail.turnId, boundEvents[0].detail.turnId);
  const turnScopedIds = recoverEvents
    .filter(e => e.type === 'codex.session.event' && e.detail?.params?.turnId)
    .map(e => e.detail.params.turnId);
  assert.ok(turnScopedIds.length > 0 && turnScopedIds.every(id => id === boundEvents[0].detail.turnId));

  const recoverState = readRecoverState();
  assert.equal(recoverState.prompts.length, 2);
  assert.equal(recoverState.prompts[0].sessionId, recoverState.prompts[1].sessionId);
  const followUpText = recoverState.prompts[1].prompt[0].text;
  assert.match(followUpText, /find \. -maxdepth 1 \| head/);
  assert.match(followUpText, /shell operators not allowed/);
  assert.match(followUpText, /built-in tools is allowed and needs no approval/);
  assert.match(followUpText, /Do not retry/);

  // 2. Repeated blocks stop after 2 continuations (3 prompts total) and preserve last non-empty message
  const outsidePath = path.join(os.tmpdir(), `secret-outside-${process.pid}.txt`);
  const { env: capEnv, readFakeState: readCapState } = createTestHarness(t, {
    FAKE_AGY_SCENARIO: 'reject_then_continue',
    FAKE_AGY_BLOCK_CYCLES: '5',
    FAKE_AGY_PREAMBLE_TEXT: 'Preamble before persistent blocks.',
    FAKE_AGY_OUTSIDE_TARGET: outsidePath
  });
  const capEvents = [];
  const capRes = await handleRequest({
    id: 'continue-cap-1',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Keep hitting blocked tools.',
      project: buildFullProjectSnapshot()
    }
  }, capEnv, event => capEvents.push(event));

  assert.equal(capRes.ok, true);
  assert.equal(capRes.result.assistantMessage, 'Preamble before persistent blocks.');
  assert.equal(capEvents.filter(e => e.type === 'antigravity.turn.continued').length, 2);
  const capState = readCapState();
  assert.equal(capState.prompts.length, 3);
  assert.match(capState.prompts[1].prompt[0].text, /answer without editing/i);
  assert.match(capState.prompts[2].prompt[0].text, /is not in the read-only list/);

  // 3. Cancel during continuation aborts cleanly and never auto-continues after cancel
  const { env: cancelContEnv, readFakeState: readCancelContState } = createTestHarness(t, {
    FAKE_AGY_SCENARIO: 'reject_then_continue',
    FAKE_AGY_BLOCK_CYCLES: '5',
    FAKE_AGY_HANG_ON_CYCLE: '1'
  });
  let notifyContinued;
  const continuedReady = new Promise(resolve => { notifyContinued = resolve; });
  const cancelRunPromise = handleRequest({
    id: 'continue-cancel-1',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-cancel-cont',
      mode: 'auto',
      model: 'gemini-4-neon',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Cancel during continuation.',
      project: buildFullProjectSnapshot()
    }
  }, cancelContEnv, event => {
    if (event.type === 'antigravity.turn.continued') {
      notifyContinued();
    }
  });

  await continuedReady;
  await new Promise(resolve => setTimeout(resolve, 60));
  const cancelContRes = await handleRequest({
    id: 'cancel-cont-req',
    method: 'codex.cancel',
    params: { requestId: 'continue-cancel-1' }
  }, cancelContEnv);
  assert.equal(cancelContRes.ok, true);

  const settledCancelRun = await cancelRunPromise;
  assert.equal(settledCancelRun.ok, false);
  assert.equal(settledCancelRun.error.code, 'codex_cancelled');
  const cancelContState = readCancelContState();
  assert.equal(cancelContState.prompts.length, 2);
  assert.equal(isProcessAlive(cancelContState.lastPid), false);
});

test('Thread identity uses session/resume for agy: ids and starts fresh with warnings across runtimes', async t => {
  const { env, readFakeState } = createTestHarness(t);

  // 1. Fresh Antigravity run -> session/new -> agy:sess-1
  const firstRun = await handleRequest({
    id: 'thread-1',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'First turn.',
      project: buildFullProjectSnapshot()
    }
  }, env);
  assert.equal(firstRun.ok, true);
  assert.equal(firstRun.result.threadId, 'agy:sess-1');

  // 2. Resume with agy:sess-1 -> session/resume
  const resumeEvents = [];
  const secondRun = await handleRequest({
    id: 'thread-2',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      threadId: 'agy:sess-1',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Second turn.',
      project: buildFullProjectSnapshot()
    }
  }, env, event => resumeEvents.push(event));
  assert.equal(secondRun.ok, true);
  assert.equal(secondRun.result.threadId, 'agy:sess-1');
  assert.equal(resumeEvents.some(e => e.type === 'antigravity.thread.fresh'), false);

  const stateAfterResume = readFakeState();
  assert.equal(stateAfterResume.sessionsCreated.length, 1);
  assert.deepEqual(stateAfterResume.sessionsResumed.map(s => s.sessionId), ['sess-1']);

  // 3. Antigravity run given a Codex threadId -> emits antigravity.thread.fresh and calls session/new
  const foreignAgyEvents = [];
  const thirdRun = await handleRequest({
    id: 'thread-3',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      threadId: 'thr_codex_legacy_123',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Switched from Codex.',
      project: buildFullProjectSnapshot()
    }
  }, env, event => foreignAgyEvents.push(event));
  assert.equal(thirdRun.ok, true);
  assert.equal(thirdRun.result.threadId, 'agy:sess-2');
  assert.equal(foreignAgyEvents.some(e => e.type === 'antigravity.thread.fresh' && e.status === 'warning'), true);

  // 4. Codex run given an agy: threadId -> emits codex.thread.fresh and calls thread/start instead of thread/resume
  const fakeCodexBin = path.join(path.dirname(env.FAKE_AGY_STATE_FILE), 'fake-codex.js');
  const codexCallsFile = path.join(path.dirname(env.FAKE_AGY_STATE_FILE), 'fake-codex-calls.json');
  fs.writeFileSync(fakeCodexBin, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { process.stdout.write('codex 0.160.0\\n'); process.exit(0); }
const methods = [];
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method) methods.push(msg.method);
    if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: 'codex' } }) + '\\n');
    if (msg.method === 'thread/start') process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: 'codex-fresh-1' } } }) + '\\n');
    if (msg.method === 'thread/resume') process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'Should not resume agy thread' } }) + '\\n');
    if (msg.method === 'turn/start') {
      fs.writeFileSync(${JSON.stringify(codexCallsFile)}, JSON.stringify(methods));
      process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-c-1' } } }) + '\\n');
      process.stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId: 'codex-fresh-1', turnId: 'turn-c-1', item: { id: 'm1', type: 'agentMessage', text: 'Codex fresh reply.' } } }) + '\\n');
      process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'codex-fresh-1', turnId: 'turn-c-1', turn: { id: 'turn-c-1', status: 'completed' } } }) + '\\n');
    }
  }
});
`, 'utf8');
  if (process.platform !== 'win32') fs.chmodSync(fakeCodexBin, 0o755);

  const codexEvents = [];
  const codexRes = await handleRequest({
    id: 'codex-from-agy',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      threadId: 'agy:sess-2',
      providerSelection: { providerId: 'builtin', providerRevision: 0 },
      task: 'Switched back to Codex.',
      project: buildFullProjectSnapshot()
    }
  }, { ...env, CODEX_OVERLEAF_CODEX_PATH: fakeCodexBin }, event => codexEvents.push(event));

  assert.equal(codexRes.ok, true);
  assert.equal(codexRes.result.threadId, 'codex-fresh-1');
  assert.equal(codexEvents.some(e => e.type === 'codex.thread.fresh' && e.status === 'warning'), true);
  const codexMethods = JSON.parse(fs.readFileSync(codexCallsFile, 'utf8'));
  assert.ok(codexMethods.includes('thread/start'));
  assert.equal(codexMethods.includes('thread/resume'), false);
});

test('Auth-required maps to antigravity_auth_required, probe sessions send session/close, and login persists signedIn even if follow-up probe times out', async t => {
  const { env, readFakeState } = createTestHarness(t, {
    FAKE_AGY_SCENARIO: 'signed_out'
  });

  // status when signed out: returns ok:true with signedIn:false and error.code='antigravity_auth_required', no authenticate call
  const statusRes = await handleRequest({
    id: 'status-signed-out',
    method: 'codex.providers.antigravity.status',
    params: {}
  }, env);
  assert.equal(statusRes.ok, true);
  assert.equal(statusRes.result.installed, true);
  assert.equal(statusRes.result.version, '1.5.18');
  assert.equal(statusRes.result.signedIn, false);
  assert.equal(statusRes.result.error?.code, 'antigravity_auth_required');
  assert.equal(readFakeState().authenticates, undefined);

  // models when signed out -> fails with antigravity_auth_required
  const modelsRes = await handleRequest({
    id: 'models-signed-out',
    method: 'codex.models',
    params: { providerSelection: { providerId: 'antigravity', providerRevision: 0 } }
  }, env);
  assert.equal(modelsRes.ok, false);
  assert.equal(modelsRes.error.code, 'antigravity_auth_required');

  // codex.run when signed out -> fails with antigravity_auth_required
  const runRes = await handleRequest({
    id: 'run-signed-out',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Try signed out.',
      project: buildFullProjectSnapshot()
    }
  }, env);
  assert.equal(runRes.ok, false);
  assert.equal(runRes.error.code, 'antigravity_auth_required');

  // login calls authenticate { methodId: 'oauth-personal' }, persists signedIn, and still reports signedIn:true when post-auth session/new times out
  const loginWithHungProbe = await handleRequest({
    id: 'login-probe-timeout',
    method: 'codex.providers.antigravity.login',
    params: {}
  }, {
    ...env,
    FAKE_AGY_POST_AUTH_PROBE_HANG: '1',
    CODEX_OVERLEAF_ANTIGRAVITY_STATUS_TIMEOUT_MS: '80'
  });
  assert.equal(loginWithHungProbe.ok, true);
  assert.equal(loginWithHungProbe.result.signedIn, true);
  assert.equal(loginWithHungProbe.result.error, null);
  assert.equal(loginWithHungProbe.result.warning?.code, 'antigravity_probe_timeout');
  assert.deepEqual(readFakeState().authenticates, [{ methodId: 'oauth-personal' }]);
  assert.equal(readFakeState().signedIn, true);

  // Subsequent status call in a fresh process sees persisted signedIn:true and closes its temporary session via session/close
  const statusAfterLogin = await handleRequest({
    id: 'status-after-login',
    method: 'codex.providers.antigravity.status',
    params: {}
  }, env);
  assert.equal(statusAfterLogin.ok, true);
  assert.equal(statusAfterLogin.result.signedIn, true);
  assert.deepEqual(statusAfterLogin.result.tier, { name: 'Google AI Ultra', id: 'g1-ultra-tier' });
  assert.equal(readFakeState().sessionsClosed?.length, 1);
});

test('Models catalog exposes Gemini-only base models with per-model efforts and closes probe session', async t => {
  const { env, readFakeState } = createTestHarness(t);

  const res = await handleRequest({
    id: 'models-1',
    method: 'codex.models',
    params: { providerSelection: { providerId: 'antigravity', providerRevision: 0 } }
  }, env);

  assert.equal(res.ok, true);
  assert.equal(res.result.providerId, 'antigravity');
  assert.equal(res.result.providerRevision, 0);
  assert.equal(res.result.providerName, 'Antigravity');
  assert.equal(res.result.source, 'antigravity');
  assert.equal(res.result.defaultModelId, 'gemini-4-neon');
  assert.equal(readFakeState().sessionsClosed?.length, 1);
  assert.deepEqual(
    res.result.models.map(m => ({
      id: m.id,
      label: m.label,
      reasoningEfforts: m.reasoningEfforts,
      defaultReasoningEffort: m.defaultReasoningEffort,
      reasoningPresentation: m.reasoningPresentation,
      speedTiers: m.speedTiers,
      defaultSpeedTier: m.defaultSpeedTier
    })),
    [
      {
        id: 'gemini-4-neon',
        label: 'Gemini 4 Neon',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
        reasoningPresentation: 'effort',
        speedTiers: ['standard'],
        defaultSpeedTier: 'standard'
      },
      {
        id: 'gemini-4-carbon',
        label: 'Gemini 4 Carbon',
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high',
        reasoningPresentation: 'effort',
        speedTiers: ['standard'],
        defaultSpeedTier: 'standard'
      },
      {
        id: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high',
        reasoningPresentation: 'effort',
        speedTiers: ['standard'],
        defaultSpeedTier: 'standard'
      }
    ]
  );
});

test('Explicit providerSelection is required for Antigravity, while Native codex.run works without Codex CLI', async t => {
  const { env } = createTestHarness(t, {
    CODEX_OVERLEAF_CODEX_PATH: ''
  });

  // bridge.ping reports antigravityRuntime:true; UI Compatibility still requires Codex in MVP when codex.ok === false
  const ping = await handleRequest({ id: 'ping-1', method: 'bridge.ping', params: {} }, env);
  assert.equal(ping.ok, true);
  assert.equal(ping.result.capabilities.antigravityRuntime, true);
  assert.equal(ping.result.environment.codex.ok, false);
  assert.equal(ping.result.environment.antigravity.ok, true);
  assert.equal(Compatibility.evaluateNativeCompatibility(ping).classification, 'incompatible');

  // codex.providers.list includes fixed antigravity entry and activate switches default provider
  const listed = await handleRequest({ id: 'prov-list', method: 'codex.providers.list', params: {} }, env);
  assert.equal(listed.ok, true);
  const agyEntry = listed.result.providers.find(p => p.id === 'antigravity');
  assert.deepEqual(agyEntry, {
    id: 'antigravity',
    kind: 'antigravity',
    revision: 0,
    name: 'Antigravity',
    editable: false,
    deletable: false,
    models: [],
    hasSecret: false
  });
  const activated = await handleRequest({
    id: 'prov-act',
    method: 'codex.providers.activate',
    params: { providerId: 'antigravity' }
  }, env);
  assert.equal(activated.ok, true);
  assert.equal(activated.result.activeProviderId, 'antigravity');

  // Item 3: Omitting providerSelection when activeProviderId === 'antigravity' must fail with provider_selection_unavailable
  const unconfirmedModels = await handleRequest({
    id: 'models-unconfirmed',
    method: 'codex.models',
    params: {}
  }, env);
  assert.equal(unconfirmedModels.ok, false);
  assert.equal(unconfirmedModels.error.code, 'provider_selection_unavailable');

  const unconfirmedRun = await handleRequest({
    id: 'run-unconfirmed',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      task: 'Omitted providerSelection must not silently route to Antigravity.',
      project: buildFullProjectSnapshot()
    }
  }, env);
  assert.equal(unconfirmedRun.ok, false);
  assert.equal(unconfirmedRun.error.code, 'provider_selection_unavailable');

  // Built-in Codex run is still gated by codex_not_found
  const codexRun = await handleRequest({
    id: 'codex-missing',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      providerSelection: { providerId: 'builtin', providerRevision: 0 },
      task: 'Should fail with codex_not_found.',
      project: buildFullProjectSnapshot()
    }
  }, env);
  assert.equal(codexRun.ok, false);
  assert.equal(codexRun.error.code, 'codex_not_found');

  // Explicit Antigravity run succeeds on Native even with CODEX_OVERLEAF_CODEX_PATH=''
  const agyRun = await handleRequest({
    id: 'agy-works',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Run without Codex installed.',
      project: buildFullProjectSnapshot()
    }
  }, env);
  assert.equal(agyRun.ok, true);
  assert.equal(agyRun.result.assistantMessage, 'Hello from fake Antigravity.');

  // Missing agy executable maps to antigravity_not_found
  const missingAgyRun = await handleRequest({
    id: 'agy-missing',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'ask',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Missing agy.',
      project: buildFullProjectSnapshot()
    }
  }, { ...env, CODEX_OVERLEAF_ANTIGRAVITY_BIN: '/nonexistent/agy-binary' });
  assert.equal(missingAgyRun.ok, false);
  assert.equal(missingAgyRun.error.code, 'antigravity_not_found');

  // Unsupported operations fail early with antigravity_unsupported_operation
  const compactRes = await handleRequest({
    id: 'agy-compact',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      operation: 'compact',
      threadId: 'agy:sess-1',
      providerSelection: { providerId: 'antigravity', providerRevision: 0 }
    }
  }, env);
  assert.equal(compactRes.ok, false);
  assert.equal(compactRes.error.code, 'antigravity_unsupported_operation');

  const skillInstallRes = await handleRequest({
    id: 'agy-skill-install',
    method: 'codex.run',
    params: {
      projectId: 'proj-agy-1',
      mode: 'auto',
      skipMirrorSync: true,
      skillInvocation: { id: 'skill-installer', title: 'Skill Installer' },
      providerSelection: { providerId: 'antigravity', providerRevision: 0 },
      task: 'Install skill'
    }
  }, env);
  assert.equal(skillInstallRes.ok, false);
  assert.equal(skillInstallRes.error.code, 'antigravity_unsupported_operation');

  const forkRes = await handleRequest({
    id: 'agy-fork',
    method: 'codex.thread.fork',
    params: {
      threadId: 'agy:sess-1',
      lastTurnId: 'agy-turn-1'
    }
  }, env);
  assert.equal(forkRes.ok, false);
  assert.equal(forkRes.error.code, 'antigravity_unsupported_operation');
});
