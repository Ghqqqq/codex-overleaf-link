const assert = require('node:assert/strict');
const test = require('node:test');
const GovernanceRules = require('../extension/src/shared/governanceRules');
const WritebackPlan = require('../extension/src/content/writebackPlan');
const FailureReasons = require('../extension/src/shared/failureReasons');
const I18n = require('../extension/src/shared/i18n');
const Transcript = require('../extension/src/shared/agentTranscript');
const Meta = require('../extension/src/content/runCompletionMeta');

function options(locale) {
  return { tx: (en, zh) => locale === 'zh' ? zh : en, getLocale: () => locale,
    tr: key => I18n.t(locale, key), trackedChangeInFlight: new Map(),
    isTrackedChangeLifecycleRun: () => false, projectRunSettlement: () => ({ canUndo: false }) };
}

const cases = [
  { reason: 'readonly', rules: { readonlyPatterns: ['main.tex'] }, code: 'governance_readonly', en: /read-only/, zh: /只读/ },
  { reason: 'writable_allowlist', rules: { writablePatterns: ['chapters/**'] }, code: 'governance_writable_allowlist', en: /writable paths/, zh: /可写路径/ }
];

for (const entry of cases) {
  for (const sourceLocale of ['en', 'zh']) {
    test(`governance ${entry.reason} from ${sourceLocale} keeps protection and renders both UI languages`, () => {
      const plan = WritebackPlan.create({
        tx: (en, zh) => sourceLocale === 'zh' ? zh : en,
        GovernanceRules,
        getGovernanceRulesForCurrentProject: () => entry.rules
      });
      const evaluated = plan.evaluateGovernedOperations([{ type: 'edit', path: 'main.tex' }]);
      assert.equal(evaluated.allowed.length, 0);
      assert.equal(evaluated.blocked[0].reason, entry.reason);
      const result = plan.buildGovernanceSkippedApplyResult(evaluated.blocked);
      const skipped = result.skipped[0];
      const original = JSON.stringify(result);
      const failure = FailureReasons.normalizeFailureReason(skipped.result, skipped.operation);
      assert.equal(failure.code, entry.code);
      assert.equal(failure.stage, 'preflight');
      assert.equal(failure.severity, 'blocked');
      assert.equal(failure.retryable, false);
      assert.equal(failure.file, 'main.tex');
      assert.equal(failure.technicalMessage, skipped.result.reason);
      assert.equal(failure.evidence.originalCode, 'governance_blocked');
      const saved = Transcript.buildHumanCompletionReport({ mode: 'auto', status: 'failed', locale: sourceLocale,
        conclusion: 'MODEL_OUTPUT_UNCHANGED', applyResults: [result], unchangedReason: skipped.result.reason });
      for (const locale of ['en', 'zh']) {
        const localized = FailureReasons.localizeFailureReason(failure, locale, key => I18n.t(locale, key));
        assert.match(localized.userMessage, entry[locale]);
        assert.match(localized.nextAction, locale === 'en' ? /Settings.*Protection.*privacy/ : /设置.*保护与隐私/);
        if (locale === 'en') assert.doesNotMatch(localized.userMessage + localized.nextAction, /\p{Script=Han}/u);
        const report = Transcript.buildHumanCompletionReport({
          mode: 'auto', status: 'failed', locale, conclusion: 'MODEL_OUTPUT_UNCHANGED', applyResults: [result]
        });
        assert.equal(report.structured.conclusion, 'MODEL_OUTPUT_UNCHANGED');
        assert.match(report.text, new RegExp(entry.code));
        assert.match(report.text, locale === 'en' ? /Stage: preflight/ : /阶段: preflight/);
        assert.doesNotMatch(report.text, /unknown_legacy_failure|Stage: unknown|阶段: unknown/);
        const body = Meta.projectCompletionBody(saved.structured.body, options(locale).tx);
        assert.match(body, locale === 'en' ? /Reason: Project|Reason: A path/ : /原因: 项目|原因: 此操作/);
        if (locale === 'en') assert.doesNotMatch(body, /\p{Script=Han}/u);
        const meta = Meta.projectCompletionMeta(saved.structured.meta, {}, options(locale));
        assert.equal(meta.find(row => row.key === 'unchangedReason').value, localized.userMessage);
      }
      assert.equal(JSON.stringify(result), original, 'display must not rewrite persisted results or protection evidence');
    });
  }
}

test('older governance envelopes without a reason key retain a known generic classification', () => {
  const result = { ok: false, code: 'governance_blocked', reason: 'Historic product explanation' };
  const failure = FailureReasons.normalizeFailureReason(result, { type: 'edit', path: 'main.tex' });
  assert.equal(failure.code, 'governance_blocked');
  assert.equal(failure.stage, 'preflight');
  assert.equal(failure.retryable, false);
  assert.equal(failure.technicalMessage, result.reason);
  for (const locale of ['en', 'zh']) {
    const localized = FailureReasons.localizeFailureReason(failure, locale, key => I18n.t(locale, key));
    assert.match(localized.userMessage, locale === 'en' ? /Project file rules/ : /项目文件规则/);
    assert.match(localized.nextAction, locale === 'en' ? /Settings/ : /设置/);
  }
});

for (const locale of ['en', 'zh']) {
  test(`saved unknown governance body is re-projected only for complete product blocks (${locale})`, () => {
    const old = 'Skipped:\n- main.tex: edit was not written\nReason: Project governance marked this path read-only, so Codex did not write it.\nStage: unknown\nCode: unknown_legacy_failure\nNext: Open Technical Details for the raw report.';
    const projected = Meta.projectCompletionBody(old, options(locale).tx);
    assert.match(projected, /governance_readonly/);
    assert.match(projected, locale === 'en' ? /Stage: preflight/ : /阶段: preflight/);
    assert.doesNotMatch(projected, /unknown_legacy_failure|Open Technical Details/);
    assert.equal(Meta.projectCompletionBody(projected, options(locale).tx), projected);
    for (const opaque of [
      old.replace('Project governance marked this path read-only, so Codex did not write it.', 'Model reason: do not translate'),
      old.replace('Open Technical Details for the raw report.', 'Custom next step'),
      old.replace('Stage: unknown', 'Stage: write'),
      old.replace('Code: unknown_legacy_failure', 'Code: stale_source_changed'),
      old + '\nAdditional model text'
    ]) {
      const value = Meta.projectCompletionBody(opaque, options(locale).tx);
      assert.equal(value.slice(value.indexOf('\n')), opaque.slice(opaque.indexOf('\n')));
    }
  });
}
