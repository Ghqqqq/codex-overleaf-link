const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');
const { getContentScriptSource } = require('./_helpers/contentScriptSource');

// v1.7: @ file autocomplete + first-run setup prompt locks.

test('typing @ drives a file autocomplete through the shared composer menu', () => {
  const src = getContentScriptSource();
  const update = extractFunction(src, 'updateSlashMenuForTaskInput');
  // Dual-mode menu: slash commands first, then the @ trigger, else close.
  assert.match(update, /getSlashTrigger\(\)/);
  assert.match(update, /getAtFileTrigger\(\)/);
  assert.match(update, /renderAtFileMenu\(atTrigger\)/);

  const trigger = extractFunction(src, 'getAtFileTrigger');
  // Mid-text trigger: @ after anything non-email-ish (blocks word chars,
  // dot, hyphen, @) so emails stay inert while CJK text before @ triggers.
  const regexSource = trigger.match(/\/\(\^\|(\[[^\]]+\])\)@\(\[\^\\s@\]\*\)\$\//)?.[0];
  assert.ok(regexSource, 'trigger regex present');
  const triggerRegex = new RegExp(regexSource.slice(1, -1));
  const hits = value => triggerRegex.test(value);
  assert.equal(hits('@ma'), true, '@ at start triggers');
  assert.equal(hits('fix @ma'), true, '@ after space triggers');
  assert.equal(hits('你好@ma'), true, 'CJK directly before @ triggers');
  assert.equal(hits('（@'), true, 'CJK punctuation before @ triggers');
  assert.equal(hits('mail me a@b'), false, 'email local-part never triggers');
  assert.equal(hits('v1.2@x'), false, 'dot before @ never triggers');
  assert.equal(hits('a-b@x'), false, 'hyphen before @ never triggers');
  assert.equal(hits('@@'), false, 'double @ never triggers');
  assert.match(trigger, /selectionStart/);
  assert.match(trigger, /currentRunView/, 'no autocomplete while a run is active');

  const menu = extractFunction(src, 'renderAtFileMenu');
  assert.match(menu, /getContextProjectFiles/);
  assert.match(menu, /getContextFileRank/, '.tex files rank first');
  assert.match(menu, /slice\(0, 8\)/, 'menu is capped');
  assert.match(menu, /@compile-log/, 'the resolvable builtin token is offered');
  assert.match(menu, /at-builtin:compile-log/, 'builtin id is namespaced apart from file ids');
  assert.match(menu, /selectable !== false && file\.kind !== 'binary'/, 'binary files never enter the menu');
});

test('the @compile-log gate matches tokens at start/after whitespace (the positions the menu inserts)', () => {
  const src = getContentScriptSource();
  const gate = src.match(/if \((\/[^\n]+?\/i)\.test\(task\)\) \{\n\s+appendRunEvent\(\{ title: tx\('Fetching compile log/)?.[1];
  assert.ok(gate, 'compile-log gate regex found');
  const gateRegex = new RegExp(gate.slice(1, -2), 'i');
  assert.equal(gateRegex.test('@compile-log why does it fail'), true, 'token at start');
  assert.equal(gateRegex.test('check @compile-log now'), true, 'token after space');
  assert.equal(gateRegex.test('not-a-token@compile-log'), false, 'mid-word stays inert');
});

test('first-run prompt never fires for installed profiles and burns its flag before showing', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/nativeCompatibilityController.js'),
    'utf8'
  );
  const prompt = extractFunction(src, 'maybePromptFirstRunSetup');
  const refresh = extractFunction(src, 'refreshBadge');
  assert.match(prompt, /codexOverleafNativeEverOk/, 'ever-worked profiles are exempt');
  // wired from the resolved-but-unreachable branch (a missing host resolves
  // {ok:false}; it does not throw), gated on no native version
  assert.match(refresh, /if \(!compatibility\?\.native\?\.version\) maybePromptFirstRunSetup\(\);/);
  // and the compatible branch records the ever-ok marker
  assert.match(src, /codexOverleafNativeEverOk', 'true'/);
});

test('selecting an @ file inserts the token AND selects the focus file (toggle-guarded)', () => {
  const src = getContentScriptSource();
  const dispatch = extractFunction(src, 'selectSlashCommand');
  assert.match(dispatch, /command\.kind === 'at-file'/);
  assert.match(dispatch, /applyAtFileSelection\(command\)/);

  const apply = extractFunction(src, 'applyAtFileSelection');
  // The typed token is cosmetic; the focus selection attaches the file.
  assert.match(apply, /selectFocusFile\(command\.path\)/);
  assert.match(apply, /!focusFiles\.includes\(command\.path\)/,
    'selectFocusFile toggles — must not deselect an already-focused file');
  assert.match(apply, /focusFiles\.length >= 5/,
    'the 5-file focus cap eviction is surfaced, not silent');
  assert.match(apply, /if \(!input \|\| !trigger\) \{/,
    'a stale menu (caret moved / trigger gone) attaches nothing');
  assert.match(apply, /autosizeTaskTextarea\(\)/);
  assert.match(apply, /syncComposerSendAvailability\(\)/);
  assert.match(apply, /setSelectionRange/, 'caret lands after the inserted token');
});

test('the composer copy promises @ again now that it is real (en+zh)', () => {
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'extension/src/shared/i18n.js'), 'utf8');
  assert.match(i18n, /placeholder: 'Ask Codex anything\. Type @ to add files as context',/);
  assert.match(i18n, /placeholder: '问 Codex 任何事。输入 @ 添加文件上下文',/);
  assert.match(i18n, /atMenuLoading/);
  assert.match(i18n, /atMenuCompileLogSubtitle/);
});

test('first-run setup prompt opens once and can never nag-loop', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/nativeCompatibilityController.js'),
    'utf8'
  );
  const prompt = extractFunction(src, 'maybePromptFirstRunSetup');
  // The once-flag is written BEFORE the modal shows, so a dismissal is final
  // even if the modal throws; storage failures bail out silently.
  const setAt = prompt.indexOf("setItem('codexOverleafSetupPromptShown'");
  const showAt = prompt.indexOf('showUpdateGuidance');
  assert.ok(setAt !== -1 && showAt !== -1);
  assert.ok(setAt < showAt, 'flag persists before the modal opens');
  assert.match(prompt, /catch \(_storageError\)/);
  // Wired from the no-response badge path only.
  assert.match(src, /maybePromptFirstRunSetup\(\);/);
});
