const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const RELEASE_TEST_TRACE = process.env.CI === 'true' || process.env.CODEX_OVERLEAF_RELEASE_TEST_TRACE === '1';

function releaseTest(name, optionsOrFn, maybeFn) {
  const hasOptions = typeof optionsOrFn !== 'function';
  const options = hasOptions ? optionsOrFn : undefined;
  const fn = hasOptions ? maybeFn : optionsOrFn;
  const wrapped = async (t) => {
    if (RELEASE_TEST_TRACE) {
      console.error(`[releaseScripts] start ${name}`);
    }
    try {
      return await fn(t);
    } finally {
      if (RELEASE_TEST_TRACE) {
        console.error(`[releaseScripts] end ${name}`);
      }
    }
  };
  return hasOptions ? test(name, options, wrapped) : test(name, wrapped);
}

async function importScriptModule(relativePath) {
  const moduleUrl = pathToFileURL(path.join(repoRoot, relativePath)).href;
  const previous = process.env.CODEX_OVERLEAF_TEST_IMPORT;
  process.env.CODEX_OVERLEAF_TEST_IMPORT = '1';
  try {
    return await import(moduleUrl);
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_OVERLEAF_TEST_IMPORT;
    } else {
      process.env.CODEX_OVERLEAF_TEST_IMPORT = previous;
    }
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readReleaseWorkflow() {
  return readText(path.join(repoRoot, '.github/workflows/release.yml'));
}

function readTestWorkflow() {
  return readText(path.join(repoRoot, '.github/workflows/test.yml'));
}

function readIssueTemplate(templateName) {
  return readText(path.join(repoRoot, '.github/ISSUE_TEMPLATE', templateName));
}

function getIssueTemplateFieldBlock(templateText, fieldId) {
  const lines = templateText.split(/\r?\n/);
  const blocks = [];
  let currentBlock = [];

  for (const line of lines) {
    if (line.startsWith('  - type: ')) {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock);
      }
      currentBlock = [line];
    } else if (currentBlock.length > 0) {
      currentBlock.push(line);
    }
  }
  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  const block = blocks.find((candidate) => candidate.includes(`    id: ${fieldId}`));
  assert.ok(block, `Missing issue template field ${fieldId}`);
  return block.join('\n');
}

function assertIssueTemplateRequiredField(templateText, fieldId, fieldType) {
  const block = getIssueTemplateFieldBlock(templateText, fieldId);
  assert.match(block, new RegExp(`^  - type: ${fieldType}$`, 'm'), `${fieldId} should be a ${fieldType} field`);
  assert.match(block, /^    validations:\n      required: true$/m, `${fieldId} should be required`);
  return block;
}

function getIssueTemplateOptions(templateText, fieldId) {
  const block = getIssueTemplateFieldBlock(templateText, fieldId);
  const options = [];
  let inOptions = false;

  for (const line of block.split('\n')) {
    if (line === '      options:') {
      inOptions = true;
      continue;
    }
    if (!inOptions) {
      continue;
    }
    const option = line.match(/^        - (.*)$/)?.[1];
    if (option) {
      options.push(option.replace(/^"|"$/g, ''));
      continue;
    }
    if (line.trim() && !line.startsWith('          ')) {
      break;
    }
  }

  assert.notEqual(options.length, 0, `${fieldId} should define dropdown options`);
  return options;
}

