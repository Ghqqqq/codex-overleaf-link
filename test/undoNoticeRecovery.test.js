'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const Notice = require('../extension/src/content/runFailureNotice');
const Session = require('../extension/src/shared/sessionState');
const Storage = require('../extension/src/shared/storageDb');
const Settlement = require('../extension/src/shared/writebackSettlement');
const FailureReasons = require('../extension/src/shared/failureReasons');
const I18n = require('../extension/src/shared/i18n');
const timeline = fs.readFileSync(path.join(__dirname, '../extension/src/content/runTimelineView.js'), 'utf8');
const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const failed = title => ({ title, status: 'failed', kind: 'activity',
  activity: { v: 1, kind: 'notice', state: 'failed', output: title } });
const titles = ['Undo result: undone 1 item(s), skipped 2 item(s)',
  'Undo result: rejected 0 tracked change(s), skipped 1',
  'Undo result: undone 0 file(s), skipped 1',
  '撤销结果：已撤销 0 项，跳过 2 项', '撤销结果：已拒绝 1 条留痕，跳过 2 条'];
for (const terminal of [{ undoStatus: 'applied' }, { trackedChangeStatus: 'rejected' }]) {
  test('resolved undo hides only obsolete attempt notices: ' + JSON.stringify(terminal), () => {
    const other = failed('Could not compile the current document.');
    const stream = { ...failed(titles[0]), kind: 'stream', streamRole: 'assistant' };
    const completed = { ...failed(titles[0]), status: 'completed' };
    const run = { ...terminal, events: [...titles.map(failed), other, stream, completed] };
    const saved = JSON.stringify(run), projected = Notice.projectResolvedUndo(run);
    assert.deepEqual(projected.events, [other, stream, completed]);
    assert.equal(JSON.stringify(run), saved, 'raw events and normalized activity metadata remain intact');
  });
}
for (const status of [{}, { undoStatus: 'running' }, { undoStatus: 'partial' },
  { trackedChangeStatus: 'needs_review' }, { trackedChangeStatus: 'accepted' }]) {
  test('unresolved or accepted run retains its failed undo evidence: ' + JSON.stringify(status), () => {
    const run = { ...status, events: titles.map(failed) };
    assert.equal(Notice.projectResolvedUndo(run), run);
  });
}
test('presentation remains selective after session hydration', () => {
  const hydrated = Session.normalizePanelState({ sessions: [{ id: 's', runs: [{ id: 'r', status: 'completed',
    undoStatus: 'applied', events: [failed(titles[0]), failed('Unrelated write failed')] }] }], activeSessionId: 's' });
  const run = hydrated.sessions[0].runs[0];
  assert.equal(run.events.length, 2);
  assert.deepEqual(Notice.projectResolvedUndo(run).events.map(event => event.title), ['Unrelated write failed']);
});
test('live activity projection uses the same filtered run without changing persistence', () => {
  let options;
  const run = { id: 'r', undoStatus: 'applied', events: [failed(titles[0])] };
  const context = vm.createContext({ window: {} });
  for (const file of ['moduleRegistryKernel', 'runRecoveryActions']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/' + file + '.js'), 'utf8'), context);
  }
  vm.runInContext(timeline, context);
  context.window.CodexOverleafRunTimelineView.create({ RunFailureNotice: Notice,
    RunActivitySummary: { create(value) { options = value; return {}; } }, findRunRecord: () => run });
  assert.equal(options.findRunRecord('r').events.length, 0);
  assert.equal(run.events.length, 1);
});
function extract(source, name) {
  const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(match, name);
  const end = /\n  }(?=\n|$)/.exec(source.slice(match.index + match[0].length));
  assert.ok(end, name + ' closing boundary');
  return source.slice(match.index, match.index + match[0].length + end.index + end[0].length);
}
test('resolved card refresh preserves disclosure and scroll position', () => {
  const run = { id: 'r', undoStatus: 'applied', events: [failed(titles[0])] };
  const process = { open: false }, next = { querySelector: () => process };
  let replacement, restored;
  const existing = { querySelector: () => ({ open: true }), replaceWith: node => { replacement = node; } };
  const log = { querySelector: () => existing };
  const context = vm.createContext({ getPanel: () => ({ querySelector: () => log }),
    cssEscape: value => value, findRunRecord: () => run, displayRun: Notice.projectResolvedUndo,
    scrollLayout: { snapshot: () => ({ scrollTop: 123 }), restore: value => { restored = value; } },
    renderRunCard: value => { assert.equal(value, run); return next; } });
  vm.runInContext(extract(timeline, 'refreshRunCard'), context);
  assert.equal(context.refreshRunCard('r'), true);
  assert.equal(replacement, next);
  assert.equal(process.open, true);
  assert.equal(restored.scrollTop, 123);
});
test('settlement control refresh replaces the resolved transcript before stale rows survive', () => {
  let refreshed = 0;
  const context = vm.createContext({ findRunRecord: () => ({ id: 'r' }),
    panel: { querySelector: () => ({}) }, cssEscape: value => value,
    runTimelineView: { refreshResolvedUndo: id => { assert.equal(id, 'r'); refreshed++; return true; } },
    configureAcceptButton() { assert.fail('old card must not be reused'); } });
  vm.runInContext(extract(runtime, 'refreshRunCardControls'), context);
  context.refreshRunCardControls('r');
  assert.equal(refreshed, 1);
});

