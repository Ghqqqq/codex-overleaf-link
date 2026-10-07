const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { extractFunction } = require('./_helpers/extractFunction');
const I18n = require('../extension/src/shared/i18n');

const read = name => fs.readFileSync(path.join(__dirname, '../extension/src/content', name + '.js'), 'utf8');
function production(file, name, deps = {}) {
  return Function(...Object.keys(deps), `${extractFunction(read(file), name)}; return ${name};`)(...Object.values(deps));
}
const noop = () => {};

test('language change refreshes nonempty history and cached UI without resetting draft controls', () => {
  const calls = [];
  const task = { value: '用户 English draft', placeholder: '' };
  const access = { dataset: { i18nAriaLabel: 'historyStatusLabel' }, setAttribute: (key, value) => { access[key] = value; } };
  const panel = { querySelectorAll: selector => selector === '[data-i18n-aria-label]' ? [access] : [],
    querySelector: selector => selector === '[data-task]' ? task : null };
  let locale = 'zh';
  const deps = { panel, tr: key => I18n.t(locale, key), tx: (en, zh) => locale === 'zh' ? zh : en,
    panelRendererInstance: { setLocale: value => calls.push(['shell', value]) },
    runTimelineView: { refreshLocale: () => calls.push(['history']) },
    settingsPanelInstance: { refreshNotes: noop, refreshLocale: () => calls.push(['settings']) },
    providerSettingsCoordinator: { renderSummary: noop, refreshLocale: () => calls.push(['providers']) },
    writingStyleSettings: { sync: noop }, Modules: { UpdateNotice: { refreshLocale: () => calls.push(['update']) } },
    DiagnosticsPanel: {}, diagnosticsPanelInstance: null, diagnosticsController: {}, localSkillsPanel: {} };
  for (const name of ['setElementTitleAndAria', 'setDiagnosticsHealth', 'syncComposerSendAvailability', 'syncModeControls',
    'updateOtStatusDisplay', 'updateExperimentalOtMenuStatus', 'renderModelConfigChoices', 'updateModelDisplay',
    'renderSessionList', 'renderContextSelection', 'renderContextSummary', 'renderContextFiles', 'renderPendingInputs',
    'renderComposerAttachments', 'renderComposerSkillInvocation', 'updateSkillsEntrySummary']) deps[name] = () => calls.push([name]);
  const refresh = production('contentRuntime', 'applyLocaleToPanel', deps);
  for (locale of ['zh', 'en']) {
    calls.length = 0; refresh();
    assert.ok(calls.some(([name]) => name === 'history'));
    for (const name of ['providers', 'settings', 'update', 'renderPendingInputs', 'renderComposerAttachments', 'renderComposerSkillInvocation']) assert.ok(calls.some(([value]) => value === name), name);
    assert.equal(task.value, '用户 English draft');
    assert.equal(task.placeholder, I18n.t(locale, 'placeholder'));
    assert.equal(access['aria-label'], I18n.t(locale, 'historyStatusLabel'));
    assert.match(calls.find(([name]) => name === 'shell')[1].close, locale === 'zh' ? /关闭/ : /Close/);
  }
});

test('stored product statuses project both ways while unfamiliar text stays untouched', () => {
  let locale = 'en';
  const status = production('runTimelineView', 'getRunStatusText', {
    tx: (en, zh) => locale === 'zh' ? zh : en, tr: (key, args) => I18n.t(locale, key, args), formatProcessedSummary: () => 'unused'
  });
  const run = { status: 'completed', statusText: '已处理 1m 2s', task: '用户 English' };
  assert.equal(status(run), 'Done 1m 2s');
  locale = 'zh';
  assert.equal(status({ ...run, statusText: 'Done 1m 2s' }), '已处理 1m 2s');
  assert.equal(status({ status: 'interrupted', statusText: 'Stopped tracking after a page refresh' }), '页面刷新后已停止跟踪');
  assert.equal(status({ statusText: 'Custom event / 原始内容' }), 'Custom event / 原始内容');
  assert.equal(run.statusText, '已处理 1m 2s');
});