function getTopLevelYamlSection(text, sectionName) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${sectionName}:`);
  assert.notEqual(start, -1, `Missing top-level ${sectionName}: section`);

  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && /^\S/.test(line)) {
      break;
    }
    body.push(line);
  }
  return body.join('\n');
}

function assertContainsInOrder(text, expectedFragments) {
  let searchFrom = 0;
  for (const fragment of expectedFragments) {
    const index = text.indexOf(fragment, searchFrom);
    assert.notEqual(index, -1, `Expected workflow to contain ${fragment} after offset ${searchFrom}`);
    searchFrom = index + fragment.length;
  }
}

function getReleaseWorkflowUploadFilesBlock(workflow) {
  const filesBlock = workflow.match(/^\s+files:\s+\|\s*$([\s\S]*?)^\s+fail_on_unmatched_files:/m)?.[1] || '';
  assert.notEqual(filesBlock, '', 'Release workflow must define an explicit files: block.');
  return filesBlock;
}

function getReleaseWorkflowUploadFiles(workflow) {
  return getReleaseWorkflowUploadFilesBlock(workflow)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getExpectedReleaseWorkflowUploadFiles() {
  const releaseDir = '${{ env.RELEASE_DIR }}';
  const releaseAssetTag = '${{ env.RELEASE_ASSET_TAG }}';
  const checksumCoveredUploads = [
    `${releaseDir}/codex-overleaf-link-extension-${releaseAssetTag}.zip`,
    `${releaseDir}/codex-overleaf-native-host-${releaseAssetTag}.tar.gz`,
    `${releaseDir}/codex-overleaf-update-${releaseAssetTag}.tar.gz`,
    `${releaseDir}/codex-overleaf-link-` + '${{ env.PACKAGE_VERSION }}.tgz',
    `${releaseDir}/install.sh`,
    `${releaseDir}/install.ps1`,
    `${releaseDir}/uninstall-native-host.mjs`,
    `${releaseDir}/nativeHostPlatform.js`,
    `${releaseDir}/manifest.js`,
    `${releaseDir}/runtimeInstaller.js`,
    `${releaseDir}/release-manifest.json`,
    `${releaseDir}/release-manifest.sig`,
    `${releaseDir}/release-notes.md`
  ];

  return [
    ...checksumCoveredUploads,
    // SHA256SUMS is the checksum index for every other uploaded asset; it cannot include its own hash.
    `${releaseDir}/SHA256SUMS`
  ];
}

function assertReleaseWorkflowUploadsExactArtifactSet(workflow) {
  const filesBlock = getReleaseWorkflowUploadFilesBlock(workflow);
  assert.doesNotMatch(filesBlock, /\*/);
  assert.doesNotMatch(filesBlock, /codex-overleaf-release-output/);
  assert.deepEqual(
    getReleaseWorkflowUploadFiles(workflow).sort(),
    getExpectedReleaseWorkflowUploadFiles().sort()
  );
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listTarEntries(filePath) {
  const result = spawnSync('tar', ['-tzf', filePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, ''));
}

function listZipEntries(filePath, t) {
  const result = spawnSync('unzip', ['-Z1', filePath], { encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') {
    t.skip('unzip is required to inspect release zip contents');
    return [];
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.split('\n').filter(Boolean);
}

let releaseTestIndexPath;

function createReleaseTestIndexPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-index-'));
  const indexPath = path.join(tempDir, 'index');
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexPath
  };
  const readTree = spawnSync('git', ['read-tree', 'HEAD'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8'
  });
  assert.equal(readTree.status, 0, readTree.stderr || readTree.stdout);
  const add = spawnSync('git', [
    'add',
    '--',
    'install.ps1',
    'native-host/src/nativeHostPlatform.js',
    'extension/bootstrap/background.js',
    'extension/bootstrap/manifest.template.json',
    'extension/bootstrap/popup.css',
    'extension/bootstrap/popup.html',
    'extension/bootstrap/popup.js',
    'extension/bootstrap/runtimeContext.js',
    'extension/bootstrap/update.css',
    'extension/bootstrap/update.html',
    'extension/bootstrap/update.js',
    'extension/runtime-manifest.json',
    'extension/src/content/updateIdle.js',
    'native-host/src/managedInstall.js',
    'native-host/src/managedLauncherRuntime.js',
    'native-host/src/updateArchive.js',
    'native-host/src/updateManager.js',
    'native-host/src/updateTrust.js',
    'scripts/install-managed.mjs',
    'scripts/sign-release-manifest.mjs',
    'scripts/uninstall-managed.mjs'
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8'
  });
  assert.equal(add.status, 0, add.stderr || add.stdout);
  return indexPath;
}

function getReleaseTestIndexPath() {
  if (!releaseTestIndexPath) {
    releaseTestIndexPath = createReleaseTestIndexPath();
  }
  return releaseTestIndexPath;
}

function releaseTrackedInputEnv(overrides = {}) {
  return {
    ...process.env,
    GIT_INDEX_FILE: getReleaseTestIndexPath(),
    ...overrides
  };
}

function releaseBuildEnv(overrides = {}) {
  return {
    ...process.env,
    CODEX_OVERLEAF_ALLOW_DIRTY_RELEASE_INPUTS: '1',
    GIT_INDEX_FILE: getReleaseTestIndexPath(),
    ...overrides
  };
}

function writeMinimalReleaseBuildFixture(rootDir, { untracked = [] } = {}) {
  const files = {
    'package.json': `${JSON.stringify({
      name: 'codex-overleaf-link',
      version: '0.6.0',
      packageManager: 'npm@11.11.0'
    }, null, 2)}\n`,
    'CHANGELOG.md': '# Changelog\n\n## v0.6.0 - 2026-05-06\n\nFixture release notes.\n',
    'install.sh': '#!/usr/bin/env bash\nREF="${CODEX_OVERLEAF_REF:-main}"\n',
    'install.ps1': "$DefaultRef = 'main'\n",
    'extension/manifest.json': `${JSON.stringify({ version: '0.6.0' }, null, 2)}\n`,
    'extension/popup.html': '<!doctype html>\n',
    'extension/src/shared/compatibility.js': 'module.exports = {};\n',
    'native-host/src/nativeHostPlatform.js': 'module.exports = {};\n',
    'native-host/src/taskRunner.js': 'module.exports = {};\n',
    'scripts/codex-json-agent.mjs': '#!/usr/bin/env node\n',
    'scripts/uninstall-native-host.mjs': [
      '#!/usr/bin/env node',
      "import { getDefaultBridgePath } from '../native-host/src/nativeHostPlatform.js';",
      'void getDefaultBridgePath;'
    ].join('\n')
  };

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  const init = spawnSync('git', ['init'], { cwd: rootDir, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const trackedFiles = Object.keys(files).filter((relativePath) => !untracked.includes(relativePath));
  const add = spawnSync('git', ['add', '--', ...trackedFiles], { cwd: rootDir, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const commit = spawnSync('git', [
    '-c',
    'user.name=Codex Test',
    '-c',
    'user.email=codex@example.invalid',
    'commit',
    '-m',
    'fixture'
  ], { cwd: rootDir, encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr || commit.stdout);
}

function writeReleaseFixture(rootDir, overrides = {}) {
  const packageVersion = Object.hasOwn(overrides, 'packageVersion') ? overrides.packageVersion : '0.6.0';
  const packageName = Object.hasOwn(overrides, 'packageName') ? overrides.packageName : 'codex-overleaf-link';
  const packageManager = Object.hasOwn(overrides, 'packageManager') ? overrides.packageManager : 'npm@11.11.0';
  const lockfileVersion = Object.hasOwn(overrides, 'lockfileVersion') ? overrides.lockfileVersion : 3;
  const manifestVersion = Object.hasOwn(overrides, 'manifestVersion') ? overrides.manifestVersion : packageVersion;
  const buildTargetVersion = Object.hasOwn(overrides, 'buildTargetVersion') ? overrides.buildTargetVersion : packageVersion;
  const readmeVersion = Object.hasOwn(overrides, 'readmeVersion') ? overrides.readmeVersion : packageVersion;
  const changelogVersion = Object.hasOwn(overrides, 'changelogVersion') ? overrides.changelogVersion : packageVersion;
  const changelogDate = overrides.changelogDate || '2026-05-06';
  const changelogBody = Object.hasOwn(overrides, 'changelogBody')
    ? overrides.changelogBody
    : 'Fixture release notes.\n';

  fs.mkdirSync(path.join(rootDir, 'extension'), { recursive: true });
  const packageJson = {
    name: packageName,
    version: packageVersion,
    repository: Object.hasOwn(overrides, 'repository')
      ? overrides.repository
      : {
          type: 'git',
          url: 'git+https://github.com/Ghqqqq/codex-overleaf-link.git'
        },
    packageManager
  };
  if (packageManager === undefined) {
    delete packageJson.packageManager;
  }
  fs.writeFileSync(
    path.join(rootDir, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(rootDir, 'package-lock.json'),
    `${JSON.stringify({
      name: packageName,
      version: packageVersion,
      lockfileVersion,
      requires: true,
      packages: {
        '': {
          name: packageName,
          version: packageVersion
        }
      }
    }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(rootDir, 'extension/manifest.json'),
    `${JSON.stringify({ version: manifestVersion }, null, 2)}\n`
  );
  fs.mkdirSync(path.join(rootDir, 'extension/src/shared'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'extension/src/shared/compatibility.js'),
    `const BUILD_TARGET_VERSION = '${buildTargetVersion}';\nmodule.exports = { BUILD_TARGET_VERSION };\n`
  );
  fs.writeFileSync(
    path.join(rootDir, 'README.md'),
    overrides.readmeText || [
      `<img src="https://img.shields.io/badge/version-${readmeVersion}-blue" alt="version">`,
      `npm exec --yes codex-overleaf-link@${packageVersion} -- install-native`
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(rootDir, 'CHANGELOG.md'),
    overrides.changelogText || `# Changelog\n\n## v${changelogVersion} - ${changelogDate}\n\n${changelogBody}`
  );
  fs.writeFileSync(path.join(rootDir, 'install.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(rootDir, 'install.ps1'), '$ErrorActionPreference = "Stop"\n');
  fs.mkdirSync(path.join(rootDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'scripts/install-native-host.mjs'), '#!/usr/bin/env node\n');
}

releaseTest('CHANGELOG exposes structured release notes for the current version', async () => {
  const version = readJson(path.join(repoRoot, 'package.json')).version;
  const changelog = readText(path.join(repoRoot, 'CHANGELOG.md'));
  const heading = `## v${version} - 2026-07-19`;
  const start = changelog.indexOf(heading);
  assert.notEqual(start, -1, `CHANGELOG.md should contain ${heading}`);
  assert.equal(changelog.includes(`## [${version}] - 2026-07-19`), false);
  assert.equal(changelog.indexOf(heading, start + heading.length), -1, 'CHANGELOG.md should not duplicate the current release heading');

  const { extractReleaseNotes } = await importScriptModule('scripts/build-release.mjs');
  const section = extractReleaseNotes(changelog, version);
  const escapedVersion = version.replace(/\./g, '\\.');

  assert.match(section, new RegExp(`^## v${escapedVersion} - 2026-07-19$`, 'm'));
  assert.match(section, /^### (Added|Changed|Deprecated|Removed|Fixed|Security)$/m);
  assert.match(section, /^- \S.+$/m);
  assert.doesNotMatch(section, new RegExp(`^## v(?!${escapedVersion}(?:\\s|$))`, 'm'));
});

releaseTest('package exposes release verification and artifact build commands', () => {
  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const runTests = fs.readFileSync(path.join(repoRoot, 'scripts/run-tests.mjs'), 'utf8');

  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs');
  assert.match(runTests, /--test-concurrency=1/);
  assert.match(runTests, /--test-isolation=none/);
  assert.doesNotMatch(runTests, /--test-force-exit/);
  assert.match(runTests, /spawn\(process\.execPath, nodeArgs/);
  assert.doesNotMatch(runTests, /spawnSync\(process\.execPath, nodeArgs/);
  assert.match(runTests, /killProcessTree/);
  assert.match(runTests, /SIGKILL|taskkill/);
  assert.match(runTests, /for \(const testFile of testFiles\)/);
  assert.match(runTests, /HIGH_PRIORITY_TEST_FILE_NAMES/);
  assert.match(runTests, /releaseScripts\.test\.js/);
  assert.match(runTests, /CODEX_OVERLEAF_RELEASE_SCRIPTS_TEST_TIMEOUT_MS/);
  assert.match(runTests, /CODEX_OVERLEAF_TEST_FILE_TIMEOUT_MS/);
  assert.equal(pkg.scripts['verify:release'], 'node scripts/verify-release.mjs');
  assert.equal(pkg.scripts['build:release'], 'node scripts/build-release.mjs');
});

releaseTest('README documents the npm tarball in GitHub Release artifacts', () => {
  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const readme = readText(path.join(repoRoot, 'README.md'));

  assert.match(readme, new RegExp(`codex-overleaf-link-${pkg.version.replace(/\./g, '\\.')}\\.tgz`));
});

releaseTest('release workflow only publishes semver-like version tags', () => {
  const workflow = readReleaseWorkflow();
  const triggerSection = getTopLevelYamlSection(workflow, 'on');

  assert.match(triggerSection, /^\s+push:\s*$/m);
  assert.match(triggerSection, /^\s+tags:\s*$/m);
  assert.match(triggerSection, /^\s+- "v\*\.\*\.\*"\s*$/m);
  assert.doesNotMatch(triggerSection, /^\s+branches:/m);
  assert.doesNotMatch(triggerSection, /^\s+pull_request:/m);
  assert.doesNotMatch(triggerSection, /^\s+workflow_dispatch:/m);
  assert.doesNotMatch(triggerSection, /^\s+schedule:/m);
});

releaseTest('release workflow grants publish permission and builds/verifies artifacts before npm publish', () => {
  const workflow = readReleaseWorkflow();
  const permissionsSection = getTopLevelYamlSection(workflow, 'permissions');

  assert.match(permissionsSection, /^\s+contents:\s+read\s*$/m);
  assert.match(workflow, /release:[\s\S]*?permissions:\s*\n\s+contents:\s+write\s*\n\s+id-token:\s+write/m);
  assert.match(workflow, /node-version:\s+24\.18\.0/);
  assert.match(workflow, /npm install -g npm@11\.11\.0/);
  assert.match(workflow, /registry-url:\s+https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /NODE_AUTH_TOKEN:\s+\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
  assert.match(workflow, /npm publish "\$\{LOCAL_TGZ\}" --access public --provenance/);
  assert.match(workflow, /gh release view "\$\{GITHUB_REF_NAME\}"/);
  assert.match(workflow, /dist\.integrity/);
  assertContainsInOrder(workflow, [
    'run: npm test',
    'npm run verify:release -- --release-date',
    'name: Verify release tag matches package version',
    'name: Build release artifacts',
    'name: Sign coordinated update manifest',
    'name: Verify release artifact contents',
    'name: Publish npm package',
    'name: Verify npm package is published',
    'uses: softprops/action-gh-release@v2'
  ]);
});

releaseTest('release workflow accepts the stable tag or a numbered RC and rejects other tags', () => {
  const workflow = readReleaseWorkflow();

  assert.match(workflow, /stable_tag="v\$\{package_version\}"/);
  assert.match(workflow, /-rc\\\.\[1-9\]\[0-9\]\*/);
  assert.match(workflow, /Release tag \$\{GITHUB_REF_NAME\} must be \$\{stable_tag\} or \$\{stable_tag\}-rc\.N\./);
  assert.match(workflow, /echo "PACKAGE_VERSION=\$\{package_version\}" >> "\$\{GITHUB_ENV\}"/);
  assert.match(workflow, /echo "RELEASE_PRERELEASE=\$\{release_prerelease\}" >> "\$\{GITHUB_ENV\}"/);
  assertContainsInOrder(workflow, [
    'npm run verify:release -- --release-date',
    'name: Verify release tag matches package version',
    'name: Build release artifacts',
    'name: Verify release artifact contents',
    'name: Publish npm package',
    'name: Verify npm package is published'
  ]);
});

releaseTest('test workflow runs the test suite on macOS, Linux, and Windows', () => {
  const workflow = readTestWorkflow();

  assert.match(workflow, /^\s+strategy:\s*$/m);
  assert.match(workflow, /^\s+matrix:\s*$/m);
  assert.match(workflow, /^\s+os:\s+\[macos-latest,\s+ubuntu-latest,\s+windows-latest\]\s*$/m);
  assert.match(workflow, /^\s+runs-on:\s+\$\{\{ matrix\.os \}\}\s*$/m);
  assertContainsInOrder(workflow, [
    'run: npm test',
    'run: npm run verify:release',
    'run: npm run verify:npm-package',
    'run: npm run check:architecture'
  ]);
});

releaseTest('issue templates require task mode and release triage fields', () => {
  const taskModeOptions = [
    'Ask-only',
    'Suggest-edit',
    'Auto-write',
    'Compile',
    'Diagnostics',
    'Skills',
    'Install/update/uninstall',
    'Other'
  ];
  const requiredFields = [
    ['overleaf_page', 'input'],
    ['os_version_arch', 'input'],
    ['browser', 'input'],
    ['native_install_mode', 'dropdown'],
    ['extension_id', 'input'],
    ['extension_version', 'input'],
    ['native_version', 'input'],
    ['codex_cli_version', 'input'],
    ['node_version', 'input'],
    ['install_update_method', 'input'],
    ['project_shape', 'input'],
    ['task_mode', 'dropdown'],
    ['diagnostics_export', 'dropdown'],
    ['reproduction', 'textarea']
  ];

  for (const templateName of ['bug_report.yml', 'compatibility_report.yml']) {
    const template = readIssueTemplate(templateName);

    for (const [fieldId, fieldType] of requiredFields) {
      assertIssueTemplateRequiredField(template, fieldId, fieldType);
    }
    assert.deepEqual(getIssueTemplateOptions(template, 'task_mode'), taskModeOptions);
    assert.match(getIssueTemplateFieldBlock(template, 'browser'), /channel, version, and install mode/i);
    assert.match(getIssueTemplateFieldBlock(template, 'native_install_mode'), /Linux Chromium installer with --browser chromium/);
    assert.match(getIssueTemplateFieldBlock(template, 'native_host_logs'), /project ids/i);
    assert.match(getIssueTemplateFieldBlock(template, 'native_host_logs'), /tokens, and secrets|tokens, secrets/i);

    const redaction = getIssueTemplateFieldBlock(template, 'redaction');
    assert.match(redaction, /^  - type: checkboxes$/m);
    assert.match(redaction, /project text, prompt bodies, compile logs, raw diffs, binary content/i);
    assert.match(redaction, /diagnostics are local exports/i);
    assert.ok((redaction.match(/required: true/g) || []).length >= 2, 'redaction checklist should be required');
  }

  const compatibilityTemplate = readIssueTemplate('compatibility_report.yml');
  assertIssueTemplateRequiredField(compatibilityTemplate, 'failure_area', 'dropdown');
  assert.match(
    getIssueTemplateFieldBlock(compatibilityTemplate, 'compatibility_matrix_row'),
    /last smoke date\/result/i
  );
});

releaseTest('release workflow gates publishing on the cross-platform test matrix', () => {
  const workflow = readReleaseWorkflow();

  assertContainsInOrder(workflow, [
    'test-matrix:',
    'os: [macos-latest, ubuntu-latest, windows-latest]',
    'run: npm test',
    'release:',
    'needs: test-matrix',
    'uses: softprops/action-gh-release@v2'
  ]);
});

releaseTest('release workflow publishes generated notes and built artifacts', () => {
  const workflow = readReleaseWorkflow();

  assert.match(workflow, /uses:\s+softprops\/action-gh-release@v2/);
  assert.match(workflow, /^\s+draft:\s+false\s*$/m);
  assert.match(workflow, /^\s+prerelease:\s+\$\{\{ env\.RELEASE_PRERELEASE == 'true' \}\}\s*$/m);
  assert.match(workflow, /^\s+name:\s+\$\{\{ github\.ref_name \}\}\s*$/m);
  assert.match(
    workflow,
    /^\s+body_path:\s+\$\{\{ env\.RELEASE_DIR \}\}\/release-notes\.md\s*$/m
  );
  assert.match(workflow, /if:\s+env\.RELEASE_PRERELEASE != 'true'/);
  assertReleaseWorkflowUploadsExactArtifactSet(workflow);
  assert.match(workflow, /^\s+fail_on_unmatched_files:\s+true\s*$/m);
  assert.match(workflow, /^\s+overwrite_files:\s+false\s*$/m);
});

releaseTest('release workflow upload artifact gate rejects extra explicit files', () => {
  const workflow = readReleaseWorkflow();
  const workflowWithExtraUpload = workflow.replace(
    /^(\s+fail_on_unmatched_files:)/m,
    '            ${{ env.RELEASE_DIR }}/unchecked-extra.txt\n$1'
  );

  assert.throws(
    () => assertReleaseWorkflowUploadsExactArtifactSet(workflowWithExtraUpload),
    /unchecked-extra\.txt|deepStrictEqual|Expected values to be strictly deep-equal/
  );
});

releaseTest('release verifier catches package and extension manifest version mismatch', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-verify-'));
  try {
    writeReleaseFixture(tempDir, {
      packageVersion: '1.2.3',
      manifestVersion: '1.2.4'
    });
    const { collectReleaseVerificationErrors } = await importScriptModule('scripts/verify-release.mjs');

    const errors = collectReleaseVerificationErrors({
      rootDir: tempDir,
      releaseDate: '2026-05-06'
    });

    assert.ok(
      errors.some((error) => /manifest\.json version .*1\.2\.4.*package\.json version .*1\.2\.3/i.test(error)),
      errors.join('\n')
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release verifier follows package metadata and requires Windows installer source', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-current-'));
  try {
    writeReleaseFixture(tempDir, {
      packageVersion: ''
    });
    fs.rmSync(path.join(tempDir, 'install.ps1'));
    const { collectReleaseVerificationErrors } = await importScriptModule('scripts/verify-release.mjs');

    const errors = collectReleaseVerificationErrors({
      rootDir: tempDir,
      releaseDate: '2026-05-06'
    });

    assert.ok(errors.some((error) => /package\.json must define a release version/i.test(error)), errors.join('\n'));
    assert.ok(errors.some((error) => /install\.ps1 is required/i.test(error)), errors.join('\n'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release verifier catches BUILD_TARGET_VERSION mismatch (v1.6.2 single-source gate)', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-buildtarget-'));
  try {
    writeReleaseFixture(tempDir, { packageVersion: '1.2.3', buildTargetVersion: '1.2.2' });
    const { collectReleaseVerificationErrors } = await importScriptModule('scripts/verify-release.mjs');

    const errors = collectReleaseVerificationErrors({
      rootDir: tempDir,
      releaseDate: '2026-05-06'
    });

    assert.ok(
      errors.some((error) => /BUILD_TARGET_VERSION .*1\.2\.2.*package\.json version .*1\.2\.3/i.test(error)),
      errors.join('\n')
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release verifier catches README badge mismatch', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-readme-'));
  try {
    writeReleaseFixture(tempDir, {
      packageVersion: '1.2.3',
      readmeVersion: '1.2.4'
    });
    const { collectReleaseVerificationErrors } = await importScriptModule('scripts/verify-release.mjs');

    const errors = collectReleaseVerificationErrors({
      rootDir: tempDir,
      releaseDate: '2026-05-06'
    });

    assert.ok(
      errors.some((error) => /README\.md.*version-1\.2\.3-blue/i.test(error)),
      errors.join('\n')
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release verifier requires npm package metadata, lockfile, exact manifest, README, and upload docs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-npm-metadata-'));
  try {
    writeReleaseFixture(tempDir, {
      packageManager: undefined,
      repository: undefined,
      readmeText: '<img src="https://img.shields.io/badge/version-1.2.3-blue" alt="version">\n',
      packageVersion: '1.2.3'
    });
    fs.writeFileSync(
      path.join(tempDir, 'package-lock.json'),
      `${JSON.stringify({
        name: 'codex-overleaf-link',
        version: '1.2.2',
        packages: {
          '': {
            name: 'codex-overleaf-link',
            version: '1.2.2'
          }
        }
      }, null, 2)}\n`
    );
    const { collectReleaseVerificationErrors } = await importScriptModule('scripts/verify-release.mjs');

    const errors = collectReleaseVerificationErrors({
      rootDir: tempDir,
      releaseDate: '2026-05-06'
    });

    assert.ok(errors.some((error) => /package\.json must define packageManager/i.test(error)), errors.join('\n'));
    assert.ok(errors.some((error) => /package\.json must define repository\.url/i.test(error)), errors.join('\n'));
    assert.ok(errors.some((error) => /package-lock\.json lockfileVersion <missing> must be 3/i.test(error)), errors.join('\n'));
    assert.ok(errors.some((error) => /package-lock\.json version 1\.2\.2 must match package\.json version 1\.2\.3/i.test(error)), errors.join('\n'));
    assert.ok(errors.some((error) => /README\.md.*npm exec --yes codex-overleaf-link@1\.2\.3 -- install-native/i.test(error)), errors.join('\n'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release verifier rejects invalid package-lock lockfileVersion', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-lockfile-version-'));
  try {
    writeReleaseFixture(tempDir, {
      packageVersion: '1.2.3',
      lockfileVersion: 2
    });
    const { collectReleaseVerificationErrors } = await importScriptModule('scripts/verify-release.mjs');

    const errors = collectReleaseVerificationErrors({
      rootDir: tempDir,
      releaseDate: '2026-05-06'
    });

    assert.ok(
      errors.some((error) => /package-lock\.json lockfileVersion 2 must be 3/i.test(error)),
      errors.join('\n')
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release verifier catches CHANGELOG heading date mismatch', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-changelog-'));
  try {
    writeReleaseFixture(tempDir, {
      packageVersion: '1.2.3',
      changelogDate: '2026-05-07'
    });
    const { collectReleaseVerificationErrors } = await importScriptModule('scripts/verify-release.mjs');

    const errors = collectReleaseVerificationErrors({
      rootDir: tempDir,
      releaseDate: '2026-05-06'
    });

    assert.ok(
      errors.some((error) => /CHANGELOG\.md.*## v1\.2\.3 - 2026-05-06/i.test(error)),
      errors.join('\n')
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release verifier accepts changelog date from package release heading by default', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-dynamic-date-'));
  try {
    writeReleaseFixture(tempDir, {
      packageVersion: '0.9.0',
      changelogDate: '2026-05-07'
    });
    const { collectReleaseVerificationErrors } = await importScriptModule('scripts/verify-release.mjs');

    const errors = collectReleaseVerificationErrors({
      rootDir: tempDir
    });

    assert.deepEqual(errors, []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release verifier rejects forbidden tracked internal and private files', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-forbidden-'));
  try {
    writeReleaseFixture(tempDir, {
      packageVersion: '0.9.0',
      changelogDate: '2026-05-07'
    });
    const { collectReleaseVerificationErrors } = await importScriptModule('scripts/verify-release.mjs');

    const forbiddenPaths = [
      '.local/release-process.md',
      'ROADMAP.md',
      'docs/manual-extension/release-checklist.md',
      'docs/chrome-web-store/privacy.md',
      'docs/superpowers/specs/internal.md',
      'scripts/npm-package-files-v1.2.3.txt',
      'dist/releases/private.zip',
      'build/tmp.txt',
      'native-host/bin/local-bridge',
      '.worktrees/local-work/release.md',
      'worktrees/local-work/release.md',
      'secret.pem',
      'cert.key',
      'profile.p12',
      'extension.crx',
      'debug.log',
      'state.sqlite'
    ];
    const errors = collectReleaseVerificationErrors({
      rootDir: tempDir,
      releaseDate: '2026-05-07',
      trackedFiles: [
        'README.md',
        ...forbiddenPaths
      ]
    });

    for (const relativePath of forbiddenPaths) {
      assert.ok(
        errors.some((error) => error.includes(relativePath)),
        `Expected ${relativePath} to be rejected.\n${errors.join('\n')}`
      );
    }
    assert.equal(
      errors.some((error) => error.includes('README.md')),
      false,
      errors.join('\n')
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release verifier rejects private files from packaged source trees without blocking normal inputs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-packaged-private-'));
  try {
    writeReleaseFixture(tempDir, {
      packageVersion: '0.9.0',
      changelogDate: '2026-05-07'
    });
    const { collectReleaseVerificationErrors } = await importScriptModule('scripts/verify-release.mjs');

    const allowedPackagedPaths = [
      'extension/manifest.json',
      'extension/src/contentScript.js',
      'extension/src/shared/sessionState.js',
      'native-host/src/taskRunner.js',
      'native-host/src/nativeHostPlatform.js'
    ];
    const forbiddenPackagedPaths = [
      'extension/src/private-notes.md',
      'extension/src/internal/spec.md',
      'extension/.env',
      'native-host/src/credentials.json',
      'native-host/src/release-plan.md',
      'native-host/src/debug.log'
    ];
    const errors = collectReleaseVerificationErrors({
      rootDir: tempDir,
      releaseDate: '2026-05-07',
      trackedFiles: [
        ...allowedPackagedPaths,
        ...forbiddenPackagedPaths
      ]
    });

    for (const relativePath of forbiddenPackagedPaths) {
      assert.ok(
        errors.some((error) => error.includes(relativePath)),
        `Expected ${relativePath} to be rejected.\n${errors.join('\n')}`
      );
    }
    for (const relativePath of allowedPackagedPaths) {
      assert.equal(
        errors.some((error) => error.includes(relativePath)),
        false,
        `Expected ${relativePath} to remain allowed.\n${errors.join('\n')}`
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release verifier does not require manual extension docs in public source', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-no-public-docs-'));
  try {
    writeReleaseFixture(tempDir, {
      packageVersion: '0.9.0',
      changelogDate: '2026-05-07'
    });
    const { collectReleaseVerificationErrors } = await importScriptModule('scripts/verify-release.mjs');

    assert.deepEqual(collectReleaseVerificationErrors({ rootDir: tempDir, releaseDate: '2026-05-07' }), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release verifier CLI exits 1 on metadata mismatch', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-cli-'));
  try {
    writeReleaseFixture(tempDir, {
      packageVersion: '1.2.3',
      manifestVersion: '1.2.4'
    });

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/verify-release.mjs'),
      '--root',
      tempDir
    ], {
      encoding: 'utf8'
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Release verification failed/);
    assert.match(result.stderr, /extension\/manifest\.json version 1\.2\.4/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('build-release derives the default output directory from version', async () => {
  const { getDefaultReleaseOutputDir } = await importScriptModule('scripts/build-release.mjs');

  assert.equal(
    getDefaultReleaseOutputDir({ rootDir: '/tmp/codex-overleaf-link', version: '1.2.3' }),
    path.join('/tmp/codex-overleaf-link', 'dist/releases/v1.2.3')
  );
});

releaseTest('build-release rejects unsafe output paths before deletion', async () => {
  const { assertSafeReleaseOutputDir } = await importScriptModule('scripts/build-release.mjs');
  const unsafePaths = [
    repoRoot,
    path.dirname(repoRoot),
    path.parse(repoRoot).root,
    os.homedir()
  ];

  for (const outputDir of unsafePaths) {
    assert.throws(
      () => assertSafeReleaseOutputDir({ rootDir: repoRoot, outputDir }),
      /Refusing to use unsafe release output directory/
    );
  }

  assert.doesNotThrow(() => assertSafeReleaseOutputDir({
    rootDir: repoRoot,
    outputDir: path.join(os.tmpdir(), `codex-overleaf-fresh-output-${process.pid}`)
  }));
});

releaseTest('build-release refuses unmarked non-empty custom output directories without deleting them', async () => {
  const { buildRelease } = await importScriptModule('scripts/build-release.mjs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-unsafe-output-'));
  const outputDir = path.join(tempDir, 'existing-output');
  const sentinelPath = path.join(outputDir, 'keep.txt');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(sentinelPath, 'keep this file\n');

  try {
    let error;
    try {
      buildRelease({ rootDir: repoRoot, outputDir });
    } catch (caught) {
      error = caught;
    }

    assert.match(error && error.message, /non-empty release output directory/);
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'keep this file\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('build-release argument parser rejects missing values and unknown flags', async () => {
  const { parseBuildReleaseArgs } = await importScriptModule('scripts/build-release.mjs');

  assert.throws(() => parseBuildReleaseArgs(['--output']), /--output requires a path value/);
  assert.throws(() => parseBuildReleaseArgs(['--output', '--unknown']), /--output requires a path value/);
  assert.throws(() => parseBuildReleaseArgs(['--unknown']), /Unknown option: --unknown/);
});

releaseTest('build-release CLI exits non-zero on unknown flags before building', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-bad-args-'));
  const outputDir = path.join(tempDir, 'out');
  try {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/build-release.mjs'),
      '--output',
      outputDir,
      '--unknown'
    ], {
      cwd: repoRoot,
      env: releaseTrackedInputEnv(),
      encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown option: --unknown/);
    assert.match(result.stderr, /Usage: node scripts\/build-release\.mjs/);
    assert.equal(fs.existsSync(outputDir), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release note extraction fails for missing or empty changelog sections', async () => {
  const { extractReleaseNotes } = await importScriptModule('scripts/build-release.mjs');

  assert.throws(
    () => extractReleaseNotes('# Changelog\n\n## v1.2.2 - 2026-05-05\n\nPrevious notes.\n', '1.2.3'),
    /does not contain a release section for v1\.2\.3/
  );
  assert.throws(
    () => extractReleaseNotes('# Changelog\n\n## v1.2.3 - 2026-05-06\n\n## v1.2.2 - 2026-05-05\n\nPrevious notes.\n', '1.2.3'),
    /release section for v1\.2\.3 is empty/
  );
});

releaseTest('build-release refuses an untracked Windows installer source', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-untracked-ps1-'));
  const outputDir = path.join(tempDir, 'out');
  try {
    const fixtureRoot = path.join(tempDir, 'repo');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    writeMinimalReleaseBuildFixture(fixtureRoot, {
      untracked: ['install.ps1']
    });
    const { buildRelease } = await importScriptModule('scripts/build-release.mjs');

    assert.throws(
      () => buildRelease({ rootDir: fixtureRoot, outputDir, allowDirtyReleaseInputs: true }),
      /Required release file is not git-tracked: install\.ps1/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('build-release refuses an untracked required native runtime helper', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-untracked-native-'));
  const outputDir = path.join(tempDir, 'out');
  try {
    const fixtureRoot = path.join(tempDir, 'repo');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    writeMinimalReleaseBuildFixture(fixtureRoot, {
      untracked: ['native-host/src/nativeHostPlatform.js']
    });
    const { buildRelease } = await importScriptModule('scripts/build-release.mjs');

    assert.throws(
      () => buildRelease({ rootDir: fixtureRoot, outputDir, allowDirtyReleaseInputs: true }),
      /Required release file is not git-tracked: native-host\/src\/nativeHostPlatform\.js/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('top-level copied uninstaller runs from release artifact root', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-uninstall-'));
  const outputDir = path.join(tempDir, 'out');
  const homeDir = path.join(tempDir, 'home');
  const runtimeRoot = path.join(tempDir, 'runtime');
  const bridgePath = path.join(tempDir, 'codex-overleaf-bridge');

  try {
    const build = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/build-release.mjs'),
      '--output',
      outputDir
    ], {
      cwd: repoRoot,
      env: releaseBuildEnv(),
      encoding: 'utf8'
    });

    if (build.status !== 0 && /required command "zip"|zip is required/i.test(build.stderr)) {
      t.skip('zip is required to build release artifacts');
      return;
    }
    assert.equal(build.status, 0, build.stderr || build.stdout);

    fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
    fs.writeFileSync(bridgePath, '#!/bin/sh\n');
    fs.mkdirSync(runtimeRoot, { recursive: true });

    const result = spawnSync(process.execPath, [
      path.join(outputDir, 'uninstall-native-host.mjs'),
      '--runtime-root',
      runtimeRoot,
      '--bridge-path',
      bridgePath,
      '--keep-runtime'
    ], {
      env: {
        ...process.env,
        HOME: homeDir
      },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(bridgePath), false);
    assert.equal(fs.existsSync(runtimeRoot), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release archives exclude untracked files under packaged directories', (t) => {
  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const version = pkg.version;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-untracked-'));
  const outputDir = path.join(tempDir, 'out');
  const uniqueName = `codex-overleaf-untracked-${process.pid}-${Date.now()}.js`;
  const extensionUntracked = path.join(repoRoot, 'extension/src/shared', uniqueName);
  const nativeUntracked = path.join(repoRoot, 'native-host/src', uniqueName);
  const assetUntrackedName = uniqueName.replace(/\.js$/, '.txt');
  const assetUntracked = path.join(repoRoot, 'extension/assets', assetUntrackedName);

  try {
    fs.writeFileSync(extensionUntracked, 'window.__codexOverleafUntracked = true;\n');
    fs.writeFileSync(nativeUntracked, 'module.exports = true;\n');
    fs.writeFileSync(assetUntracked, 'untracked asset\n');

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/build-release.mjs'),
      '--output',
      outputDir
    ], {
      cwd: repoRoot,
      env: releaseBuildEnv(),
      encoding: 'utf8'
    });

    if (result.status !== 0 && /required command "zip"|zip is required/i.test(result.stderr)) {
      t.skip('zip is required to build release artifacts');
      return;
    }
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const zipEntries = listZipEntries(path.join(outputDir, `codex-overleaf-link-extension-v${version}.zip`), t);
    assert.equal(zipEntries.includes(`runtime/src/shared/${uniqueName}`), false);
    assert.equal(zipEntries.includes(`assets/${assetUntrackedName}`), false);

    const tarEntries = listTarEntries(path.join(outputDir, `codex-overleaf-native-host-v${version}.tar.gz`));
    assert.equal(tarEntries.includes(`extension/src/shared/${uniqueName}`), false);
    assert.equal(tarEntries.includes(`native-host/src/${uniqueName}`), false);
  } finally {
    fs.rmSync(extensionUntracked, { force: true });
    fs.rmSync(nativeUntracked, { force: true });
    fs.rmSync(assetUntracked, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('build-release refuses dirty tracked packaged files before writing artifacts', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-dirty-tracked-'));
  const outputDir = path.join(tempDir, 'out');
  const trackedFile = path.join(repoRoot, 'extension/src/shared/summary.js');
  const originalContent = fs.readFileSync(trackedFile);

  try {
    fs.writeFileSync(
      trackedFile,
      Buffer.concat([originalContent, Buffer.from('\n// codex-overleaf dirty release test\n')])
    );

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/build-release.mjs'),
      '--output',
      outputDir
    ], {
      cwd: repoRoot,
      env: releaseTrackedInputEnv(),
      encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tracked release input files have uncommitted changes/i);
    assert.match(result.stderr, /commit or stash/i);
    assert.match(result.stderr, /extension\/src\/shared\/summary\.js/);
    assert.equal(fs.existsSync(path.join(outputDir, 'release-manifest.json')), false);
    assert.equal(fs.existsSync(path.join(outputDir, `codex-overleaf-link-extension-v${readJson(path.join(repoRoot, 'package.json')).version}.zip`)), false);
  } finally {
    fs.writeFileSync(trackedFile, originalContent);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('build-release refuses packaged files staged for deletion from HEAD', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-staged-delete-'));
  const outputDir = path.join(tempDir, 'out');
  const relativePath = 'extension/src/shared/summary.js';
  const trackedFile = path.join(repoRoot, relativePath);
  const originalContent = fs.readFileSync(trackedFile);
  const gitEnv = releaseTrackedInputEnv({
    GIT_INDEX_FILE: createReleaseTestIndexPath()
  });

  try {
    const removeResult = spawnSync('git', ['rm', '--cached', relativePath], {
      cwd: repoRoot,
      env: gitEnv,
      encoding: 'utf8'
    });
    assert.equal(removeResult.status, 0, removeResult.stderr || removeResult.stdout);
    assert.equal(fs.existsSync(trackedFile), true);

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/build-release.mjs'),
      '--output',
      outputDir
    ], {
      cwd: repoRoot,
      env: gitEnv,
      encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tracked release input files have uncommitted changes/i);
    assert.match(result.stderr, /commit or stash/i);
    assert.match(result.stderr, /extension\/src\/shared\/summary\.js/);
    assert.equal(fs.existsSync(path.join(outputDir, 'release-manifest.json')), false);
    assert.equal(fs.existsSync(path.join(outputDir, `codex-overleaf-link-extension-v${readJson(path.join(repoRoot, 'package.json')).version}.zip`)), false);
  } finally {
    fs.writeFileSync(trackedFile, originalContent);
    fs.writeFileSync(trackedFile, originalContent);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('build-release creates expected artifacts and metadata', (t) => {
  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const version = pkg.version;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-build-'));
  const outputDir = path.join(tempDir, 'out');
  const extensionZip = `codex-overleaf-link-extension-v${version}.zip`;
  const nativeTarball = `codex-overleaf-native-host-v${version}.tar.gz`;
  const npmTarball = `codex-overleaf-link-${version}.tgz`;
  const updateBundle = `codex-overleaf-update-v${version}.tar.gz`;
  const helperArtifacts = [
    'nativeHostPlatform.js',
    'manifest.js',
    'runtimeInstaller.js'
  ];

  try {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/build-release.mjs'),
      '--output',
      outputDir
    ], {
      cwd: repoRoot,
      env: releaseBuildEnv(),
      encoding: 'utf8'
    });

    if (result.status !== 0 && /required command "zip"|zip is required/i.test(result.stderr)) {
      t.skip('zip is required to build release artifacts');
      return;
    }
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const expectedFiles = [
      extensionZip,
      nativeTarball,
      npmTarball,
      updateBundle,
      'install.sh',
      'install.ps1',
      'uninstall-native-host.mjs',
      ...helperArtifacts,
      'release-manifest.json',
      'release-notes.md',
      'SHA256SUMS'
    ];
    for (const fileName of expectedFiles) {
      assert.equal(fs.existsSync(path.join(outputDir, fileName)), true, `${fileName} was not generated`);
    }

    const manifest = readJson(path.join(outputDir, 'release-manifest.json'));
    assert.equal(manifest.version, version);
    assert.match(manifest.gitCommit, /^(unknown|[0-9a-f]{40})$/);
    assert.doesNotThrow(() => new Date(manifest.createdAt).toISOString());
    assert.deepEqual(
      manifest.artifacts.map((artifact) => artifact.name).sort(),
      [
        extensionZip,
        nativeTarball,
        npmTarball,
        updateBundle,
        'install.sh',
        'install.ps1',
        'uninstall-native-host.mjs',
        ...helperArtifacts
      ].sort()
    );
    for (const artifact of manifest.artifacts) {
      const artifactPath = path.join(outputDir, artifact.name);
      assert.equal(artifact.size, fs.statSync(artifactPath).size);
      assert.equal(artifact.sha256, sha256(artifactPath));
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    }

    const releaseNotes = fs.readFileSync(path.join(outputDir, 'release-notes.md'), 'utf8');
    assert.match(releaseNotes, new RegExp(`^## v${version.replace(/\./g, '\\.')} - `));
    assert.match(releaseNotes, new RegExp(`npm exec --yes codex-overleaf-link@${version.replace(/\./g, '\\.')} -- install-native`));
    assert.match(releaseNotes, new RegExp(`npm exec --yes codex-overleaf-link@${version.replace(/\./g, '\\.')} -- doctor`));
    assert.match(releaseNotes, new RegExp(`npm exec --yes codex-overleaf-link@${version.replace(/\./g, '\\.')} -- uninstall-native`));
    assert.doesNotMatch(releaseNotes, /\n## v0\.2\.0 - /);

    const sums = fs.readFileSync(path.join(outputDir, 'SHA256SUMS'), 'utf8').trim().split('\n');
    const checksumNames = sums.map((line) => line.replace(/^[0-9a-f]{64}\s+\*?/, ''));
    assert.deepEqual(
      checksumNames.sort(),
      [
        extensionZip,
        nativeTarball,
        npmTarball,
        updateBundle,
        'install.sh',
        'install.ps1',
        'uninstall-native-host.mjs',
        ...helperArtifacts,
        'release-manifest.json',
        'release-notes.md'
      ].sort()
    );
    assert.equal(checksumNames.includes('SHA256SUMS'), false);
    for (const line of sums) {
      assert.match(line, /^[0-9a-f]{64}  \S/);
      const fileName = line.replace(/^[0-9a-f]{64}\s+/, '');
      assert.equal(line.slice(0, 64), sha256(path.join(outputDir, fileName)));
    }
    assert.equal(fs.existsSync(path.join(repoRoot, npmTarball)), false, `${npmTarball} should not be left in the package root`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('build-release writes a version-pinned install artifact while root installer stays source-oriented', (t) => {
  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const version = pkg.version;
  const releaseRef = `v${version}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-install-ref-'));
  const outputDir = path.join(tempDir, 'out');
  const binDir = path.join(tempDir, 'bin');
  const installDir = path.join(tempDir, 'source');
  const visibleExtensionLink = path.join(tempDir, 'Codex Overleaf Link Extension');
  const nodeLog = path.join(tempDir, 'node-args.txt');
  const gitLog = path.join(tempDir, 'git-args.txt');
  const openLog = path.join(tempDir, 'open-args.txt');
  const pbcopyLog = path.join(tempDir, 'pbcopy-input.txt');

  try {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/build-release.mjs'),
      '--output',
      outputDir
    ], {
      cwd: repoRoot,
      env: releaseBuildEnv(),
      encoding: 'utf8'
    });

    if (result.status !== 0 && /required command "zip"|zip is required/i.test(result.stderr)) {
      t.skip('zip is required to build release artifacts');
      return;
    }
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const rootInstaller = readText(path.join(repoRoot, 'install.sh'));
    const releaseInstaller = readText(path.join(outputDir, 'install.sh'));
    const rootWindowsInstaller = readText(path.join(repoRoot, 'install.ps1'));
    const releaseWindowsInstaller = readText(path.join(outputDir, 'install.ps1'));
    assert.match(rootInstaller, /REF="\$\{CODEX_OVERLEAF_REF:-main\}"/);
    assert.match(releaseInstaller, new RegExp(`REF="\\$\\{CODEX_OVERLEAF_REF:-${releaseRef}\\}"`));
    assert.doesNotMatch(releaseInstaller, /REF="\$\{CODEX_OVERLEAF_REF:-main\}"/);
    assert.match(rootWindowsInstaller, /\$DefaultRef = 'main'/);
    assert.match(releaseWindowsInstaller, new RegExp(`\\$DefaultRef = '${releaseRef}'`));
    assert.doesNotMatch(releaseWindowsInstaller, /\$DefaultRef = 'main'/);

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'git'), [
      '#!/bin/bash',
      `printf '%s\\n' "$*" >> "${gitLog}"`,
      'if [ "$1" = "clone" ]; then',
      '  target=""',
      '  for arg in "$@"; do target="$arg"; done',
      '  mkdir -p "$target/.git"',
      '  mkdir -p "$target/extension"',
      `  printf '{"version":"${version}"}\\n' > "$target/package.json"`,
      'fi',
      'exit 0'
    ].join('\n'));
    fs.writeFileSync(path.join(binDir, 'node'), [
      '#!/bin/bash',
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > "${nodeLog}"`,
      `echo '{"version":"${version}","extensionRoot":"'"$HOME"'/.codex-overleaf/managed/extension","nativeRoot":"'"$HOME"'/.codex-overleaf/managed/native"}'`,
      'exit 0'
    ].join('\n'));
    fs.writeFileSync(path.join(binDir, 'open'), [
      '#!/bin/bash',
      `printf '%s\\n' "$*" >> "${openLog}"`,
      'exit 0'
    ].join('\n'));
    fs.writeFileSync(path.join(binDir, 'pbcopy'), [
      '#!/bin/bash',
      `cat > "${pbcopyLog}"`,
      'exit 0'
    ].join('\n'));
    for (const command of ['git', 'node', 'open', 'pbcopy']) {
      fs.chmodSync(path.join(binDir, command), 0o755);
    }

    const installResult = spawnSync('/bin/bash', [path.join(outputDir, 'install.sh')], {
      env: {
        HOME: tempDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        CODEX_OVERLEAF_REPO_URL: 'https://example.invalid/repo.git',
        CODEX_OVERLEAF_INSTALL_DIR: installDir,
        CODEX_OVERLEAF_EXTENSION_LINK: visibleExtensionLink
      },
      encoding: 'utf8'
    });

    assert.equal(installResult.status, 0, installResult.stderr || installResult.stdout);
    assert.match(installResult.stdout, new RegExp(`CODEX_OVERLEAF_REF: ${releaseRef}`));
    assert.match(readText(gitLog), new RegExp(`fetch --depth 1 origin ${releaseRef}`));
    assert.match(readText(nodeLog), /scripts\/install-managed\.mjs/);
    assert.match(readText(nodeLog), /--json/);
    assert.match(readText(openLog), /chrome:\/\/extensions/);
    assert.equal(readText(pbcopyLog), visibleExtensionLink);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('native host tarball includes only runtime categories', (t) => {
  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const version = pkg.version;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-native-'));
  const outputDir = path.join(tempDir, 'out');

  try {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/build-release.mjs'),
      '--output',
      outputDir
    ], {
      cwd: repoRoot,
      env: releaseBuildEnv(),
      encoding: 'utf8'
    });

    if (result.status !== 0 && /required command "zip"|zip is required/i.test(result.stderr)) {
      t.skip('zip is required to build release artifacts');
      return;
    }
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const entries = listTarEntries(path.join(outputDir, `codex-overleaf-native-host-v${version}.tar.gz`));
    assert.ok(entries.includes('package.json'));
    assert.ok(entries.some((entry) => entry.startsWith('native-host/src/')));
    assert.ok(entries.some((entry) => entry.startsWith('extension/src/shared/')));
    assert.ok(entries.includes('scripts/codex-json-agent.mjs'));
    assert.ok(entries.includes('install.sh'));
    assert.ok(entries.includes('install.ps1'));
    assert.ok(entries.includes('scripts/uninstall-native-host.mjs'));

    const forbiddenPatterns = [
      /^test\//,
      /^docs\//,
      /^\.git(?:\/|$)/,
      /(^|\/)\.DS_Store$/,
      /^dist\//,
      /^extension\/manifest\.json$/,
      /^extension\/popup\.html$/,
      /^extension\/assets\//,
      /^extension\/styles\//,
      /^extension\/src\/(?:background|content|page|popup|contentScript|pageBridge)/
    ];
    for (const pattern of forbiddenPatterns) {
      assert.equal(entries.some((entry) => pattern.test(entry)), false, `unexpected native tarball entry matching ${pattern}`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('extension zip includes loadable extension files and excludes repository/native files', (t) => {
  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const version = pkg.version;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-release-extension-'));
  const outputDir = path.join(tempDir, 'out');

  try {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/build-release.mjs'),
      '--output',
      outputDir
    ], {
      cwd: repoRoot,
      env: releaseBuildEnv(),
      encoding: 'utf8'
    });

    if (result.status !== 0 && /required command "zip"|zip is required/i.test(result.stderr)) {
      t.skip('zip is required to build release artifacts');
      return;
    }
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const entries = listZipEntries(path.join(outputDir, `codex-overleaf-link-extension-v${version}.zip`), t);
    assert.ok(entries.includes('manifest.json'));
    assert.ok(entries.includes('bootstrap/background.js'));
    assert.ok(entries.includes('bootstrap/popup.html'));
    assert.ok(entries.includes('runtime/runtime-manifest.json'));
    assert.ok(entries.some((entry) => entry.startsWith('runtime/src/')));
    assert.ok(entries.some((entry) => entry.startsWith('runtime/styles/')));
    assert.ok(entries.some((entry) => entry.startsWith('assets/')));

    const forbiddenPatterns = [
      /^test\//,
      /^docs\//,
      /^\.git(?:\/|$)/,
      /(^|\/)\.DS_Store$/,
      /^dist\//,
      /^native-host\//,
      /^scripts\//,
      /^package\.json$/,
      /^install\.sh$/,
      /^install\.ps1$/
    ];
    for (const pattern of forbiddenPatterns) {
      assert.equal(entries.some((entry) => pattern.test(entry)), false, `unexpected extension zip entry matching ${pattern}`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

releaseTest('release workflow builds and verifies artifacts before npm publish with retrying npm visibility', () => {
  const workflow = readReleaseWorkflow();

  assertContainsInOrder(workflow, [
    'name: Verify release metadata',
    'name: Verify release tag matches package version',
    'name: Build release artifacts',
    'name: Sign coordinated update manifest',
    'name: Verify release artifact contents',
    'name: Publish npm package',
    'name: Verify npm package is published',
    'name: Publish GitHub release'
  ]);
  assert.match(workflow, /npm run verify:release-artifacts/);
  assert.match(workflow, /for attempt in 1 2 3 4 5 6 7 8 9 10 11 12;/);
  assert.match(workflow, /sleep 5/);
  assert.match(workflow, /overwrite_files:\s*false/);
});

releaseTest('release artifact verifier is wired as an npm script and checks archives', () => {
  const packageJson = readJson(path.join(repoRoot, 'package.json'));
  const verifier = readText(path.join(repoRoot, 'scripts/verify-release-artifacts.mjs'));

  assert.equal(packageJson.scripts['verify:release-artifacts'], 'node scripts/verify-release-artifacts.mjs');
  assert.match(verifier, /codex-overleaf-link-extension-v\$\{version\}\.zip/);
  assert.match(verifier, /codex-overleaf-native-host-v\$\{version\}\.tar\.gz/);
  assert.match(verifier, /verifyPackagePaths/);
  assert.match(verifier, /SHA256SUMS/);
  assert.match(verifier, /FORBIDDEN_ARCHIVE_PATTERNS/);
});
