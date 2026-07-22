const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

async function loadBudgetModule() {
  return import(pathToFileURL(path.join(repoRoot, 'scripts/check-architecture-budget.mjs')).href);
}

function writeLines(rootDir, relativePath, lines) {
  const fullPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, Array.from({ length: lines }, (_, index) => `line ${index}`).join('\n'), 'utf8');
}

test('architecture budget tracks v1.0 final split targets for the largest files', async () => {
  const { ARCHITECTURE_FILE_BUDGETS } = await loadBudgetModule();
  assert.deepEqual(
    ARCHITECTURE_FILE_BUDGETS.map(entry => [entry.path, entry.maxLines]),
    [
      ['extension/src/contentScript.js', 4500],
      ['extension/src/pageBridge.js', 2000],
      ['extension/src/page/saveState.js', 350],
      ['extension/src/content/contentRuntime.js', 8700],
      ['extension/src/content/projectSettingsCoordinator.js', 420],
      ['extension/src/content/projectProviderSelection.js', 120],
      ['extension/src/content/sessionPersistence.js', 140],
      ['extension/src/content/runGuidanceController.js', 120],
      ['extension/src/content/sessionMenuView.js', 280],
      ['extension/src/content/panelMaintenance.js', 420],
      ['extension/src/content/markdownText.js', 700],
      ['extension/src/content/diagnosticsController.js', 700],
      ['extension/src/content/runTimelineView.js', 1160],
      ['extension/src/content/sessionManager.js', 320],
      ['extension/src/content/applyResultFormatters.js', 450],
      ['extension/src/content/modelPicker.js', 550],
      ['extension/src/content/recentProjects.js', 1080],
      ['extension/src/content/otWarmMirror.js', 1000],
      ['extension/src/content/writebackOrchestrator.js', 880],
      ['extension/src/page/writebackRouter.js', 1950],
      ['extension/src/page/trackedChangesLifecycle.js', 1650],
      ['extension/src/page/treeOperations.js', 1650],
      ['extension/src/shared/storageDb.js', 1350],
      ['native-host/src/codexSessionRunner.js', 1500],
      ['native-host/src/subagentBroker.js', 640],
      ['native-host/src/taskRunner.js', 1000]
    ]
  );
});

test('architecture budget has no current ceiling exceptions in v1.0 mode', async () => {
  const { ARCHITECTURE_FILE_BUDGETS, collectArchitectureBudgetResults } = await loadBudgetModule();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-budget-'));
  try {
    for (const entry of ARCHITECTURE_FILE_BUDGETS) {
      assert.equal(Object.hasOwn(entry, 'currentCeiling'), false, `${entry.path} should not keep currentCeiling`);
      assert.equal(Object.hasOwn(entry, 'exception'), false, `${entry.path} should not keep exception text`);
      writeLines(rootDir, entry.path, entry.maxLines);
    }
    const results = collectArchitectureBudgetResults({ rootDir });
    assert.equal(results.every(result => result.ceiling === result.maxLines), true);
    assert.equal(results.every(result => result.targetMet), true);
    assert.equal(results.every(result => !Object.hasOwn(result, 'currentCeiling')), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('architecture budget defaults to final target enforcement', async () => {
  const { ARCHITECTURE_FILE_BUDGETS, collectArchitectureBudgetErrors } = await loadBudgetModule();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-budget-'));
  try {
    for (const entry of ARCHITECTURE_FILE_BUDGETS) {
      writeLines(rootDir, entry.path, entry.maxLines + 1);
    }
    const errors = collectArchitectureBudgetErrors({ rootDir });
    assert.equal(errors.length, ARCHITECTURE_FILE_BUDGETS.length);
    assert.ok(errors.every(error => error.includes('limit is')));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