test('history locale refresh preserves live streaming references and historical expansion', () => {
  const first = { id: 'done', status: 'completed', task: '用户 question', events: [{ title: 'model English answer' }] };
  const running = { id: 'active', status: 'running', task: 'another', events: [{ kind: 'report', title: 'Answer 原文' }] };
  const oldHistory = { querySelector: () => ({ open: true }), replaceWith(value) { oldHistory.replaced = value; } };
  const status = { textContent: '处理中' };
  const active = { querySelector: () => status };
  const report = { replaceChildren(value) { this.rendered = value; } };
  const view = { root: active, report, events: {}, streamed: '模型 text' };
  const log = { scrollTop: 73, querySelector: selector => selector.includes('done') ? oldHistory : active };
  const nextProcess = { open: false };
  const next = { querySelector: () => nextProcess };
  let updates = 0;
  const refresh = production('runTimelineView', 'refreshLocale', {
    getPanel: () => ({ querySelector: () => log }), getState: () => ({ runs: [first, running] }),
    scrollLayout: null, cssEscape: value => value, getCurrentRunView: () => view,
    renderRunCard: run => { assert.equal(run, first); return next; }, getRunStatusText: () => 'Running',
    configureAcceptButton: noop, configureUndoButton: noop, configureEditButton: noop, configureWritebackButton: noop,
    RunResultActions: { configureResultActions: noop }, activitySummary: { update: actual => { assert.equal(actual, view); updates++; } },
    updateJumpToLatestButton: noop, renderRunHistory: () => { throw Error('must preserve live owner'); }
    , displayLocalizedRun: value => value, renderCompletionReport: value => ({ localized: true, answer: value.title })
  });
  refresh();
  assert.equal(oldHistory.replaced, next); assert.equal(nextProcess.open, true); assert.equal(log.scrollTop, 73);
  assert.equal(view.root, active); assert.equal(view.streamed, '模型 text'); assert.equal(updates, 1);
  assert.equal(status.textContent, 'Running');
  assert.equal(view.report, report); assert.deepEqual(report.rendered, { localized: true, answer: 'Answer 原文' });
  assert.equal(first.task, '用户 question'); assert.equal(first.events[0].title, 'model English answer');
});

function text(value) { return { nodeType: 3, nodeValue: value }; }
function element(tag, children = [], attributes = {}) {
  return { nodeType: 1, tagName: tag, childNodes: children, attrs: { ...attributes },
    getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; },
    setAttribute(key, value) { this.attrs[key] = value; } };
}

test('provider locale patch only changes copy and leaves input nodes, secrets, selection and textareas intact', () => {
  const label = text('Provider name'), secret = element('INPUT', [], { placeholder: 'optional' });
  secret.value = 'local-test-secret'; secret.selectionStart = 4;
  const instructions = element('TEXTAREA', [text('用户原文 English')]); instructions.value = 'draft 用户';
  const current = element('DIV', [label, secret, instructions], { 'aria-label': 'Models & providers' });
  const reference = element('DIV', [text('服务名称'), element('INPUT', [], { placeholder: '可选', value: '' }), element('TEXTAREA', [text('stale')])], { 'aria-label': '模型与服务' });
  const patch = Function(`${extractFunction(read('providerSettingsDialog'), 'patchLocaleCopy')}; return patchLocaleCopy;`)();
  patch(current, reference);
  assert.equal(label.nodeValue, '服务名称'); assert.equal(current.attrs['aria-label'], '模型与服务');
  assert.equal(current.childNodes[1], secret); assert.equal(secret.value, 'local-test-secret');
  assert.equal(secret.selectionStart, 4); assert.equal(secret.attrs.placeholder, '可选');
  assert.equal(instructions.value, 'draft 用户'); assert.equal(instructions.childNodes[0].nodeValue, '用户原文 English');
});

