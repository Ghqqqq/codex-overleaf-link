'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Transcript = require('../extension/src/shared/agentTranscript');
const Session = require('../extension/src/shared/sessionState');
const Storage = require('../extension/src/shared/storageDb');
const { projectCompletionConclusion } = require('../extension/src/content/runCompletionMeta');

function saveReport(input, locale) {
  const report = Transcript.buildHumanCompletionReport({ ...input, locale });
  const state = Session.normalizePanelState({ activeSessionId: 's', sessions: [{ id: 's', projectId: 'p', runs: [{
    id: 'r', status: 'completed', events: [{ kind: 'report', title: report.title,
      status: report.status, detail: report.text, detailStructured: report.structured }]
  }] }] });
  const row = Storage.buildSessionRecord(Session.prepareStateForStorage(state).sessions[0], { preserveRunActionPayload: true });
  const restored = Session.normalizePanelState({ activeSessionId: 's', sessions: [JSON.parse(JSON.stringify(row))] });
  const run = restored.sessions[0].runs[0];
  return { run, event: run.events[0] };
}
const productText = (key, locale) => Transcript.projectProductConclusion({ origin: 'product', key }, locale);
const project = (saved, locale) => projectCompletionConclusion(saved.event, saved.run, locale);

test('saved product conclusions follow the selected language without rewriting stored history', () => {
  for (const from of ['en', 'zh']) {
    const saved = saveReport({ conclusion: productText('cancelled', from), conclusionKey: 'cancelled' }, from);
    const before = JSON.stringify(saved);
    const en = project(saved, 'en'), zh = project(saved, 'zh');
    assert.equal(en, productText('cancelled', 'en'));
    assert.equal(zh, productText('cancelled', 'zh'));
    assert.doesNotMatch(en, /\p{Script=Han}/u);
    assert.match(zh, /\p{Script=Han}/u);
    assert.notEqual(en, zh);
    assert.equal(JSON.stringify(saved), before);
  }
});

test('model and user text remains verbatim even when it resembles a product conclusion', () => {
  for (const locale of ['en', 'zh']) {
    const raw = productText('cancelled', locale);
    for (const input of [{ conclusion: raw }, { userReport: { conclusion: raw,
      conclusionSource: { origin: 'product', key: 'cancelled' } } }]) {
      const saved = saveReport(input, locale);
      assert.equal(project(saved, 'en'), raw);
      assert.equal(project(saved, 'zh'), raw);
    }
  }
});

test('a persisted composite report translates only its product suffix and preserves the model prefix', () => {
  const prefix = 'Model 原文🙂\nKeep this exact text.';
  const suffix = locale => productText('partial_sync_note', locale);
  const raw = prefix + '\n\n' + suffix('en');
  const saved = saveReport({ conclusion: raw, conclusionSource: {
    origin: 'product', key: 'writeback', outcome: 'partial_sync', prefixLength: prefix.length
  } }, 'en');
  assert.equal(project(saved, 'zh'), prefix + '\n\n' + suffix('zh'));
  assert.equal(project(saved, 'en'), raw);
  saved.event.detailStructured.conclusion = prefix + '\nA later user edit';
  assert.equal(project(saved, 'zh'), prefix + '\nA later user edit');
});
