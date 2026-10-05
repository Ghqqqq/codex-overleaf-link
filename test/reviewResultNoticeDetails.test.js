'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');
const { createPersistenceFixture } = require('./_helpers/undoPersistenceHarness');
const Activity = require('../extension/src/shared/runActivityModel');
const I18n = require('../extension/src/shared/i18n');
const Failures = require('../extension/src/shared/failureReasons');
const Db = require('../extension/src/shared/storageDb');
const Session = require('../extension/src/shared/sessionState');
const Settlement = require('../extension/src/shared/writebackSettlement');
const read = file => fs.readFileSync(path.join(__dirname, '../extension/src/content', file + '.js'), 'utf8');
function production(file, name, deps = {}) {
  return Function(...Object.keys(deps), extractFunction(read(file), name) + '; return ' + name)(...Object.values(deps));
}
function messages(getLocale) {
  const tr = (key, values) => I18n.t(getLocale(), key, values);
  const tx = (en, zh) => getLocale() === 'zh' ? zh : en;
  const context = { window: {} };
  vm.runInNewContext(read('applyResultFormatters'), context);
  const formatters = context.window.CodexOverleafApplyResultFormatters.create({ i18n: I18n, FailureReasons: Failures, getLocale, tr, tx });
  const deps = { I18n, tr, localizeVisibleReason: formatters.localizeVisibleReason, localizeCompileReason: value => value };
  const projectReviewResultEvent = production('runTimelineView', 'sanitizeRunEventForRender', {
    ...deps, localizeProductActivity: production('runTimelineView', 'localizeProductActivity', deps),
    sanitizeAssistantVisibleText: value => value || '', sanitizeAssistantVisibleValue: value => value,
    stripEmptyHtmlCommentPlaceholders: value => value
  });
  const formatReviewResultFailure = production('runTimelineView', 'formatReviewResultFailure', { FailureReasons: Failures, getLocale, tr });
  return { tr, tx, ...formatters, projectReviewResultEvent, formatReviewResultFailure };
}
function node() {
  return { children: [], dataset: {}, _text: '',
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); },
    set textContent(value) { this._text = String(value); this.children = []; },
    append(...values) { this.children.push(...values); }, replaceChildren(...values) { this._text = ''; this.children = values; } };
}
function renderer(locale) {
  const m = messages(locale), plain = value => String(value || '').replace(/SENSITIVE_TEST_PAYLOAD/g, '[redacted]');
  const deps = { ...m, plain, choices: new Map(), text: (target, value) => { target.textContent = value; },
    make: () => node(), formatElapsed: value => String(value), effectiveState: item => item.meta.state,
    kindLabel: () => m.tx('Notice', '提示'), targetText: item => item.event.title, stateLabel: state => state };
  deps.reviewResultLines = read('runActivitySummary').includes('function reviewResultLines(')
    ? production('runActivitySummary', 'reviewResultLines', deps) : () => [];
  return { render: production('runActivitySummary', 'renderTool', deps), deps };
}
function row() { return { el: node(), label: node(), target: node(), status: node(), diff: node(), body: node(), bodyStamp: '', key: 'existing-notice' }; }
const skippedPath = 'qa/中文-file.tex';
const rawReason = `还有 ${skippedPath} 的留痕记录未处理，但没有找到对应的 Reject/拒绝按钮；请在 Overleaf 审阅面板手动拒绝。`;
async function controllerResult(t, action, locale) {
  const m = messages(() => locale);
  const h = await createPersistenceFixture({ track: true,
    files: [{ path: skippedPath, content: 'before\n' }],
    operations: [{ type: 'edit', path: skippedPath, replaceAll: 'before\n% marker\n', verifiedContent: 'before\n% marker\n' }] });
  t.after(() => h.close());
  h.run.undoTrackedChanges = [{ path: skippedPath, key: 'owned', id: 'owned', label: 'INTERNAL_RECORD_MUST_NOT_RENDER' }];
  h.run.trackedChangeStatus = 'pending';
  h.context.tr = m.tr; h.context.tx = m.tx; h.context.formatBridgeResultReason = m.formatBridgeResultReason;
  const markdown = { window: {} }; vm.runInNewContext(read('markdownText'), markdown);
  const sanitizer = markdown.window.CodexOverleafMarkdownText.create({});
  h.context.appendRunRecordEvent = production('contentRuntime', 'appendRunRecordEvent', {
    findRunRecord: () => h.run, Modules: { RunActivityModel: Activity }, MAX_RUN_EVENTS: 300,
    sanitizeAssistantVisibleText: sanitizer.sanitizeAssistantVisibleText, sanitizeAssistantVisibleValue: sanitizer.sanitizeAssistantVisibleValue,
    saveStateSoon() {}, panel: null, cssEscape: String
  });
  h.context.callPageBridge = async method => {
    assert.equal(method, action === 'undo' ? 'rejectTrackedChanges' : 'acceptTrackedChanges');
    return { ok: false, applied: [], skipped: [{ trackedChange: h.run.undoTrackedChanges[0], result: {
      ok: false, code: 'tracked_change_reject_control_not_found', reason: rawReason, changedDocument: false
    } }] };
  };
  if (action === 'undo') await h.undo(); else await h.context.getRunReviewController().acceptRun(h.run.id);
  const event = h.run.events.find(value => value.title === m.tr(action === 'undo' ? 'undoTrackedResult' : 'runAcceptTrackedResult', { applied: 0, skipped: 1 }));
  assert.ok(event, 'real controller emitted the attempted review result');
  assert.ok(event.failure, 'the production appendRunRecordEvent preserved its sanitized machine failure');
  assert.ok(event.detail[m.tr('detailSkipped')][0][m.tr('detailReason')]);
  return { ...event, kind: 'activity', timestamp: '2026-10-05T10:00:00.000Z' };
}