test('provider native errors use current UI language and preserve unknown provider diagnostics', () => {
  let locale = 'zh'; const instance = { tx: (en, zh) => locale === 'zh' ? zh : en };
  const format = production('providerSettingsCoordinator', 'formatError');
  for (const code of ['provider_store_busy', 'provider_store_too_large', 'provider_store_unavailable', 'provider_store_corrupt',
    'provider_not_found', 'provider_dns_failed', 'provider_tls_failed', 'provider_rate_limited', 'provider_model_not_configured',
    'provider_selection_unavailable', 'provider_disclosure_required', 'provider_secret_invalid', 'provider_model_catalog_unavailable', 'native_unavailable']) {
    const error = { code, message: 'Internal English detail' };
    assert.match(format(instance, error), /\p{Script=Han}/u, code);
    locale = 'en'; assert.doesNotMatch(format(instance, error), /\p{Script=Han}/u, code); locale = 'zh';
    assert.equal(error.message, 'Internal English detail');
  }
  assert.equal(format(instance, { code: 'unknown_remote_error', message: 'Vendor diagnostic 原文' }), 'Vendor diagnostic 原文');
});

test('provider validation errors keep their field-specific meaning across locale refreshes', () => {
  let locale = 'zh'; const calls = [];
  const instance = { tx: (en, zh) => { calls.push([en, zh]); return locale === 'zh' ? zh : en; } };
  const format = production('providerSettingsDialog', 'formatModelEditorError');
  const error = { field: 'contextWindow', message: 'Invalid context window.' };
  assert.equal(format(instance, error), '上下文窗口必须为 8192 至 4000000 之间的整数。');
  assert.equal(calls.length, 1);
  locale = 'en'; assert.equal(format(instance, error), 'Invalid context window.');
  assert.deepEqual(error, { field: 'contextWindow', message: 'Invalid context window.' });
});

test('update messages project known native states without modifying evidence', () => {
  let locale = 'zh';
  const format = production('updateNotice', 'formatUpdateMessage', { tx: (en, zh) => locale === 'zh' ? zh : en, blockersCopy: () => '等待保存' });
  for (const code of ['update_phase_timeout', 'update_not_applied', 'update_recovery_pending', 'update_rolled_back', 'update_not_managed',
    'update_native_busy', 'update_cancel_unconfirmed', 'update_apply_unconfirmed', 'update_rollback_unconfirmed', 'update_candidate_missing',
    'update_transaction_locked', 'update_bundle_hash_mismatch', 'update_consent_required', 'update_manifest_schema_unsupported', 'update_signature_invalid', 'update_archive_path_forbidden']) {
    const state = { code, message: 'Original internal message' };
    assert.match(format(state), /\p{Script=Han}/u, code);
    locale = 'en'; assert.doesNotMatch(format(state), /\p{Script=Han}/u, code); locale = 'zh';
    assert.equal(state.message, 'Original internal message');
  }
  assert.equal(format({ code: 'update_reload_required', message: 'Reload is waiting for Overleaf to be saved and idle (unsaved).' }), '等待保存');
  assert.equal(format({ code: 'unknown', message: 'External 原始 detail' }), 'External 原始 detail');
});

test('owned Undo activity localizes structured reasons and counts without changing model streams or file content', () => {
  let locale = 'en';
  const deps = { I18n, tr: (key, params) => I18n.t(locale, key, params),
    localizeCompileReason: value => value,
    localizeVisibleReason: value => value === 'file.tex: 留痕失败' ? 'file.tex: Tracked changes unavailable' : value };
  deps.localizeProductActivity = production('runTimelineView', 'localizeProductActivity', deps);
  const sanitize = production('runTimelineView', 'sanitizeRunEventForRender', {
    ...deps, sanitizeAssistantVisibleText: value => value || '', sanitizeAssistantVisibleValue: value => value,
    stripEmptyHtmlCommentPlaceholders: value => value
  });
  const event = { kind: 'activity', title: '撤销结果：已拒绝 1 条留痕，跳过 1 条',
    detail: { '跳过': [{ '文件': '中文路径.tex', '原因': 'file.tex: 留痕失败', '记录': '用户 label' }] },
    technicalDetail: { reason: '原始诊断' } };
  const result = sanitize(event);
  assert.equal(result.title, 'Undo result: rejected 1 tracked change(s), skipped 1');
  assert.equal(result.detail[I18n.t('en', 'detailSkipped')][0][I18n.t('en', 'detailReason')], 'file.tex: Tracked changes unavailable');
  assert.equal(result.detail.Skipped[0].File, '中文路径.tex');
  assert.equal(result.detail.Skipped[0].Record, '用户 label');
  assert.equal(event.title, '撤销结果：已拒绝 1 条留痕，跳过 1 条');
  assert.deepEqual(result.technicalDetail, event.technicalDetail);
  for (const kind of ['stream', 'report', 'guidance', 'technical', 'command']) assert.equal(sanitize({ ...event, kind }).title, event.title);
  locale = 'zh'; assert.equal(sanitize({ ...event, title: result.title }).title, event.title);
});

