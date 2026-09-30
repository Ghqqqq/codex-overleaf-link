(function initFailureReasons(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafFailureReasons = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function failureReasonsFactory() {
  'use strict';

  /**
   * All stages a FailureReason can attach to. Source: design spec §8.
   * @type {Set<string>}
   */
  const FAILURE_STAGES = new Set([
    'context', 'codex', 'navigation', 'preflight', 'write', 'verify',
    'reviewing', 'undo', 'accept', 'native', 'storage', 'unknown'
  ]);

  /**
   * Severity vocabulary. Source: design spec §7.
   * @type {Set<string>}
   */
  const FAILURE_SEVERITIES = new Set(['info', 'warning', 'error', 'blocked']);

  /**
   * Terminal-state vocabulary. Source: design spec §7.
   * @type {Set<string>}
   */
  const TERMINAL_STATES = new Set(['failed', 'blocked', 'degraded', 'needs_review']);

  /**
   * Allowed severity × terminalState pairs per design spec §7.
   * @type {Record<string, Set<string>>}
   */
  const ALLOWED_SEVERITY_PER_TERMINAL = {
    blocked: new Set(['blocked']),
    failed: new Set(['error', 'blocked']),
    needs_review: new Set(['warning', 'error']),
    degraded: new Set(['info', 'warning'])
  };

  /**
   * Code catalog — keyed by code. Pulled verbatim from §9 of the spec.
   * Each entry: { stage, severity, defaultRetryable, fallbackUserMessage, fallbackNextAction }.
   * Used by `normalizeFailureReason` to fill in defaults for legacy results.
   * @type {Record<string, {stage: string, severity: string, defaultRetryable: boolean, fallbackUserMessage: string, fallbackNextAction: string}>}
   */
  const FAILURE_CODE_CATALOG = {
    // 9.0 Context
    project_snapshot_unavailable: {
      stage: 'context', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not read the Overleaf project snapshot.',
      fallbackNextAction: 'Refresh Overleaf, then rerun the task.'
    },
    selected_context_unresolved: {
      stage: 'context', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not resolve the requested selection or context.',
      fallbackNextAction: 'Select the target again or specify the file/section explicitly.'
    },
    base_file_missing_at_start: {
      stage: 'context', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'A file needed for this task was missing during the initial project read.',
      fallbackNextAction: 'Refresh project context and rerun.'
    },

    // 9.1 Navigation
    target_file_missing_path: {
      stage: 'navigation', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'The change did not include a target file path.',
      fallbackNextAction: 'Retry after regenerating the change; report a bug if repeated.'
    },
    target_file_not_found: {
      stage: 'navigation', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not find the target file in this Overleaf project.',
      fallbackNextAction: 'Check the file name/path in Overleaf and retry.'
    },
    target_file_open_failed: {
      stage: 'navigation', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not open the target file in Overleaf.',
      fallbackNextAction: 'Expand the folder or manually open the file, then retry.'
    },
    target_file_not_active: {
      stage: 'navigation', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Codex tried to write the target file, but another file was active at write time.',
      fallbackNextAction: 'Open the target file in Overleaf, then retry this run.'
    },
    target_editor_not_ready: {
      stage: 'navigation', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Target file is active but the editor was not ready before timeout.',
      fallbackNextAction: 'Wait for Overleaf to finish loading, then retry.'
    },
    target_file_focus_lost: {
      stage: 'navigation', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Target file became active, then focus switched before the write landed.',
      fallbackNextAction: 'Avoid switching files during writeback and retry.'
    },
    jump_target_not_resolved: {
      stage: 'navigation', severity: 'warning', defaultRetryable: false,
      fallbackUserMessage: 'A line/position link could not map to an editor range.',
      fallbackNextAction: 'Open the file manually and inspect the referenced line.'
    },

    // 9.2 Preflight
    missing_base_file: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'A write safety check needed a base file that is missing from the run snapshot.',
      fallbackNextAction: 'Refresh project context and rerun.'
    },
    stale_source_changed: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'The file changed while Codex was working.',
      fallbackNextAction: 'Review the current file, then rerun the task.'
    },
    patch_anchor_not_found: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'The edit anchor no longer matches current Overleaf content.',
      fallbackNextAction: 'Rerun the task against the current document.'
    },
    patch_anchor_ambiguous: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'The edit anchor matches multiple locations.',
      fallbackNextAction: 'Narrow the request or select a smaller region.'
    },
    delete_confirmation_missing: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'A destructive delete was not confirmed.',
      fallbackNextAction: 'Confirm the delete explicitly if intended.'
    },
    binary_write_blocked: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'Codex tried to write unsupported binary content.',
      fallbackNextAction: 'Upload the file manually or attach a supported text file.'
    },

    // 9.3 Write/verify
    write_operation_failed: {
      stage: 'write', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Editor write call failed.',
      fallbackNextAction: 'Retry after the editor is stable.'
    },
    write_timeout: {
      stage: 'write', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Editor did not accept the write before timeout.',
      fallbackNextAction: 'Refresh Overleaf and retry.'
    },
    write_observed_mismatch: {
      stage: 'verify', severity: 'error', defaultRetryable: false,
      fallbackUserMessage: 'Codex attempted to write, but the content read back from Overleaf did not match the approved change.',
      fallbackNextAction: 'Open Technical Details and compare expected vs observed.'
    },
    write_post_read_failed: {
      stage: 'verify', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not read the file after writing.',
      fallbackNextAction: 'Check Overleaf manually, then refresh and retry.'
    },
    file_tree_verification_failed: {
      stage: 'verify', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Create/delete/rename/move did not appear in the file tree as expected.',
      fallbackNextAction: 'Inspect the file tree and retry if needed.'
    },
    source_zip_unavailable: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'The project could not be checked before uploading this file.',
      fallbackNextAction: 'Retry sync; only missing files will be uploaded.'
    },
    file_upload_unconfirmed: {
      stage: 'verify', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'The file was submitted, but its saved content is not yet confirmed.',
      fallbackNextAction: 'Check the file before retrying; matching content will not be uploaded twice.'
    },
    subagent_unfinished_output: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'A subagent stopped before finishing this file; the main agent must review and adopt it.',
      fallbackNextAction: 'Have the main agent complete and adopt the pending file.'
    },
    subagent_unauthorized_edit: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'A file changed outside the subagent ownership boundary and was not synced.',
      fallbackNextAction: 'Review the ownership violation; it cannot be cleared through output adoption.'
    },
    partial_write_needs_review: {
      stage: 'verify', severity: 'warning', defaultRetryable: false,
      fallbackUserMessage: 'Some operations wrote, some were skipped.',
      fallbackNextAction: 'Review written files; use Undo written parts if needed.'
    },

    // 9.0+ — write-safety primitive (welcome-panel + writeback project-ID guard)
    aborted_project_changed: {
      stage: 'write', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Codex stopped a write because Overleaf switched to a different project mid-run.',
      fallbackNextAction: 'Reopen the original project and rerun the task if you still want this change.'
    },
    editor_project_id_unavailable: {
      stage: 'write', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not confirm which Overleaf project the editor is currently showing, so it did not write.',
      fallbackNextAction: 'Refresh the Overleaf tab and retry; if it persists, reload the extension.'
    },

    // 9.4 Reviewing
    reviewing_state_unknown: {
      stage: 'reviewing', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not determine whether Reviewing/Track Changes is enabled.',
      fallbackNextAction: 'Check Overleaf mode manually before retrying.'
    },
    reviewing_enable_failed: {
      stage: 'reviewing', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not enable Reviewing when it needed to.',
      fallbackNextAction: 'Enable Reviewing manually or retry.'
    },
    reviewing_disable_failed: {
      stage: 'reviewing', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not switch to Editing / no-trace mode.',
      fallbackNextAction: 'Switch to Editing manually, wait briefly, then retry.'
    },
    editing_not_confirmed: {
      stage: 'reviewing', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Editing mode could not be proven stable.',
      fallbackNextAction: 'Do not write; check the mode selector and retry.'
    },
    tracked_changes_created_unexpectedly: {
      stage: 'reviewing', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'A replay intended to be untracked created Track Changes.',
      fallbackNextAction: 'Inspect Overleaf Reviewing and decide whether to accept or reject.'
    },
    tracked_changes_remain: {
      stage: 'reviewing', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Accept/reject operation finished but tracked changes remain.',
      fallbackNextAction: 'Open Overleaf Reviewing and inspect remaining changes.'
    },
    tracked_change_nodes_not_identified: {
      stage: 'reviewing', severity: 'warning', defaultRetryable: false,
      fallbackUserMessage: 'Codex wrote while Reviewing was enabled but cannot map generated tracked-change nodes.',
      fallbackNextAction: 'Use Overleaf review tools manually; automatic tracked undo is disabled.'
    },

    // 9.5 Undo
    undo_preflight_content_drift: {
      stage: 'undo', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: "Current content no longer matches this run's written content.",
      fallbackNextAction: 'Review manual edits; Codex did not undo to avoid removing them.'
    },
    undo_operation_failed: {
      stage: 'undo', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Overleaf undo or reject operation failed.',
      fallbackNextAction: 'Use Overleaf undo/review tools manually.'
    },
    undo_not_verified: {
      stage: 'undo', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Undo ran, but Codex could not prove the file returned to pre-run content.',
      fallbackNextAction: 'Inspect the file manually before continuing.'
    },
    undo_partial: {
      stage: 'undo', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Some run writes were undone, some were skipped.',
      fallbackNextAction: 'Review remaining files and retry undo if safe.'
    },
    undo_reviewing_restore_unverified: {
      stage: 'undo', severity: 'info', defaultRetryable: true,
      fallbackUserMessage: 'Undo completed but previous Reviewing state was not verified afterward.',
      fallbackNextAction: 'Check Overleaf Reviewing/Editing mode manually.'
    },

    // 9.6 Accept
    accept_preflight_content_drift: {
      stage: 'accept', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: "Content drifted from this run's writeback before accept.",
      fallbackNextAction: 'Retry Accept changes after reviewing current content.'
    },
    accept_force_editing_failed: {
      stage: 'accept', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not enter stable Editing mode for untracked replay.',
      fallbackNextAction: 'Switch to Editing manually and retry.'
    },
    accept_replay_failed: {
      stage: 'accept', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Replaying accepted content failed.',
      fallbackNextAction: 'Inspect the file and retry.'
    },
    accept_replay_created_tracked_changes: {
      stage: 'accept', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Replay created tracked changes, so accept cannot be proven clean.',
      fallbackNextAction: 'Review remaining tracked changes manually.'
    },
    accept_not_verified: {
      stage: 'accept', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Accept appeared to run but Codex could not prove final content/state.',
      fallbackNextAction: 'Inspect Overleaf Reviewing before continuing.'
    },

    // 9.7 Native + Codex
    native_bridge_unavailable: {
      stage: 'native', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Extension cannot connect to the Codex native host.',
      fallbackNextAction: 'Run install-native or reload the extension.'
    },
    native_request_failed: {
      stage: 'native', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Native host request failed.',
      fallbackNextAction: 'Open diagnostics and retry.'
    },
    native_protocol_incompatible: {
      stage: 'native', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Native host version or capabilities do not match the extension.',
      fallbackNextAction: 'Update the native host.'
    },
    codex_no_usable_result: {
      stage: 'codex', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Local Codex returned no usable final report or operations.',
      fallbackNextAction: 'Open Technical Details and resolve the local Codex error.'
    },
    provider_revision_conflict: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'The active model provider changed after this tab loaded it.',
      fallbackNextAction: 'Refresh the provider configuration and retry.'
    },
    provider_not_found: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'The active model provider no longer exists.',
      fallbackNextAction: 'Select Built-in Codex or another provider.'
    },
    provider_model_not_configured: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'The selected model is not configured for the active provider.',
      fallbackNextAction: 'Add or select a model in Model Providers.'
    },
    provider_protocol_unverified: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'The provider API protocol has not been verified.',
      fallbackNextAction: 'Run Test connection, save the provider, and retry.'
    },
    provider_auth_rejected: {
      stage: 'codex', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'The provider rejected the configured API key.',
      fallbackNextAction: 'Replace the API key and test the connection.'
    },
    provider_model_not_found: {
      stage: 'codex', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'The provider could not find the configured model.',
      fallbackNextAction: 'Correct the model ID and test the connection.'
    },
    provider_protocol_incompatible: {
      stage: 'codex', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'The endpoint is incompatible with the selected API protocol.',
      fallbackNextAction: 'Select another protocol or use Auto detection.'
    },
    provider_request_rejected: {
      stage: 'codex', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'The provider rejected the protocol probe request.',
      fallbackNextAction: 'Review the model ID, reasoning controls, tool support, and request overrides.'
    },
    provider_rate_limited: {
      stage: 'codex', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'The provider rate limit was reached.',
      fallbackNextAction: 'Wait for the rate-limit window to recover and retry.'
    },
    provider_connection_timeout: {
      stage: 'codex', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'The provider connection timed out.',
      fallbackNextAction: 'Check the endpoint and network, then retry.'
    },
    provider_dns_failed: {
      stage: 'codex', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'The provider hostname could not be resolved.',
      fallbackNextAction: 'Check the Base URL and DNS, then retry.'
    },
    provider_tls_failed: {
      stage: 'codex', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'TLS verification failed for the provider endpoint.',
      fallbackNextAction: 'Check the endpoint certificate and Base URL.'
    },
    provider_response_invalid: {
      stage: 'codex', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'The provider returned an incompatible or invalid response.',
      fallbackNextAction: 'Test the connection and verify protocol compatibility.'
    },
    provider_store_unavailable: {
      stage: 'storage', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'The Native Host could not access provider configuration storage.',
      fallbackNextAction: 'Check local permissions and Native Host status.'
    },
    provider_store_corrupt: {
      stage: 'storage', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'The provider configuration store is corrupt or inconsistent.',
      fallbackNextAction: 'Repair or rebuild the local provider configuration.'
    },
    codex_project_locked: {
      stage: 'codex', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Another Codex task is already running for this Overleaf project.',
      fallbackNextAction: 'Wait for the active task to finish, or cancel it before retrying.'
    },
    codex_result_parse_failed: {
      stage: 'codex', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Codex output could not be parsed into operations.',
      fallbackNextAction: 'Retry with a simpler request; report if repeated.'
    },
    codex_run_cancelled: {
      stage: 'codex', severity: 'info', defaultRetryable: true,
      fallbackUserMessage: 'The local run was cancelled.',
      fallbackNextAction: 'Start a new run.'
    },
    codex_timeout: {
      stage: 'codex', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Local Codex took too long to finish.',
      fallbackNextAction: 'Check whether local Codex is still running; cancel and retry with smaller @context.'
    },
    codex_output_limit: {
      stage: 'codex', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Local Codex output was too large; the bridge stopped reading.',
      fallbackNextAction: 'Retry with smaller @context, or open Technical Details to inspect the output limit.'
    },
    codex_not_found: {
      stage: 'codex', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Codex CLI was not found on this machine.',
      fallbackNextAction: 'Confirm `codex` works in Terminal, then reinstall the native host or reload the extension.'
    },

    // 9.8 Storage
    storage_quota_exceeded: {
      stage: 'storage', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Browser storage quota was exceeded.',
      fallbackNextAction: 'Clear old run history or reduce attachments.'
    },
    run_state_persist_failed: {
      stage: 'storage', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Current run state could not be saved.',
      fallbackNextAction: "Continue carefully; refresh may lose this run's recovery state."
    },
    receipt_persist_failed: {
      stage: 'storage', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Writeback receipt could not be saved.',
      fallbackNextAction: 'Export/copy Technical Details before refreshing.'
    },

    // Defensive fallback
    unknown_legacy_failure: {
      stage: 'unknown', severity: 'error', defaultRetryable: false,
      fallbackUserMessage: 'Codex could not classify this failure.',
      fallbackNextAction: 'Open Technical Details for the raw report.'
    }
  };

  /**
   * Legacy code → canonical code mapping per design spec §14.
   * Function-valued entries inspect the legacy result for evidence flags before deciding.
   * @type {Record<string, string | ((result: any) => string)>}
   */
  const LEGACY_CODE_MAP = {
    path_not_found: 'target_file_not_found',
    file_open_failed: 'target_file_open_failed',
    editor_not_ready: 'target_editor_not_ready',
    stale_snapshot: 'stale_source_changed',
    missing_base_file: 'missing_base_file',
    reviewing_enable_failed: 'reviewing_enable_failed',
    reviewing_disable_failed: 'reviewing_disable_failed',
    editing_not_confirmed: 'editing_not_confirmed',
    file_tree_verification_failed: 'file_tree_verification_failed',
    native_connection_failed: 'native_bridge_unavailable',
    reviewing_not_enabled: function reviewingNotEnabledMapper(result) {
      const attempted = result && result.evidence && result.evidence.toggleAttempted === true;
      return attempted ? 'reviewing_enable_failed' : 'reviewing_state_unknown';
    }
  };

  /**
   * Validate a candidate FailureReason record against the design-spec §7 schema.
   * Never throws. Returns `{ ok: true }` on success or `{ ok: false, reason: <code> }` on failure.
   * @param {unknown} obj
   * @returns {{ ok: boolean, reason?: string }}
   */
  function validateFailureReason(obj) {
    if (!obj || typeof obj !== 'object') {
      return { ok: false, reason: 'not_object' };
    }
    if (typeof obj.code !== 'string' || !obj.code) {
      return { ok: false, reason: 'missing_code' };
    }
    if (!FAILURE_STAGES.has(obj.stage)) {
      return { ok: false, reason: 'invalid_stage' };
    }
    if (!FAILURE_SEVERITIES.has(obj.severity)) {
      return { ok: false, reason: 'invalid_severity' };
    }
    if (typeof obj.userMessage !== 'string' || !obj.userMessage) {
      return { ok: false, reason: 'missing_userMessage' };
    }
    if (typeof obj.retryable !== 'boolean') {
      return { ok: false, reason: 'missing_retryable' };
    }
    if (obj.retryable === true && (typeof obj.nextAction !== 'string' || !obj.nextAction)) {
      return { ok: false, reason: 'missing_nextAction_for_retryable' };
    }
    if (obj.terminalState !== undefined) {
      if (!TERMINAL_STATES.has(obj.terminalState)) {
        return { ok: false, reason: 'invalid_terminalState' };
      }
      const allowed = ALLOWED_SEVERITY_PER_TERMINAL[obj.terminalState];
      if (!allowed || !allowed.has(obj.severity)) {
        return { ok: false, reason: 'disallowed_severity_terminalState_pair' };
      }
    }
    return { ok: true };
  }

  /**
   * Normalize a legacy `result` object (possibly null / malformed) into a valid FailureReason.
   * Never throws. Prefers an explicit `result.failure` when valid; otherwise maps legacy
   * `result.code` via `LEGACY_CODE_MAP` and falls back to `unknown_legacy_failure`.
   *
   * @param {unknown} result - The legacy result object from a writeback/page-bridge call.
   * @param {{ path?: string, type?: string }} [operation] - Operation context to augment the failure with.
   * @param {Record<string, unknown>} [context] - Reserved for future contextual hints (unused today).
   * @returns {{ code: string, stage: string, severity: string, userMessage: string, retryable: boolean, nextAction?: string, file?: string, operationType?: string, evidence?: Record<string, unknown>, technicalMessage?: string }}
   */
  function normalizeFailureReason(result, operation, context) {
    void context;
    const op = operation || {};

    // Defensive repair for null / non-object / missing code.
    if (!result || typeof result !== 'object') {
      return buildFallbackFailureReason('unknown_legacy_failure', op);
    }

    // Prefer explicit, valid failure record.
    if (result.failure) {
      const checked = validateFailureReason(result.failure);
      if (checked.ok) {
        return augmentWithOperation(result.failure, op);
      }
      // Invalid explicit failure — fall through to legacy normalization.
    }

    const legacyCode = typeof result.code === 'string' ? result.code : '';
    let canonicalCode = '';
    const mapEntry = LEGACY_CODE_MAP[legacyCode];
    if (mapEntry instanceof Function) {
      canonicalCode = mapEntry(result);
    } else if (typeof mapEntry === 'string') {
      canonicalCode = mapEntry;
    } else if (legacyCode && FAILURE_CODE_CATALOG[legacyCode]) {
      // Already a canonical code.
      canonicalCode = legacyCode;
    } else {
      canonicalCode = 'unknown_legacy_failure';
    }

    const catalog = FAILURE_CODE_CATALOG[canonicalCode] || FAILURE_CODE_CATALOG.unknown_legacy_failure;
    const legacyReason = typeof result.reason === 'string' ? result.reason : undefined;
    const failure = {
      code: canonicalCode,
      stage: catalog.stage,
      severity: catalog.severity,
      userMessage: legacyReason || catalog.fallbackUserMessage,
      retryable: catalog.defaultRetryable,
      nextAction: catalog.fallbackNextAction,
      evidence: {}
    };
    if (legacyReason) {
      failure.technicalMessage = legacyReason;
    }
    if (result.evidence && typeof result.evidence === 'object') {
      Object.assign(failure.evidence, result.evidence);
    }
    if (legacyCode) {
      failure.evidence.originalCode = legacyCode;
    }
    if (legacyReason) {
      failure.evidence.originalReason = legacyReason;
    }
    // Strip undefined evidence keys.
    for (const k of Object.keys(failure.evidence)) {
      if (failure.evidence[k] === undefined) delete failure.evidence[k];
    }
    return augmentWithOperation(failure, op);
  }

  function augmentWithOperation(failure, op) {
    const out = Object.assign({}, failure);
    if (op && op.path && !out.file) out.file = op.path;
    if (op && op.type && !out.operationType) out.operationType = op.type;
    return out;
  }

  function buildFallbackFailureReason(code, op) {
    const catalog = FAILURE_CODE_CATALOG[code] || FAILURE_CODE_CATALOG.unknown_legacy_failure;
    return augmentWithOperation({
      code: catalog === FAILURE_CODE_CATALOG[code] ? code : 'unknown_legacy_failure',
      stage: catalog.stage,
      severity: catalog.severity,
      userMessage: catalog.fallbackUserMessage,
      retryable: catalog.defaultRetryable,
      nextAction: catalog.fallbackNextAction,
      evidence: {}
    }, op || {});
  }

  /**
   * Severity ranking used by `selectPrimaryFailure`. Lower index = higher priority.
   * Source: design spec §12.
   */
  const SEVERITY_ORDER = { blocked: 0, error: 1, warning: 2, info: 3 };

  /**
   * Stage tie-breaker order used by `selectPrimaryFailure` when two failures
   * share severity. Source: design spec §12 — infrastructure first, then
   * user-controlled blockers, then pipeline order, then auxiliary stages.
   * @type {string[]}
   */
  const STAGE_TIE_BREAKER_ORDER = [
    'native', 'navigation', 'preflight', 'write', 'verify',
    'reviewing', 'accept', 'undo', 'storage', 'codex', 'context', 'unknown'
  ];

  /**
   * Pick the run-level primary failure from a list of per-operation FailureReason
   * records. Orders first by severity (`blocked > error > warning > info`),
   * then by stage tie-breaker per §12.
   * @param {Array<{ stage?: string, severity?: string }>} failures
   * @returns {object | null}
   */
  function selectPrimaryFailure(failures) {
    if (!Array.isArray(failures) || failures.length === 0) {
      return null;
    }
    const ranked = failures.slice().sort(function compareFailures(a, b) {
      const sevA = SEVERITY_ORDER[a && a.severity] !== undefined ? SEVERITY_ORDER[a.severity] : 99;
      const sevB = SEVERITY_ORDER[b && b.severity] !== undefined ? SEVERITY_ORDER[b.severity] : 99;
      if (sevA !== sevB) return sevA - sevB;
      const stageA = STAGE_TIE_BREAKER_ORDER.indexOf((a && a.stage) || '');
      const stageB = STAGE_TIE_BREAKER_ORDER.indexOf((b && b.stage) || '');
      const normalizedA = stageA < 0 ? STAGE_TIE_BREAKER_ORDER.length : stageA;
      const normalizedB = stageB < 0 ? STAGE_TIE_BREAKER_ORDER.length : stageB;
      return normalizedA - normalizedB;
    });
    return ranked[0];
  }

  /**
   * Render the localized user message + next action for a FailureReason. Looks up
   * `failureReason_<code>_user` and `failureReason_<code>_next` through the supplied
   * `i18nLookup(key)` accessor; falls back to the failure's own `userMessage` /
   * `nextAction` (which already come from the §9 catalog) when the lookup misses.
   * Interpolates `{file}`, `{activeFile}`, `{operationType}` from the failure record.
   *
   * @param {{ code: string, userMessage?: string, nextAction?: string, file?: string, activeFile?: string, operationType?: string }} failure
   * @param {string} locale - Caller passes the active locale; reserved for future locale-aware fallback logic.
   * @param {(key: string) => (string | undefined)} i18nLookup
   * @returns {{ userMessage: string, nextAction: string | undefined }}
   */
  function localizeFailureReason(failure, locale, i18nLookup) {
    void locale;
    const lookup = i18nLookup instanceof Function ? i18nLookup : function noopLookup() { return undefined; };
    const code = failure && typeof failure.code === 'string' ? failure.code : '';
    const userTemplate = code ? lookup('failureReason_' + code + '_user') : undefined;
    const nextTemplate = code ? lookup('failureReason_' + code + '_next') : undefined;
    const userMessage = userTemplate
      ? interpolateFailureTemplate(userTemplate, failure)
      : (failure && failure.userMessage) || '';
    const nextAction = nextTemplate
      ? interpolateFailureTemplate(nextTemplate, failure)
      : (failure && failure.nextAction) || undefined;
    return { userMessage, nextAction };
  }

  function interpolateFailureTemplate(template, failure) {
    const file = failure && failure.file ? String(failure.file) : '';
    const activeFile = failure && failure.activeFile ? String(failure.activeFile) : '';
    const operationType = failure && failure.operationType ? String(failure.operationType) : '';
    return String(template)
      .replace(/\{file\}/g, file)
      .replace(/\{activeFile\}/g, activeFile)
      .replace(/\{operationType\}/g, operationType);
  }

  return {
    FAILURE_STAGES,
    FAILURE_SEVERITIES,
    TERMINAL_STATES,
    ALLOWED_SEVERITY_PER_TERMINAL,
    FAILURE_CODE_CATALOG,
    LEGACY_CODE_MAP,
    SEVERITY_ORDER,
    STAGE_TIE_BREAKER_ORDER,
    validateFailureReason,
    normalizeFailureReason,
    selectPrimaryFailure,
    localizeFailureReason
  };
});
