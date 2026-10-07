'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const Transcript = require('../extension/src/shared/agentTranscript');
const Meta = require('../extension/src/content/runCompletionMeta');
const Queue = require('../extension/src/shared/runInputQueue');
const Scheduler = require('../extension/src/content/runQueueScheduler');
const Session = require('../extension/src/shared/sessionState');
const I18n = require('../extension/src/shared/i18n');
const ResultActions = require('../extension/src/content/runResultActions').create();
const { extractFunction } = require('./_helpers/extractFunction');

function metaOptions(locale) {
  return { tx: (en, zh) => locale === 'zh' ? zh : en, getLocale: () => locale,
    tr: key => I18n.t(locale, key), trackedChangeInFlight: new Map(),
    isTrackedChangeLifecycleRun: () => false, projectRunSettlement: () => ({ canUndo: false }) };
}

for (const from of ['en', 'zh']) {
  test(`structured report product headings follow ${from} round trip while item text stays original`, () => {
    const input = { conclusion: 'Checked:\n- 模型原结论\n\n发现：\n- must stay unchanged',
      checked: ['Checked:\n- 模型同名标题'], findings: ['发现：模型自己的句子'],
      plannedChanges: ['Planned changes:\n一句模型内容'], appliedChanges: ['Changes: unchanged source text'],
      skippedChanges: ['main.tex: model reason\n  detail line\n\nChanges:\n- fake title in opaque skipped content'] };
    const saved = Transcript.buildStructuredHumanReport(input, from);
    const sourceSnapshot = JSON.stringify(saved), to = from === 'en' ? 'zh' : 'en';
    const projected = ResultActions.projectCompletionBody(saved.body, metaOptions(to).tx);
    const expected = Transcript.buildStructuredHumanReport(input, to);
    assert.equal(projected, expected.body);
    assert.equal(ResultActions.projectCompletionBody(projected, metaOptions(from).tx), saved.body);
    assert.equal(JSON.stringify(saved), sourceSnapshot);
    assert.equal(saved.conclusion, input.conclusion);
  });
}

test('non-producer report bodies are opaque and never partially translated', () => {
  for (const body of [
    'Model paragraph\n\nChecked:\n- item',
    'Checked:\n- item\n\nmodel paragraph',
    'Checked:\n- item\n\nChecked:\n- duplicate',
    'Findings:\n- item\n\nChecked:\n- reversed',
    'Checked:\n- item\n  unknown continuation',
    'Checked:\n- item\n\n发现：\n- mixed heading language',
    'Unknown:\n- item'
  ]) assert.equal(ResultActions.projectCompletionBody(body, metaOptions('zh').tx), body);
});

for (const from of ['en', 'zh']) {
  test(`saved Ask metadata follows ${from} → opposite → ${from} without rewriting the answer`, () => {
    const original = Transcript.buildHumanCompletionReport({ locale: from, mode: 'ask', status: 'completed',
      conclusion: '用户和 model answer 保留原文', includeWriteResult: true, undoCount: 0 });
    const state = Session.normalizePanelState({ sessions: [{ id: 's', runs: [{ id: 'r', mode: 'ask',
      status: 'completed', events: [{ kind: 'report', title: original.title, detail: original.text,
        detailStructured: original.structured }] }] }], activeSessionId: 's' });
    const run = state.sessions[0].runs[0], meta = run.events[0].detailStructured.meta;
    const saved = JSON.stringify(run);
    for (const locale of [from === 'en' ? 'zh' : 'en', from]) {
      const rows = Meta.projectCompletionMeta(meta, run, metaOptions(locale));
      assert.equal(rows.find(row => row.key === 'writeResult').label, locale === 'en' ? 'Write result' : '写入结果');
      assert.equal(rows.find(row => row.key === 'writeResult').value, locale === 'en' ? 'wrote 0 items, skipped 0 items' : '已写入 0 项，跳过 0 项');
      assert.equal(rows.find(row => row.key === 'unchangedReason').value, locale === 'en' ? 'This run was Ask mode.' : '这轮是只问不改。');
      assert.equal(rows.find(row => row.key === 'undo').value, locale === 'en' ? 'this run has no reversible writes' : '本轮没有可撤销的写入');
      assert.equal(rows.find(row => row.key === 'nextStep').value, locale === 'en'
        ? 'You can continue asking, or add more @context and run another check.' : '可以继续追问，或加入更多 @context 后再检查。');
    }
    assert.equal(JSON.stringify(run), saved);
    assert.equal(run.events[0].detailStructured.conclusion, '用户和 model answer 保留原文');
  });
}