async function produceWritebackActivities(locale, written, skipped) {
  const tx = (en, zh) => locale === 'zh' ? zh : en;
  const tr = (key, params) => I18n.t(locale, key, params);
  const events = [], windowObject = {};
  Function('window', read('applyResultFormatters'))(windowObject);
  Function('window', read('writebackOrchestrator'))(windowObject);
  const plan = require('../extension/src/content/writebackPlan').create({ tx,
    GovernanceRules: require('../extension/src/shared/governanceRules'),
    getGovernanceRulesForCurrentProject: () => ({ readonlyPatterns: ['blocked/**'] }) });
  const operations = Array.from({ length: skipped }, (_, index) => ({ type: 'edit', path: `blocked/file-${index}.tex` }));
  const governed = plan.evaluateGovernedOperations(operations);
  const blocked = plan.buildGovernanceSkippedApplyResult(governed.blocked);
  const formatters = windowObject.CodexOverleafApplyResultFormatters.create({ tx, tr, getLocale: () => locale,
    FailureReasons: require('../extension/src/shared/failureReasons'),
    getAppliedEntries: result => result.applied, getSkippedEntries: result => result.skipped,
    appendRunEvent: event => events.push(event) });
  formatters.appendApplyResult({ ...blocked,
    applied: Array.from({ length: written }, (_, index) => ({ operation: { type: 'edit', path: `written-${index}.tex` }, result: { status: 'applied' } })) });
  const writeEvent = events.pop();
  const orchestrator = windowObject.CodexOverleafWritebackOrchestrator.create({ tx, tr,
    appendRunEvent: event => events.push(event), appendChangeSummary: noop, appendCompletionReport: noop, appendApplyResult: noop,
    getState: () => ({ mode: 'auto', requireReviewing: true }), getAssistantAnswerForCurrentRun: () => '',
    cleanFinalAnswer: value => value, buildSyncApplyOperations: () => operations,
    partitionUnsafeProjectPathOperations: value => ({ safe: value, skipped: [] }),
    evaluateGovernedOperations: plan.evaluateGovernedOperations, buildGovernanceSkippedApplyResult: plan.buildGovernanceSkippedApplyResult,
    getSkippedEntries: result => result.skipped, filterSyncChangesByOperations: () => [], formatWritebackSkippedNextStep: () => '',
    summarizeOperationForAudit: value => value, buildAuditSummaryFromApply: value => value,
    writebackSettlement: require('../extension/src/shared/writebackSettlement') });
  await orchestrator.applySyncChangesToOverleaf(operations, {}, { mode: 'auto', assistantMessage: 'Model 原文' });
  return [writeEvent, events[0]];
}

for (const from of ['en', 'zh']) {
  for (const [written, skipped] of [[0, 1], [2, 3]]) {
    test(`owned writeback activities (${written}/${skipped}, ${from}) reproject producer counts and preserve non-activity text`, async () => {
      const original = await produceWritebackActivities(from, written, skipped);
      const saved = JSON.stringify(original);
      const to = from === 'en' ? 'zh' : 'en';
      const expected = await produceWritebackActivities(to, written, skipped);
      let locale = to;
      const deps = { I18n, tx: (en, zh) => locale === 'zh' ? zh : en,
        tr: (key, params) => I18n.t(locale, key, params), localizeVisibleReason: value => value, localizeCompileReason: value => value };
      deps.localizeProductActivity = production('runTimelineView', 'localizeProductActivity', deps);
      const sanitize = production('runTimelineView', 'sanitizeRunEventForRender', { ...deps,
        sanitizeAssistantVisibleText: value => value || '', sanitizeAssistantVisibleValue: value => value,
        stripEmptyHtmlCommentPlaceholders: value => value });
      for (const [index, event] of original.entries()) {
        const projected = sanitize(event);
        assert.equal(projected.title, expected[index].title);
        assert.deepEqual(projected.detail, event.detail);
        locale = from;
        assert.equal(sanitize(projected).title, event.title);
        locale = to;
        for (const patch of [
          ...['stream', 'report', 'guidance', 'technical', 'command'].map(kind => ({ kind })),
          { streamRole: 'assistant' }, { streamRole: 'reasoning' }, { guidanceId: 'guide-1' }
        ]) assert.equal(sanitize({ ...event, ...patch }).title, event.title);
        for (const title of [`Model says: ${event.title}`, `${event.title} extra 原文`, 'unknown diagnostic 原文']) {
          assert.equal(sanitize({ ...event, title }).title, title);
        }
      }
      assert.equal(JSON.stringify(original), saved);
    });
  }
}

