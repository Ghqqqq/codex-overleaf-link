(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafUpdateRuntimeIdentity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function version(value) { return /^\d+\.\d+\.\d+$/.test(String(value || '')) ? String(value) : ''; }
  function compare(left, right) {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  }

  function verifiedRollback(status = {}) {
    const transaction = status.transaction;
    const pair = status.restoredPair;
    const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
    return Boolean(transaction?.id && transaction.state === 'rolled_back'
      && version(transaction.sourceVersion) && version(transaction.targetVersion)
      && status.installedAligned === true && status.activeVersion === transaction.sourceVersion
      && pair?.extensionVersion === transaction.sourceVersion && pair.nativeVersion === transaction.sourceVersion
      && digest(pair.extensionSha256) && digest(pair.nativeSha256)
      && (!transaction.bootstrapRevision || digest(pair.bootstrapSha256)));
  }

  function inspectInstalledRuntime(status = {}, options = {}) {
    const result = { installedVersion: version(status.activeVersion), nativeVersion: version(status.runtimeVersion),
      extensionVersion: version(options.extensionVersion), runtimeVersion: version(options.runtimeVersion), state: 'unknown' };
    if (!status.managed || !result.installedVersion || !result.nativeVersion ||
        !result.extensionVersion || !result.runtimeVersion) return result;
    if (['authorized', 'bound'].includes(status.authorization?.state) ||
        ['staged', 'activation_pending', 'applying', 'bootstrap_pending', 'bootstrap_rolling_back', 'awaiting_health', 'rolling_back'].includes(status.transaction?.state)) {
      return { ...result, state: 'transaction_active' };
    }
    if (status.installedAligned !== true) return { ...result, state: 'repair_required' };
    const loaded = [result.nativeVersion, result.extensionVersion, result.runtimeVersion];
    if (loaded.every(value => value === result.installedVersion)) return { ...result, state: 'aligned' };
    const rollbackReload = verifiedRollback(status) && loaded.every(value =>
      value === status.transaction.sourceVersion || value === status.transaction.targetVersion);
    return { ...result, state: rollbackReload || loaded.every(value => compare(result.installedVersion, value) >= 0)
      ? 'reload_required' : 'repair_required' };
  }

  return Object.freeze({ inspectInstalledRuntime, verifiedRollback });
});
