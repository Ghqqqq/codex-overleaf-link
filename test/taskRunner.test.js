const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../package.json');
const {
  getProjectMirror,
  patchMirrorFiles,
  syncOverleafToMirror
} = require('../native-host/src/mirrorWorkspace');
const { handleRequest: handleTaskRunnerRequest } = require('../native-host/src/taskRunner');
const compatibility = require('../extension/src/shared/compatibility');
const {
  BUILD_TARGET_VERSION,
  MIN_COMPATIBLE_EXTENSION_VERSION,
  MIN_NATIVE_VERSION,
  REQUIRED_CAPABILITIES
} = compatibility;

const TEST_PROVIDER_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-task-providers-'));
test.after(() => fs.rmSync(TEST_PROVIDER_STORE_DIR, { recursive: true, force: true }));

function handleRequest(request, env = {}, emit) {
  return handleTaskRunnerRequest(request, {
    CODEX_OVERLEAF_PROVIDER_STORE_DIR: TEST_PROVIDER_STORE_DIR,
    ...env
  }, emit);
}

const TEST_QUOTAS = {
  maxProjectFiles: 1000,
  maxProjectTextBytes: 32 * 1024 * 1024,
  maxProjectBinaryBytes: 32 * 1024 * 1024,
  maxOperations: 1000,
  maxCompileLogBytes: 512 * 1024,
  maxAttachmentCount: 8,
  maxAttachmentBytes: 12 * 1024 * 1024,
  maxSkillContentBytes: 64 * 1024
};

function fixtureAgentEnv(fixtureName, extra = {}) {
  return {
    CODEX_OVERLEAF_AGENT_FILE: process.execPath,
    CODEX_OVERLEAF_AGENT_ARGS_JSON: JSON.stringify([path.join(__dirname, 'fixtures', fixtureName)]),
    ...extra
  };
}

function loadTaskRunnerWithFakeRunner(fakeRunner) {
  const runnerPath = require.resolve('../native-host/src/codexSessionRunner');
  const taskRunnerPath = require.resolve('../native-host/src/taskRunner');
  const taskRunnerRuntimePath = require.resolve('../native-host/src/taskRunnerRuntime');
  const originalRunner = require(runnerPath);

  delete require.cache[taskRunnerPath];
  delete require.cache[taskRunnerRuntimePath];
  require.cache[runnerPath].exports = {
    ...originalRunner,
    runCodexSession: fakeRunner
  };

  const taskRunner = require(taskRunnerPath);
  require.cache[runnerPath].exports = originalRunner;
  delete require.cache[taskRunnerPath];
  delete require.cache[taskRunnerRuntimePath];
  return {
    ...taskRunner,
    handleRequest(request, env = {}, emit) {
      return taskRunner.handleRequest(request, {
        CODEX_OVERLEAF_PROVIDER_STORE_DIR: TEST_PROVIDER_STORE_DIR,
        ...env
      }, emit);
    }
  };
}

function makeMirrorStale(projectId, rootDir, ageMs = 10 * 60 * 1000) {
  const mirror = getProjectMirror(projectId, { rootDir });
  const baseline = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const staleAt = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(mirror.baselinePath, JSON.stringify({
    ...baseline,
    capturedAt: staleAt,
    lastFullSyncAt: staleAt
  }, null, 2), 'utf8');
}

async function seedFreshOtFreshMirror({ projectId, rootDir }) {
  await syncOverleafToMirror({
    projectId,
    rootDir,
    project: {
      capabilities: { fullProjectSnapshot: true },
      files: [
        { path: 'main.tex', content: 'old main' },
        { path: 'refs.bib', content: '@article{old}' }
      ]
    }
  });
  const mirror = getProjectMirror(projectId, { rootDir });
  const baseline = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const mainEntry = baseline.files.find(file => file.path === 'main.tex');
  await patchMirrorFiles({
    projectId,
    rootDir,
    files: [{ path: 'main.tex', baseHash: mainEntry.hash, nextContent: 'fresh main' }]
  });
}

async function seedStaleOtFreshMirror({ projectId, rootDir }) {
  await seedFreshOtFreshMirror({ projectId, rootDir });
  makeMirrorStale(projectId, rootDir);
}

function assertQuotaError(response, { field, limit }) {
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'native_request_quota_exceeded');
  assert.equal(response.error.field, field);
  assert.equal(response.error.limit, limit);
  assert.match(response.error.message, /too large|too many|quota/i);
}

function isVersionAtLeast(version, minimum) {
  const left = parseVersion(version);
  const right = parseVersion(minimum);
  if (!left || !right) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index];
    }
  }
  return true;
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  return match ? match.slice(1).map(Number) : null;
}

test('bridge.ping returns bridge metadata', async () => {
  const response = await handleRequest({ id: '1', method: 'bridge.ping', params: {} }, {
    CODEX_OVERLEAF_CODEX_PATH: '/opt/homebrew/bin/codex',
    CODEX_OVERLEAF_CODEX_VERSION: '0.144.6',
    CODEX_OVERLEAF_LATEXMK_PATH: '/Library/TeX/texbin/latexmk'
  });

  assert.equal(response.id, '1');
  assert.equal(response.ok, true);
  assert.equal(response.result.host, 'com.codex.overleaf');
  assert.equal(response.result.platform, process.platform);
  assert.equal(response.result.version, packageJson.version);
  assert.deepEqual(response.result.supportedProtocol, { min: 1, max: 2 });
  assert.deepEqual(
    response.result.capabilities,
    Object.fromEntries(REQUIRED_CAPABILITIES.map(capability => [capability, true]))
  );
  assert.equal(response.result.minExtensionVersion, MIN_COMPATIBLE_EXTENSION_VERSION);
  assert.equal(response.result.environment.codex.ok, true);
  assert.equal(response.result.environment.codex.version, '0.144.6');
  assert.equal(response.result.environment.codex.candidates.length, 1);
  assert.deepEqual(response.result.environment.latex.available, ['latexmk']);
});

