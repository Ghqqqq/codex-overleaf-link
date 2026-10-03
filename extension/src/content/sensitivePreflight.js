(function initCodexOverleafSensitivePreflight(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafSensitivePreflight = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function sensitivePreflightFactory() {
  'use strict';

  function create({
    SensitiveScan, normalizeGovernanceRules, isTextSnapshotFile, sendBackgroundNative,
    getCurrentProjectId, appendRunEvent, appendCompletionReport, showPluginConfirm, tr, tx
  }) {
    async function runSensitivePreflight(options) {
      options = options || {};
      const { task, project, rules, useExistingMirror = false } = options;
      const normalizedRules = normalizeGovernanceRules(rules);
      if (normalizedRules.sensitiveCheckEnabled === false) {
        return { blocked: false, findings: [] };
      }
      if (!SensitiveScan?.scanSensitiveInputs && !useExistingMirror) {
        return { blocked: false, findings: [] };
      }
      let findings = SensitiveScan?.scanSensitiveInputs
        ? SensitiveScan.scanSensitiveInputs({
          task,
          files: (project?.files || []).filter(isTextSnapshotFile)
        })
        : [];
      if (useExistingMirror) {
        findings = dedupeSensitiveFindings([
          ...findings,
          ...await scanNativeMirrorSensitiveFindings()
        ]);
      }
      if (!findings.length) {
        return { blocked: false, findings: [] };
      }
      appendRunEvent({
        title: tx(
          `Sensitive content check found ${findings.length} item(s).`,
          `敏感内容检查发现 ${findings.length} 项。`
        ),
        status: 'failed',
        detail: findings.slice(0, 8).map(finding => ({
          [tr('detailFile')]: finding.path || finding.source || 'task',
          [tr('detailReason')]: finding.detectorId,
          [tx('Preview', '预览')]: finding.preview || '[REDACTED]'
        }))
      });
      if (normalizedRules.sensitiveConfirmAllowed === true) {
        const approved = await showPluginConfirm({
          title: tr('sensitiveConfirmTitle'),
          message: formatSensitiveConfirmMessage(findings),
          confirmLabel: tr('sensitiveConfirmRun'),
          cancelLabel: tr('confirmDefaultCancel'),
          destructive: true
        });
        return { blocked: !approved, findings };
      }
      appendCompletionReport({
        conclusion: tx(
          'This run was blocked before Codex received project context because sensitive content was detected.',
          '检测到敏感内容，本轮已在向 Codex 发送项目上下文前阻止。'
        ),
        status: 'blocked',
        operations: [],
        applyResults: [],
        nextStep: tx(
          'Remove the sensitive content, narrow @context, or enable explicit sensitive confirmation in Project Settings.',
          '请移除敏感内容、缩小 @context，或在项目设置里允许敏感内容显式确认。'
        )
      });
      return { blocked: true, findings };
    }

    function formatSensitiveConfirmMessage(findings = []) {
      const visible = findings.slice(0, 8).map(finding => {
        const path = finding.path || finding.source || 'task';
        return `${path}: ${finding.detectorId || 'sensitive'} (${finding.preview || '[REDACTED]'})`;
      });
      return [
        tr('sensitiveConfirmMessage'),
        '',
        ...visible,
        findings.length > visible.length ? tx(`${findings.length - visible.length} more finding(s).`, `另有 ${findings.length - visible.length} 项。`) : ''
      ].filter(Boolean).join('\n');
    }

    async function scanNativeMirrorSensitiveFindings() {
      try {
        const response = await sendBackgroundNative({
          method: 'mirror.scanSensitive',
          params: { projectId: getCurrentProjectId() }
        });
        if (response?.ok) {
          return Array.isArray(response.result?.findings) ? response.result.findings : [];
        }
        return [{
          detectorId: 'mirror-sensitive-scan-unavailable',
          source: 'local-mirror',
          preview: response?.error?.message || 'Could not scan the local mirror before Codex runs.'
        }];
      } catch (error) {
        return [{
          detectorId: 'mirror-sensitive-scan-unavailable',
          source: 'local-mirror',
          preview: error?.message || 'Could not scan the local mirror before Codex runs.'
        }];
      }
    }

    function dedupeSensitiveFindings(findings = []) {
      const seen = new Set();
      const deduped = [];
      for (const finding of findings || []) {
        const key = [
          finding?.detectorId || '',
          finding?.source || '',
          finding?.path || '',
          finding?.preview || ''
        ].join('\u0000');
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        deduped.push(finding);
      }
      return deduped;
    }

    return { run: runSensitivePreflight };
  }

  return { create };
});
