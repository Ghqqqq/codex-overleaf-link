const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'extension/bootstrap/background.js'), 'utf8');
const contentRuntimeSource = fs.readFileSync(path.join(root, 'extension/src/content/contentRuntime.js'), 'utf8');
const updateIdleSource = fs.readFileSync(path.join(root, 'extension/src/content/updateIdle.js'), 'utf8');
const manifest = require('../extension/bootstrap/manifest.template.json');
const runtimeManifest = require('../extension/runtime-manifest.json');

test('managed Bootstrap owns alarms, scripting and native messaging while runtime stays replaceable', () => {
  assert.equal(manifest.permissions.includes('alarms'), true);
  assert.equal(manifest.permissions.includes('scripting'), true);
  assert.equal(manifest.permissions.includes('nativeMessaging'), true);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.background.service_worker, 'bootstrap/background.js');
  assert.match(source, /registerContentScripts/);
  assert.match(source, /persistAcrossSessions:\s*true/);
  assert.match(source, /chrome\.runtime\.reload\(\)/);
});

test('safe-point probing recovers stale runtime tabs without reloading editor documents', () => {
  assert.match(source, /isEditorProjectTab\(tab\)/);
  assert.match(source, /\^\\\/project\\\/\[\^\/\]\+/);
  assert.match(source, /tab\.discarded \|\| tab\.status === 'unloaded'/);
  assert.match(source, /injectManagedRuntimeIntoTab/);
  assert.match(source, /chrome\.scripting\.insertCSS/);
  assert.match(source, /chrome\.scripting\.executeScript/);
  assert.match(source, /const recoveredProbe = await sendTabIdleProbe/);
  assert.doesNotMatch(source.match(/async function probeTabIdle[\s\S]*?\n}\n\nasync function confirmPendingUpdate/)?.[0] || '', /chrome\.tabs\.reload/);
});

test('safe-point editors and post-update Overleaf refresh surfaces are tracked separately', () => {
  assert.match(source, /const surfaceTabs = await chrome\.tabs\.query\(\{ url: OVERLEAF_MATCHES \}\)/);
  assert.match(source, /const activeTabs = surfaceTabs\.filter\(tab => isEditorProjectTab\(tab\)/);
  assert.match(source, /const refreshTabs = surfaceTabs\.filter\(tab => !tab\.discarded/);
  assert.match(source, /UPDATE_RELOAD_TABS_KEY\]: refreshTabs\.map/);
  assert.match(contentRuntimeSource, /allowQuietEditorFallback:\s*true/);
  assert.match(contentRuntimeSource, /quietFallbackMs:\s*1000/);
  assert.match(updateIdleSource, /'verified_saved', 'verified_quiet'/);
});

test('runtime manifest preserves content order and places idle probe before content runtime', () => {
  const idle = runtimeManifest.js.indexOf('src/content/updateIdle.js');
  const notice = runtimeManifest.js.indexOf('src/content/updateNotice.js');
  const runtime = runtimeManifest.js.indexOf('src/content/contentRuntime.js');
  const entry = runtimeManifest.js.indexOf('src/contentScript.js');
  assert.equal(idle >= 0 && idle < notice && notice < runtime && runtime < entry, true);
});

test('health confirmation waits for the replacement content runtime to answer from Overleaf', () => {
  assert.match(contentRuntimeSource, /codex-overleaf\/runtime-health-probe/);
  assert.match(source, /await verifyPendingRuntimeHealth\(targetVersion\)[\s\S]*method:\s*'update\.confirm'/);
  assert.match(source, /if \(!tabIds\.length\) return false/);
  assert.match(source, /missingCapabilities[\s\S]*rollbackBrokenRuntime/);
  assert.match(source, /transaction\?\.state === 'rolled_back'[\s\S]*reloadPendingOverleafTabs/);
});