test('bridge.ping reports injected platform metadata from the native host environment', async () => {
  const response = await handleRequest({ id: 'platform', method: 'bridge.ping', params: {} }, {
    CODEX_OVERLEAF_PLATFORM: 'linux'
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.platform, 'linux');
});

test('bridge.ping ignores unsupported ambient platform metadata', async () => {
  const response = await handleRequest({ id: 'platform-spoof', method: 'bridge.ping', params: {} }, {
    CODEX_OVERLEAF_PLATFORM: 'freebsd'
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.platform, process.platform);
});

test('real bridge.ping compatibility follows package version metadata', async () => {
  const response = await handleRequest({ id: 'compat-real', method: 'bridge.ping', params: {} }, {
    CODEX_OVERLEAF_CODEX_PATH: '/opt/homebrew/bin/codex'
  });
  const result = compatibility.evaluateNativeCompatibility(response, { version: BUILD_TARGET_VERSION });
  const expectedStatus = isVersionAtLeast(packageJson.version, MIN_NATIVE_VERSION) ? 'ok' : 'native_too_old';

  assert.equal(response.result.version, packageJson.version);
  assert.equal(result.status, expectedStatus);
});

test('codex.models returns a usable fallback model list', async () => {
  const response = await handleRequest(
    { id: 'models-1', method: 'codex.models', params: {} },
    { HOME: path.join(__dirname, 'fixtures', 'missing-codex-model-home') }
  );

  assert.equal(response.id, 'models-1');
  assert.equal(response.ok, true);
  assert.equal(Array.isArray(response.result.models), true);
  assert.equal(response.result.models.some(model => model.id === 'gpt-5.5'), true);
  assert.equal(response.result.source, 'fallback');
  assert.equal(typeof response.result.fetchedAt, 'string');
});

test('codex.models returns models discovered from the Codex cache', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-task-models-'));
  try {
    const cachePath = path.join(home, '.codex', 'models_cache.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      fetched_at: '2026-05-05T06:44:19.541424Z',
      models: [
        {
          slug: 'gpt-taskrunner-cache',
          display_name: 'GPT TaskRunner Cache',
          visibility: 'list'
        }
      ]
    }), 'utf8');

    const response = await handleRequest({ id: 'models-cache', method: 'codex.models', params: {} }, { HOME: home });

    assert.equal(response.id, 'models-cache');
    assert.equal(response.ok, true);
    assert.equal(response.result.source, 'codex-cache');
    assert.deepEqual(response.result.models.map(model => model.id), ['gpt-taskrunner-cache']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('skills.install, skills.list, and skills.remove manage project-local markdown skills', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-skills-'));
  const env = { CODEX_OVERLEAF_MIRROR_ROOT: rootDir };
  try {
    const install = await handleRequest({
      id: 'skill-install',
      method: 'skills.install',
      params: {
        projectId: 'skills-project',
        skillId: 'citation-style',
        content: '# Citation Style\n\nPrefer author-year citations and preserve BibTeX keys.'
      }
    }, env);

    assert.equal(install.ok, true);
    assert.equal(install.result.id, 'citation-style');
    assert.equal(install.result.size, Buffer.byteLength('# Citation Style\n\nPrefer author-year citations and preserve BibTeX keys.'));

    const list = await handleRequest({
      id: 'skill-list',
      method: 'skills.list',
      params: { projectId: 'skills-project' }
    }, env);

    assert.equal(list.ok, true);
    assert.deepEqual(list.result.skills.map(skill => skill.id), ['citation-style']);
    assert.equal(list.result.skills[0].title, 'Citation Style');
    assert.match(list.result.skills[0].preview, /Prefer author-year citations/);
    assert.equal(typeof list.result.skills[0].updatedAt, 'string');

    const remove = await handleRequest({
      id: 'skill-remove',
      method: 'skills.remove',
      params: { projectId: 'skills-project', skillId: 'citation-style' }
    }, env);

    assert.equal(remove.ok, true);
    assert.equal(remove.result.removed, true);

    const empty = await handleRequest({
      id: 'skill-list-empty',
      method: 'skills.list',
      params: { projectId: 'skills-project' }
    }, env);
    assert.deepEqual(empty.result.skills, []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('skills.install, skills.list, and skills.remove manage Codex Overleaf plugin skills', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-plugin-skills-'));
  const pluginSkillsRoot = path.join(home, '.codex-overleaf', 'skills');
  const env = { HOME: home, CODEX_OVERLEAF_SKILLS_ROOT: pluginSkillsRoot };
  try {
    const install = await handleRequest({
      id: 'plugin-skill-install',
      method: 'skills.install',
      params: {
        scope: 'codex-overleaf',
        skillId: 'overleaf-style',
        content: '# Overleaf Style\n\nPrefer concise reviewer-facing LaTeX edits.'
      }
    }, env);

    assert.equal(install.ok, true);
    assert.equal(install.result.id, 'overleaf-style');
    assert.equal(install.result.scope, 'codex-overleaf');
    assert.equal(
      fs.readFileSync(path.join(pluginSkillsRoot, 'overleaf-style', 'SKILL.md'), 'utf8'),
      '# Overleaf Style\n\nPrefer concise reviewer-facing LaTeX edits.'
    );

    const list = await handleRequest({
      id: 'plugin-skill-list',
      method: 'skills.list',
      params: { scope: 'codex-overleaf' }
    }, env);

    assert.equal(list.ok, true);
    // v1.6.1: listing installs/restores the official skills first, so the
    // catalog always contains them alongside user-installed ones.
    assert.deepEqual(list.result.skills.map(skill => [skill.id, skill.scope]), [
      ['annotated-rewrite', 'codex-overleaf'],
      ['overleaf-style', 'codex-overleaf'],
      ['parallel-subagents', 'codex-overleaf']
    ]);
    assert.equal(list.result.skills.find(skill => skill.id === 'overleaf-style').title, 'Overleaf Style');

    const remove = await handleRequest({
      id: 'plugin-skill-remove',
      method: 'skills.remove',
      params: { scope: 'codex-overleaf', skillId: 'overleaf-style' }
    }, env);

    assert.equal(remove.ok, true);
    assert.equal(remove.result.removed, true);
    assert.equal(fs.existsSync(path.join(pluginSkillsRoot, 'overleaf-style')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('skills.install rejects unsafe ids and non-text content', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-skills-'));
  const env = { CODEX_OVERLEAF_MIRROR_ROOT: rootDir };
  try {
    const unsafe = await handleRequest({
      id: 'skill-unsafe',
      method: 'skills.install',
      params: {
        projectId: 'skills-project',
        skillId: '../escape',
        content: '# Bad'
      }
    }, env);
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.error.code, 'skills_install_failed');
    assert.match(unsafe.error.message, /Invalid skill id/);

    const binary = await handleRequest({
      id: 'skill-binary',
      method: 'skills.install',
      params: {
        projectId: 'skills-project',
        skillId: 'binary',
        contentBase64: Buffer.from('# Binary').toString('base64')
      }
    }, env);
    assert.equal(binary.ok, false);
    assert.equal(binary.error.code, 'skills_install_failed');
    assert.match(binary.error.message, /markdown\/text content/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('skills.install rejects oversized skill content with a structured quota error', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-skills-quota-'));
  const env = { CODEX_OVERLEAF_MIRROR_ROOT: rootDir };
  try {
    const response = await handleRequest({
      id: 'skill-content-quota',
      method: 'skills.install',
      params: {
        projectId: 'skills-project',
        skillId: 'too-large',
        content: 'x'.repeat(TEST_QUOTAS.maxSkillContentBytes + 1)
      }
    }, env);

    assertQuotaError(response, {
      field: 'content',
      limit: TEST_QUOTAS.maxSkillContentBytes
    });
    assert.equal(fs.existsSync(path.join(rootDir, 'skills-project')), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('skills.install rejects Codex Overleaf skill roots outside the plugin data root', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-skill-root-'));
  const globalSkillRoot = path.join(home, '.codex', 'skills');
  try {
    const response = await handleRequest({
      id: 'plugin-skill-global-root',
      method: 'skills.install',
      params: {
        scope: 'codex-overleaf',
        skillId: 'escape',
        content: '# Escape\n'
      }
    }, {
      HOME: home,
      CODEX_OVERLEAF_SKILLS_ROOT: globalSkillRoot
    });

    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'skills_install_failed');
    assert.match(response.error.message, /Codex Overleaf skill root/i);
    assert.equal(fs.existsSync(path.join(globalSkillRoot, 'escape', 'SKILL.md')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('skills.install rejects Codex Overleaf skill roots that symlink outside the plugin data root', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-skill-root-link-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-outside-skills-'));
  const defaultSkillRoot = path.join(home, '.codex-overleaf', 'skills');
  try {
    fs.mkdirSync(path.dirname(defaultSkillRoot), { recursive: true });
    fs.symlinkSync(outsideRoot, defaultSkillRoot, process.platform === 'win32' ? 'junction' : 'dir');

    const response = await handleRequest({
      id: 'plugin-skill-symlink-root',
      method: 'skills.install',
      params: {
        scope: 'codex-overleaf',
        skillId: 'escape',
        content: '# Escape\n'
      }
    }, { HOME: home });

    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'skills_install_failed');
    assert.match(response.error.message, /Codex Overleaf skill root/i);
    assert.equal(fs.existsSync(path.join(outsideRoot, 'escape', 'SKILL.md')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('codex.run rejects too many project files before starting Codex', async () => {
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  const response = await handleWithFakeRunner({
    id: 'codex-file-quota',
    method: 'codex.run',
    params: {
      projectId: 'quota-files',
      mode: 'ask',
      task: 'Check project',
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: Array.from({ length: TEST_QUOTAS.maxProjectFiles + 1 }, (_, index) => ({
          path: `file-${index}.tex`,
          content: 'x'
        }))
      }
    }
  }, {});

  assertQuotaError(response, {
    field: 'project.files',
    limit: TEST_QUOTAS.maxProjectFiles
  });
  assert.equal(calls, 0);
});

test('codex.run rejects oversized project text before starting Codex', async () => {
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  const response = await handleWithFakeRunner({
    id: 'codex-text-quota',
    method: 'codex.run',
    params: {
      projectId: 'quota-text',
      mode: 'ask',
      task: 'Check project',
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'x'.repeat(TEST_QUOTAS.maxProjectTextBytes + 1) }]
      }
    }
  }, {});

  assertQuotaError(response, {
    field: 'project.files.content',
    limit: TEST_QUOTAS.maxProjectTextBytes
  });
  assert.equal(calls, 0);
});

test('codex.run rejects oversized project binary snapshots before starting Codex', async () => {
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  const response = await handleWithFakeRunner({
    id: 'codex-binary-quota',
    method: 'codex.run',
    params: {
      projectId: 'quota-binary',
      mode: 'ask',
      task: 'Check project',
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{
          path: 'figures/plot.pdf',
          kind: 'binary',
          size: TEST_QUOTAS.maxProjectBinaryBytes + 1,
          contentBase64: Buffer.from([1]).toString('base64')
        }]
      }
    }
  }, {});

  assertQuotaError(response, {
    field: 'project.files.contentBase64',
    limit: TEST_QUOTAS.maxProjectBinaryBytes
  });
  assert.equal(calls, 0);
});

test('codex.run rejects oversized text file overlays before mirror mutation', async () => {
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  const response = await handleWithFakeRunner({
    id: 'codex-overlay-text-quota',
    method: 'codex.run',
    params: {
      projectId: 'quota-overlay-text',
      mode: 'ask',
      task: 'Check overlay',
      useExistingMirror: true,
      fileOverlays: [{
        path: 'main.tex',
        content: 'x'.repeat(TEST_QUOTAS.maxProjectTextBytes + 1)
      }]
    }
  }, {});

  assertQuotaError(response, {
    field: 'fileOverlays.content',
    limit: TEST_QUOTAS.maxProjectTextBytes
  });
  assert.equal(calls, 0);
});

test('codex.run rejects oversized binary file overlays before mirror mutation', async () => {
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  const response = await handleWithFakeRunner({
    id: 'codex-overlay-binary-quota',
    method: 'codex.run',
    params: {
      projectId: 'quota-overlay-binary',
      mode: 'ask',
      task: 'Check overlay',
      useExistingMirror: true,
      fileOverlays: [{
        path: 'figures/plot.pdf',
        size: TEST_QUOTAS.maxProjectBinaryBytes + 1,
        contentBase64: Buffer.from([1]).toString('base64')
      }]
    }
  }, {});

  assertQuotaError(response, {
    field: 'fileOverlays.contentBase64',
    limit: TEST_QUOTAS.maxProjectBinaryBytes
  });
  assert.equal(calls, 0);
});

test('codex.run rejects oversized compile log context before starting Codex', async () => {
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  const response = await handleWithFakeRunner({
    id: 'codex-compile-log-quota',
    method: 'codex.run',
    params: {
      projectId: 'quota-compile-log',
      mode: 'ask',
      task: 'Check @compile-log',
      compileLog: 'x'.repeat(TEST_QUOTAS.maxCompileLogBytes + 1),
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'hello' }]
      }
    }
  }, {});

  assertQuotaError(response, {
    field: 'compileLog',
    limit: TEST_QUOTAS.maxCompileLogBytes
  });
  assert.equal(calls, 0);
});

test('codex.run rejects attachment quota violations before starting Codex', async () => {
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  const tooMany = await handleWithFakeRunner({
    id: 'codex-attachment-count-quota',
    method: 'codex.run',
    params: {
      projectId: 'quota-attachment-count',
      mode: 'ask',
      task: 'Check attachments',
      attachments: Array.from({ length: TEST_QUOTAS.maxAttachmentCount + 1 }, (_, index) => ({
        name: `attachment-${index}.txt`,
        contentBase64: Buffer.from('x').toString('base64')
      })),
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'hello' }]
      }
    }
  }, {});

  const tooLarge = await handleWithFakeRunner({
    id: 'codex-attachment-byte-quota',
    method: 'codex.run',
    params: {
      projectId: 'quota-attachment-bytes',
      mode: 'ask',
      task: 'Check attachments',
      attachments: [{
        name: 'large.pdf',
        size: TEST_QUOTAS.maxAttachmentBytes + 1,
        contentBase64: Buffer.from([1]).toString('base64')
      }],
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'hello' }]
      }
    }
  }, {});

  assertQuotaError(tooMany, {
    field: 'attachments',
    limit: TEST_QUOTAS.maxAttachmentCount
  });
  assertQuotaError(tooLarge, {
    field: 'attachments.contentBase64',
    limit: TEST_QUOTAS.maxAttachmentBytes
  });
  assert.equal(calls, 0);
});

test('task.run rejects oversized operation lists before external agent work', async () => {
  const response = await handleRequest({
    id: 'task-operation-quota',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Prepare edits',
      project: { id: 'abc', files: [{ path: 'main.tex', content: 'hello' }] },
      proposedOperations: Array.from({ length: TEST_QUOTAS.maxOperations + 1 }, (_, index) => ({
        type: 'edit',
        path: `file-${index}.tex`,
        hunks: []
      }))
    }
  }, fixtureAgentEnv('agentNotes.cjs'));

  assertQuotaError(response, {
    field: 'proposedOperations',
    limit: TEST_QUOTAS.maxOperations
  });
});

test('task.run rejects oversized secondary operations lists even when proposedOperations is present', async () => {
  const response = await handleRequest({
    id: 'task-secondary-operation-quota',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Prepare edits',
      project: { id: 'abc', files: [{ path: 'main.tex', content: 'hello' }] },
      proposedOperations: [],
      operations: Array.from({ length: TEST_QUOTAS.maxOperations + 1 }, (_, index) => ({
        type: 'edit',
        path: `file-${index}.tex`,
        hunks: []
      }))
    }
  }, fixtureAgentEnv('agentNotes.cjs'));

  assertQuotaError(response, {
    field: 'operations',
    limit: TEST_QUOTAS.maxOperations
  });
});

test('task.run rejects oversized proposed operation text before external agent work', async () => {
  const response = await handleRequest({
    id: 'task-proposed-operation-text-quota',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Prepare edits',
      project: { id: 'abc', files: [{ path: 'main.tex', content: 'hello' }] },
      proposedOperations: [{
        type: 'create',
        path: 'large.tex',
        content: 'x'.repeat(TEST_QUOTAS.maxProjectTextBytes + 1)
      }]
    }
  }, fixtureAgentEnv('agentNotes.cjs'));

  assertQuotaError(response, {
    field: 'proposedOperations.content',
    limit: TEST_QUOTAS.maxProjectTextBytes
  });
  assert.equal(response.result?.planId, undefined);
});

test('task.run rejects oversized secondary operation binary payloads before external agent work', async () => {
  const oversizedBase64 = 'A'.repeat(Math.ceil((TEST_QUOTAS.maxProjectBinaryBytes + 1) * 4 / 3) + 4);
  const response = await handleRequest({
    id: 'task-secondary-operation-binary-quota',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Prepare edits',
      project: { id: 'abc', files: [{ path: 'main.tex', content: 'hello' }] },
      proposedOperations: [{
        type: 'edit',
        path: 'main.tex',
        find: 'hello',
        replace: 'hello world'
      }],
      operations: [{
        type: 'overwrite-binary',
        path: 'figures/large.pdf',
        contentBase64: oversizedBase64
      }]
    }
  }, fixtureAgentEnv('agentNotes.cjs'));

  assertQuotaError(response, {
    field: 'operations.contentBase64',
    limit: TEST_QUOTAS.maxProjectBinaryBytes
  });
  assert.equal(response.result?.planId, undefined);
});

test('task.run rejects oversized text file overlays before external agent work', async () => {
  const response = await handleRequest({
    id: 'task-file-overlay-text-quota',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Prepare edits',
      project: { id: 'abc', files: [{ path: 'main.tex', content: 'hello' }] },
      fileOverlays: [{
        path: 'main.tex',
        content: 'x'.repeat(TEST_QUOTAS.maxProjectTextBytes + 1)
      }],
      proposedOperations: [{
        type: 'edit',
        path: 'main.tex',
        find: 'hello',
        replace: 'hello world'
      }]
    }
  }, {});

  assertQuotaError(response, {
    field: 'fileOverlays.content',
    limit: TEST_QUOTAS.maxProjectTextBytes
  });
  assert.equal(response.result?.planId, undefined);
});

test('task.run rejects oversized binary file overlays before external agent work', async () => {
  const oversizedBase64 = 'A'.repeat(Math.ceil((TEST_QUOTAS.maxProjectBinaryBytes + 1) * 4 / 3) + 4);
  const response = await handleRequest({
    id: 'task-file-overlay-binary-quota',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Prepare edits',
      project: { id: 'abc', files: [{ path: 'main.tex', content: 'hello' }] },
      fileOverlays: [{
        path: 'figures/large.pdf',
        contentBase64: oversizedBase64
      }],
      proposedOperations: [{
        type: 'edit',
        path: 'main.tex',
        find: 'hello',
        replace: 'hello world'
      }]
    }
  }, {});

  assertQuotaError(response, {
    field: 'fileOverlays.contentBase64',
    limit: TEST_QUOTAS.maxProjectBinaryBytes
  });
  assert.equal(response.result?.planId, undefined);
});

