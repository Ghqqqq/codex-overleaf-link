(function initCodexOverleafSettlementFacts(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./failureReasons'));
  } else {
    root.CodexOverleafModuleRegistry.define('SettlementFacts', ['FailureReasons'], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function settlementFactsFactory(DefaultFailureReasons) {
  'use strict';

  const SETTLEMENT_FACTS_MAX_BYTES = 32 * 1024;
  const SESSION_SETTLEMENT_DETAIL_MAX_BYTES = 512 * 1024;
  const RECOVERY_FIELDS = Object.freeze([
    'appliedOperations', 'undoOperations', 'undoBaseFiles', 'undoTrackedChanges',
    'undoExpectedFiles', 'undoStatus', 'interruptedDraft'
  ]);

  function compactSettlementFacts(value = {}, maxBytes = SETTLEMENT_FACTS_MAX_BYTES) {
    const legacyFailures = value.primaryFailure && typeof value.primaryFailure === 'object'
      ? [value.primaryFailure]
      : [];
    const facts = {
      schemaVersion: 1,
      documentEffect: normalizeDocumentEffect(
        value.documentEffect || (value.changedDocument === true ? 'changed' : '')
      ),
      evidence: normalizeEvidence(value),
      fileSettlements: normalizeFiles(value.fileSettlements),
      failures: normalizeFailures(Array.isArray(value.failures) ? value.failures : legacyFailures),
      recoveryAvailability: normalizeAvailability(value.recoveryAvailability),
      recoveryDisposition: normalizeDisposition(value.recoveryDisposition),
      capturedAt: typeof value.capturedAt === 'string' ? value.capturedAt : ''
    };
    if (value.compaction && typeof value.compaction === 'object') {
      facts.compaction = normalizeCompaction(value.compaction);
    }
    if (estimateBytes(facts) <= maxBytes) return facts;

    const files = facts.fileSettlements;
    files.sort((left, right) => importance(left) - importance(right)
      || left.path.localeCompare(right.path));
    const omitted = {
      failureOrRecovery: Number(facts.compaction?.omittedFileSettlements?.failureOrRecovery || 0),
      changed: Number(facts.compaction?.omittedFileSettlements?.changed || 0),
      unchangedOrUnknown: Number(facts.compaction?.omittedFileSettlements?.unchangedOrUnknown || 0)
    };
    facts.compaction = {
      ...(facts.compaction || {}),
      omittedFileSettlements: omitted,
      omittedFailures: Number(facts.compaction?.omittedFailures || 0)
    };
    while (files.length && estimateBytes(facts) > maxBytes) {
      omitted[category(files.shift())]++;
    }
    facts.fileSettlements = files.sort((left, right) => left.path.localeCompare(right.path));
    if (estimateBytes(facts) > maxBytes) {
      const primaryFailure = selectPrimaryFailure(facts.failures);
      facts.failures = facts.failures.map(compactFailure);
      if (primaryFailure) {
        const primaryIndex = facts.failures.findIndex(item =>
          item.code === primaryFailure.code
          && item.stage === primaryFailure.stage
          && item.severity === primaryFailure.severity
          && item.file === primaryFailure.file
        );
        if (primaryIndex > 0) {
          facts.failures.unshift(facts.failures.splice(primaryIndex, 1)[0]);
        }
      }
      while (facts.failures.length > 1 && estimateBytes(facts) > maxBytes) {
        facts.failures.pop();
        facts.compaction.omittedFailures++;
      }
    }
    return facts;
  }

  function compactSessionSettlementFacts(runs = [], options = {}) {
    const sanitize = options.sanitize instanceof Function ? options.sanitize : cloneValue;
    const measure = options.estimateBytes instanceof Function ? options.estimateBytes : estimateBytes;
    const maxDetailBytes = Number.isFinite(options.maxDetailBytes)
      ? Math.max(0, options.maxDetailBytes)
      : SESSION_SETTLEMENT_DETAIL_MAX_BYTES;
    const entries = (Array.isArray(runs) ? runs : [])
      .filter(run => run?.id && (
        (run.settlement && typeof run.settlement === 'object')
        || (run.settlementFacts && typeof run.settlementFacts === 'object')
      ))
      .map((run, index) => ({
        id: run.id,
        protected: run.status === 'running'
          || run.trackedChangeStatus === 'pending'
          || run.trackedChangeStatus === 'needs_review'
          || index === runs.length - 1,
        facts: sanitize(run.settlement && typeof run.settlement === 'object'
          ? run.settlement
          : run.settlementFacts)
      }));
    const detailBytes = () => entries.reduce((total, entry) =>
      total + measure(entry.facts.fileSettlements || []), 0);
    const candidates = [
      ...entries.filter(entry => !entry.protected),
      ...entries.filter(entry => entry.protected)
    ];
    for (const entry of candidates) {
      if (detailBytes() <= maxDetailBytes) break;
      compactSettlementFileDetails(entry.facts, () => detailBytes() <= maxDetailBytes);
    }
    return new Map(entries.map(entry => [entry.id, entry.facts]));
  }

  function compactSettlementFileDetails(facts, budgetSatisfied) {
    const files = Array.isArray(facts?.fileSettlements) ? [...facts.fileSettlements] : [];
    files.sort((left, right) => importance(left) - importance(right)
      || String(left?.path || '').localeCompare(String(right?.path || '')));
    const omitted = {
      failureOrRecovery: positive(facts?.compaction?.omittedFileSettlements?.failureOrRecovery),
      changed: positive(facts?.compaction?.omittedFileSettlements?.changed),
      unchangedOrUnknown: positive(facts?.compaction?.omittedFileSettlements?.unchangedOrUnknown)
    };
    while (files.length && !budgetSatisfied()) {
      omitted[category(files.shift())]++;
      facts.fileSettlements = [...files].sort((left, right) =>
        String(left?.path || '').localeCompare(String(right?.path || '')));
      facts.compaction = { ...(facts.compaction || {}), omittedFileSettlements: omitted };
    }
  }

  function projectRunSettlement(run = {}) {
    const storedFacts = run.settlement && typeof run.settlement === 'object'
      ? run.settlement
      : run.settlementFacts;
    const facts = storedFacts && typeof storedFacts === 'object'
      ? compactSettlementFacts(storedFacts)
      : null;
    const primaryFailure = selectPrimaryFailure(facts?.failures || []);
    const status = text(run.trackedChangeStatus);
    const actionable = status === 'pending' || status === 'needs_review';
    const terminal = status === 'accepted' || status === 'rejected';
    const payload = run.recoveryPayload && typeof run.recoveryPayload === 'object'
      ? run.recoveryPayload
      : run;
    const tracked = hasItems(payload.undoTrackedChanges);
    const anyRecovery = tracked
      || hasItems(payload.undoOperations)
      || hasItems(payload.undoBaseFiles)
      || hasItems(payload.undoExpectedFiles)
      || hasItems(payload.appliedOperations);
    const canAccept = actionable && tracked;
    const canUndo = !terminal
      && run.undoStatus !== 'applied'
      && (actionable ? anyRecovery : (!status && anyRecovery));
    const failureTerminalState = normalizeTerminalState(primaryFailure?.terminalState);
    return {
      changedDocument: projectDocumentEffect(facts?.documentEffect, run.changedDocument),
      primaryFailure,
      failureTerminalState,
      canAccept,
      canUndo,
      canRetry: Boolean(primaryFailure?.retryable),
      terminalState: failureTerminalState || '',
      actions: { accept: canAccept, undo: canUndo }
    };
  }

  function deriveLegacyProjection(run = {}) {
    return projectRunSettlement({ ...run, settlement: null, settlementFacts: null });
  }

  function normalizeEvidence(value = {}) {
    const evidence = value.evidence && typeof value.evidence === 'object' ? value.evidence : {};
    const legacySave = value.save && typeof value.save === 'object' ? value.save : {};
    const savedCandidate = evidence.saved
      || (legacySave.confidence === 'verified' ? 'verified'
        : legacySave.confidence === 'quiet-observed' ? 'quiet-observed' : '');
    return {
      applied: allowed(evidence.applied, ['none', 'partial', 'complete', 'unknown'], 'unknown'),
      readBack: allowed(evidence.readBack, ['not-attempted', 'exact', 'partial', 'mismatch', 'unavailable'], 'not-attempted'),
      saved: allowed(savedCandidate, ['not-attempted', 'not-required', 'quiet-observed', 'verified', 'failed', 'unavailable'], 'not-attempted'),
      mirrored: normalizeMirror(evidence.mirrored || value.mirror?.state),
      compiled: normalizeCompile(evidence.compiled || value.compile?.state),
      settled: allowed(evidence.settled, ['unsettled', 'partial', 'complete', 'needs-review'], 'unsettled')
    };
  }

  function normalizeFiles(value) {
    return (Array.isArray(value) ? value : []).map(file => ({
      path: safePath(file?.path),
      operationIds: strings(file?.operationIds, 100),
      relatedPaths: strings(file?.relatedPaths, 20).map(safePath).filter(Boolean),
      applied: allowed(file?.applied, ['none', 'partial', 'complete', 'failed', 'unknown'],
        file?.applied === true ? 'complete' : 'unknown'),
      documentEffect: normalizeDocumentEffect(file?.documentEffect),
      readBack: normalizeReadback(file?.readBack),
      recoveryKind: allowed(file?.recoveryKind,
        ['tracked-changes', 'editor-history', 'legacy-baseline', 'mixed', 'none'], 'none'),
      failureCodes: strings(file?.failureCodes, 40)
    })).filter(file => file.path);
  }

  function normalizeFailures(value) {
    return (Array.isArray(value) ? value : []).filter(item => item && typeof item === 'object')
      .map(item => ({
        code: text(item.code).slice(0, 120),
        stage: text(item.stage).slice(0, 40),
        severity: text(item.severity).slice(0, 40),
        userMessage: text(item.userMessage).slice(0, 1000),
        retryable: item.retryable === true,
        nextAction: text(item.nextAction).slice(0, 1000),
        file: safePath(item.file),
        operationType: text(item.operationType).slice(0, 80),
        changedDocument: item.changedDocument === true,
        terminalState: normalizeTerminalState(item.terminalState)
      }));
  }

  function normalizeDocumentEffect(value) {
    return allowed(value === 'possible' ? 'possibly-changed' : text(value),
      ['unchanged', 'changed', 'possibly-changed', 'unknown'], 'unknown');
  }

  function normalizeReadback(value) {
    if (value === 'match') return 'exact';
    if (value === 'missing' || value === 'unknown') return 'unavailable';
    return allowed(value, ['not-attempted', 'exact', 'mismatch', 'unavailable'], 'not-attempted');
  }

  function normalizeMirror(value) {
    if (value === 'not_started' || !value) return 'not-attempted';
    if (value === 'pending') return 'not-attempted';
    return allowed(value, ['not-attempted', 'complete', 'partial', 'failed', 'unknown'], 'unknown');
  }

  function normalizeCompile(value) {
    if (value === 'success' || value === 'completed') return 'succeeded';
    if (value === 'not_started' || !value) return 'not-attempted';
    return allowed(value, ['not-attempted', 'succeeded', 'failed', 'unknown'], 'unknown');
  }

  function normalizeAvailability(value = {}) {
    return {
      trackedChanges: value?.trackedChanges === true,
      editorHistory: value?.editorHistory === true,
      legacyBaseline: value?.legacyBaseline === true
    };
  }

  function normalizeDisposition(value = {}) {
    return Object.fromEntries(RECOVERY_FIELDS.map(field => [
      field, value?.[field] === 'clear' ? 'clear' : 'preserve'
    ]));
  }

  function normalizeCompaction(value = {}) {
    const omitted = value.omittedFileSettlements || {};
    return {
      omittedFileSettlements: {
        failureOrRecovery: positive(omitted.failureOrRecovery),
        changed: positive(omitted.changed),
        unchangedOrUnknown: positive(omitted.unchangedOrUnknown)
      },
      omittedFailures: positive(value.omittedFailures)
    };
  }

  function projectDocumentEffect(effect, legacy) {
    if (effect === 'changed') return true;
    if (effect === 'unchanged') return false;
    if (effect === 'possibly-changed' || effect === 'unknown') return null;
    return legacy === true ? true : legacy === false ? false : null;
  }

  function category(file = {}) {
    if (file.failureCodes?.length || (file.recoveryKind && file.recoveryKind !== 'none')) return 'failureOrRecovery';
    return file.documentEffect === 'changed' || file.documentEffect === 'possibly-changed'
      ? 'changed'
      : 'unchangedOrUnknown';
  }

  function importance(file) {
    const value = category(file);
    return value === 'unchangedOrUnknown' ? 1 : value === 'changed' ? 2 : 3;
  }

  function compactFailure(item = {}) {
    const { userMessage, nextAction, ...compact } = item;
    return compact;
  }

  function selectPrimaryFailure(failures) {
    return DefaultFailureReasons?.selectPrimaryFailure instanceof Function
      ? DefaultFailureReasons.selectPrimaryFailure(failures)
      : failures[0] || null;
  }

  function normalizeTerminalState(value) {
    return allowed(text(value), ['failed', 'blocked', 'degraded', 'needs_review'], null);
  }

  function safePath(value) {
    const path = text(value).replace(/\\/g, '/');
    if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').includes('..')) return '';
    return path.slice(0, 300);
  }

  function strings(value, limit) {
    return (Array.isArray(value) ? value : []).map(text).filter(Boolean).slice(0, limit);
  }

  function hasItems(value) {
    return Array.isArray(value)
      ? value.length > 0
      : Boolean(value && typeof value === 'object' && Object.keys(value).length);
  }

  function estimateBytes(value) {
    const serialized = JSON.stringify(value);
    return typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(serialized).length
      : serialized.length * 2;
  }

  function cloneValue(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_error) {
      return {};
    }
  }

  function allowed(value, values, fallback) {
    return values.includes(value) ? value : fallback;
  }

  function positive(value) {
    return Math.max(0, Number(value) || 0);
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  return {
    RECOVERY_FIELDS,
    SESSION_SETTLEMENT_DETAIL_MAX_BYTES,
    SETTLEMENT_FACTS_MAX_BYTES,
    compactSessionSettlementFacts,
    compactSettlementFacts,
    deriveLegacyProjection,
    projectRunSettlement
  };
});