for (const action of ['undo', 'accept']) for (const savedLocale of ['en', 'zh']) {
  test(`real ${action} result shows available ${savedLocale} details live and after legacy hydration in either language`, async t => {
    const event = await controllerResult(t, action, savedLocale);
    const original = structuredClone(event);
    const run = { id: 'notice-run', status: 'completed', events: [event] };
    const restored = Session.normalizeRuns(JSON.parse(JSON.stringify([run])))[0];
    const saved = Db.buildSessionRecord({ id: 'notice-session', projectId: 'qa-project', runs: [run] });
    const reloaded = Session.normalizeRuns(JSON.parse(JSON.stringify(saved.runs)))[0];
    assert.equal(reloaded.events[0].detail.redacted, true);
    assert.ok(reloaded.events[0].failure.userMessage);
    assert.equal(reloaded.events[0].failure.file, skippedPath);
    let locale = savedLocale; const ui = renderer(() => locale), view = row();
    for (const availableRun of [run, restored, reloaded]) {
    const item = Activity.project(availableRun).blocks.find(value => value.kind === 'notice');
    assert.ok(item); assert.equal(item.meta.output, '', 'the model does not expose the raw object as tool output');
    for (locale of [savedLocale, savedLocale === 'en' ? 'zh' : 'en', savedLocale]) {
      ui.render(view, item, { projection: { notices: [item] } }, availableRun);
      assert.match(view.body.textContent, /qa\/中文-file\.tex/);
      assert.match(view.body.textContent, locale === 'en' ? /Reject control|Reject button|review panel/i : /拒绝按钮|审阅面板/);
      assert.doesNotMatch(view.body.textContent, /INTERNAL_RECORD_MUST_NOT_RENDER|"Skipped"|"跳过"/);
    }
    }
    assert.deepEqual(event, original);
    assert.equal(restored.events[0].detail[messages(() => savedLocale).tr('detailSkipped')][0][messages(() => savedLocale).tr('detailFile')], skippedPath);
  });
}

test('existing notice body updates when a later result has the same title but a different reason', () => {
  const ui = renderer(() => 'en'), view = row();
  const run = { status: 'completed', events: [{ kind: 'activity', status: 'failed', title: 'Undo result: rejected 0 tracked change(s), skipped 1',
    detail: { Skipped: [{ File: 'main.tex', Reason: 'First visible reason' }] } }] };
  let item = Activity.project(run).blocks[0];
  ui.render(view, item, { projection: { notices: [item] } }, run); assert.match(view.body.textContent, /First visible reason/);
  run.events[0].detail.Skipped[0].Reason = 'New visible reason'; item = Activity.project(run).blocks[0];
  ui.render(view, item, { projection: { notices: [item] } }, run);
  assert.match(view.body.textContent, /New visible reason/); assert.doesNotMatch(view.body.textContent, /First visible reason/);
});