test('mirror.scanSensitive reports redacted findings from the local mirror workspace', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-sensitive-'));
  const env = { CODEX_OVERLEAF_MIRROR_ROOT: rootDir };
  try {
    await syncOverleafToMirror({
      projectId: 'sensitive-project',
      rootDir,
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [
          { path: 'main.tex', content: `token = ${['sk', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('-')}` },
          { path: 'figure.png', contentBase64: Buffer.from([1, 2, 3]).toString('base64'), size: 3 }
        ]
      }
    });

    const response = await handleRequest({
      id: 'mirror-sensitive',
      method: 'mirror.scanSensitive',
      params: { projectId: 'sensitive-project' }
    }, env);

    assert.equal(response.ok, true);
    assert.equal(response.result.findings.length, 1);
    assert.equal(response.result.findings[0].path, 'main.tex');
    assert.equal(response.result.findings[0].source, 'mirror-file');
    assert.equal(response.result.findings[0].detectorId, 'api-token');
    assert.match(response.result.findings[0].preview, /\[REDACTED\]/);
    assert.equal(JSON.stringify(response.result).includes('abcdefghijklmnopqrstuvwxyz1234567890'), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('mirror.patchFiles applies a baseline-verified text patch without invoking Codex', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-patch-'));
  const env = { CODEX_OVERLEAF_MIRROR_ROOT: rootDir };
  let codexCalls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    codexCalls++;
    return { status: 'completed', syncChanges: [] };
  });

  try {
    const projectId = 'patch-files-project';
    const syncResponse = await handleWithFakeRunner({
      id: 'patch-sync',
      method: 'mirror.sync',
      params: {
        projectId,
        project: {
          capabilities: { fullProjectSnapshot: true },
          files: [{ path: 'main.tex', content: 'old' }]
        }
      }
    }, env);

    assert.equal(syncResponse.ok, true);

    const mirror = getProjectMirror(projectId, { rootDir });
    const baseline = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
    const mainTex = baseline.files.find(file => file.path === 'main.tex');
    assert.ok(mainTex?.hash);

    const patchResponse = await handleWithFakeRunner({
      id: 'patch-files',
      method: 'mirror.patchFiles',
      params: {
        projectId,
        source: 'ot',
        files: [{ path: 'main.tex', baseHash: mainTex.hash, nextContent: 'new' }]
      }
    }, env);

    assert.equal(patchResponse.ok, true);
    assert.equal(patchResponse.result.appliedCount, 1);
    assert.equal(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), 'new');
    assert.equal(codexCalls, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('codex.run returns a clear error before spawning when Codex is missing', async () => {
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  const response = await handleWithFakeRunner({
    id: 'codex-missing',
    method: 'codex.run',
    params: {
      projectId: 'missing-codex-project',
      mode: 'ask',
      task: '检查 citation',
      project: { files: [{ path: 'main.tex', content: 'hello' }] }
    }
  }, {
    CODEX_OVERLEAF_ENV_READY: '1',
    CODEX_OVERLEAF_CODEX_PATH: ''
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'codex_not_found');
  assert.equal(calls, 0);
});

test('codex.run rejects project snapshots without explicit freshness evidence', async () => {
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  const response = await handleWithFakeRunner({
    id: 'codex-unverified-snapshot',
    method: 'codex.run',
    params: {
      projectId: 'unverified-codex-project',
      mode: 'ask',
      task: '检查 citation',
      project: { files: [{ path: 'main.tex', content: 'hello' }] }
    }
  }, {});

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'codex_run_requires_snapshot_evidence');
  assert.equal(calls, 0);
});

test('codex.run accepts skill installer turns without project snapshot evidence', async () => {
  let calls = 0;
  let seenParams = null;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async ({ params }) => {
    calls++;
    seenParams = params;
    return { status: 'completed', syncChanges: [] };
  });

  const response = await handleWithFakeRunner({
    id: 'codex-skill-installer',
    method: 'codex.run',
    params: {
      projectId: 'skill-installer-project',
      mode: 'ask',
      task: 'Install the skill from https://github.com/example/skills/tree/main/foo',
      skipMirrorSync: true,
      skillInvocation: {
        id: 'skill-installer',
        title: 'Skill Installer'
      },
      focusFiles: []
    }
  }, {});

  assert.equal(response.ok, true);
  assert.equal(calls, 1);
  assert.equal(seenParams.skipMirrorSync, true);
  assert.deepEqual(seenParams.skillInvocation, {
    id: 'skill-installer',
    title: 'Skill Installer'
  });
});

test('codex.run accepts explicit focused partial snapshots', async () => {
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  const response = await handleWithFakeRunner({
    id: 'codex-focused-partial',
    method: 'codex.run',
    params: {
      projectId: 'focused-partial-codex-project',
      mode: 'ask',
      task: '检查 main.tex',
      restrictToFocusFiles: true,
      focusFiles: ['main.tex'],
      project: {
        capabilities: { fullProjectSnapshot: false },
        files: [{ path: 'main.tex', content: 'hello' }]
      }
    }
  }, {});

  assert.equal(response.ok, true);
  assert.equal(calls, 1);
});

test('codex.run preserves recoverable thread resume failures from the runner', async () => {
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    const error = new Error('Could not resume Codex thread');
    error.code = 'thread_resume_failed';
    throw error;
  });

  const response = await handleWithFakeRunner({
    id: 'codex-thread-resume-failed',
    method: 'codex.run',
    params: {
      projectId: 'thread-resume-failed-project',
      mode: 'ask',
      task: '继续上一轮',
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'hello' }]
      }
    }
  }, {});

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'thread_resume_failed');
  assert.equal(response.error.message, 'Could not resume Codex thread');
});

