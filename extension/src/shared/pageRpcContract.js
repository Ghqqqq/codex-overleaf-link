(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafPageRpcContract = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var REVISION = '2026-08-04-page-rpc-contract-v15';
  var METHODS = freezeCatalog({
    initializeCapability: entry('bridge.initialize', 'control', 'none', 'default', false, 'none'),
    probe: entry('bridge.probe', 'read', 'none', 'default', false, 'safe'),
    cancelActiveWrite: entry('write.cancel', 'control', 'none', 'default', false, 'idempotent'),
    getProjectSnapshot: entry('snapshot.read', 'read', 'none', 'snapshot', true, 'safe'),
    getProjectFileList: entry('snapshot.list', 'read', 'none', 'file_list', true, 'safe'),
    invalidateProjectSnapshot: entry('snapshot.invalidate', 'cache', 'none', 'default', false, 'idempotent'),
    createCheckpoint: entry('checkpoint.create', 'page_state', 'none', 'default', false, 'no_retry'),
    ensureReviewing: entry('reviewing.enable', 'page_state', 'optional', 'default', true, 'idempotent'),
    ensureEditing: entry('reviewing.disable', 'page_state', 'optional', 'default', true, 'idempotent'),
    applyOperations: entry('document.write', 'document', 'required', 'writeback', true, 'no_retry'),
    binaryUploadBegin: entry('asset.stage', 'cache', 'required', 'default', false, 'no_retry'),
    binaryUploadAppend: entry('asset.stage', 'cache', 'none', 'writeback', true, 'no_retry'),
    binaryUploadCommit: entry('asset.write', 'document', 'required', 'writeback', true, 'no_retry'),
    binaryUploadAbort: entry('asset.stage', 'cache', 'none', 'default', false, 'idempotent'),
    jumpToPosition: entry('editor.navigate', 'navigation', 'required', 'default', false, 'idempotent'),
    rejectTrackedChanges: entry('tracked_changes.reject', 'document', 'required', 'lifecycle', true, 'no_retry'),
    acceptTrackedChanges: entry('tracked_changes.accept', 'document', 'required', 'lifecycle', true, 'no_retry'),
    triggerCompile: entry('compile.trigger', 'page_state', 'required', 'compile', false, 'no_retry'),
    getCompileLog: entry('compile.log', 'read', 'required', 'compile', true, 'safe'),
    getCompileState: entry('compile.state', 'read', 'none', 'default', false, 'safe'),
    waitForSaveState: entry('save.wait', 'read', 'none', 'default', true, 'safe'),
    startOtObserver: entry('ot.start', 'observer', 'none', 'default', false, 'idempotent'),
    stopOtObserver: entry('ot.stop', 'observer', 'none', 'default', false, 'idempotent'),
    getOtStatus: entry('ot.status', 'read', 'none', 'default', false, 'safe'),
    drainOtEvents: entry('ot.drain', 'observer', 'none', 'default', false, 'no_retry')
  });

  function entry(capability, mutation, projectIdentity, timeoutClass, cancellable, retryClass) {
    return {
      capability: capability,
      mutation: mutation,
      projectIdentity: projectIdentity,
      timeoutClass: timeoutClass,
      cancellation: cancellable ? 'content_abort' : 'none',
      retryClass: retryClass,
      failureClass: mutation === 'document' ? 'write' : mutation
    };
  }

  function getMethod(name) {
    return typeof name === 'string' && METHODS[name] ? METHODS[name] : null;
  }

  function listMethods() {
    return Object.keys(METHODS);
  }

  function isCancellable(name) {
    return getMethod(name)?.cancellation === 'content_abort';
  }

  function requiresProjectIdentity(name) {
    return getMethod(name)?.projectIdentity === 'required';
  }

  function resolveTimeoutMs(name, overrides) {
    overrides = overrides || {};
    var timeoutClass = getMethod(name)?.timeoutClass || 'default';
    var defaults = {
      default: 8000,
      snapshot: 70000,
      file_list: 35000,
      compile: 75000,
      lifecycle: 120000,
      writeback: 45000
    };
    var candidate = Number(overrides[timeoutClass]);
    return Number.isFinite(candidate) && candidate > 0 ? candidate : defaults[timeoutClass];
  }

  function resolveDispatchPolicy(name, overrides) {
    var method = getMethod(name);
    return Object.freeze({
      timeoutMs: resolveTimeoutMs(name, overrides),
      cancellation: method ? method.cancellation : 'none',
      retryClass: method ? method.retryClass : 'none',
      automaticAttempts: 1
    });
  }

  function capabilityReport() {
    var report = {};
    listMethods().forEach(function (name) {
      var method = METHODS[name];
      report[name] = {
        capability: method.capability,
        mutation: method.mutation,
        projectIdentity: method.projectIdentity,
        retryClass: method.retryClass,
        timeoutClass: method.timeoutClass,
        cancellation: method.cancellation
      };
    });
    return report;
  }

  function withCapabilityReport(capabilities) {
    return Object.assign({}, capabilities || {}, { pageRpc: capabilityReport() });
  }

  function normalizeFailure(method, error) {
    var contract = getMethod(method);
    var message = error && error.message ? error.message : String(error || 'Page bridge request failed');
    return {
      ok: false,
      code: 'page_bridge_dispatch_failed',
      error: message,
      rpcMethod: typeof method === 'string' ? method : '',
      failureClass: contract ? contract.failureClass : 'unknown'
    };
  }

  function freezeCatalog(catalog) {
    Object.keys(catalog).forEach(function (name) { Object.freeze(catalog[name]); });
    return Object.freeze(catalog);
  }

  return Object.freeze({
    METHODS: METHODS,
    REVISION: REVISION,
    capabilityReport: capabilityReport,
    getMethod: getMethod,
    isCancellable: isCancellable,
    listMethods: listMethods,
    normalizeFailure: normalizeFailure,
    requiresProjectIdentity: requiresProjectIdentity,
    resolveDispatchPolicy: resolveDispatchPolicy,
    resolveTimeoutMs: resolveTimeoutMs,
    withCapabilityReport: withCapabilityReport
  });
});