test('historical compile activity projects only owned titles and keeps raw technical evidence', () => {
  const Compile = require('../extension/src/shared/compileAdapter');
  let locale = 'zh';
  const deps = { I18n, tr: (key, params) => I18n.t(locale, key, params), localizeVisibleReason: value => value,
    localizeCompileReason: value => Compile.localizeCompileReason(value, locale) };
  const project = production('runTimelineView', 'localizeProductActivity', deps);
  assert.equal(project('Compile succeeded.', '').title, '编译成功。');
  const source = 'Post-write compile did not succeed: No Overleaf Recompile button or compile request template is available.';
  assert.equal(project(source, { raw: 'No log file found in compile output' }).title, '写后编译未成功：没有可用的 Overleaf 重新编译按钮或编译请求模板。');
  assert.deepEqual(project(source, { raw: 'No log file found in compile output' }).detail, { raw: 'No log file found in compile output' });
  const sanitize = production('runTimelineView', 'sanitizeRunEventForRender', { ...deps, localizeProductActivity: project,
    sanitizeAssistantVisibleText: value => value || '', sanitizeAssistantVisibleValue: value => value, stripEmptyHtmlCommentPlaceholders: value => value });
  locale = 'en';
  const title = '写后编译未成功：没有可用的编译日志地址';
  const activity = { kind: 'compile', output: '没有可用的编译日志地址' };
  const projected = sanitize({ kind: 'activity', title, activity });
  assert.equal(projected.title, 'Post-write compile did not succeed: No compile log URL available');
  assert.equal(projected.activity.output, 'No compile log URL available');
  assert.equal(activity.output, '没有可用的编译日志地址');
  for (const kind of ['stream', 'report', 'technical']) { const item = sanitize({ kind, title, activity }); assert.equal(item.title, title); assert.equal(item.activity, activity); }
  assert.equal(sanitize({ kind: 'activity', title, activity: { kind: 'compile', output: '! TeX raw log 中文' } }).activity.output, '! TeX raw log 中文');
});

test('model choices rederive reasoning labels and the owned custom suffix without changing model IDs', () => {
  let locale = 'zh';
  const model = { value: 'custom-id', textContent: 'custom-id (custom)', dataset: { unverified: 'true' } };
  const named = { value: 'provider-id', textContent: '用户 Model Name', dataset: {} };
  const list = { textContent: '', entries: [], append(value) { this.entries.push(value); } };
  const tx = (en, zh) => locale === 'zh' ? zh : en;
  const models = production('modelPicker', 'renderModelChoices', { getPanel: () => ({ querySelector: selector => selector === '[data-model-choice-list]' ? list : { options: [model, named] } }),
    createModelConfigChoice: value => value, tx });
  models(); assert.equal(model.textContent, 'custom-id（自定义）'); assert.equal(named.textContent, '用户 Model Name');
  locale = 'en'; models(); assert.equal(model.textContent, 'custom-id (custom)'); assert.equal(model.value, 'custom-id');
  const reasoning = production('modelPicker', 'renderReasoningChoices', { getPanel: () => ({ querySelector: selector => selector === '[data-reasoning-choice-list]' ? list : { options: [{ value: 'high', textContent: 'High' }], dataset: {} } }),
    formatReasoningEffortLabel: () => '高', createModelConfigChoice: value => value });
  reasoning(); assert.equal(list.entries.at(-1).label, '高');
});