test('codex.run rejects focused partial snapshots missing focused files', async () => {
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  const response = await handleWithFakeRunner({
    id: 'codex-focused-partial-missing-file',
    method: 'codex.run',
    params: {
      projectId: 'focused-partial-missing-file-project',
      mode: 'ask',
      task: '检查 main.tex',
      restrictToFocusFiles: true,
      focusFiles: ['@file:/sections/main.tex'],
      project: {
        capabilities: { fullProjectSnapshot: false },
        files: [{ path: 'main.tex', content: 'hello' }]
      }
    }
  }, {});

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'codex_run_requires_snapshot_evidence');
  assert.equal(calls, 0);
});

test('codex.run rejects focused partial snapshots with unusable focused file content', async () => {
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  const response = await handleWithFakeRunner({
    id: 'codex-focused-partial-loading-file',
    method: 'codex.run',
    params: {
      projectId: 'focused-partial-loading-file-project',
      mode: 'ask',
      task: '检查 main.tex',
      restrictToFocusFiles: true,
      focusFiles: ['@file:/main.tex'],
      project: {
        capabilities: { fullProjectSnapshot: false },
        files: [{ path: 'main.tex', content: 'Loading...' }]
      }
    }
  }, {});

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'codex_run_requires_snapshot_evidence');
  assert.equal(calls, 0);
});

