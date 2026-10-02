'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Results = require('../extension/src/content/runResultActions').create();
const State = require('../extension/src/shared/sessionState');
const paths = ['main.tex', 'qa/a.tex', 'qa/b.tex', 'qa.png'];
const checkpoint = { type: 'delete', path: 'qa.png', undoCreatedFile: { v: 1, kind: 'binary', sha256: 'a'.repeat(64) } };
const rows = [{ key: 'writeResult', value: 'wrote 4 items, skipped 0 items' },
  { key: 'undo', label: 'Undo', value: '4 reversible writes' }];
const options = locale => ({ tx: (en, zh) => locale === 'zh' ? zh : en,
  trackedChangeInFlight: new Map(), isTrackedChangeLifecycleRun: run => Boolean(run.trackedChangeStatus),
  projectRunSettlement: () => ({ canUndo: true }) });

function receipt(locale, kind, applied, skipped) {
  const zh = locale === 'zh', tracked = kind === 'tracked';
  const title = zh ? `撤销结果：已${tracked ? '拒绝' : '撤销'} ${applied.length} ${tracked ? '条留痕' : kind === 'native' ? '个文件' : '项'}，跳过 ${skipped.length} ${tracked ? '条' : '项'}`
    : `Undo result: ${tracked ? 'rejected' : 'undone'} ${applied.length} ${tracked ? 'tracked change(s)' : kind === 'native' ? 'file(s)' : 'item(s)'}, skipped ${skipped.length}${kind === 'legacy' ? ' item(s)' : ''}`;
  const entries = files => files.map(file => ({ [zh ? '文件' : 'File']: file }));
  return { kind: 'technical', status: skipped.length ? 'failed' : 'completed', title,
    detail: { [zh ? tracked ? '已拒绝' : '已撤销' : tracked ? 'Rejected' : 'Undone']: entries(applied),
      [zh ? '跳过' : 'Skipped']: entries(skipped) } };
}

function partial(events, kind = 'legacy') {
  return { id: 'undo-summary', task: 'QA mixed write', status: 'completed', events,
    ...(kind === 'tracked' ? { trackedChangeStatus: 'needs_review', undoOperations: [checkpoint] } : { undoStatus: 'partial' }) };
}

function project(run, locale = 'en', overrides = {}) {
  const opts = { ...options(locale), ...overrides }, before = JSON.stringify({ run, rows });
  const meta = Results.projectCompletionMeta(rows, run, opts);
  const summary = Results.summarizeCompletionMeta(meta, run, opts);
  assert.equal(JSON.stringify({ run, rows }), before, 'summary projection must not mutate persistence or recovery');
  return { text: summary.facts.find(fact => fact.key === 'undo')?.text, detail: meta.find(row => row.key === 'undo')?.value };
}

for (const locale of ['en', 'zh']) for (const kind of ['legacy', 'native', 'tracked']) {
  test(`${locale} ${kind}: 0 undone / 4 skipped stays incomplete`, () => {
    const value = project(partial([receipt(locale, kind, [], paths)], kind), locale);
    assert.equal(value.text, locale === 'zh' ? '撤销未完成' : 'Undo incomplete');
    assert.match(value.detail, locale === 'zh' ? /撤销未完成/ : /Undo is incomplete/);
    assert.match(value.detail, locale === 'zh'
      ? kind === 'tracked' ? /可重试剩余文件/ : /剩余修改仍可撤销/
      : kind === 'tracked' ? /retry the remaining files/ : /remaining changes can still be undone/);
    assert.doesNotMatch(value.detail, /Some changes were undone|已撤销部分修改/);
  });
  test(`${locale} ${kind}: confirmed current progress remains partly undone`, () => {
    const value = project(partial([receipt(locale, kind, paths.slice(0, 1), paths.slice(1))], kind), locale);
    assert.equal(value.text, locale === 'zh' ? '已撤销部分修改' : 'Partly undone');
    assert.match(value.detail, locale === 'zh' ? /已撤销部分修改/ : /Some changes were undone/);
    assert.match(value.detail, locale === 'zh'
      ? kind === 'tracked' ? /可重试剩余文件/ : /剩余修改仍可撤销/
      : kind === 'tracked' ? /retry the remaining files/ : /remaining changes can still be undone/);
  });
  test(`${locale} ${kind}: a zero-progress retry retains confirmed cumulative progress after hydration`, () => {
    const run = partial([receipt(locale, kind, paths.slice(0, 1), paths.slice(1)),
      receipt(locale, kind, [], paths.slice(1))], kind);
    const restored = State.normalizePanelState({ sessions: [{ id: 's', runs: [JSON.parse(JSON.stringify(run))] }], activeSessionId: 's' }).sessions[0].runs[0];
    assert.equal(project(restored, locale).text, locale === 'zh' ? '已撤销部分修改' : 'Partly undone');
  });
}