test('old flat metadata uses the same translation and leaves custom reasons intact', () => {
  const original = '结论：用户原文\n\n写入结果：已写入 1 项，跳过 2 项\n\n可撤销：可撤销本轮 1 项写入\n\n下一步：下一步模型自己的回答';
  const split = Meta.splitFlatCompletionReport(original, en => en);
  const result = Meta.projectCompletionMeta(split.meta, { id: 'r' }, metaOptions('en'));
  assert.equal(result[0].value, 'wrote 1 item, skipped 2 items');
  assert.equal(result[1].value, 'this run has 1 reversible write');
  assert.equal(result[2].value, '下一步模型自己的回答');
  assert.equal(split.body, '结论：用户原文');
});

for (const written of [0, 1]) {
  for (const from of ['en', 'zh']) {
    test(`saved writeback next step (${written} written, ${from}) follows both languages without changing original text`, () => {
      const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
      const nextStepAt = locale => Function('tx', 'getAppliedEntries',
        `${extractFunction(source, 'formatWritebackSkippedNextStep')}; return formatWritebackSkippedNextStep;`
      )(metaOptions(locale).tx, result => result.applied)({ applied: Array(written).fill({}) });
      const original = Transcript.buildHumanCompletionReport({ locale: from, mode: 'auto', status: 'failed',
        conclusion: nextStepAt(from), nextStep: nextStepAt(from) });
      const snapshot = JSON.stringify(original);
      const metaForms = [original.structured.meta, Meta.splitFlatCompletionReport(original.text).meta];
      for (const meta of metaForms) {
        const savedMeta = JSON.stringify(meta);
        for (const locale of [from === 'en' ? 'zh' : 'en', from]) {
          const rows = Meta.projectCompletionMeta(meta, { id: 'r' }, metaOptions(locale));
          const next = rows.find(row => row.key === 'nextStep');
          assert.equal(next.label, locale === 'en' ? 'Next' : '下一步');
          assert.equal(next.value, nextStepAt(locale));
        }
        assert.equal(JSON.stringify(meta), savedMeta);
      }
      assert.equal(original.structured.conclusion, nextStepAt(from));
      assert.equal(JSON.stringify(original), snapshot);
      const custom = [{ key: 'nextStep', label: 'Next', value: `${nextStepAt(from)} Model note: 原文` }];
      assert.equal(Meta.projectCompletionMeta(custom, { id: 'r' }, metaOptions(from === 'en' ? 'zh' : 'en'))[0].value,
        custom[0].value, 'only complete product templates may be translated');
    });
  }
}

