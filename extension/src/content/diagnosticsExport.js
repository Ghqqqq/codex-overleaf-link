(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('DiagnosticsExport', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(deps = {}) {
    const { root, window, document, Blob, URL, TextEncoder, AuditRecords, StorageDb, CodexOverleafCompatibility, getState, getCurrentRunView, getCurrentProjectId, findRunRecord, getMirrorFreshness, getExtensionCompatibilityMetadata, getModelDiscovery, getGovernanceRulesForCurrentProject, sendBackgroundNative, fallbackNativeCompatibility, isNativeCompatibilityCompatible, getNativeCompatibilityClassification, callPageBridge, showPluginToast, tr, RUN_SNAPSHOT_ZIP_TIMEOUT_MS } = deps;

  function exposeSmokeHelper() {
    const helper = Object.freeze({
      probeNative: smokeProbeNative,
      probeProject: smokeProbeProject,
      getProjectSnapshotMetrics: smokeProbeProject
    });
    try {
      Object.defineProperty(root, 'CodexOverleafSmoke', {
        configurable: true,
        enumerable: false,
        value: helper
      });
    } catch (_error) {
      root.CodexOverleafSmoke = helper;
    }
  }

  async function smokeProbeNative() {
    try {
      const params = CodexOverleafCompatibility?.buildBridgePingParams
        ? CodexOverleafCompatibility.buildBridgePingParams(getExtensionCompatibilityMetadata())
        : {};
      const response = await sendBackgroundNative({ method: 'bridge.ping', params });
      const compatibility = CodexOverleafCompatibility?.evaluateNativeCompatibility
        ? CodexOverleafCompatibility.evaluateNativeCompatibility(response, getExtensionCompatibilityMetadata())
        : fallbackNativeCompatibility(response);
      return {
        supported: true,
        ok: response?.ok === true && isNativeCompatibilityCompatible(compatibility),
        status: compatibility?.status || (response?.ok ? 'ok' : 'native_missing'),
        classification: getNativeCompatibilityClassification(compatibility),
        errorCode: response?.error?.code || compatibility?.status || '',
        nativeCompatibility: summarizeSmokeNativeCompatibility(compatibility, response)
      };
    } catch (_error) {
      return {
        supported: true,
        ok: false,
        status: 'native_probe_failed',
        errorCode: 'native_probe_failed'
      };
    }
  }

  async function smokeProbeProject(options = {}) {
    try {
      const project = await callPageBridge('getProjectSnapshot', {
        force: Boolean(options.force),
        preferLightweight: true,
        allowZipFallback: true,
        allowEditorNavigation: false,
        requireFullProject: false,
        includeBinaryFiles: true,
        includeContent: false,
        zipTimeoutMs: RUN_SNAPSHOT_ZIP_TIMEOUT_MS
      });
      const files = Array.isArray(project?.files) ? project.files : [];
      const skipped = Array.isArray(project?.capabilities?.skipped) ? project.capabilities.skipped : [];
      const bytes = summarizeSmokeProjectBytes(files);
      const ok = project?.ok !== false && files.length > 0;
      return {
        supported: true,
        ok,
        status: ok ? 'ok' : 'project_snapshot_unavailable',
        errorCode: ok ? '' : project?.code || 'project_snapshot_unavailable',
        counts: {
          files: files.length,
          skipped: skipped.length
        },
        bytes,
        method: project?.capabilities?.method || ''
      };
    } catch (_error) {
      return {
        supported: true,
        ok: false,
        status: 'project_probe_failed',
        errorCode: 'project_probe_failed',
        counts: {
          files: 0,
          skipped: 0
        },
        bytes: {
          text: 0,
          binary: 0
        }
      };
    }
  }

  function summarizeSmokeNativeCompatibility(compatibility = {}, response = {}) {
    const native = compatibility?.native || response?.result || {};
    return {
      status: compatibility?.status || (response?.ok ? 'ok' : 'native_missing'),
      classification: getNativeCompatibilityClassification(compatibility),
      nativeVersion: compatibility?.nativeVersion || native.version || '',
      version: compatibility?.version || native.version || '',
      minimumNativeVersion: compatibility?.minimumNativeVersion || compatibility?.minNativeVersion || '',
      protocolVersion: compatibility?.protocolVersion || native.protocolVersion || '',
      supportedProtocol: compatibility?.supportedProtocol || native.supportedProtocol || ''
    };
  }

  function summarizeSmokeProjectBytes(files = []) {
    return files.reduce((bytes, file) => {
      let size = Number(file?.size || file?.byteLength || 0);
      if ((!Number.isFinite(size) || size <= 0) && typeof file?.content === 'string') {
        size = new TextEncoder().encode(file.content).byteLength;
      }
      if (!Number.isFinite(size) || size <= 0) {
        return bytes;
      }
      if (file?.kind === 'binary') {
        bytes.binary += size;
      } else {
        bytes.text += size;
      }
      return bytes;
    }, {
      text: 0,
      binary: 0
    });
  }

  async function exportDiagnosticsBundle() {
    if (!AuditRecords?.buildDiagnosticBundle) {
      throw new Error('Audit diagnostics helper is unavailable');
    }
    const projectId = getCurrentProjectId();
    const currentRunView = getCurrentRunView();
    const activeRecord = currentRunView && findRunRecord(currentRunView.recordId, currentRunView.sessionId);
    const recentRuns = (getState().runs || []).filter(run => run && (!run.runProjectId || run.runProjectId === projectId))
      .slice().reverse().sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0)).slice(0, 8);
    const [auditLogs, mirror, nativeDiagnostics] = await Promise.all([
      getRecentAuditLogsForCurrentProject(),
      getMirrorFreshness().catch(error => ({ status: 'unavailable', errorCode: error.message })),
      getNativeDiagnosticsSummaryForBundle()
    ]);
    if (getCurrentProjectId() !== projectId) throw new Error('Project changed during diagnostics export; export again.');
    const bundle = AuditRecords.buildDiagnosticBundle({
      excludeContent: true,
      compatibility: {
        extension: getExtensionCompatibilityMetadata(),
        modelDiscovery: getModelDiscovery()
      },
      platform: nativeDiagnostics.platform,
      nativeEnvironment: nativeDiagnostics.nativeEnvironment,
      mirror,
      auditLogs,
      run: activeRecord?.runProjectId === projectId ? activeRecord : recentRuns[0] || {},
      recentRuns,
      governance: getGovernanceRulesForCurrentProject(),
      projectId
    });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `codex-overleaf-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showPluginToast(tr('diagnosticsExportDone'), { status: 'completed' });
  }

  async function getNativeDiagnosticsSummaryForBundle() {
    try {
      const params = CodexOverleafCompatibility?.buildBridgePingParams
        ? CodexOverleafCompatibility.buildBridgePingParams(getExtensionCompatibilityMetadata())
        : {};
      const response = await sendBackgroundNative({ method: 'bridge.ping', params });
      if (!response?.ok) {
        const errorCode = response?.error?.code || 'native_unavailable';
        return {
          platform: { status: 'unavailable', errorCode },
          nativeEnvironment: { status: 'unavailable', errorCode }
        };
      }
      return {
        platform: {
          host: response.result?.host || '',
          platform: response.result?.platform || '',
          version: response.result?.version || '',
          protocolVersion: response.result?.protocolVersion || ''
        },
        nativeEnvironment: response.result?.environment || {}
      };
    } catch (error) {
      const errorCode = error?.message || 'native_unavailable';
      return {
        platform: { status: 'unavailable', errorCode },
        nativeEnvironment: { status: 'unavailable', errorCode }
      };
    }
  }

  async function getRecentAuditLogsForCurrentProject(limit = 12) {
    if (!StorageDb?.getAllByIndex) {
      return [];
    }
    const records = await StorageDb.getAllByIndex('auditLogs', 'projectId', getCurrentProjectId());
    return (records || [])
      .slice()
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
      .slice(0, limit);
  }

    return { exposeSmokeHelper, exportDiagnosticsBundle, smokeProbeNative, smokeProbeProject, summarizeSmokeProjectBytes };
  }

  return { create };
});