test('a locale switch retains the meaning of earlier receipts', () => {
  assert.equal(project(partial([receipt('en', 'legacy', ['main.tex'], ['qa.png'])]), 'zh').text, '已撤销部分修改');
  assert.equal(project(partial([receipt('zh', 'tracked', ['main.tex'], ['qa.png'])]), 'en').text, 'Partly undone');
});

for (const evidence of [{}, { events: null }, { events: {} },
  { settlement: { documentEffect: 'changed', evidence: { applied: 'complete', settled: 'needs-review' },
    fileSettlements: [{ path: 'main.tex', applied: 'complete', readBack: 'exact' }] } }]) {
  test('legacy partial status and forward writeback facts do not prove Undo progress: ' + JSON.stringify(evidence), () => {
    const value = project({ ...partial([]), ...evidence });
    assert.equal(value.text, 'Undo incomplete');
    assert.match(value.detail, /remaining changes/);
  });
}

for (const override of [{ status: 'running' }, { streamRole: 'assistant' }, { kind: 'report' },
  { kind: 'guidance' }, { kind: 'stream' }, { detail: {} }, { detail: 'compacted' },
  { title: 'wrote 1 item, skipped 3' }, { title: 'Quoted: Undo result: undone 1 item(s), skipped 3 item(s)' }]) {
  test('unrelated or incomplete event evidence cannot claim progress: ' + JSON.stringify(override), () => {
    const run = partial([{ ...receipt('en', 'legacy', ['main.tex'], paths.slice(1)), ...override }]);
    assert.equal(project(run).text, 'Undo incomplete');
  });
}

test('an applied entry also skipped on the same path cannot claim verified Undo progress', () => {
  const run = partial([receipt('en', 'legacy', ['main.tex'], paths)]);
  assert.equal(project(run).text, 'Undo incomplete');
});

for (const field of ['settlement', 'settlementFacts']) {
  test(field + ': an unverified Undo receipt cannot claim progress', () => {
    const run = partial([receipt('en', 'legacy', ['main.tex'], paths.slice(1))]);
    run[field] = { failures: [{ code: 'undo_not_verified', file: 'main.tex', changedDocument: true }] };
    assert.equal(project(run).text, 'Undo incomplete');
    run[field].failures[0].file = '';
    assert.equal(project(run).text, 'Undo incomplete');
  });
}

test('verification failure on one file preserves known progress on another file', () => {
  const run = partial([receipt('en', 'legacy', ['main.tex', 'qa/a.tex'], ['qa.png'])]);
  run.settlement = { failures: [{ code: 'undo_not_verified', file: 'qa/a.tex' }] };
  assert.equal(project(run).text, 'Partly undone');
});

for (const locale of ['en', 'zh']) {
  test(locale + ': running legacy Undo overrides stale partial history', () => {
    const run = { ...partial([receipt('en', 'legacy', ['main.tex'], ['qa.png'])]), undoStatus: 'running' };
    assert.equal(project(run, locale).text, locale === 'zh' ? '正在撤销…' : 'Undoing…');
  });
  test(locale + ': tracked rejection in flight overrides the previous incomplete result', () => {
    const run = partial([receipt('en', 'tracked', [], paths)], 'tracked');
    assert.equal(project(run, locale, { trackedChangeInFlight: new Map([[run.id, 'reject']]) }).text,
      locale === 'zh' ? '正在撤销…' : 'Undoing…');
  });
  for (const [terminal, expected] of [[{ undoStatus: 'applied' }, ['Changes undone', '已撤销本轮修改']],
    [{ trackedChangeStatus: 'rejected' }, ['Changes undone', '已撤销本轮修改']],
    [{ trackedChangeStatus: 'accepted' }, ['Changes accepted', '修改已接受']]]) {
    test(locale + ': terminal state outranks old zero-progress and partial results: ' + JSON.stringify(terminal), () => {
      const run = { ...partial([receipt('en', 'legacy', ['main.tex'], paths.slice(1)),
        receipt('en', 'legacy', [], paths.slice(1))]), ...terminal };
      assert.equal(project(run, locale).text, expected[locale === 'zh' ? 1 : 0]);
    });
  }
}

test('summary does not promise retry when canonical settlement has no recoverable payload', () => {
  const opts = { projectRunSettlement: () => ({ canUndo: false }) };
  assert.equal(project(partial([receipt('en', 'legacy', [], paths)]), 'en', opts).detail, 'Undo is incomplete.');
  assert.equal(project(partial([receipt('en', 'legacy', ['main.tex'], paths.slice(1))]), 'en', opts).detail, 'Some changes were undone.');
});

test('an untouched reversible run retains its normal availability summary', () => {
  const run = { id: 'before-undo', undoStatus: 'ready', events: [] };
  assert.equal(project(run).text, '4 undoable');
});