test('older redacted stored details without machine failure stay redacted and do not invent a skipped reason', async t => {
  const event = await controllerResult(t, 'undo', 'en');
  delete event.failure;
  const saved = Db.buildSessionRecord({ id: 'notice-session', projectId: 'qa-project', runs: [{ id: 'notice-run', status: 'completed', events: [event] }] });
  const restored = Session.normalizeRuns(JSON.parse(JSON.stringify(saved.runs)))[0];
  assert.equal(restored.events[0].detail.redacted, true);
  const item = Activity.project(restored).blocks.find(value => value.kind === 'notice');
  const ui = renderer(() => 'en'), view = row();
  ui.render(view, item, { projection: { notices: [item] } }, restored);
  assert.equal(view.body.textContent, event.title);
  assert.doesNotMatch(view.body.textContent, /hash|redacted|INTERNAL_RECORD|Reject button/);
});

test('new machine failure keeps recovery and action projection byte-identical and excludes arbitrary external payload', () => {
  const run = { id: 'review-run', runProjectId: 'project', trackedChangeStatus: 'needs_review', undoStatus: 'partial',
    undoOperations: [], appliedOperations: [{ path: 'main.tex', content: 'post' }], undoBaseFiles: [{ path: 'main.tex', content: 'before' }],
    undoExpectedFiles: [{ path: 'main.tex', content: 'before' }], undoTrackedChanges: [{ path: 'main.tex', id: 'owned' }],
    trackedChangeCaptures: [{ path: 'main.tex', refs: ['owned'] }], events: [] };
  const original = JSON.stringify(run), beforeProjection = Settlement.projectRunSettlement(run);
  const tr = (key, params) => I18n.t('en', key, params);
  const build = production('runReviewController', 'reviewEventFailure', { deps: { FailureReasons: Failures }, Modules: {}, WritebackSettlement: Settlement, tr });
  const secret = 'SENSITIVE_TEST_PAYLOAD'.repeat(10000);
  for (const code of ['native_review_unknown_' + secret, 'tracked_change_reject_control_not_found']) {
    const result = { ok: false, skipped: [{ trackedChange: { path: 'main.tex' }, result: { ok: false, code, reason: secret, evidence: { raw: secret } } }] };
    const priorResult = JSON.stringify(result), failure = build(run, result);
    assert.equal(failure.file, 'main.tex'); assert.ok(JSON.stringify(failure).length < 1200);
    assert.doesNotMatch(JSON.stringify(failure), /SENSITIVE_TEST_PAYLOAD|technicalMessage|originalReason/);
    assert.equal(JSON.stringify(run), original); assert.equal(JSON.stringify(result), priorResult);
    assert.deepEqual(Settlement.projectRunSettlement({ ...run, events: [{ status: 'failed', kind: 'activity', failure }] }), beforeProjection);
    assert.equal(Failures.validateFailureReason(failure).ok, true);
    const stored = Db.buildSessionRecord({ id: 'safe-event', projectId: 'project', runs: [{ ...run, events: [{ title: 'Undo result: rejected 0 tracked change(s), skipped 1', status: 'failed', kind: 'activity', detail: { raw: secret }, failure }] }] });
    assert.equal(stored.runs[0].events[0].detail.redacted, true);
    assert.doesNotMatch(JSON.stringify(stored.runs[0].events[0]), /SENSITIVE_TEST_PAYLOAD/);
  }
  const outside = build(run, { ok: false, skipped: [{ operation: { path: '/outside/project' }, result: { code: 'target_file_not_found', reason: secret } }] });
  assert.equal(outside.file, undefined);
  assert.doesNotMatch(JSON.stringify(outside), /outside\/project|SENSITIVE_TEST_PAYLOAD/);
});