test('codex.run accepts stale project mirror only for explicitly focused OT-fresh reuse', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-stale-ot-'));
  const projectId = 'stale-ot-focused-project';
  let calls = 0;
  let seenParams = null;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async ({ params }) => {
    calls++;
    seenParams = params;
    return { status: 'completed', syncChanges: [] };
  });

  try {
    await seedStaleOtFreshMirror({ projectId, rootDir });

    const response = await handleWithFakeRunner({
      id: 'codex-stale-ot-focused',
      method: 'codex.run',
      params: {
        projectId,
        mode: 'ask',
        task: '检查 main.tex',
        useExistingMirror: true,
        otWarmStart: true,
        warmStartStrategy: 'ot-warm-mirror',
        restrictToFocusFiles: true,
        focusFiles: ['@file:/main.tex'],
        expectedMirrorFreshness: 1
      }
    }, { CODEX_OVERLEAF_MIRROR_ROOT: rootDir });

    assert.equal(response.ok, true);
    assert.equal(calls, 1);
    assert.equal(seenParams.skipMirrorSync, true);
    assert.equal(seenParams.useExistingMirror, true);
    assert.equal(seenParams.otWarmStart, true);
    assert.equal(seenParams.restrictToFocusFiles, true);
    assert.deepEqual(seenParams.focusFiles, ['@file:/main.tex']);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('codex.run rejects overlays on fresh OT warm mirror reuse before mirror mutation', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-fresh-ot-overlay-'));
  const projectId = 'fresh-ot-overlay-project';
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  try {
    await seedFreshOtFreshMirror({ projectId, rootDir });
    const mirror = getProjectMirror(projectId, { rootDir });

    const response = await handleWithFakeRunner({
      id: 'codex-fresh-ot-overlay',
      method: 'codex.run',
      params: {
        projectId,
        mode: 'ask',
        task: '检查 main.tex',
        useExistingMirror: true,
        otWarmStart: true,
        warmStartStrategy: 'ot-warm-mirror',
        restrictToFocusFiles: true,
        focusFiles: ['main.tex'],
        fileOverlays: [{ path: 'refs.bib', content: '@article{mutated}' }]
      }
    }, { CODEX_OVERLEAF_MIRROR_ROOT: rootDir });

    const baselineAfter = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
    const refsEntry = baselineAfter.files.find(file => file.path === 'refs.bib');

    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'mirror_stale');
    assert.match(response.error.message, /OT warm mirror reuse does not accept file overlays/);
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(path.join(mirror.workspacePath, 'refs.bib'), 'utf8'), '@article{old}');
    assert.equal(refsEntry.content, '@article{old}');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('codex.run rejects fresh OT warm mirror reuse without focused result restriction', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-fresh-ot-unrestricted-'));
  const projectId = 'fresh-ot-unrestricted-project';
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return {
      status: 'completed',
      syncChanges: [
        { path: 'main.tex', content: 'changed main' },
        { path: 'refs.bib', content: 'changed refs' }
      ]
    };
  });

  try {
    await seedFreshOtFreshMirror({ projectId, rootDir });

    const response = await handleWithFakeRunner({
      id: 'codex-fresh-ot-unrestricted',
      method: 'codex.run',
      params: {
        projectId,
        mode: 'ask',
        task: '检查 main.tex',
        useExistingMirror: true,
        otWarmStart: true,
        warmStartStrategy: 'ot-warm-mirror',
        focusFiles: ['main.tex']
      }
    }, { CODEX_OVERLEAF_MIRROR_ROOT: rootDir });

    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'mirror_stale');
    assert.match(response.error.message, /requires restrictToFocusFiles=true/);
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('codex.run rejects overlays on stale OT warm mirror reuse before mirror mutation', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-stale-ot-overlay-'));
  const projectId = 'stale-ot-overlay-project';
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  try {
    await seedStaleOtFreshMirror({ projectId, rootDir });
    const mirror = getProjectMirror(projectId, { rootDir });

    const response = await handleWithFakeRunner({
      id: 'codex-stale-ot-overlay',
      method: 'codex.run',
      params: {
        projectId,
        mode: 'ask',
        task: '检查 main.tex',
        useExistingMirror: true,
        otWarmStart: true,
        warmStartStrategy: 'ot-warm-mirror',
        restrictToFocusFiles: true,
        focusFiles: ['main.tex'],
        fileOverlays: [{ path: 'refs.bib', content: '@article{mutated}' }],
        expectedMirrorFreshness: 1
      }
    }, { CODEX_OVERLEAF_MIRROR_ROOT: rootDir });

    const baselineAfter = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
    const refsEntry = baselineAfter.files.find(file => file.path === 'refs.bib');

    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'mirror_stale');
    assert.match(response.error.message, /OT warm mirror reuse does not accept file overlays/);
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(path.join(mirror.workspacePath, 'refs.bib'), 'utf8'), '@article{old}');
    assert.equal(refsEntry.content, '@article{old}');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('codex.run rejects stale OT warm mirror reuse without focused fresh coverage', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-stale-ot-reject-'));
  const projectId = 'stale-ot-reject-project';
  let calls = 0;
  const { handleRequest: handleWithFakeRunner } = loadTaskRunnerWithFakeRunner(async () => {
    calls++;
    return { status: 'completed', syncChanges: [] };
  });

  try {
    await seedStaleOtFreshMirror({ projectId, rootDir });

    const noFocusResponse = await handleWithFakeRunner({
      id: 'codex-stale-ot-no-focus',
      method: 'codex.run',
      params: {
        projectId,
        mode: 'ask',
        task: '检查 project',
        useExistingMirror: true,
        otWarmStart: true,
        warmStartStrategy: 'ot-warm-mirror',
        restrictToFocusFiles: true,
        focusFiles: [],
        expectedMirrorFreshness: 1
      }
    }, { CODEX_OVERLEAF_MIRROR_ROOT: rootDir });

    const missingCoverageResponse = await handleWithFakeRunner({
      id: 'codex-stale-ot-missing-focus',
      method: 'codex.run',
      params: {
        projectId,
        mode: 'ask',
        task: '检查 refs.bib',
        useExistingMirror: true,
        otWarmStart: true,
        warmStartStrategy: 'ot-warm-mirror',
        restrictToFocusFiles: true,
        focusFiles: ['refs.bib'],
        expectedMirrorFreshness: 1
      }
    }, { CODEX_OVERLEAF_MIRROR_ROOT: rootDir });

    assert.equal(noFocusResponse.ok, false);
    assert.equal(noFocusResponse.error.code, 'mirror_stale');
    assert.match(noFocusResponse.error.message, /requires focused files/);
    assert.equal(missingCoverageResponse.ok, false);
    assert.equal(missingCoverageResponse.error.code, 'mirror_stale');
    assert.match(missingCoverageResponse.error.message, /not OT-fresh: refs\.bib/);
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('codex.history.clearPlugin removes only the requested plugin Codex thread history', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-history-'));
  const pluginSessionFile = path.join(home, '.codex-overleaf', 'codex-home', 'sessions', '2026', '05', '02', 'plugin.jsonl');
  const otherPluginSessionFile = path.join(home, '.codex-overleaf', 'codex-home', 'sessions', '2026', '05', '02', 'other.jsonl');
  const userSessionFile = path.join(home, '.codex', 'sessions', '2026', '05', '02', 'user.jsonl');
  try {
    fs.mkdirSync(path.dirname(pluginSessionFile), { recursive: true });
    fs.mkdirSync(path.dirname(userSessionFile), { recursive: true });
    fs.writeFileSync(pluginSessionFile, '{"threadId":"thread-a","plugin":true}\n', 'utf8');
    fs.writeFileSync(otherPluginSessionFile, '{"threadId":"thread-b","plugin":true}\n', 'utf8');
    fs.writeFileSync(userSessionFile, '{"threadId":"thread-a","user":true}\n', 'utf8');

    const response = await handleRequest({
      id: 'clear-history',
      method: 'codex.history.clearPlugin',
      params: { threadId: 'thread-a' }
    }, { HOME: home });

    assert.equal(response.ok, true);
    assert.equal(response.result.scope, 'thread');
    assert.deepEqual(response.result.removed, ['sessions/2026/05/02/plugin.jsonl']);
    assert.equal(fs.existsSync(pluginSessionFile), false);
    assert.equal(fs.existsSync(otherPluginSessionFile), true);
    assert.equal(fs.existsSync(userSessionFile), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('task.run rejects Auto Mode when neither checkpoint nor Reviewing is verified', async () => {
  const response = await handleRequest({
    id: '2',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Fix citations',
      checkpoint: { ok: false },
      project: { id: 'abc', files: [] }
    }
  }, {});

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'safety_required');
});

test('task.run accepts Auto Mode with verified Reviewing even without checkpoint', async () => {
  const response = await handleRequest({
    id: '2b',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Fix citations',
      checkpoint: { ok: false },
      reviewing: { ok: true },
      project: { id: 'abc', files: [] },
      proposedOperations: []
    }
  }, {});

  assert.equal(response.ok, true);
  assert.equal(response.result.status, 'completed');
  assert.equal(response.result.notes, '');
});

test('task.run rejects Auto Mode when Reviewing is only a manual override', async () => {
  const response = await handleRequest({
    id: '2c',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Fix citations',
      checkpoint: { ok: false },
      reviewing: { ok: true, status: 'manual-override', source: 'user-confirmed' },
      project: { id: 'abc', files: [] },
      proposedOperations: []
    }
  }, {});

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'safety_required');
});