class NoticeNode {
  constructor(tag) { this.tagName = tag; this.dataset = {}; this.children = []; this.listeners = {}; this.text = ''; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  addEventListener(type, callback) { this.listeners[type] = callback; }
}
function renderFailure(run, locale) {
  const document = { createElement: tag => new NoticeNode(tag) };
  const report = document.createElement('section'); report.dataset.status = 'failed';
  const view = Notice.create({ document, tr: (key, params) => I18n.t(locale, key, params),
    projectRunSettlement: Settlement.projectRunSettlement });
  view.append(report, {}, run);
  return { report, view, message: report.children[0].children[1].textContent };
}
const undoPath = 'codex-smoke-20261004/nested.tex';
const originalMismatch = undoPath + ' 当前内容或文档身份与本轮撤销检查点不一致；Codex 保留恢复材料并停止撤销。';
function persistedUndoFailure(code, reason, failure) {
  const initial = { id: 'r', status: 'completed', mode: 'auto', undoStatus: 'ready',
    undoExpectedFiles: [{ path: undoPath, content: 'before' }], events: [] };
  const result = { ok: false, applied: [], skipped: [{ trackedChange: { path: undoPath },
    result: { ok: false, code, file: undoPath, reason, changedDocument: false, ...(failure ? { failure } : {}) } }] };
  const run = Settlement.applySettlementTransition(initial,
    Settlement.settleLegacyUndo({ run: initial, status: 'partial', result }));
  const record = Storage.buildSessionRecord({ id: 's', projectId: 'qa', accountScopeId: 'test', runs: [run] });
  return Session.normalizeRuns(JSON.parse(JSON.stringify(record)).runs)[0];
}
for (const code of ['snapshot_undo_current_mismatch', 'snapshot_undo_open_failed', 'snapshot_undo_unavailable']) {
  test('snapshot Undo stays canonical through settlement/storage and follows current Notice locale: ' + code, () => {
    const run = persistedUndoFailure(code, originalMismatch);
    const before = JSON.stringify(run);
    const failure = Settlement.projectRunSettlement(run).primaryFailure;
    assert.equal(failure.code, code);
    assert.equal(failure.stage, 'undo');
    assert.equal(failure.file, undoPath);
    assert.equal(failure.userMessage, originalMismatch, 'raw producer reason remains stored');
    for (const locale of ['en', 'zh', 'en']) {
      const rendered = renderFailure(run, locale);
      assert.equal(rendered.message, undoPath + ': ' + I18n.t(locale, 'failureReason_' + code + '_user'));
      assert.equal(rendered.view.getRecoveryContext(rendered.report).failure.code, code);
      assert.equal(rendered.view.getRecoveryContext(rendered.report).file, undoPath);
    }
    assert.equal(JSON.stringify(run), before, 'display-time localization does not rewrite recovery facts');
  });
}
test('old screenshot Notice is localized without granting a parsed file recovery action', () => {
  const run = persistedUndoFailure('unknown_legacy_failure', originalMismatch);
  run.settlement.failures[0].file = '';
  const before = JSON.stringify(run);
  for (const locale of ['en', 'zh']) {
    const { report, view, message } = renderFailure(run, locale);
    assert.equal(message, undoPath + ': ' + I18n.t(locale, 'failureReason_snapshot_undo_current_mismatch_user'));
    assert.equal(view.getRecoveryContext(report).failure.code, 'unknown_legacy_failure');
    assert.equal(view.getRecoveryContext(report).file, '', 'path inferred for display never authorizes opening a file');
    assert.equal(view.getRecoveryContext(report).failure.retryable, false);
  }
  assert.equal(JSON.stringify(run), before);
});
test('unknown diagnostics and near-miss legacy templates are preserved verbatim', () => {
  for (const reason of ['Unrecognized Page diagnostic: 自定义原因', originalMismatch + ' Additional context.',
    originalMismatch.replace(undoPath, '../private.tex')]) {
    const run = persistedUndoFailure('unknown_legacy_failure', reason);
    run.settlement.failures[0].file = '';
    assert.equal(renderFailure(run, 'en').message, reason);
    assert.equal(renderFailure(run, 'zh').message, reason);
  }
});
test('other exact historical snapshot templates use the selected language without changing their failure code', () => {
  for (const [reason, code] of [
    [undoPath + ' 当前内容已经不是本轮写入后的内容；为避免覆盖你的后续修改，Codex 不执行快照撤销。', 'snapshot_undo_current_mismatch'],
    ['无法打开 ' + undoPath + ' 来执行快照撤销。', 'snapshot_undo_open_failed'],
    ['The saved checkpoint is unavailable for this undo.', 'snapshot_undo_unavailable']
  ]) {
    const run = persistedUndoFailure('unknown_legacy_failure', reason);
    for (const locale of ['en', 'zh']) {
      const { report, view, message } = renderFailure(run, locale);
      assert.equal(message, undoPath + ': ' + I18n.t(locale, 'failureReason_' + code + '_user'));
      assert.equal(view.getRecoveryContext(report).failure.code, 'unknown_legacy_failure');
    }
  }
});
test('snapshot originalCode localizes historical diagnostics without changing classification or evidence', () => {
  const failure = { code: 'unknown_legacy_failure', stage: 'unknown', severity: 'error',
    retryable: false, userMessage: originalMismatch, technicalMessage: originalMismatch,
    evidence: { originalCode: 'snapshot_undo_current_mismatch', originalReason: originalMismatch } };
  const before = JSON.stringify(failure);
  for (const locale of ['en', 'zh']) {
    const localized = FailureReasons.localizeFailureReason(failure, locale, key => I18n.t(locale, key));
    assert.equal(localized.userMessage, I18n.t(locale, 'failureReason_snapshot_undo_current_mismatch_user'));
  }
  assert.equal(FailureReasons.normalizeFailureReason({ failure }).code, 'unknown_legacy_failure');
  assert.equal(JSON.stringify(failure), before);
});
test('a retained originalCode takes display precedence over a legacy message template', () => {
  const run = persistedUndoFailure('unknown_legacy_failure', originalMismatch);
  const failure = run.settlement.failures[0];
  failure.evidence = { originalCode: 'snapshot_undo_open_failed' };
  const before = JSON.stringify(failure);
  // Read the event failure directly: old compact settlement facts intentionally
  // omit evidence, while a retained structured event can still provide it.
  const document = { createElement: tag => new NoticeNode(tag) };
  const report = document.createElement('section'); report.dataset.status = 'failed';
  const view = Notice.create({ document, tr: (key, params) => I18n.t('en', key, params) });
  view.append(report, { failure }, {});
  assert.equal(report.children[0].children[1].textContent,
    undoPath + ': ' + I18n.t('en', 'failureReason_snapshot_undo_open_failed_user'));
  assert.equal(JSON.stringify(failure), before);
});
test('existing Bridge and apply-result Undo details use the same snapshot translations', () => {
  const context = vm.createContext({ window: {} });
  for (const file of ['failureReasons', 'i18n']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/shared/' + file + '.js'), 'utf8'), context);
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/applyResultFormatters.js'), 'utf8'), context);
  let locale = 'en';
  const formatters = context.window.CodexOverleafApplyResultFormatters.create({ i18n: context.CodexOverleafI18n,
    FailureReasons: context.CodexOverleafFailureReasons,
    getLocale: () => locale, tr: (key, params) => I18n.t(locale, key, params), tx: (en, zh) => locale === 'zh' ? zh : en });
  for (const code of ['snapshot_undo_current_mismatch', 'snapshot_undo_open_failed', 'snapshot_undo_unavailable', 'file_tree_controls_unavailable']) {
    const result = { ok: false, code, file: undoPath, reason: originalMismatch };
    for (locale of ['en', 'zh']) {
      const expected = undoPath + ': ' + I18n.t(locale, 'failureReason_' + code + '_user');
      assert.equal(formatters.formatBridgeResultReason(result), expected);
      assert.equal(formatters.formatApplyResultReason({ result, operation: { path: undoPath } }), expected);
    }
    assert.equal(result.reason, originalMismatch);
  }
  locale = 'en';
  assert.equal(formatters.formatBridgeResultReason({ code: 'unrecognized', reason: '原始诊断保留' }), '原始诊断保留');
});
test('unsupported file controls keep their exact preflight blocker and current-language Notice', () => {
  const code = 'file_tree_controls_unavailable';
  const reason = 'No supported Overleaf file-tree method was detected';
  const raw = FailureReasons.normalizeFailureReason({ code, reason, ok: false }, { path: undoPath, type: 'move' });
  assert.equal(raw.code, code); assert.equal(raw.stage, 'preflight');
  assert.equal(raw.severity, 'blocked'); assert.equal(raw.retryable, false);
  assert.equal(raw.technicalMessage, reason);
  const run = persistedUndoFailure(code, reason);
  for (const locale of ['en', 'zh']) {
    const { report, view, message } = renderFailure(run, locale);
    assert.equal(message, undoPath + ': ' + I18n.t(locale, 'failureReason_' + code + '_user'));
    assert.equal(view.getRecoveryContext(report).failure.retryable, false);
  }
});
test('declined deletion is a nonretryable blocker without implying other writes were cancelled', () => {
  const code = 'delete_confirmation_rejected';
  const failure = FailureReasons.normalizeFailureReason({ ok: false, code,
    reason: 'Delete requires explicit confirmation and was skipped.' }, { type: 'delete', path: undoPath });
  assert.equal(failure.code, code);
  assert.equal(failure.stage, 'preflight');
  assert.equal(failure.severity, 'blocked');
  assert.equal(failure.retryable, false);
  assert.equal(failure.operationType, 'delete');
  assert.equal(failure.file, undoPath);
  for (const [locale, expected] of [
    ['en', 'The deletion was cancelled and was not applied. Other allowed changes in this run may still proceed.'],
    ['zh', '删除已取消，未执行该删除；本轮其他获准改动仍可能继续。']
  ]) {
    const localized = FailureReasons.localizeFailureReason(failure, locale, key => I18n.t(locale, key));
    assert.equal(localized.userMessage, expected);
    assert.equal(localized.nextAction, I18n.t(locale, 'failureReason_' + code + '_next'));
  }
});

const trackedNotFoundReason = '没有在 Overleaf 页面里找到这轮写入对应的留痕记录；Codex 没有用文本补丁伪撤销。';
const trackedNotFoundEnglish = 'No matching tracked changes were found on the Overleaf page for this run. Codex did not undo with text patches.';
test('partial tracked Undo Notice follows the current locale after settlement and storage without changing recovery facts', () => {
  for (const failurePath of [undoPath, '']) {
    const initial = { id: 'r', status: 'completed', mode: 'auto', trackedChangeStatus: 'pending',
      undoExpectedFiles: [{ path: undoPath, content: 'before' }],
      undoTrackedChanges: [{ path: undoPath, id: 'owned-ref' }], events: [] };
    const result = { ok: false, applied: [{ trackedChange: { path: 'main.tex' }, result: { ok: true } }],
      skipped: [{ trackedChange: failurePath ? { path: failurePath } : null,
        result: { ok: false, code: 'tracked_change_not_found', reason: trackedNotFoundReason } }] };
    const settled = Settlement.applySettlementTransition(initial,
      Settlement.settleTrackedChangeLifecycle({ kind: 'reject', run: initial, result }));
    const record = Storage.buildSessionRecord({ id: 's', projectId: 'qa', accountScopeId: 'test', runs: [settled] });
    const run = Session.normalizeRuns(JSON.parse(JSON.stringify(record)).runs)[0];
    const before = JSON.stringify(run);
    const failure = Settlement.projectRunSettlement(run).primaryFailure;
    assert.equal(run.trackedChangeStatus, 'needs_review');
    assert.equal(failure.code, 'unknown_legacy_failure');
    assert.equal(failure.retryable, false);
    assert.equal(failure.evidence, undefined, 'settlement may retain only the exact historical message');
    for (const [locale, expected] of [['en', trackedNotFoundEnglish], ['zh', trackedNotFoundReason], ['en', trackedNotFoundEnglish]]) {
      const { report, view, message } = renderFailure(run, locale);
      assert.equal(message, [failurePath, expected].filter(Boolean).join(': '));
      const recovery = view.getRecoveryContext(report);
      assert.equal(recovery.failure.code, 'unknown_legacy_failure');
      assert.equal(recovery.failure.retryable, false);
      assert.equal(recovery.file, failurePath);
    }
    assert.equal(JSON.stringify(run), before, 'display must preserve statuses, original diagnostic and remaining checkpoints');
  }
});
test('tracked Undo originalCode localizes Notice and details without canonicalizing stored diagnostics', () => {
  const failure = FailureReasons.normalizeFailureReason({ ok: false, code: 'tracked_change_not_found',
    reason: trackedNotFoundReason }, { path: undoPath });
  const before = JSON.stringify(failure);
  const context = vm.createContext({ window: {} });
  for (const file of ['failureReasons', 'i18n']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/shared/' + file + '.js'), 'utf8'), context);
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/applyResultFormatters.js'), 'utf8'), context);
  let locale = 'en';
  const formatters = context.window.CodexOverleafApplyResultFormatters.create({ i18n: context.CodexOverleafI18n,
    FailureReasons: context.CodexOverleafFailureReasons, getLocale: () => locale,
    tr: (key, params) => I18n.t(locale, key, params), tx: (en, zh) => locale === 'zh' ? zh : en });
  for (const [activeLocale, expected] of [['en', trackedNotFoundEnglish], ['zh', trackedNotFoundReason]]) {
    locale = activeLocale;
    assert.equal(FailureReasons.localizeFailureReason(failure, locale, key => I18n.t(locale, key)).userMessage, expected);
    const document = { createElement: tag => new NoticeNode(tag) };
    const report = document.createElement('section'); report.dataset.status = 'failed';
    const view = Notice.create({ document, tr: (key, params) => I18n.t(locale, key, params) });
    view.append(report, { failure }, {});
    assert.equal(report.children[0].children[1].textContent, undoPath + ': ' + expected);
    assert.equal(view.getRecoveryContext(report).failure, failure);
    for (const result of [{ ok: false, code: 'tracked_change_not_found', reason: trackedNotFoundReason }, { failure }]) {
      assert.equal(formatters.formatBridgeResultReason(result, undoPath), undoPath + ': ' + expected);
      assert.equal(formatters.formatApplyResultReason({ result, operation: { path: undoPath } }), undoPath + ': ' + expected);
    }
  }
  assert.equal(FailureReasons.normalizeFailureReason({ failure }).code, 'unknown_legacy_failure');
  assert.equal(JSON.stringify(failure), before, 'technicalMessage, originalCode, originalReason and retryability remain intact');
});
test('tracked Undo display compatibility preserves near-miss and unrelated diagnostics verbatim', () => {
  for (const reason of [trackedNotFoundReason + ' Additional context.', trackedNotFoundReason.replace('留痕记录', '编辑记录')]) {
    const run = persistedUndoFailure('unknown_legacy_failure', reason);
    for (const locale of ['en', 'zh']) assert.equal(renderFailure(run, locale).message, undoPath + ': ' + reason);
  }
});

const reviewLocaleCases = [
  [
    "missing_tracked_changes",
    "这轮写入没有可识别的 Overleaf 留痕记录；为避免制造新的红线，Codex 没有执行文本补丁撤销。",
    "No matching Overleaf tracked-change records were found for this run. Codex did not undo with text patches.",
    "这轮写入没有可识别的 Overleaf 留痕记录；Codex 没有执行文本补丁撤销。"
  ],
  [
    "missing_tracked_changes",
    "No matching Overleaf tracked-change records were found for this run, so Codex did not undo with text patches.",
    "No matching Overleaf tracked-change records were found for this run. Codex did not undo with text patches.",
    "这轮写入没有可识别的 Overleaf 留痕记录；Codex 没有执行文本补丁撤销。"
  ],
  [
    "tracked_change_file_open_failed",
    "无法打开 {file} 来查找这轮写入的留痕记录；Codex 没有用文本补丁伪撤销。",
    "Could not open the file to find this run's tracked changes. Check it in the Overleaf review panel.",
    "无法打开文件来查找这轮写入的留痕记录；请在 Overleaf 审阅面板检查。"
  ],
  [
    "tracked_change_file_open_failed",
    "无法打开 {file} 来继续拒绝这轮留痕记录；请在 Overleaf 审阅面板手动处理。",
    "Could not open the file to find this run's tracked changes. Check it in the Overleaf review panel.",
    "无法打开文件来查找这轮写入的留痕记录；请在 Overleaf 审阅面板检查。"
  ],
  [
    "tracked_change_file_open_failed",
    "Could not open {file} to find this run's tracked changes. Handle them manually in the Overleaf review tools.",
    "Could not open the file to find this run's tracked changes. Check it in the Overleaf review panel.",
    "无法打开文件来查找这轮写入的留痕记录；请在 Overleaf 审阅面板检查。"
  ],
  [
    "tracked_change_file_open_failed",
    "Could not open the file to find this run's tracked changes. Handle them manually in the Overleaf review tools.",
    "Could not open the file to find this run's tracked changes. Check it in the Overleaf review panel.",
    "无法打开文件来查找这轮写入的留痕记录；请在 Overleaf 审阅面板检查。"
  ],
  [
    "tracked_change_reject_control_not_found",
    "找到了这轮写入的留痕记录，但没有找到对应的 Reject/拒绝按钮；Codex 没有用文本补丁伪撤销。",
    "Some tracked changes remain, but the matching Reject button was not found. Check them in the Overleaf review panel.",
    "仍有留痕记录未处理，但未找到对应的拒绝按钮；请在 Overleaf 审阅面板检查。"
  ],
  [
    "tracked_change_reject_control_not_found",
    "还有 {file} 的留痕记录未处理，但没有找到对应的 Reject/拒绝按钮；请在 Overleaf 审阅面板手动拒绝。",
    "Some tracked changes remain, but the matching Reject button was not found. Check them in the Overleaf review panel.",
    "仍有留痕记录未处理，但未找到对应的拒绝按钮；请在 Overleaf 审阅面板检查。"
  ],
  [
    "tracked_change_reject_control_not_found",
    "Some tracked changes in {file} remain, but the matching Reject button was not found. Reject them manually in Overleaf.",
    "Some tracked changes remain, but the matching Reject button was not found. Check them in the Overleaf review panel.",
    "仍有留痕记录未处理，但未找到对应的拒绝按钮；请在 Overleaf 审阅面板检查。"
  ],
  [
    "tracked_change_reject_control_not_found",
    "Some tracked changes remain, but the matching Reject button was not found. Reject them manually in Overleaf.",
    "Some tracked changes remain, but the matching Reject button was not found. Check them in the Overleaf review panel.",
    "仍有留痕记录未处理，但未找到对应的拒绝按钮；请在 Overleaf 审阅面板检查。"
  ],
  [
    "tracked_change_reject_not_confirmed",
    "Codex 点击了 Reject/拒绝，但 Overleaf 页面仍显示这条留痕记录；请在 Overleaf 审阅面板手动拒绝。",
    "Codex clicked Reject, but Overleaf still shows this tracked change. Check it in the Overleaf review panel.",
    "Codex 已点击拒绝，但 Overleaf 仍显示该留痕记录；请在审阅面板检查。"
  ],
  [
    "tracked_change_reject_not_confirmed",
    "Codex clicked Reject, but Overleaf still shows this tracked change. Reject it manually in the Overleaf review panel.",
    "Codex clicked Reject, but Overleaf still shows this tracked change. Check it in the Overleaf review panel.",
    "Codex 已点击拒绝，但 Overleaf 仍显示该留痕记录；请在审阅面板检查。"
  ],
  [
    "tracked_change_accept_control_not_found",
    "Some tracked changes in {file} remain, but the matching Accept button was not found. Accept them manually in Overleaf.",
    "Some tracked changes remain, but the matching Accept button was not found. Check them in the Overleaf review panel.",
    "仍有留痕记录未处理，但未找到对应的接受按钮；请在 Overleaf 审阅面板检查。"
  ],
  [
    "tracked_change_accept_control_not_found",
    "Some tracked changes remain, but the matching Accept button was not found. Accept them manually in Overleaf.",
    "Some tracked changes remain, but the matching Accept button was not found. Check them in the Overleaf review panel.",
    "仍有留痕记录未处理，但未找到对应的接受按钮；请在 Overleaf 审阅面板检查。"
  ],
  [
    "tracked_change_accept_not_confirmed",
    "Codex clicked Accept, but Overleaf still shows this tracked change. Accept it manually in the Overleaf review panel.",
    "Codex clicked Accept, but Overleaf still shows this tracked change. Check it in the Overleaf review panel.",
    "Codex 已点击接受，但 Overleaf 仍显示该留痕记录；请在审阅面板检查。"
  ],
  [
    "tracked_change_editor_undo_open_failed",
    "无法打开 {file} 来执行 Overleaf 原生撤销。",
    "Could not open the file for Overleaf native Undo.",
    "无法打开文件来执行 Overleaf 原生撤销。"
  ],
  [
    "tracked_change_editor_undo_open_failed",
    "Could not open {file} for Overleaf native undo.",
    "Could not open the file for Overleaf native Undo.",
    "无法打开文件来执行 Overleaf 原生撤销。"
  ],
  [
    "tracked_change_editor_undo_open_failed",
    "Could not open the file for Overleaf native undo.",
    "Could not open the file for Overleaf native Undo.",
    "无法打开文件来执行 Overleaf 原生撤销。"
  ],
  [
    "tracked_change_editor_undo_current_mismatch",
    "{file} 当前内容已经不是本轮写入后的内容；为避免撤掉你的后续修改，Codex 不使用 Overleaf 原生撤销。",
    "The current content no longer matches this run's written content. Codex stopped native Undo to preserve later edits.",
    "当前内容与本轮写入后的内容不一致；Codex 已停止原生撤销，以保留后续编辑。"
  ],
  [
    "tracked_change_editor_undo_current_mismatch",
    "{file} no longer matches this run's written content, so Codex did not use Overleaf native undo.",
    "The current content no longer matches this run's written content. Codex stopped native Undo to preserve later edits.",
    "当前内容与本轮写入后的内容不一致；Codex 已停止原生撤销，以保留后续编辑。"
  ],
  [
    "tracked_change_editor_undo_current_mismatch",
    "The current content no longer matches this run's written content, so Codex did not use Overleaf native undo.",
    "The current content no longer matches this run's written content. Codex stopped native Undo to preserve later edits.",
    "当前内容与本轮写入后的内容不一致；Codex 已停止原生撤销，以保留后续编辑。"
  ],
  [
    "editor_undo_control_not_found",
    "没有找到 Overleaf 编辑器自己的 Undo/撤销按钮，无法一次性撤销 {file} 的本轮留痕。",
    "Could not find Overleaf's editor Undo button to undo this run.",
    "未找到 Overleaf 编辑器的撤销按钮，无法撤销本轮改动。"
  ],
  [
    "editor_undo_control_not_found",
    "Could not find Overleaf's editor Undo button to undo this run in {file}.",
    "Could not find Overleaf's editor Undo button to undo this run.",
    "未找到 Overleaf 编辑器的撤销按钮，无法撤销本轮改动。"
  ],
  [
    "editor_undo_no_progress",
    "Codex 点击了 Overleaf Undo/撤销，但 {file} 内容没有变化。",
    "Codex clicked Overleaf Undo, but the file did not change.",
    "Codex 已点击 Overleaf 撤销，但文件内容没有变化。"
  ],
  [
    "editor_undo_no_progress",
    "Codex clicked Overleaf Undo, but {file} did not change.",
    "Codex clicked Overleaf Undo, but the file did not change.",
    "Codex 已点击 Overleaf 撤销，但文件内容没有变化。"
  ],
  [
    "editor_undo_max_iterations",
    "{file} 经过多次 Overleaf 原生撤销后仍未回到本轮写入前内容，已停止以避免撤销其它修改。",
    "The file did not return to its pre-run content after repeated native Undo steps. Codex stopped to avoid undoing other edits.",
    "经过多次原生撤销后，文件仍未恢复到本轮写入前的内容；Codex 已停止，以免撤销其他编辑。"
  ],
  [
    "editor_undo_max_iterations",
    "{file} did not return to its pre-run content after repeated Overleaf native undo steps. Codex stopped to avoid undoing other edits.",
    "The file did not return to its pre-run content after repeated native Undo steps. Codex stopped to avoid undoing other edits.",
    "经过多次原生撤销后，文件仍未恢复到本轮写入前的内容；Codex 已停止，以免撤销其他编辑。"
  ],
  [
    "editor_undo_max_iterations",
    "The file did not return to its pre-run content after repeated Overleaf native undo steps. Codex stopped to avoid undoing other edits.",
    "The file did not return to its pre-run content after repeated native Undo steps. Codex stopped to avoid undoing other edits.",
    "经过多次原生撤销后，文件仍未恢复到本轮写入前的内容；Codex 已停止，以免撤销其他编辑。"
  ],
  [
    "tracked_change_undo_max_iterations",
    "{file} 仍有未完成的留痕记录；Codex 已停止以避免误拒绝其它改动。",
    "Tracked changes are still left. Codex stopped to avoid rejecting unrelated edits.",
    "仍有未处理的留痕记录；Codex 已停止，以免误拒绝其他编辑。"
  ],
  [
    "tracked_change_undo_max_iterations",
    "{file} still has tracked changes after the reject sweep, so Codex stopped to avoid mis-rejecting other edits.",
    "Tracked changes are still left. Codex stopped to avoid rejecting unrelated edits.",
    "仍有未处理的留痕记录；Codex 已停止，以免误拒绝其他编辑。"
  ],
  [
    "tracked_change_undo_max_iterations",
    "{file} still has tracked changes after the per-expected-file reject sweep, so Codex stopped to avoid mis-rejecting other edits.",
    "Tracked changes are still left. Codex stopped to avoid rejecting unrelated edits.",
    "仍有未处理的留痕记录；Codex 已停止，以免误拒绝其他编辑。"
  ],
  [
    "tracked_change_undo_max_iterations",
    "{file} still has tracked changes left. Codex stopped to avoid rejecting unrelated edits.",
    "Tracked changes are still left. Codex stopped to avoid rejecting unrelated edits.",
    "仍有未处理的留痕记录；Codex 已停止，以免误拒绝其他编辑。"
  ],
  [
    "tracked_change_undo_verify_open_failed",
    "撤销后无法打开 {file} 验证内容；请刷新 Overleaf 后检查。",
    "Could not open the file after Undo to verify its content. Reload Overleaf and check it.",
    "撤销后无法打开文件验证内容；请刷新 Overleaf 后检查。"
  ],
  [
    "tracked_change_undo_verify_open_failed",
    "Could not open {file} after undo to verify content. Reload Overleaf and check manually.",
    "Could not open the file after Undo to verify its content. Reload Overleaf and check it.",
    "撤销后无法打开文件验证内容；请刷新 Overleaf 后检查。"
  ],
  [
    "tracked_change_undo_verify_open_failed",
    "Could not open the file after undo to verify content. Reload Overleaf and check manually.",
    "Could not open the file after Undo to verify its content. Reload Overleaf and check it.",
    "撤销后无法打开文件验证内容；请刷新 Overleaf 后检查。"
  ],
  [
    "tracked_change_undo_verify_failed",
    "{file} 拒绝留痕后内容没有回到写入前状态；请在 Overleaf 审阅面板检查这轮修改。",
    "The file did not return to its pre-run content after rejecting tracked changes. Check this run's changes in the Overleaf review panel.",
    "拒绝留痕后，文件内容仍未恢复到写入前状态；请在 Overleaf 审阅面板检查本轮修改。"
  ],
  [
    "tracked_change_undo_verify_failed",
    "{file} did not return to its pre-run content after rejecting tracked changes. Check this run's changes in the Overleaf review panel.",
    "The file did not return to its pre-run content after rejecting tracked changes. Check this run's changes in the Overleaf review panel.",
    "拒绝留痕后，文件内容仍未恢复到写入前状态；请在 Overleaf 审阅面板检查本轮修改。"
  ],
  [
    "tracked_change_undo_verify_failed",
    "The file did not return to its pre-run content after rejecting tracked changes. Check this run's changes in the Overleaf review panel.",
    "The file did not return to its pre-run content after rejecting tracked changes. Check this run's changes in the Overleaf review panel.",
    "拒绝留痕后，文件内容仍未恢复到写入前状态；请在 Overleaf 审阅面板检查本轮修改。"
  ],
  [
    "accept_missing_run_content",
    "这轮写入没有可识别的写入前/写入后内容；Codex 没有把留痕改动接受为永久文本。",
    "The pre-write or post-write content is unavailable. Codex did not replay or accept the tracked changes.",
    "缺少写入前或写入后的内容；Codex 未重放或接受留痕改动。"
  ],
  [
    "accept_missing_run_content",
    "{file} 缺少写入前/写入后内容；Codex 没有重放本轮改动。",
    "The pre-write or post-write content is unavailable. Codex did not replay or accept the tracked changes.",
    "缺少写入前或写入后的内容；Codex 未重放或接受留痕改动。"
  ],
  [
    "accept_editor_undo_unavailable",
    "没有可执行的 Overleaf 原生撤销或安全快照回滚来清掉本轮留痕；Codex 没有接受这轮改动。",
    "Native Undo and a safe checkpoint rollback are unavailable. Codex did not accept this run.",
    "原生撤销及安全的检查点回滚均不可用；Codex 未接受本轮改动。"
  ],
  [
    "accept_editing_not_confirmed",
    "无法确认 Overleaf 已切换到 Editing 模式；Codex 没有把本轮改动重写为永久文本。",
    "Codex could not confirm Overleaf Editing mode. It stopped replaying this run to avoid creating new tracked changes.",
    "无法确认 Overleaf 已进入编辑模式；Codex 已停止重放本轮改动，以免产生新的留痕。"
  ],
  [
    "accept_editing_not_confirmed",
    "切换后仍未能确认 Overleaf 处于 Editing 模式；为避免重写又留下留痕，Codex 没有重放本轮改动。",
    "Codex could not confirm Overleaf Editing mode. It stopped replaying this run to avoid creating new tracked changes.",
    "无法确认 Overleaf 已进入编辑模式；Codex 已停止重放本轮改动，以免产生新的留痕。"
  ],
  [
    "accept_editing_not_confirmed",
    "本次操作前未能确认 Overleaf 处于 Editing 模式；为避免重写又留下留痕，Codex 没有继续重放本轮剩余改动。",
    "Codex could not confirm Overleaf Editing mode. It stopped replaying this run to avoid creating new tracked changes.",
    "无法确认 Overleaf 已进入编辑模式；Codex 已停止重放本轮改动，以免产生新的留痕。"
  ],
  [
    "accept_editing_not_confirmed",
    "Codex could not re-confirm Editing mode before replaying {file}; Codex stopped to avoid landing a tracked write.",
    "Codex could not confirm Overleaf Editing mode. It stopped replaying this run to avoid creating new tracked changes.",
    "无法确认 Overleaf 已进入编辑模式；Codex 已停止重放本轮改动，以免产生新的留痕。"
  ],
  [
    "accept_editing_not_confirmed",
    "Codex could not confirm Editing mode for the untracked Accept replay, so the run was not finalized.",
    "Codex could not confirm Overleaf Editing mode. It stopped replaying this run to avoid creating new tracked changes.",
    "无法确认 Overleaf 已进入编辑模式；Codex 已停止重放本轮改动，以免产生新的留痕。"
  ],
  [
    "accept_editing_not_confirmed",
    "Codex could not switch Overleaf to Editing mode for the untracked Accept replay, so the run was not finalized.",
    "Codex could not confirm Overleaf Editing mode. It stopped replaying this run to avoid creating new tracked changes.",
    "无法确认 Overleaf 已进入编辑模式；Codex 已停止重放本轮改动，以免产生新的留痕。"
  ],
  [
    "accept_editing_not_confirmed",
    "Codex toggled Overleaf to Editing, but the post-toggle state did not positively confirm Editing — Codex did not replay the run.",
    "Codex could not confirm Overleaf Editing mode. It stopped replaying this run to avoid creating new tracked changes.",
    "无法确认 Overleaf 已进入编辑模式；Codex 已停止重放本轮改动，以免产生新的留痕。"
  ],
  [
    "accept_editing_not_stable",
    "Overleaf Editing mode did not remain stable long enough for an untracked Accept All replay; Codex did not replay this write.",
    "Overleaf Editing mode did not remain stable long enough for an untracked Accept replay. Codex did not replay this write.",
    "Overleaf 编辑模式未保持稳定，无法无留痕地重放接受的改动；Codex 未重放此次写入。"
  ],
  [
    "accept_replay_rollback_missing_content",
    "Accept All detected fresh tracked changes, but could not roll back because the pre/post content was unavailable.",
    "Accept created fresh tracked changes, but rollback could not run because the pre-write or post-write content was unavailable.",
    "接受改动时产生了新的留痕，但缺少写入前或写入后的内容，无法回滚。"
  ],
  [
    "review_scope_unavailable",
    "The native tracked-change scope could not be safely isolated. No review mutation was attempted. Use Overleaf Review to handle the changes individually.",
    "The native tracked-change scope could not be safely isolated. No review mutation was attempted. Check the changes individually in Overleaf Review.",
    "无法安全确认本轮原生留痕的范围；尚未尝试审阅写入。请在 Overleaf 审阅面板逐项检查。"
  ],
  [
    "review_request_unverified",
    "The native review request could not be fully verified; some target changes may already be accepted. No text replay was attempted. Check Overleaf Review before retrying.",
    "The native review request could not be fully verified; some target changes may already be accepted. No text replay was attempted. Check Overleaf Review before retrying.",
    "原生审阅请求未能完全核实，部分目标改动可能已接受；未尝试文本重放。请先在 Overleaf 审阅面板检查，再决定是否重试。"
  ],
  [
    "review_owner_disconnected",
    "The Undo owner disconnected; no further review writes were started.",
    "The Undo owner disconnected; no further review writes were started.",
    "撤销操作的连接已断开；未再启动后续审阅写入。"
  ],
  [
    "review_deadline_exceeded",
    "The review time budget expired; no further review writes were started.",
    "The review time budget expired; no further review writes were started.",
    "审阅操作已超时；未再启动后续审阅写入。"
  ],
  [
    "review_deadline_exceeded",
    "The review time budget expired.",
    "The review time budget expired; no further review writes were started.",
    "审阅操作已超时；未再启动后续审阅写入。"
  ],
  [
    "review_cancelled",
    "The review was cancelled; no further review writes were started.",
    "The review was cancelled; no further review writes were started.",
    "审阅操作已取消；未再启动后续审阅写入。"
  ],
  [
    "review_project_changed",
    "The original review project is no longer active.",
    "The original review project is no longer active.",
    "原审阅项目已不再处于活动状态。"
  ],
  [
    "tracked_change_not_found",
    "没有在 Overleaf 页面里找到这轮写入对应的留痕记录；Codex 没有用文本补丁伪撤销。",
    "No matching tracked changes were found on the Overleaf page for this run. Codex did not undo with text patches.",
    "没有在 Overleaf 页面里找到这轮写入对应的留痕记录；Codex 没有用文本补丁伪撤销。"
  ],
  [
    "tracked_change_not_found",
    "No matching tracked changes were found on the Overleaf page for this run.",
    "No matching tracked changes were found on the Overleaf page for this run. Codex did not undo with text patches.",
    "没有在 Overleaf 页面里找到这轮写入对应的留痕记录；Codex 没有用文本补丁伪撤销。"
  ],
  [
    "snapshot_undo_current_mismatch",
    "{file} 当前内容或文档身份与本轮撤销检查点不一致；Codex 保留恢复材料并停止撤销。",
    "The current content or document identity does not match this run's undo checkpoint. Codex stopped Undo and kept the recovery data.",
    "当前内容或文档身份与本轮撤销检查点不一致；Codex 已停止撤销并保留恢复材料。"
  ],
  [
    "snapshot_undo_current_mismatch",
    "{file} 当前内容已经不是本轮写入后的内容；为避免覆盖你的后续修改，Codex 不执行快照撤销。",
    "The current content or document identity does not match this run's undo checkpoint. Codex stopped Undo and kept the recovery data.",
    "当前内容或文档身份与本轮撤销检查点不一致；Codex 已停止撤销并保留恢复材料。"
  ],
  [
    "snapshot_undo_open_failed",
    "无法打开 {file} 来执行快照撤销。",
    "Codex could not open the file to restore its saved checkpoint.",
    "Codex 无法打开文件来恢复已保存的检查点。"
  ],
  [
    "snapshot_undo_unavailable",
    "The saved checkpoint is unavailable for this undo.",
    "The saved checkpoint is unavailable for this Undo. Codex kept the remaining recovery data.",
    "本次撤销所需的检查点不可用；Codex 已保留剩余恢复材料。"
  ]
];
function reviewLocaleFormatters(getLocale) {
  const context = vm.createContext({ window: {} });
  for (const file of ['failureReasons', 'i18n']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/shared/' + file + '.js'), 'utf8'), context);
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/applyResultFormatters.js'), 'utf8'), context);
  return context.window.CodexOverleafApplyResultFormatters.create({ i18n: context.CodexOverleafI18n,
    FailureReasons: context.CodexOverleafFailureReasons, getLocale,
    tr: (key, params) => I18n.t(getLocale(), key, params), tx: (en, zh) => getLocale() === 'zh' ? zh : en });
}
for (const [code, template, english, chinese] of reviewLocaleCases) {
  test('review messages retain semantics and follow locale through settlement/storage/Notice/details: ' + template, () => {
    const reason = template.replaceAll('{file}', undoPath);
    for (const rawCode of [code, 'unknown_legacy_failure']) {
      const run = persistedUndoFailure(rawCode, reason);
      const before = JSON.stringify(run), failure = Settlement.projectRunSettlement(run).primaryFailure;
      let locale = 'en';
      const formatters = reviewLocaleFormatters(() => locale);
      for (const [activeLocale, expected] of [['en', english], ['zh', chinese], ['en', english]]) {
        locale = activeLocale;
        const { report, view, message } = renderFailure(run, locale);
        assert.equal(message, undoPath + ': ' + expected);
        assert.equal(message.split(undoPath).length - 1, 1, 'file prefix must be displayed only once');
        assert.equal(FailureReasons.localizeFailureMessage(reason, locale, key => I18n.t(locale, key)),
          (template.includes('{file}') ? undoPath + ': ' : '') + expected, 'a static fallback must not invent a file path');
        const recovery = view.getRecoveryContext(report);
        assert.deepEqual(recovery.failure, failure, 'display cannot alter the actual recovery failure');
        assert.equal(recovery.file, undoPath);
        for (const result of [{ failure }, { ok: false, code: rawCode, reason }]) {
          assert.equal(formatters.formatBridgeResultReason(result, undoPath), undoPath + ': ' + expected);
          assert.equal(formatters.formatApplyResultReason({ result, operation: { path: undoPath } }), undoPath + ': ' + expected);
        }
      }
      assert.equal(JSON.stringify(run), before, 'locale switching cannot rewrite raw facts or checkpoints');
    }
  });
}

test('structured native Review and cancellation/deadline failures localize without claiming an unstarted action completed', () => {
  const nativeNotStarted = 'The native tracked-change scope could not be safely isolated. No review mutation was attempted. Use Overleaf Review to handle the changes individually.';
  const nativeStarted = 'The native review request could not be fully verified; some target changes may already be accepted. No text replay was attempted. Check Overleaf Review before retrying.';
  const cases = [
    ['tracked_changes_remain', 'native_review_scope_changed', nativeNotStarted, 'review_scope_unavailable', false],
    ['tracked_changes_remain', 'native_merged_review_interrupted', nativeStarted, 'review_request_unverified', true],
    ['tracked_changes_remain', 'writeback_deadline_exceeded', 'The review time budget expired; no further review writes were started.', 'review_deadline_exceeded', true],
    ['tracked_changes_remain', 'aborted_project_changed', 'The original review project is no longer active.', 'review_project_changed', false],
    ['codex_run_cancelled', 'codex_cancelled', 'The Undo owner disconnected; no further review writes were started.', 'review_owner_disconnected', true],
    ['codex_run_cancelled', 'codex_cancelled', 'The review was cancelled; no further review writes were started.', 'review_cancelled', false],
    ['editing_not_confirmed', 'accept_editing_not_confirmed', 'Codex could not confirm Editing mode for the untracked Accept replay, so the run was not finalized.', 'accept_editing_not_confirmed', true],
    ['tracked_changes_remain', 'tracked_change_undo_max_iterations', undoPath + ' still has tracked changes after the per-expected-file reject sweep, so Codex stopped to avoid mis-rejecting other edits.', 'tracked_change_undo_max_iterations', true]
  ];
  for (const [code, originalCode, userMessage, displayCode, changedDocument] of cases) {
    const raw = { code, stage: 'reviewing', severity: 'blocked', terminalState: 'blocked', retryable: false,
      userMessage, technicalMessage: userMessage, changedDocument, file: undoPath,
      nextAction: 'Check the retained per-file results in Overleaf before retrying.',
      evidence: { originalCode, writeStarted: changedDocument } };
    const run = persistedUndoFailure(originalCode, userMessage, raw);
    const before = JSON.stringify({ raw, run });
    let locale = 'en'; const formatters = reviewLocaleFormatters(() => locale);
    for (locale of ['en', 'zh', 'en']) {
      const expected = undoPath + ': ' + I18n.t(locale, 'failureReason_' + displayCode + '_user');
      assert.equal(renderFailure(run, locale).message, expected);
      assert.equal(formatters.formatBridgeResultReason({ failure: raw }), expected);
      const localized = FailureReasons.localizeFailureReason(raw, locale, key => I18n.t(locale, key));
      assert.equal(localized.nextAction, I18n.t(locale, 'failureReason_review_detail_next'));
      assert.equal(FailureReasons.localizeFailureMessage(userMessage, locale, key => I18n.t(locale, key)),
        (userMessage.includes(undoPath) ? undoPath + ': ' : '') + I18n.t(locale, 'failureReason_' + displayCode + '_user'));
      const recovery = renderFailure(run, locale);
      assert.equal(recovery.view.getRecoveryContext(recovery.report).failure.code, code);
      assert.equal(recovery.view.getRecoveryContext(recovery.report).failure.retryable, false);
    }
    assert.equal(JSON.stringify({ raw, run }), before);
  }
});
test('display matching rejects modified templates and unsafe inferred paths in every consumer', () => {
  const template = '还有 {file} 的留痕记录未处理，但没有找到对应的 Reject/拒绝按钮；请在 Overleaf 审阅面板手动拒绝。';
  for (const reason of [template.replace('{file}', '../private.tex'), template.replace('{file}', '/private.tex'),
    template.replace('{file}', undoPath) + ' Extra details.', 'External diagnostic: 数据缺失']) {
    let locale = 'en'; const formatters = reviewLocaleFormatters(() => locale);
    const run = persistedUndoFailure('unknown_legacy_failure', reason);
    run.settlement.failures[0].file = '';
    const before = JSON.stringify(run);
    for (locale of ['en', 'zh']) {
      assert.equal(renderFailure(run, locale).message, reason);
      assert.equal(formatters.formatBridgeResultReason({ code: 'unknown_legacy_failure', reason }), reason);
      assert.equal(formatters.formatApplyResultReason({ result: { code: 'unknown_legacy_failure', reason } }), reason);
      assert.equal(FailureReasons.localizeFailureMessage(reason, locale, key => I18n.t(locale, key)), reason);
    }
    assert.equal(JSON.stringify(run), before);
  }
});
test('historical review path parsing never grants a recovery action', () => {
  const run = persistedUndoFailure('unknown_legacy_failure', '还有 ' + undoPath + ' 的留痕记录未处理，但没有找到对应的 Reject/拒绝按钮；请在 Overleaf 审阅面板手动拒绝。');
  run.settlement.failures[0].file = '';
  for (const locale of ['en', 'zh']) {
    const { report, view, message } = renderFailure(run, locale);
    assert.equal(message, undoPath + ': ' + I18n.t(locale, 'failureReason_tracked_change_reject_control_not_found_user'));
    assert.equal(view.getRecoveryContext(report).file, '');
    assert.equal(view.getRecoveryContext(report).failure.code, 'unknown_legacy_failure');
  }
});

test('every canonical failure has bilingual Notice, details and next action without rewriting its recovery facts', () => {
  let locale = 'en'; const formatters = reviewLocaleFormatters(() => locale);
  for (const [code, catalog] of Object.entries(FailureReasons.FAILURE_CODE_CATALOG)) {
    if (code === 'unknown_legacy_failure') continue;
    const failure = FailureReasons.normalizeFailureReason({ ok: false, code, reason: catalog.fallbackUserMessage }, { path: undoPath });
    const before = JSON.stringify(failure);
    for (locale of ['en', 'zh', 'en']) {
      const userKey = 'failureReason_' + code + '_user', nextKey = 'failureReason_' + code + '_next';
      const template = I18n.t(locale, userKey), next = I18n.t(locale, nextKey);
      assert.notEqual(template, userKey, code + ' needs localized user copy in ' + locale);
      assert.notEqual(next, nextKey, code + ' needs localized next step in ' + locale);
      if (locale === 'zh') {
        assert.match(template, /[\u4e00-\u9fff]/, code + ' Chinese user copy');
        assert.match(next, /[\u4e00-\u9fff]/, code + ' Chinese next step');
      } else {
        assert.doesNotMatch(template + next, /[\u4e00-\u9fff]/, code + ' English copy');
      }
      const localized = FailureReasons.localizeFailureReason(failure, locale, key => I18n.t(locale, key));
      const expected = (template.includes('{file}') ? '' : undoPath + ': ') + template.replaceAll('{file}', undoPath).replaceAll('{activeFile}', '').replaceAll('{operationType}', '');
      const document = { createElement: tag => new NoticeNode(tag) }, report = document.createElement('section');
      report.dataset.status = 'failed';
      const view = Notice.create({ document, tr: (key, params) => I18n.t(locale, key, params) });
      view.append(report, { failure });
      assert.equal(report.children[0].children[1].textContent, expected, code + ' Notice in ' + locale);
      assert.equal(formatters.formatBridgeResultReason({ failure }), expected, code + ' Bridge in ' + locale);
      assert.equal(formatters.formatApplyResultReason({ result: { failure } }), expected, code + ' apply in ' + locale);
      assert.equal(localized.nextAction, next.replaceAll('{file}', undoPath).replaceAll('{activeFile}', '').replaceAll('{operationType}', ''));
      assert.equal(view.getRecoveryContext(report).failure, failure);
    }
    assert.equal(JSON.stringify(failure), before, code + ' raw recovery facts');
  }
});

const runtimeOwnedReasons = [
  ['The selected provider no longer exists.', '所选模型服务已不存在。'],
  ['The selected provider has no usable revision.', '所选模型服务没有可用的配置版本。'],
  ['The selected provider revision was not captured for this run.', '本轮任务未记录所选模型服务的配置版本。'],
  ['The selected provider changed after this run was submitted.', '本轮任务提交后，所选模型服务的配置已发生变化。'],
  ['The captured selection is invalid. Attach it again.', '已记录的选区无效，请重新添加。'],
  ['Provider revision must be a finite non-negative integer.', '模型服务配置版本必须是有效的非负整数。'],
  ['A stable matching Overleaf account is required for shared history.', '共享历史需要稳定且匹配的 Overleaf 账号。'],
  ['The background storage connection was lost.', '后台存储连接已断开。'],
  ['Shared history is unavailable. Reload the extension and this page.', '共享历史不可用，请重新加载扩展和当前页面。'],
  ['The shared history lock disconnected.', '共享历史的存储锁连接已断开。'],
  ['Another page is saving history. Retry after it finishes.', '其他页面正在保存历史，请待保存完成后重试。'],
  ['The shared history lock was lost before completion.', '操作完成前，共享历史的存储锁已丢失。'],
  ['A stable account scope is required for durable persistence.', '持久保存需要稳定的账号范围。'],
  ['A cross-realm browser lock is required for durable persistence.', '持久保存需要能够跨页面协调的浏览器锁。'],
  ['Shared session storage is unavailable.', '共享会话存储不可用。'],
  ['Native host request failed.', '本地主机请求失败。'],
  ['Native host disconnected', '本地主机连接已断开。']
];
test('runtime-owned failures follow locale without translating external error content', () => {
  let locale = 'en'; const formatters = reviewLocaleFormatters(() => locale);
  for (const [en, zh] of runtimeOwnedReasons) {
    for (locale of ['en', 'zh']) for (const source of [en, zh]) {
      assert.equal(formatters.localizeVisibleReason(source), locale === 'zh' ? zh : en);
    }
  }
  locale = 'zh';
  assert.equal(formatters.localizeVisibleReason('Scoped persistence failed: revision_conflict'), '限定范围的持久保存失败：revision_conflict');
  locale = 'en';
  assert.equal(formatters.localizeVisibleReason('限定范围的持久保存失败：revision_conflict'), 'Scoped persistence failed: revision_conflict');
  for (const message of ['Unknown service error: 原始诊断', 'Native host disconnected: service custom detail',
    'Scoped persistence failed: custom payload / details']) {
    for (locale of ['en', 'zh']) assert.equal(formatters.localizeVisibleReason(message), message);
  }
});

test('historical formatter file prefixes follow the locale without duplication or new recovery authority', () => {
  let locale = 'en'; const formatters = reviewLocaleFormatters(() => locale);
  const english = undoPath + ': Some tracked changes remain, but the matching Reject button was not found. Check them in the Overleaf review panel.';
  const chinese = undoPath + ': 仍有留痕记录未处理，但未找到对应的拒绝按钮；请在 Overleaf 审阅面板检查。';
  for (locale of ['en', 'zh', 'en']) for (const source of [english, chinese]) {
    const expected = locale === 'zh' ? chinese : english;
    assert.equal(formatters.localizeVisibleReason(source), expected);
    const run = persistedUndoFailure('unknown_legacy_failure', source);
    run.settlement.failures[0].file = '';
    const { report, view, message } = renderFailure(run, locale);
    assert.equal(message, expected);
    assert.equal(view.getRecoveryContext(report).file, '');
    assert.equal(view.getRecoveryContext(report).failure.code, 'unknown_legacy_failure');
  }
  for (const source of ['../escape.tex: ' + english.split(': ')[1], '/private.tex: ' + english.split(': ')[1], english + ' Additional details.']) {
    for (locale of ['en', 'zh']) assert.equal(formatters.localizeVisibleReason(source), source);
  }
});
test('exact canonical default messages in old records localize while unknown legacy details remain untouched', () => {
  let locale = 'en'; const formatters = reviewLocaleFormatters(() => locale);
  for (const [code, catalog] of Object.entries(FailureReasons.FAILURE_CODE_CATALOG)) {
    if (code === 'unknown_legacy_failure') continue;
    for (locale of ['en', 'zh']) {
      const expected = FailureReasons.formatFailureReasonForDisplay({ code, userMessage: catalog.fallbackUserMessage, file: undoPath }, locale, key => I18n.t(locale, key)).message;
      const run = persistedUndoFailure('unknown_legacy_failure', catalog.fallbackUserMessage);
      const before = JSON.stringify(run), { report, view, message } = renderFailure(run, locale);
      assert.equal(message, expected, code + ' historical Notice');
      assert.equal(formatters.formatBridgeResultReason({ code: 'unknown_legacy_failure', reason: catalog.fallbackUserMessage }, undoPath), expected);
      assert.equal(view.getRecoveryContext(report).failure.code, 'unknown_legacy_failure');
      assert.equal(view.getRecoveryContext(report).failure.retryable, false);
      assert.equal(JSON.stringify(run), before);
    }
  }
});