test('stored canonical and safe generic failures retain their codes when switching languages without a trusted file', () => {
  const secret = 'SENSITIVE_TEST_PAYLOAD'.repeat(10000);
  const run = { appliedOperations: [{ path: 'main.tex' }], undoExpectedFiles: [{ path: 'main.tex', content: 'base' }] };
  for (const savedLocale of ['en', 'zh']) {
    const build = production('runReviewController', 'reviewEventFailure', { deps: { FailureReasons: Failures }, Modules: {}, WritebackSettlement: Settlement,
      tr: (key, params) => I18n.t(savedLocale, key, params) });
    for (const code of ['target_file_open_failed', 'target_editor_not_ready', 'stale_source_changed', 'unrecognized_external']) {
      for (const failurePath of ['main.tex', '/untrusted/path']) {
        const failure = build(run, { ok: false, skipped: [{ operation: { path: failurePath }, result: { ok: false, code, reason: secret } }] });
        const record = Db.buildSessionRecord({ id: 'canonical-session', projectId: 'qa-project', runs: [{ id: 'canonical-run', status: 'completed',
          events: [{ kind: 'activity', title: I18n.t(savedLocale, 'undoTrackedResult', { applied: 0, skipped: 1 }), status: 'failed', detail: { raw: secret }, failure }] }] });
        const restored = Session.normalizeRuns(JSON.parse(JSON.stringify(record.runs)))[0];
        const item = Activity.project(restored).blocks.find(value => value.kind === 'notice');
        assert.equal(restored.events[0].detail.redacted, true);
        assert.doesNotMatch(JSON.stringify(restored.events[0].failure), /SENSITIVE_TEST_PAYLOAD|untrusted/);
        for (const locale of ['en', 'zh']) {
          const ui = renderer(() => locale), view = row(); ui.render(view, item, { projection: { notices: [item] } }, restored);
          assert.notEqual(view.body.textContent, restored.events[0].title);
          assert.doesNotMatch(view.body.textContent, /SENSITIVE_TEST_PAYLOAD|untrusted/);
          if (locale === 'en') assert.doesNotMatch(view.body.textContent, /\p{Script=Han}/u);
          else { assert.match(view.body.textContent, /\p{Script=Han}/u); assert.doesNotMatch(view.body.textContent, /this file|another file|Unknown file/); }
          if (code === 'unrecognized_external') assert.match(view.body.textContent, locale === 'en' ? /Unknown reason/ : /未知原因/);
          if (failure.file) {
            const live = { ...restored, events: [{ ...restored.events[0], detail: {
              [I18n.t(savedLocale, 'detailSkipped')]: [{ [I18n.t(savedLocale, 'detailFile')]: failure.file,
                [I18n.t(savedLocale, 'detailReason')]: failure.file + ': ' + failure.userMessage }]
            } }] };
            const liveItem = Activity.project(live).blocks.find(value => value.kind === 'notice');
            const liveView = row(); ui.render(liveView, liveItem, { projection: { notices: [liveItem] } }, live);
            assert.equal(liveView.body.textContent, view.body.textContent, 'available canonical detail uses the same complete code projection');
          }
        }
      }
    }
  }
});

test('other model and native notices never project their arbitrary payloads as review results', () => {
  const ui = renderer(() => 'en');
  for (const overrides of [{ title: 'Other failed tool' }, { kind: 'technical' }, { kind: 'stream', streamRole: 'assistant' },
    { kind: 'report' }, { kind: 'guidance' }, { technicalDetail: { type: 'codex.tool.failed' } },
    { subagent: true }, { activity: { v: 1, kind: 'notice', noticeSource: 'configWarning', state: 'failed' } }]) {
    const event = { kind: 'activity', title: 'Undo result: rejected 0 tracked change(s), skipped 1', status: 'failed',
      detail: { Skipped: [{ File: 'main.tex', Reason: 'UNRELATED_PAYLOAD_MUST_NOT_RENDER', Record: 'opaque' }] }, ...overrides };
    assert.deepEqual(ui.deps.reviewResultLines({ kind: 'notice', meta: {}, event }), []);
  }
  const value = { kind: 'notice', meta: {}, event: { title: 'Undo result: rejected 0 tracked change(s), skipped 1',
    detail: { Skipped: [{ File: 'a.tex', Reason: 'SENSITIVE_TEST_PAYLOAD', Record: 'DO_NOT_RENDER' }] } } };
  assert.deepEqual(ui.deps.reviewResultLines(value), ['a.tex: [redacted]']);
});
