(function initCodexOverleafDiagnosticsController() {
  'use strict';

  // Diagnostics controller — the check runners (inspect*) and result formatters
  // carved out of contentRuntime.js (v1.4.5 structural-debt phase 1). The code
  // below moved verbatim (original indentation kept); runtime collaborators are
  // factory-injected so behavior is unchanged. Mutable runtime state (panel
  // state, OT status) is read through injected getters.
  function create(deps = {}) {
    const {
      Compatibility: CodexOverleafCompatibility,
      tr,
      tx,
      getExtensionCompatibilityMetadata,
      showDiagnosticsLoading,
      showDiagnosticsResult,
      setDiagnosticsHealth,
      sendBackgroundNative,
      callPageBridge,
      getState,
      getCurrentOtStatus,
      getOtWarmMirrorState,
      otWarmMirrorController,
      getActiveFocusFiles,
      getCurrentProjectId,
      isExperimentalOtEnabled,
      readOtBridgeStatus,
      formatOtStatusLabel,
      normalizeOtStatus,
      formatProbeStatusBar,
      getProbeRunReadiness,
      getMirrorFreshness,
      formatProjectSnapshotLog,
      formatProjectSnapshotWarning,
      getProjectSnapshotWarnings,
      isTextSnapshotFile,
      INSTALL_COMMAND,
      RUN_SNAPSHOT_ZIP_TIMEOUT_MS
    } = deps;

  // Reduce a result status to a health bucket. 'completed' is a pass; a hard
  // failure is fail; everything else (warning, partial, info) is attention.
  function diagnosticsHealthBucket(status) {
    if (status === 'completed') return 'ok';
    if (status === 'failed') return 'fail';
    return 'warn';
  }

  // Run every diagnostic check and render one aggregated, scannable health
  // report (a status row per check) instead of four separate result screens.
  // The overall bucket also updates the trigger dot.
  async function runAllDiagnostics() {
    showDiagnosticsLoading(tr('diagnosticsHealthTitle'), tr('diagnosticsRunningAll'));
    const specs = [
      { label: tr('diagnosticsNativeShort'), run: inspectNativeEnvironment },
      { label: tr('diagnosticsPageShort'), run: inspectPageStateDiagnostics },
      { label: tr('diagnosticsSnapshotShort'), run: inspectProjectSnapshot },
      { label: tr('diagnosticsOtShort'), run: inspectOtWarmMirrorDiagnostics }
    ];
    const checks = [];
    let worst = 'ok';
    for (const spec of specs) {
      let result;
      try {
        result = await spec.run({ collectOnly: true });
      } catch (error) {
        result = { status: 'failed', summary: tr('diagnosticsCheckErrored'), technical: error?.message || String(error) };
      }
      const bucket = diagnosticsHealthBucket(result?.status);
      if (bucket === 'fail') {
        worst = 'fail';
      } else if (bucket === 'warn' && worst !== 'fail') {
        worst = 'warn';
      }
      checks.push({
        status: result?.status || 'info',
        title: spec.label,
        summary: result?.summary || result?.subtitle || '',
        nextStep: bucket === 'ok' ? '' : (result?.nextStep || '')
      });
    }
    const overallSubtitleKey = worst === 'ok'
      ? 'diagnosticsHealthOk'
      : worst === 'fail' ? 'diagnosticsHealthFail' : 'diagnosticsHealthWarn';
    showDiagnosticsResult({
      title: tr('diagnosticsHealthTitle'),
      subtitle: tr(overallSubtitleKey),
      status: worst === 'ok' ? 'completed' : worst === 'fail' ? 'failed' : 'warning',
      checks,
      technical: checks.map(check => `${check.title}: ${check.status}`).join('\n')
    });
    setDiagnosticsHealth(worst);
  }






  async function inspectProjectSnapshot(options = {}) {
    if (!options.collectOnly) {
      showDiagnosticsLoading(tr('diagnosticsSnapshotTitle'), tr('diagnosticsSnapshotLoading'));
    }
    let result;
    try {
      const project = await callPageBridge('getProjectSnapshot', {
        force: true,
        preferLightweight: true,
        allowZipFallback: true,
        allowEditorNavigation: false,
        requireFullProject: true,
        zipOnly: true,
        zipTimeoutMs: RUN_SNAPSHOT_ZIP_TIMEOUT_MS
      });
      result = formatProjectSnapshotDiagnosticsResult(project);
    } catch (error) {
      result = {
        title: tx('Project Read Failed', '项目读取失败'),
        subtitle: tx('The extension did not receive Overleaf project content.', '插件没有拿到 Overleaf 项目内容。'),
        status: 'failed',
        summary: tr('diagnosticsSnapshotErrorSummary'),
        nextStep: tx('Reload Overleaf, wait for the left file tree to finish loading, then retry.', '刷新 Overleaf 页面，等左侧文件树加载完成后重试。'),
        technical: error?.stack || error?.message || String(error)
      };
    }
    if (options.collectOnly) {
      return result;
    }
    showDiagnosticsResult(result);
  }

  async function inspectNativeEnvironment(options = {}) {
    if (!options.collectOnly) {
      showDiagnosticsLoading(tr('diagnosticsNativeTitle'), tr('diagnosticsNativeLoading'));
    }
    const params = CodexOverleafCompatibility?.buildBridgePingParams
      ? CodexOverleafCompatibility.buildBridgePingParams(getExtensionCompatibilityMetadata())
      : {};
    const response = await sendBackgroundNative({ method: 'bridge.ping', params });
    const result = formatNativeEnvironmentResult(response);
    if (options.collectOnly) {
      return result;
    }
    showDiagnosticsResult(result);
  }

  function formatNativeEnvironmentResult(response) {
    const compatibility = CodexOverleafCompatibility?.evaluateNativeCompatibility
      ? CodexOverleafCompatibility.evaluateNativeCompatibility(response, getExtensionCompatibilityMetadata())
      : fallbackNativeCompatibility(response);
    if (compatibility.status !== 'ok' && compatibility.status !== 'native_unhealthy') {
      return formatNativeCompatibilityResult(compatibility, response);
    }

    if (!response?.ok) {
      return {
        title: tx('Local Connection Problem', '本机连接异常'),
        subtitle: tx('The extension could not connect to the local service.', '插件没有连上本机服务。'),
        status: 'failed',
        summary: tx('The extension is not connected to the local service, so it cannot run local Codex or sync the local workspace yet.', '插件没有连上本机服务，所以暂时不能调用本地 Codex 或同步本地 workspace。'),
        nextStep: tx('Make sure the native host is installed, reload the Chrome extension, then try again.', '确认 native host 已安装，并重新加载 Chrome 扩展后再试。'),
        installCommand: INSTALL_COMMAND,
        technical: response?.error?.message || tx('native host did not respond', 'native host 没有响应')
      };
    }

    const environment = response.result?.environment;
    if (!environment) {
      return {
        title: tx('Local Connection Available', '本机连接可用'),
        subtitle: tx('Native Host responded.', 'Native Host 已响应。'),
        status: 'completed',
        summary: tr('diagnosticsNativeEmptySummary'),
        nextStep: tx('If tasks fail to run, reinstall the native host or check the codex command in Terminal.', '如果运行任务失败，请重新安装 native host 或检查终端里的 codex 命令。'),
        technical: JSON.stringify(response.result || {}, null, 2)
      };
    }

    const codexOk = environment.codex?.ok === true;
    const latexTools = environment.latex?.available || [];
    const latexOk = latexTools.length > 0;
    const bullets = [
      codexOk
        ? tx(`Codex available: ${environment.codex.path || 'found on PATH'}`, `Codex 可用：${environment.codex.path || '已在 PATH 中找到'}`)
        : tx('Codex was not found: the extension cannot start local Codex.', 'Codex 没有找到：插件不能启动本地 Codex。'),
      latexOk
        ? tx(`LaTeX tools available: ${latexTools.join(', ')}`, `LaTeX 工具可用：${latexTools.join(', ')}`)
        : tx('LaTeX tools were not found: text editing works, but local compile checks are limited.', 'LaTeX 工具没有找到：可以编辑文本，但不能在本地编译验证。')
    ];

    if (codexOk && latexOk) {
      return {
        title: tx('Local Connection OK', '本机连接正常'),
        subtitle: tx('Codex and LaTeX are available.', 'Codex 和 LaTeX 都可以使用。'),
        status: 'completed',
        summary: tx('Codex is connected and local LaTeX tools are available. Codex can read, edit, and locally check this Overleaf project.', 'Codex 已连接，本机 LaTeX 工具可用。你可以让 Codex 读取、修改并本地检查 Overleaf 项目。'),
        bullets,
        technical: JSON.stringify(environment, null, 2)
      };
    }

    return {
      title: codexOk ? tx('Local Connection Partially Available', '本机连接部分可用') : tx('Codex Unavailable', 'Codex 不可用'),
      subtitle: codexOk ? tx('Codex is available, but compile tools are incomplete.', 'Codex 可用，但编译工具不完整。') : tx('Local Codex was not found.', '没有找到本机 Codex。'),
      status: codexOk ? 'warning' : 'failed',
      summary: codexOk
        ? tx('Local Codex can run, but LaTeX compile tools were not found. File edits are unaffected, but compile verification is limited.', '本机 Codex 可以运行，但没有找到 LaTeX 编译工具；修改文件不受影响，编译验证会受限。')
        : tx('The extension reached the native host, but local Codex was not found, so tasks cannot start.', '插件已经连上 native host，但没有找到本机 Codex，所以不能启动任务。'),
      bullets,
      nextStep: codexOk
        ? tx('For compile verification, make sure latexmk or pdflatex is available on your Terminal PATH.', '如需编译验证，请确认 latexmk 或 pdflatex 在终端 PATH 中可用。')
        : tx('Make sure codex works in Terminal, then reload the extension.', '请确认终端里可以运行 codex，然后重新加载扩展。'),
      technical: JSON.stringify(environment, null, 2)
    };
  }

  function fallbackNativeCompatibility(response) {
    return response?.ok
      ? { status: 'ok', classification: 'compatible', native: response.result, installCommand: INSTALL_COMMAND }
      : { status: 'native_missing', classification: 'incompatible', native: response, installCommand: INSTALL_COMMAND };
  }

  function getNativeCompatibilityClassification(compatibility = {}) {
    if (compatibility.classification) {
      return compatibility.classification;
    }
    return compatibility.status === 'ok' ? 'compatible' : 'incompatible';
  }

  function isNativeCompatibilityCompatible(compatibility = {}) {
    return getNativeCompatibilityClassification(compatibility) === 'compatible';
  }

  function formatNativeCompatibilityResult(compatibility = {}, response = {}) {
    const statusValue = compatibility.status || 'unknown_native';
    if (statusValue === 'native_missing') {
      return {
        title: tx('Local Connection Problem', '本机连接异常'),
        subtitle: tx('The extension could not connect to the local service.', '插件没有连上本机服务。'),
        status: 'failed',
        summary: tx('The extension is not connected to the local service, so it cannot run local Codex or sync the local workspace yet.', '插件没有连上本机服务，所以暂时不能调用本地 Codex 或同步本地 workspace。'),
        nextStep: tx('Make sure the native host is installed, reload the Chrome extension, then try again.', '确认 native host 已安装，并重新加载 Chrome 扩展后再试。'),
        installCommand: INSTALL_COMMAND,
        technical: response?.error?.message || tx('native host did not respond', 'native host 没有响应')
      };
    }

    const messages = getNativeCompatibilityMessages(statusValue);
    return {
      title: messages.title,
      subtitle: messages.subtitle,
      status: 'failed',
      summary: messages.summary,
      bullets: formatNativeCompatibilityBullets(compatibility),
      nextStep: messages.nextStep,
      installCommand: compatibility.installCommand,
      technical: formatNativeCompatibilityTechnicalDetails(compatibility, response)
    };
  }

  function getNativeCompatibilityMessages(statusValue) {
    switch (statusValue) {
      case 'native_too_old':
        return {
          title: tx('Native Host Update Required', '需要更新 Native Host'),
          subtitle: tx('The local native host is too old for this extension.', '本机 native host 版本太旧。'),
          summary: tx('The extension reached the native host, but its version or capabilities do not match this extension. Update the native host before running Codex.', '插件已经连上 native host，但版本或能力与当前扩展不匹配。请先更新 native host 再运行 Codex。'),
          nextStep: tx('Run the installer command below, reload the Chrome extension, then check again.', '运行下面的安装命令，重新加载 Chrome 扩展后再检查。')
        };
      case 'protocol_unsupported':
        return {
          title: tx('Protocol Mismatch', '协议不匹配'),
          subtitle: tx('The extension and native host do not support the same bridge protocol.', '扩展和 native host 支持的桥接协议不一致。'),
          summary: tx('The native host responded, but its protocol range is not compatible with this extension. Update the extension and native host together.', 'Native host 已响应，但协议范围与当前扩展不兼容。请同时更新扩展和 native host。'),
          nextStep: tx('Run the installer command below and make sure the Chrome extension is the matching release.', '运行下面的安装命令，并确认 Chrome 扩展是匹配的版本。')
        };
      case 'extension_too_old':
        return {
          title: tx('Extension Update Required', '需要更新扩展'),
          subtitle: tx('The native host requires a newer Chrome extension.', 'Native host 需要更新的 Chrome 扩展。'),
          summary: tx('The installed native host is newer than this extension can safely use.', '已安装的 native host 比当前扩展更新，当前扩展不能安全使用。'),
          nextStep: tx('Update the Chrome extension, reload Overleaf, then check the local connection again.', '更新 Chrome 扩展，重新加载 Overleaf 后再检查本机连接。')
        };
      default:
        return {
          title: tx('Native Host Not Compatible', 'Native Host 不兼容'),
          subtitle: tx('The local bridge did not match this extension.', '本机桥接服务与当前扩展不匹配。'),
          summary: tx('The native host response could not be accepted by this extension.', '当前扩展不能接受 native host 的响应。'),
          nextStep: tx('Update the native host and Chrome extension, then check again.', '更新 native host 和 Chrome 扩展后再检查。')
        };
    }
  }

  function formatNativeCompatibilityBullets(compatibility = {}) {
    const native = compatibility.native || {};
    return [
      tx(`Status: ${compatibility.status || 'unknown'}`, `状态：${compatibility.status || 'unknown'}`),
      tx(`Classification: ${getNativeCompatibilityClassification(compatibility)}`, `兼容分类：${getNativeCompatibilityClassification(compatibility)}`),
      tx(`Extension version: ${compatibility.extensionVersion || 'unknown'}`, `扩展版本：${compatibility.extensionVersion || 'unknown'}`),
      tx(`Native version: ${native.version || 'unknown'}`, `Native 版本：${native.version || 'unknown'}`),
      tx(`Native protocol: ${formatNativeProtocolVersion(native)}`, `Native 协议：${formatNativeProtocolVersion(native)}`)
    ];
  }

  function formatNativeProtocolVersion(native = {}) {
    const protocolVersion = native.protocolVersion ?? 'unknown';
    const range = native.supportedProtocol;
    if (range && Number.isInteger(range.min) && Number.isInteger(range.max)) {
      return `${protocolVersion} (${range.min}-${range.max})`;
    }
    return String(protocolVersion);
  }

  function formatNativeCompatibilityTechnicalDetails(compatibility = {}, response = {}) {
    const native = compatibility.native || {};
    const capabilities = native.capabilities && typeof native.capabilities === 'object'
      ? Object.keys(native.capabilities).sort()
      : [];
    return JSON.stringify({
      status: compatibility.status || 'unknown',
      classification: getNativeCompatibilityClassification(compatibility),
      extensionVersion: compatibility.extensionVersion || '',
      nativeVersion: native.version || '',
      protocolVersion: native.protocolVersion ?? null,
      supportedProtocol: native.supportedProtocol || null,
      capabilityKeys: capabilities,
      errorCode: response?.error?.code || '',
      errorMessage: response?.error?.message || ''
    }, null, 2);
  }

  async function inspectPageStateDiagnostics(options = {}) {
    if (!options.collectOnly) {
      showDiagnosticsLoading(tr('diagnosticsPageTitle'), tr('diagnosticsPageLoading'));
    }
    let result;
    try {
      const probe = await callPageBridge('probe', {
        manualOverride: getState()?.requireReviewing === false
      });
      result = formatPageStateDiagnosticsResult(probe);
    } catch (error) {
      result = {
        title: tx('Overleaf Page Check Failed', 'Overleaf 页面检查失败'),
        subtitle: tx('The extension did not read the current page state.', '插件没有读到当前页面状态。'),
        status: 'failed',
        summary: tx('This usually means Overleaf is still loading, or the page script is temporarily unavailable.', '这通常表示 Overleaf 页面还在加载，或者页面脚本暂时不可用。'),
        nextStep: tx('Reload Overleaf, open the .tex file you want to work on, then try again.', '刷新 Overleaf 页面，点开要处理的 .tex 文件后再试。'),
        technical: error?.stack || error?.message || String(error)
      };
    }
    if (options.collectOnly) {
      return result;
    }
    showDiagnosticsResult(result);
  }

  async function inspectOtWarmMirrorDiagnostics(options = {}) {
    if (!options.collectOnly) {
      showDiagnosticsLoading(tr('diagnosticsOtTitle'), tr('diagnosticsLoading'));
    }
    // OT warm mirror is experimental and off by default. When it is disabled
    // there is nothing live to probe, so report a clean, healthy "disabled"
    // state instead of querying (then warning about) absent OT metadata — or
    // degrading to the generic "could not run" error if a probe throws. A
    // turned-off feature must never read as a failure.
    if (!isExperimentalOtEnabled()) {
      const disabledResult = {
        title: tr('diagnosticsOtTitle'),
        subtitle: tr('diagnosticsOtSubtitle'),
        status: 'completed',
        summary: tr('diagnosticsOtSummaryDisabled'),
        bullets: [],
        nextStep: '',
        technical: ''
      };
      if (options.collectOnly) {
        return disabledResult;
      }
      showDiagnosticsResult(disabledResult);
      return;
    }
    const projectId = getCurrentProjectId();
    let otStatus = null;
    let mirrorStatus = null;
    let metadataWarning = false;

    try {
      otStatus = await callPageBridge('getOtStatus', { projectId });
      if (otStatus?.ok === false) {
        metadataWarning = true;
        otStatus = {
          ...otStatus,
          lastErrorCode: 'get_ot_status_failed'
        };
      }
    } catch (error) {
      metadataWarning = true;
      otStatus = {
        ok: false,
        status: 'unavailable',
        lastErrorCode: 'get_ot_status_failed'
      };
    }

    try {
      mirrorStatus = await getMirrorFreshness();
      if (!mirrorStatus) {
        metadataWarning = true;
        mirrorStatus = { lastOtErrorCode: 'mirror_status_unavailable' };
      }
    } catch (error) {
      metadataWarning = true;
      mirrorStatus = { lastOtErrorCode: 'mirror_status_failed' };
    }

    const baseResult = formatOtDiagnosticsResult({ otStatus, mirrorStatus });
    const result = metadataWarning
      ? {
          ...baseResult,
          status: 'warning',
          summary: `${baseResult.summary} ${tx('Some OT diagnostic metadata is unavailable.', '部分 OT 诊断元数据暂时不可用。')}`
        }
      : baseResult;
    if (options.collectOnly) {
      return result;
    }
    showDiagnosticsResult(result);
  }

  function formatOtDiagnosticsResult({ otStatus, mirrorStatus }) {
    const enabled = isExperimentalOtEnabled();
    const statusValue = normalizeOtStatus(otStatus ? readOtBridgeStatus(otStatus) : getCurrentOtStatus());
    const queuedEventCount = normalizeOtDiagnosticsCount(otStatus?.queuedEventCount);
    const lastEventAt = formatOtDiagnosticValue(otStatus?.lastEventAt, tr('noneValue'));
    const warmMirrorState = getOtWarmMirrorState() || {};
    const lastOtPatchAt = formatOtDiagnosticValue(mirrorStatus?.lastOtPatchAt || warmMirrorState.lastPatchAt, tr('noneValue'));
    const lastOtErrorCode = formatOtDiagnosticValue(mirrorStatus?.lastOtErrorCode || warmMirrorState.lastErrorCode, tr('noneValue'));
    const lastErrorCode = formatOtDiagnosticValue(otStatus?.lastErrorCode || otStatus?.reason || otStatus?.error, tr('noneValue'));
    const channelCandidates = formatOtChannelCandidates(otStatus?.channelCandidates);
    const otFreshFileCount = normalizeOtDiagnosticsCount(
      mirrorStatus?.otFreshFileCount,
      Array.isArray(mirrorStatus?.otFreshFiles) ? mirrorStatus.otFreshFiles.length : 0
    );
    const bridgeFailed = otStatus?.ok === false;
    const focusFiles = getActiveFocusFiles();
    const otWarmStart = otWarmMirrorController?.canUseOtWarmStart?.({ enabled, focusFiles, mirrorStatus }) || { ok: false };
    const fallback = !enabled || statusValue !== 'observing' || bridgeFailed || otWarmStart?.ok !== true;

    return {
      title: tr('diagnosticsOtTitle'),
      subtitle: tr('diagnosticsOtSubtitle'),
      status: enabled && !fallback && !bridgeFailed ? 'completed' : (enabled || bridgeFailed ? 'warning' : 'completed'),
      summary: tr(enabled ? 'diagnosticsOtSummaryEnabled' : 'diagnosticsOtSummaryDisabled'),
      bullets: [
        `${tr('otStatus')}: ${formatOtStatusLabel(statusValue)}`,
        `${tr('otFreshFiles')}: ${otFreshFileCount}`,
        `${tr('otFallback')}: ${fallback ? tr('yes') : tr('no')}`
      ],
      nextStep: fallback ? tr('diagnosticsOtNextStep') : '',
      technical: formatOtDiagnosticsTechnicalDetails({
        strategy: formatOtDiagnosticValue(otStatus?.strategy, 'unknown'),
        queuedEventCount,
        lastEventAt,
        lastOtPatchAt,
        lastOtErrorCode,
        lastErrorCode,
        channelCandidates
      })
    };
  }

  function formatOtDiagnosticsTechnicalDetails(metadata = {}) {
    const lines = [
      `strategy: ${metadata.strategy || 'unknown'}`,
      `queuedEventCount: ${metadata.queuedEventCount}`,
      `lastEventAt: ${metadata.lastEventAt || tr('noneValue')}`,
      `lastOtPatchAt: ${metadata.lastOtPatchAt || tr('noneValue')}`,
      `lastOtErrorCode: ${metadata.lastOtErrorCode || tr('noneValue')}`,
      `lastErrorCode: ${metadata.lastErrorCode || tr('noneValue')}`
    ];
    const candidates = Array.isArray(metadata.channelCandidates) ? metadata.channelCandidates : [];
    lines.push(`channelCandidates: ${candidates.length ? '' : tr('noneValue')}`);
    for (const candidate of candidates) {
      lines.push(`- ${candidate}`);
    }
    return lines.join('\n');
  }

  function formatOtChannelCandidates(candidates) {
    return (Array.isArray(candidates) ? candidates : [])
      .slice(0, 4)
      .map(candidate => {
        const root = formatOtDiagnosticValue(candidate?.root, 'unknown');
        const keyPaths = (Array.isArray(candidate?.keyPaths) ? candidate.keyPaths : [])
          .map(value => formatOtDiagnosticValue(value, ''))
          .filter(Boolean)
          .slice(0, 6);
        return keyPaths.length ? `${root}: ${keyPaths.join(', ')}` : root;
      })
      .filter(Boolean);
  }

  function normalizeOtDiagnosticsCount(value, fallback = 0) {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : fallback;
  }

  function formatOtDiagnosticValue(value, fallback = '') {
    let text = '';
    if (typeof value === 'string') {
      text = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      text = String(value);
    } else if (value?.code || value?.message) {
      text = String(value.code || value.message);
    }
    if (!text) {
      return fallback;
    }
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  }

  function formatPageStateDiagnosticsResult(probe) {
    const readiness = getProbeRunReadiness(probe || {});
    const reviewingOk = probe?.reviewing?.ok === true;
    const writable = probe?.capabilities?.editor?.write !== false;
    const readable = probe?.editor?.ok === true;
    const bullets = [
      readable ? tx('Current file was read.', '当前文件已经读到。') : tx('Current file content has not been verified yet.', '还没有确认当前文件内容。'),
      writable ? tx('Editor write access will be verified again during writeback.', '当前编辑器写入能力会在写入时再次验证。') : tx('The current editor is not writable yet.', '当前编辑器暂时不可写。'),
      reviewingOk ? tx('Reviewing/Track Changes status is verified.', '留痕/Reviewing 状态已确认。') : tx('Reviewing/Track Changes status is not verified yet.', '留痕/Reviewing 状态还没有确认。')
    ];

    if (readable && writable) {
      return {
        title: tx('Overleaf Page Ready', 'Overleaf 页面可用'),
        subtitle: formatProbeStatusBar(probe),
        status: reviewingOk || getState()?.mode === 'ask' ? 'completed' : 'warning',
        summary: tx('The current Overleaf file can be read and written. The extension still verifies before writing to avoid overwriting new user or collaborator edits.', '当前 Overleaf 文件可以读取和写入。写入前插件仍会再次验证，避免覆盖用户或协作者的新改动。'),
        bullets,
        nextStep: reviewingOk || getState()?.mode === 'ask' ? '' : tx('If you need tracked writes, turn on Overleaf Reviewing/Track Changes first.', '如果需要留痕写入，请先在 Overleaf 开启 Reviewing/Track Changes。'),
        technical: formatPageDiagnosticsTechnicalDetails(probe)
      };
    }

    return {
      title: readable ? tx('Current File Read, Write Status Incomplete', '当前文件已读取，但写入状态不完整') : tx('Current File Not Verified Yet', '还没有确认当前文件'),
      subtitle: formatProbeStatusBar(probe),
      status: 'warning',
      summary: readable
        ? tx('The extension read the current Overleaf file, but has not verified that the current editor can be written.', '插件已读到当前 Overleaf 文件，但还没有确认当前编辑器可以写入。')
        : tx('The extension has not verified that the current editor can be written. Usually this means no .tex file is open yet, or Overleaf is still loading.', '插件没有确认当前编辑器可以写入。通常是还没点开 .tex 文件，或者 Overleaf 页面仍在加载。'),
      bullets,
      nextStep: tx('Open the target .tex file from the left Overleaf file tree, wait for the editor to load, then check again.', '在 Overleaf 左侧文件树点开要处理的 .tex 文件，等编辑器加载完成后重新检测。'),
      technical: formatPageDiagnosticsTechnicalDetails(probe)
    };
  }

  function formatProjectSnapshotDiagnosticsResult(project) {
    const files = project?.files || [];
    const textCount = files.filter(isTextSnapshotFile).length;
    const binaryCount = files.length - textCount;
    const fullProject = project?.capabilities?.fullProjectSnapshot === true;
    const warnings = getProjectSnapshotWarnings(project);
    const warningText = [...warnings.blocking, ...warnings.nonBlocking].map(formatProjectSnapshotWarning);
    const source = project?.capabilities?.method || 'unknown';
    const bullets = [
      tx(`Text files: ${textCount}`, `文本文件：${textCount} 个`),
      tx(`Asset files: ${binaryCount}`, `资源文件：${binaryCount} 个`),
      project?.activePath ? tx(`Current file: ${project.activePath}`, `当前文件：${project.activePath}`) : tx('Current file: not detected', '当前文件：未识别')
    ];

    if (fullProject && files.length) {
      return {
        title: tx('Project Read OK', '项目读取正常'),
        subtitle: tx(`Read source: ${source}`, `读取来源：${source}`),
        status: 'completed',
        summary: tx(
          `The extension read the full Overleaf project: ${textCount} text file(s)${binaryCount ? `, ${binaryCount} asset file(s)` : ''}.`,
          `插件已读到完整 Overleaf 项目：${textCount} 个文本文件${binaryCount ? `，${binaryCount} 个资源文件` : ''}。`
        ),
        bullets: warningText.length ? [...bullets, ...warningText] : bullets,
        technical: formatProjectSnapshotLog(project)
      };
    }

    return {
      title: files.length ? tx('Full Project Not Read', '没有读到完整项目') : tx('No Project Files Read', '没有读到项目文件'),
      subtitle: tx(`Read source: ${source}`, `读取来源：${source}`),
      status: 'warning',
      summary: files.length
        ? tx(
          `The full Overleaf project was not read. Currently read ${textCount} text file(s)${binaryCount ? `, ${binaryCount} asset file(s)` : ''}.`,
          `没有读到完整的 Overleaf 项目。当前只读到 ${textCount} 个文本文件${binaryCount ? `，${binaryCount} 个资源文件` : ''}。`
        )
        : tx('The full Overleaf project was not read, and no usable file content was available.', '没有读到完整的 Overleaf 项目，也没有拿到可用文件内容。'),
      bullets: warningText.length ? [...bullets, ...warningText] : bullets,
      nextStep: tx('Reload Overleaf and wait for the left file tree to load, then retry. If you only want one file, use + to add @file context.', '刷新 Overleaf 页面，等左侧文件树加载完成后重试；如果只想处理一个文件，可以用 + 添加 @file 上下文。'),
      technical: formatProjectSnapshotLog(project)
    };
  }

  function formatPageDiagnosticsTechnicalDetails(probe) {
    const lines = [];
    lines.push(tx(`Status: ${formatProbeStatusBar(probe || {})}`, `状态：${formatProbeStatusBar(probe || {})}`));
    const diagnostics = probe?.reviewingDiagnostics;
    if (diagnostics) {
      lines.push(`Reviewing controls: ${diagnostics.controlCount || 0}; body=${Boolean(diagnostics.bodyTextHasReviewing)}; text=${Boolean(diagnostics.textContentHasReviewing)}`);
      for (const control of (diagnostics.reviewLikeControls || []).slice(0, 4)) {
        const label = [
          control.text,
          control.ariaLabel && `aria:${control.ariaLabel}`,
          control.title && `title:${control.title}`,
          control.dataTestId && `test:${control.dataTestId}`,
          control.id && `id:${control.id}`
        ].filter(Boolean).join(' | ');
        lines.push(`Review-like ${control.tag || 'node'}: ${label || control.htmlSnippet || '(no label)'}`);
      }
    }
    const editorDiagnostics = probe?.editorDiagnostics;
    if (editorDiagnostics) {
      const active = editorDiagnostics.active;
      lines.push(`Editor: active ${active?.tag || 'none'} ${active?.ariaLabel || active?.className || ''} len=${active?.valueLength || 0}; textareas=${editorDiagnostics.textareaCount || 0}; editables=${editorDiagnostics.editableCount || 0}; iframes=${editorDiagnostics.iframeCount || 0}`);
      if (editorDiagnostics.documentStats) {
        const stats = editorDiagnostics.documentStats;
        lines.push(`DOM: elements=${stats.elementCount || 0}; textareas=${stats.textareaCount || 0}; cm=${stats.cmCount || 0}; role textbox=${stats.roleTextboxCount || 0}`);
      }
      if (editorDiagnostics.codeMirrorView) {
        const view = editorDiagnostics.codeMirrorView;
        lines.push(`CodeMirror: docLength=${view.docLength || 0}; dispatch=${Boolean(view.hasDispatch)}; source=${view.source || 'unknown'}`);
      }
    }
    const projectDiagnostics = probe?.projectDiagnostics;
    if (projectDiagnostics) {
      lines.push(`Project records: ${projectDiagnostics.docRecordCount || 0}; roots=${(projectDiagnostics.internalRootKeys || []).slice(0, 6).join(', ') || 'none'}`);
      for (const record of (projectDiagnostics.docRecords || []).slice(0, 4)) {
        lines.push(`Doc record: ${record.path} id=${record.id} source=${record.source || 'internal'}`);
      }
    }
    return lines.join('\n');
  }


    return {
      runAllDiagnostics,
      inspectProjectSnapshot,
      inspectNativeEnvironment,
      inspectPageStateDiagnostics,
      inspectOtWarmMirrorDiagnostics,
      fallbackNativeCompatibility,
      getNativeCompatibilityClassification,
      isNativeCompatibilityCompatible
    };
  }

  window.CodexOverleafDiagnosticsController = { create };
})();