test('task.run rejects removed Suggest mode', async () => {
  const response = await handleRequest({
    id: 'suggest-removed-run',
    method: 'task.run',
    params: { mode: 'confirm', task: 'Prepare edits', project: { id: 'abc', files: [] } }
  }, {});

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'suggest_mode_removed');
});

test('task.confirm returns the removed Suggest compatibility error', async () => {
  const response = await handleRequest({
    id: 'suggest-removed-confirm',
    method: 'task.confirm',
    params: { planId: 'legacy-plan' }
  }, {});

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'suggest_mode_removed');
});

test('task.run in Ask Mode returns analysis without write operations', async () => {
  const response = await handleRequest({
    id: '3b',
    method: 'task.run',
    params: {
      mode: 'ask',
      task: 'Explain citation issues',
      project: { id: 'abc', files: [{ path: 'main.tex', content: 'hello' }] },
      proposedOperations: [
        { type: 'edit', path: 'main.tex', hunks: [{ before: 'hello', after: 'hello world' }] }
      ]
    }
  }, {});

  assert.equal(response.ok, true);
  assert.equal(response.result.status, 'completed');
  assert.deepEqual(response.result.operations, []);
  assert.equal(response.result.summary.counts.edit, 0);
  assert.equal(JSON.stringify(response.result).includes('hello world'), false);
});

