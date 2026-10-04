(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./writebackController'), require('../shared/writebackIntent'), require('../shared/sessionState'));
  else root.CodexOverleafModuleRegistry.define('WritebackVerificationController', ['WritebackController', 'WritebackIntent', 'SessionState'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Controller, Intent, SessionState) {
  'use strict';
  function create(deps) {
    const checking = new Set();
    const scope = () => ({ projectId: deps.getProjectId(), accountScopeId: deps.getAccountScopeId(), generation: deps.getRouteGeneration?.() });
    const fail = message => { throw Object.assign(new Error(message), { code: 'writeback_verification_owner_changed' }); };
    function ownerFor(target) {
      const captured = scope();
      if (!captured.projectId || !captured.accountScopeId || target.runProjectId !== captured.projectId
        || (target.runAccountScopeId && target.runAccountScopeId !== captured.accountScopeId)) fail('Writeback ownership changed.');
      return { ...captured, sessionId: target.sessionId, runId: target.recordId };
    }
    function current(owner, checkId) {
      const now = scope(), record = deps.findRunRecord(owner.runId, owner.sessionId);
      if (now.projectId !== owner.projectId || now.accountScopeId !== owner.accountScopeId || now.generation !== owner.generation
        || !record || record.runProjectId !== owner.projectId || record.forkSnapshot
        || (checkId && record.writebackCheck?.id !== checkId)) fail('The project, account or writeback record changed.');
      return record;
    }
    const persistOptions = runId => ({ requireDurable: true, preserveRunActionPayload: true, reviewRunIds: [runId] });
    async function verifyStored(owner, expected) {
      current(owner, expected.id);
      const stored = await deps.readSession(owner.sessionId);
      current(owner, expected.id);
      const check = Intent.normalizeWritebackCheck(stored?.runs?.find(run => run.id === owner.runId)?.writebackCheck);
      if (stored?.accountScopeId !== owner.accountScopeId || stored?.projectId !== owner.projectId || stored.id !== owner.sessionId
        || !check || JSON.stringify(check) !== JSON.stringify(expected)) {
        throw Object.assign(new Error('The writeback content-check record was not durably saved. No new write was dispatched.'), { code: 'writeback_check_not_persisted' });
      }
    }
    async function stage({ operations, target, requireReviewing, project }) {
      const owner = ownerFor(target), view = deps.getCurrentRun();
      const assertStage = () => {
        if (!view || deps.getCurrentRun() !== view || view.recordId !== owner.runId || view.sessionId !== owner.sessionId
          || (view.runAccountScopeId && view.runAccountScopeId !== owner.accountScopeId)) fail('The active writeback run changed.');
        return current(owner);
      };
      assertStage();
      const plan = await Controller.buildPlannedWritebackCheck(operations, project, {
        id: deps.randomUUID(), projectId: owner.projectId, accountScopeId: owner.accountScopeId,
        sessionId: owner.sessionId, runId: owner.runId, createdAt: new Date().toISOString()
      });
      const record = assertStage();
      const previous = Intent.normalizeWritebackCheck(record.writebackCheck);
      const files = new Map((previous && previous.projectId === owner.projectId && previous.accountScopeId === owner.accountScopeId
        && previous.sessionId === owner.sessionId && previous.runId === owner.runId ? previous.files : []).map(file => [file.path, file]));
      for (const file of plan.files) files.set(file.path, file);
      const check = Intent.normalizeWritebackCheck({ ...plan, files: [...files.values()] });
      if (!check) throw Object.assign(new Error('The writeback content-check record exceeds its safe storage limits.'), { code: 'writeback_plan_unavailable' });
      record.writebackCheck = check;
      record.retryRequireReviewing = requireReviewing === true;
      const creates = operations.filter(op => op.type === 'create' && typeof op.content === 'string');
      if (creates.length) {
        const candidate = Intent.normalize({ ...owner, id: deps.randomUUID(), createdAt: check.createdAt,
          operations: creates, baseFiles: [], requireReviewing });
        const retry = SessionState.pickWritebackRecovery({ ...record, retryWriteback: candidate }).retryWriteback;
        if (retry) record.retryWriteback = retry; else delete record.retryWriteback;
      }
      await deps.persist(persistOptions(owner.runId));
      assertStage(); await verifyStored(owner, check); assertStage();
      return check.id;
    }
    async function check(runId) {
      const sessionId = deps.getState()?.activeSessionId;
      if (deps.getCurrentRun() || deps.canCheck?.() === false || checking.has(runId)) return;
      const record = deps.findRunRecord(runId, sessionId), check = Intent.normalizeWritebackCheck(record?.writebackCheck);
      if (!record || record.forkSnapshot || !check || check.runId !== runId || check.sessionId !== sessionId) return;
      const owner = ownerFor({ runProjectId: check.projectId, sessionId, recordId: runId });
      if (check.accountScopeId !== owner.accountScopeId) fail('The writeback content check belongs to another account.');
      const assertRead = () => {
        if (deps.getCurrentRun() || deps.getState()?.activeSessionId !== sessionId || deps.canCheck?.() === false) fail('The active run or session changed during content checking.');
        return current(owner, check.id);
      };
      assertRead(); checking.add(runId);
      try {
        const result = await Controller.confirmSaveCheck(check, { assertCurrent: assertRead,
          readSnapshot: params => deps.callPageBridge('getProjectSnapshot', { ...params, runProjectId: owner.projectId }) });
        const live = assertRead();
        const observation = Intent.normalizeWritebackCheck({ ...check, checkedAt: new Date().toISOString(),
          observation: result.ok ? 'matches' : result.reason === 'server_content_mismatch' ? 'differs' : 'unavailable' });
        live.writebackCheck = observation;
        await deps.persist(persistOptions(runId)); assertRead(); await verifyStored(owner, observation); assertRead();
        deps.notify(deps.tx(result.ok ? 'Current server content matches this run\'s plan; execution ownership remains unconfirmed.'
          : 'Current server content could not be matched to the plan. No file was written again.',
        result.ok ? '当前内容与本轮计划一致；执行归属未确认。' : '当前服务器内容尚未与本轮计划匹配；本次没有重复写入文件。'));
        return { ok: result.ok === true, state: result.ok ? 'planned_content_matches' : 'planned_content_unconfirmed',
          executionConfirmed: false, ...(result.reason ? { reason: result.reason } : {}) };
      } finally { checking.delete(runId); deps.refresh?.(); }
    }
    return { stage, check };
  }
  return { create };
});