for (const input of [
  { errorMessage: 'Codex CLI was not found locally' },
  { errorMessage: 'provider_auth_rejected' },
  { errorMessage: 'checkpoint unavailable' },
  { applyResults: [{ skipped: [{ operation: { path: 'main.tex' }, result: { ok: false, code: 'stale_source_changed' } }] }] },
  ...['target_file_open_failed', 'target_file_not_active', 'undo_not_verified'].map(code => ({
    applyResults: [{ skipped: [{ operation: { path: 'sections/研究.tex' }, result: { ok: false, code } }] }]
  })),
  { unchangedReason: ['No file changes need to sync back to Overleaf.', '没有产生需要同步回 Overleaf 的文件改动。'] },
  { unchangedReason: ['No approved file changes remain to sync back to Overleaf.', '没有剩余已确认的文件改动需要同步回 Overleaf。'] }
]) {
  test(`historical product error/no-write metadata reprojects both languages: ${JSON.stringify(input)}`, () => {
    const reportAt = locale => Transcript.buildHumanCompletionReport({ ...input, locale, mode: 'auto', status: 'failed',
      unchangedReason: Array.isArray(input.unchangedReason) ? input.unchangedReason[locale === 'en' ? 0 : 1] : undefined,
      includeWriteResult: true, undoCount: 0 });
    for (const from of ['en', 'zh']) {
      const to = from === 'en' ? 'zh' : 'en', report = reportAt(from);
      const snapshot = JSON.stringify(report);
      const actual = Meta.projectCompletionMeta(report.structured.meta, { id: 'r' }, metaOptions(to));
      const expected = reportAt(to).structured.meta;
      for (const key of ['nextStep', 'unchangedReason']) {
        assert.equal(actual.find(row => row.key === key)?.value, expected.find(row => row.key === key)?.value);
      }
      assert.equal(JSON.stringify(report), snapshot);
    }
  });
}

const guidanceErrors = [
  ['codex_turn_not_ready', 'The active Codex turn is not ready for guidance.', '当前 Codex 轮次尚未准备好接收指导。'],
  ['codex_turn_mismatch', 'The active Codex turn changed before the guidance was delivered.', '指导送达前，当前 Codex 轮次已发生变化。'],
  ['codex_steer_empty', 'Guidance input is empty.', '指导内容为空。'],
  ['codex_steer_too_large', 'Guidance input exceeds the 12000 character limit.', '指导内容超过 12000 字符上限。']
];
for (const [code, message, zh] of guidanceErrors) {
  test(`guidance ${code} is localized while its queue entry stays retryable`, async () => {
    const queued = Queue.enqueue([], { text: 'user guidance 不翻译' }, { randomUUID: () => 'q1' });
    assert.equal(queued.ok, true);
    const session = { id: 's', pendingInputs: queued.queue };
    const run = { sessionId: 's', recordId: 'r', nativeRequestId: 'native', activeTurn: { threadId: 'thread', turnId: 'turn' } };
    const messages = [];
    let locale = 'zh';
    const coordinator = Scheduler.createCoordinator({ getActiveSession: () => session, getSession: () => session,
      getCurrentRun: () => run, setQueue: (_, value) => { session.pendingInputs = value; }, save: async () => {},
      sendSteer: async () => ({ ok: false, error: { code, message } }),
      toast: value => messages.push(value), tr: key => I18n.t(locale, key) });
    await coordinator.guide('q1');
    assert.equal(messages.at(-1), zh);
    assert.equal(session.pendingInputs[0].status, 'queued');
    assert.equal(session.pendingInputs[0].text, 'user guidance 不翻译');
    locale = 'en';
    await coordinator.guide('q1');
    assert.equal(messages.at(-1), message);
  });
}

for (const locale of ['en', 'zh']) {
  test(`attachment read failures use ${locale} UI copy while retaining the browser cause`, async () => {
    const readers = [];
    class FileReader { readAsDataURL() { readers.push(this); } }
    const context = vm.createContext({ window: {}, FileReader });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/composerAttachments.js'), 'utf8'), context);
    const controller = context.window.CodexOverleafComposerAttachments.createComposerAttachmentController({
      tx: (en, zh) => locale === 'zh' ? zh : en });
    const adding = controller.addFiles([{ name: '附件.txt', size: 4, type: 'text/plain', lastModified: 1 }]);
    const cause = new Error('The requested file could not be read');
    readers[0].error = cause;
    readers[0].onerror();
    await assert.rejects(adding, error => {
      assert.equal(error.message, locale === 'en' ? 'Could not read selected file.' : '无法读取所选文件。');
      assert.equal(error.cause, cause);
      return true;
    });
    assert.equal(controller.getAttachmentsForRun().length, 0);
  });
}