test('task.run default results include a minimal user report', async () => {
  const response = await handleRequest({
    id: '3bb',
    method: 'task.run',
    params: {
      locale: 'zh',
      mode: 'ask',
      task: 'Explain citation issues',
      project: { id: 'abc', files: [{ path: 'main.tex', content: 'hello' }] },
      proposedOperations: []
    }
  }, {});

  assert.equal(response.ok, true);
  assert.equal(response.result.userReport.conclusion, '这轮任务已完成，没有写入 Overleaf 文件。');
  assert.deepEqual(response.result.userReport.checked, ['main.tex']);
  assert.equal(response.result.userReport.nextStep, '可以继续追问，或加入更多 @context 后再检查。');
});

test('task.run defaults missing report locale to English', async () => {
  const response = await handleRequest({
    id: '3bbc',
    method: 'task.run',
    params: {
      mode: 'ask',
      task: 'Explain citation issues',
      project: { id: 'abc', files: [{ path: 'main.tex', content: 'hello' }] },
      proposedOperations: []
    }
  }, {});

  assert.equal(response.ok, true);
  assert.equal(response.result.userReport.conclusion, 'This task completed without writing Overleaf files.');
  assert.deepEqual(response.result.userReport.checked, ['main.tex']);
  assert.equal(response.result.userReport.nextStep, 'Continue the conversation, or add more @context and run another check.');
});

