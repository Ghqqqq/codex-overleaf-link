const fs = require('node:fs');
const path = require('node:path');

const { extractFunction } = require('./extractFunction');

const CONTENT_DIR = path.join(__dirname, '..', '..', 'extension', 'src', 'content');
const SHARED_DIR = path.join(__dirname, '..', '..', 'extension', 'src', 'shared');

const CONTENT_SCRIPT_PATH = path.join(CONTENT_DIR, 'contentRuntime.js');

// The v1.4.5 structural-debt carve moved cohesive clusters out of
// contentRuntime.js into sibling modules. Source-contract tests treat the
// runtime + its carved modules as one logical source, so functions keep
// matching wherever they live. Modules come first so extractFunction finds the
// real implementation, never a same-named runtime binding.
const CONTENT_SOURCE_PATHS = [
  path.join(SHARED_DIR, 'runExecutionSnapshot.js'),
  path.join(SHARED_DIR, 'writebackSettlement.js'),
  path.join(CONTENT_DIR, 'markdownText.js'),
  path.join(CONTENT_DIR, 'diagnosticsController.js'),
  path.join(CONTENT_DIR, 'runTimelineView.js'),
  path.join(CONTENT_DIR, 'projectSettingsCoordinator.js'),
  path.join(CONTENT_DIR, 'sessionMenuView.js'),
  path.join(CONTENT_DIR, 'sessionManager.js'),
  path.join(CONTENT_DIR, 'applyResultFormatters.js'),
  path.join(CONTENT_DIR, 'modelPicker.js'),
  path.join(CONTENT_DIR, 'recentProjects.js'),
  path.join(CONTENT_DIR, 'otWarmMirror.js'),
  path.join(CONTENT_DIR, 'writebackOrchestrator.js'),
  path.join(CONTENT_DIR, 'panelMaintenance.js'),
  CONTENT_SCRIPT_PATH
];

let cachedSource = null;

/**
 * Returns the concatenated contentRuntime.js + carved-module source text, read
 * once per process and cached. test/p0ProductExperience.test.js reads this
 * ~12k-line surface ~22 times; centralizing the read reduces I/O and removes
 * the `path.join(__dirname, '..', 'extension', 'src', 'content', ...)` ritual
 * from every source-grep test.
 */
function getContentScriptSource() {
  if (cachedSource === null) {
    cachedSource = CONTENT_SOURCE_PATHS
      .map(sourcePath => fs.readFileSync(sourcePath, 'utf8'))
      .join('\n');
  }
  return cachedSource;
}

/**
 * Convenience wrapper for the common pattern:
 *   const src = getContentScriptSource();
 *   const body = extractFunction(src, name);
 */
function extractFromContentScript(name) {
  return extractFunction(getContentScriptSource(), name);
}

module.exports = {
  CONTENT_SCRIPT_PATH,
  CONTENT_SOURCE_PATHS,
  getContentScriptSource,
  extractFromContentScript
};