test('task.run in Ask Mode strips external-agent pending write operations', async () => {
  const response = await handleRequest({
    id: '3c',
    method: 'task.run',
    params: {
      mode: 'ask',
      task: 'Explain pending citation fix',
      project: { id: 'abc', files: [{ path: 'main.tex', content: 'old' }] }
    }
  }, fixtureAgentEnv('agentConfirmPending.cjs'));

  assert.equal(response.ok, true);
  assert.equal(response.result.status, 'completed');
  assert.deepEqual(response.result.operations, []);
  assert.equal(Object.hasOwn(response.result, 'pendingOperations'), false);
  assert.equal(Object.hasOwn(response.result, 'deletePlan'), false);
});

test('task.run in Ask Mode preserves external-agent userReport', async () => {
  const response = await handleRequest({
    id: '3d',
    method: 'task.run',
    params: {
      mode: 'ask',
      task: 'Check citations',
      project: { id: 'abc', files: [{ path: 'main.tex', content: '\\cite{x}' }] }
    }
  }, fixtureAgentEnv('agentUserReport.cjs'));

  assert.equal(response.ok, true);
  assert.equal(response.result.userReport.conclusion, '没有发现缺失 citation key，也没有修改文件。');
  assert.deepEqual(response.result.userReport.findings, ['所有 citation key 都能在 .bib 中找到。']);
  assert.deepEqual(response.result.operations, []);
});

test('unknown methods return a structured error', async () => {
  const response = await handleRequest({ id: '4', method: 'nope', params: {} }, {});

  assert.deepEqual(response, {
    id: '4',
    ok: false,
    error: {
      code: 'method_not_found',
      message: 'Unknown method: nope'
    }
  });
});

test('Auto Mode pauses external-agent delete operations behind a delete plan', async () => {
  const response = await handleRequest({
    id: '7',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Clean project',
      checkpoint: { ok: true },
      project: { id: 'abc', files: [] }
    }
  }, fixtureAgentEnv('agentDelete.cjs'));

  assert.equal(response.ok, true);
  assert.equal(response.result.status, 'delete_plan_required');
  assert.deepEqual(response.result.operations, [
    { type: 'edit', path: 'main.tex', find: 'a', replace: 'b' }
  ]);
  assert.deepEqual(response.result.deletePlan, [
    { path: 'unused.tex', reason: 'not referenced' }
  ]);
});

test('Auto Mode re-splits unsafe delete_plan_required agent operations', async () => {
  const response = await handleRequest({
    id: '7c',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Unsafe clean',
      checkpoint: { ok: true },
      project: { id: 'abc', files: [] }
    }
  }, fixtureAgentEnv('agentDeletePlanUnsafe.cjs'));

  assert.equal(response.ok, true);
  assert.equal(response.result.status, 'delete_plan_required');
  assert.deepEqual(response.result.operations, []);
  assert.deepEqual(response.result.deletePlan, [
    { path: 'unused.tex', reason: 'not referenced' }
  ]);
  assert.deepEqual(response.result.pendingOperations, [
    { type: 'delete', path: 'unused.tex', reason: 'not referenced' }
  ]);
});

test('task.run returns external-agent notes for analysis-only tasks', async () => {
  const response = await handleRequest({
    id: '8',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Check citations only',
      checkpoint: { ok: false },
      reviewing: { ok: true },
      project: { id: 'abc', files: [{ path: 'main.tex', content: '\\cite{x}' }] }
    }
  }, fixtureAgentEnv('agentNotes.cjs'));

  assert.equal(response.ok, true);
  assert.equal(response.result.status, 'completed');
  assert.equal(response.result.notes, 'No obvious citation issues found in the supplied files.');
  assert.deepEqual(response.result.operations, []);
});

test('task.run starts an external agent from file and args without shell command strings', async () => {
  const response = await handleRequest({
    id: '8b',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Check citations only',
      checkpoint: { ok: false },
      reviewing: { ok: true },
      project: { id: 'abc', files: [{ path: 'main.tex', content: '\\cite{x}' }] }
    }
  }, {
    CODEX_OVERLEAF_AGENT_FILE: process.execPath,
    CODEX_OVERLEAF_AGENT_ARGS_JSON: JSON.stringify([path.join(__dirname, 'fixtures/agentNotes.cjs')])
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.notes, 'No obvious citation issues found in the supplied files.');
});

test('task.run ignores legacy shell command env var', async () => {
  const response = await handleRequest({
    id: '8c',
    method: 'task.run',
    params: {
      mode: 'ask',
      task: 'Check citations only',
      project: { id: 'abc', files: [{ path: 'main.tex', content: '\\cite{x}' }] }
    }
  }, {
    CODEX_OVERLEAF_AGENT_CMD: `${process.execPath} ${path.join(__dirname, 'fixtures/agentNotes.cjs')}`
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.status, 'completed');
  assert.notEqual(response.result.notes, 'No obvious citation issues found in the supplied files.');
  assert.deepEqual(response.result.operations, []);
});

test('task.run emits realtime lifecycle events while external agent runs', async () => {
  const events = [];
  const response = await handleRequest({
    id: '9',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Check citations only',
      checkpoint: { ok: false },
      reviewing: { ok: true },
      project: { id: 'abc', files: [{ path: 'main.tex', content: '\\cite{x}' }] },
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh'
    }
  }, fixtureAgentEnv('agentProgress.cjs'), event => events.push(event));

  assert.equal(response.ok, true);
  assert.equal(response.result.notes, 'Progress fixture completed.');
  assert.deepEqual(events.map(event => event.type), [
    'native.task.received',
    'agent.command.started',
    'codex.exec.started',
    'agent.command.completed'
  ]);
  assert.equal(events[1].detail.model, 'gpt-5.5');
  assert.equal(events[2].detail.pid, 1234);
});

test('task.run fails a hanging external agent after the configured timeout', async () => {
  const response = await handleRequest({
    id: '10',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Hang',
      checkpoint: { ok: true },
      project: { id: 'abc', files: [] }
    }
  }, fixtureAgentEnv('agentHang.cjs', {
    CODEX_OVERLEAF_AGENT_TIMEOUT_MS: '50'
  }));

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'agent_failed');
  assert.match(response.error.message, /timed out/i);
});

test('task.run fails an external agent that exceeds the output byte limit', async () => {
  const response = await handleRequest({
    id: '11',
    method: 'task.run',
    params: {
      mode: 'auto',
      task: 'Too much output',
      checkpoint: { ok: true },
      project: { id: 'abc', files: [] }
    }
  }, fixtureAgentEnv('agentHugeStdout.cjs', {
    CODEX_OVERLEAF_AGENT_OUTPUT_MAX_BYTES: '1024'
  }));

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'agent_failed');
  assert.match(response.error.message, /output limit/i);
});
