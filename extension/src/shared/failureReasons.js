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
    selection_scope_violation: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'A generated change exceeded the attached selection and was blocked.',
      fallbackNextAction: 'Select the intended region again and request only changes within it. Valid written parts can be undone.'
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
    file_plan_confirmation_rejected: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'The complete file plan was cancelled; no part was applied.',
      fallbackNextAction: 'Review the intended changes and start a new run if you want to apply them.'
    },
    file_tree_controls_unavailable: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'Codex could not safely perform this file operation with the available Overleaf controls.',
      fallbackNextAction: 'Check the file operation in Overleaf before starting a new task.'
    },
    delete_confirmation_missing: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'A destructive delete was not confirmed.',
      fallbackNextAction: 'Confirm the delete explicitly if intended.'
    },
    delete_confirmation_rejected: {
      stage: 'preflight', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'The deletion was cancelled and was not applied. Other allowed changes in this run may still proceed.',
      fallbackNextAction: 'Review the other changes. If deletion is still intended, request it in a new task.'
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
    snapshot_undo_current_mismatch: {
      stage: 'undo', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'The current content or document identity does not match this run\'s undo checkpoint. Codex stopped Undo and kept the recovery data.',
      fallbackNextAction: 'Inspect the file and any later edits before trying Undo again.'
    },
    snapshot_undo_open_failed: {
      stage: 'undo', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not open the file to restore its saved checkpoint.',
      fallbackNextAction: 'Open the file in Overleaf, wait for it to load, then retry Undo.'
    },
    snapshot_undo_unavailable: {
      stage: 'undo', severity: 'blocked', defaultRetryable: false,
      fallbackUserMessage: 'The saved checkpoint is unavailable for this Undo. Codex kept the remaining recovery data.',
      fallbackNextAction: 'Inspect the file and the run details before continuing.'
    },
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

  // Display projection only: these aliases and exact historical templates do
  // not enter the canonical catalog, persistence, retry or recovery decisions.
  const REVIEW_DISPLAY_CODES = new Set([
    'missing_tracked_changes', 'tracked_change_file_open_failed', 'tracked_change_reject_control_not_found',
    'tracked_change_reject_not_confirmed', 'tracked_change_accept_control_not_found', 'tracked_change_accept_not_confirmed',
    'tracked_change_editor_undo_open_failed', 'tracked_change_editor_undo_current_mismatch', 'editor_undo_control_not_found',
    'editor_undo_no_progress', 'editor_undo_max_iterations', 'tracked_change_undo_max_iterations',
    'tracked_change_undo_verify_open_failed', 'tracked_change_undo_verify_failed', 'accept_missing_run_content',
    'accept_editor_undo_unavailable', 'accept_editing_not_confirmed', 'accept_editing_not_stable',
    'accept_replay_rollback_missing_content', 'review_scope_unavailable', 'review_request_unverified',
    'review_owner_disconnected', 'review_deadline_exceeded', 'review_cancelled',
    'review_project_changed', 'tracked_change_not_found', 'snapshot_undo_current_mismatch',
    'snapshot_undo_open_failed', 'snapshot_undo_unavailable', 'file_tree_controls_unavailable'
  ]);
  const REVIEW_DISPLAY_TEMPLATES = [
    ["missing_tracked_changes", "这轮写入没有可识别的 Overleaf 留痕记录；为避免制造新的红线，Codex 没有执行文本补丁撤销。"],
    ["missing_tracked_changes", "No matching Overleaf tracked-change records were found for this run, so Codex did not undo with text patches."],
    ["missing_tracked_changes", "No matching Overleaf tracked-change records were found for this run. Codex did not undo with text patches."],
    ["missing_tracked_changes", "这轮写入没有可识别的 Overleaf 留痕记录；Codex 没有执行文本补丁撤销。"],
    ["tracked_change_file_open_failed", "无法打开 {file} 来查找这轮写入的留痕记录；Codex 没有用文本补丁伪撤销。"],
    ["tracked_change_file_open_failed", "无法打开 {file} 来继续拒绝这轮留痕记录；请在 Overleaf 审阅面板手动处理。"],
    ["tracked_change_file_open_failed", "Could not open {file} to find this run's tracked changes. Handle them manually in the Overleaf review tools."],
    ["tracked_change_file_open_failed", "Could not open the file to find this run's tracked changes. Handle them manually in the Overleaf review tools."],
    ["tracked_change_file_open_failed", "Could not open the file to find this run's tracked changes. Check it in the Overleaf review panel."],
    ["tracked_change_file_open_failed", "无法打开文件来查找这轮写入的留痕记录；请在 Overleaf 审阅面板检查。"],
    ["tracked_change_reject_control_not_found", "找到了这轮写入的留痕记录，但没有找到对应的 Reject/拒绝按钮；Codex 没有用文本补丁伪撤销。"],
    ["tracked_change_reject_control_not_found", "还有 {file} 的留痕记录未处理，但没有找到对应的 Reject/拒绝按钮；请在 Overleaf 审阅面板手动拒绝。"],
    ["tracked_change_reject_control_not_found", "Some tracked changes in {file} remain, but the matching Reject button was not found. Reject them manually in Overleaf."],
    ["tracked_change_reject_control_not_found", "Some tracked changes remain, but the matching Reject button was not found. Reject them manually in Overleaf."],
    ["tracked_change_reject_control_not_found", "Some tracked changes remain, but the matching Reject button was not found. Check them in the Overleaf review panel."],
    ["tracked_change_reject_control_not_found", "仍有留痕记录未处理，但未找到对应的拒绝按钮；请在 Overleaf 审阅面板检查。"],
    ["tracked_change_reject_not_confirmed", "Codex 点击了 Reject/拒绝，但 Overleaf 页面仍显示这条留痕记录；请在 Overleaf 审阅面板手动拒绝。"],
    ["tracked_change_reject_not_confirmed", "Codex clicked Reject, but Overleaf still shows this tracked change. Reject it manually in the Overleaf review panel."],
    ["tracked_change_reject_not_confirmed", "Codex clicked Reject, but Overleaf still shows this tracked change. Check it in the Overleaf review panel."],
    ["tracked_change_reject_not_confirmed", "Codex 已点击拒绝，但 Overleaf 仍显示该留痕记录；请在审阅面板检查。"],
    ["tracked_change_accept_control_not_found", "Some tracked changes in {file} remain, but the matching Accept button was not found. Accept them manually in Overleaf."],
    ["tracked_change_accept_control_not_found", "Some tracked changes remain, but the matching Accept button was not found. Accept them manually in Overleaf."],
    ["tracked_change_accept_control_not_found", "Some tracked changes remain, but the matching Accept button was not found. Check them in the Overleaf review panel."],
    ["tracked_change_accept_control_not_found", "仍有留痕记录未处理，但未找到对应的接受按钮；请在 Overleaf 审阅面板检查。"],
    ["tracked_change_accept_not_confirmed", "Codex clicked Accept, but Overleaf still shows this tracked change. Accept it manually in the Overleaf review panel."],
    ["tracked_change_accept_not_confirmed", "Codex clicked Accept, but Overleaf still shows this tracked change. Check it in the Overleaf review panel."],
    ["tracked_change_accept_not_confirmed", "Codex 已点击接受，但 Overleaf 仍显示该留痕记录；请在审阅面板检查。"],
    ["tracked_change_editor_undo_open_failed", "无法打开 {file} 来执行 Overleaf 原生撤销。"],
    ["tracked_change_editor_undo_open_failed", "Could not open {file} for Overleaf native undo."],
    ["tracked_change_editor_undo_open_failed", "Could not open the file for Overleaf native undo."],
    ["tracked_change_editor_undo_open_failed", "Could not open the file for Overleaf native Undo."],
    ["tracked_change_editor_undo_open_failed", "无法打开文件来执行 Overleaf 原生撤销。"],
    ["tracked_change_editor_undo_current_mismatch", "{file} 当前内容已经不是本轮写入后的内容；为避免撤掉你的后续修改，Codex 不使用 Overleaf 原生撤销。"],
    ["tracked_change_editor_undo_current_mismatch", "{file} no longer matches this run's written content, so Codex did not use Overleaf native undo."],
    ["tracked_change_editor_undo_current_mismatch", "The current content no longer matches this run's written content, so Codex did not use Overleaf native undo."],
    ["tracked_change_editor_undo_current_mismatch", "The current content no longer matches this run's written content. Codex stopped native Undo to preserve later edits."],
    ["tracked_change_editor_undo_current_mismatch", "当前内容与本轮写入后的内容不一致；Codex 已停止原生撤销，以保留后续编辑。"],
    ["editor_undo_control_not_found", "没有找到 Overleaf 编辑器自己的 Undo/撤销按钮，无法一次性撤销 {file} 的本轮留痕。"],
    ["editor_undo_control_not_found", "Could not find Overleaf's editor Undo button to undo this run in {file}."],
    ["editor_undo_control_not_found", "Could not find Overleaf's editor Undo button to undo this run."],
    ["editor_undo_control_not_found", "未找到 Overleaf 编辑器的撤销按钮，无法撤销本轮改动。"],
    ["editor_undo_no_progress", "Codex 点击了 Overleaf Undo/撤销，但 {file} 内容没有变化。"],
    ["editor_undo_no_progress", "Codex clicked Overleaf Undo, but {file} did not change."],
    ["editor_undo_no_progress", "Codex clicked Overleaf Undo, but the file did not change."],
    ["editor_undo_no_progress", "Codex 已点击 Overleaf 撤销，但文件内容没有变化。"],
    ["editor_undo_max_iterations", "{file} 经过多次 Overleaf 原生撤销后仍未回到本轮写入前内容，已停止以避免撤销其它修改。"],
    ["editor_undo_max_iterations", "{file} did not return to its pre-run content after repeated Overleaf native undo steps. Codex stopped to avoid undoing other edits."],
    ["editor_undo_max_iterations", "The file did not return to its pre-run content after repeated Overleaf native undo steps. Codex stopped to avoid undoing other edits."],
    ["editor_undo_max_iterations", "The file did not return to its pre-run content after repeated native Undo steps. Codex stopped to avoid undoing other edits."],
    ["editor_undo_max_iterations", "经过多次原生撤销后，文件仍未恢复到本轮写入前的内容；Codex 已停止，以免撤销其他编辑。"],
    ["tracked_change_undo_max_iterations", "{file} 仍有未完成的留痕记录；Codex 已停止以避免误拒绝其它改动。"],
    ["tracked_change_undo_max_iterations", "{file} still has tracked changes after the reject sweep, so Codex stopped to avoid mis-rejecting other edits."],
    ["tracked_change_undo_max_iterations", "{file} still has tracked changes after the per-expected-file reject sweep, so Codex stopped to avoid mis-rejecting other edits."],
    ["tracked_change_undo_max_iterations", "{file} still has tracked changes left. Codex stopped to avoid rejecting unrelated edits."],
    ["tracked_change_undo_max_iterations", "Tracked changes are still left. Codex stopped to avoid rejecting unrelated edits."],
    ["tracked_change_undo_max_iterations", "仍有未处理的留痕记录；Codex 已停止，以免误拒绝其他编辑。"],
    ["tracked_change_undo_verify_open_failed", "撤销后无法打开 {file} 验证内容；请刷新 Overleaf 后检查。"],
    ["tracked_change_undo_verify_open_failed", "Could not open {file} after undo to verify content. Reload Overleaf and check manually."],
    ["tracked_change_undo_verify_open_failed", "Could not open the file after undo to verify content. Reload Overleaf and check manually."],
    ["tracked_change_undo_verify_open_failed", "Could not open the file after Undo to verify its content. Reload Overleaf and check it."],
    ["tracked_change_undo_verify_open_failed", "撤销后无法打开文件验证内容；请刷新 Overleaf 后检查。"],
    ["tracked_change_undo_verify_failed", "{file} 拒绝留痕后内容没有回到写入前状态；请在 Overleaf 审阅面板检查这轮修改。"],
    ["tracked_change_undo_verify_failed", "{file} did not return to its pre-run content after rejecting tracked changes. Check this run's changes in the Overleaf review panel."],
    ["tracked_change_undo_verify_failed", "The file did not return to its pre-run content after rejecting tracked changes. Check this run's changes in the Overleaf review panel."],
    ["tracked_change_undo_verify_failed", "拒绝留痕后，文件内容仍未恢复到写入前状态；请在 Overleaf 审阅面板检查本轮修改。"],
    ["accept_missing_run_content", "这轮写入没有可识别的写入前/写入后内容；Codex 没有把留痕改动接受为永久文本。"],
    ["accept_missing_run_content", "{file} 缺少写入前/写入后内容；Codex 没有重放本轮改动。"],
    ["accept_missing_run_content", "The pre-write or post-write content is unavailable. Codex did not replay or accept the tracked changes."],
    ["accept_missing_run_content", "缺少写入前或写入后的内容；Codex 未重放或接受留痕改动。"],
    ["accept_editor_undo_unavailable", "没有可执行的 Overleaf 原生撤销或安全快照回滚来清掉本轮留痕；Codex 没有接受这轮改动。"],
    ["accept_editor_undo_unavailable", "Native Undo and a safe checkpoint rollback are unavailable. Codex did not accept this run."],
    ["accept_editor_undo_unavailable", "原生撤销及安全的检查点回滚均不可用；Codex 未接受本轮改动。"],
    ["accept_editing_not_confirmed", "无法确认 Overleaf 已切换到 Editing 模式；Codex 没有把本轮改动重写为永久文本。"],
    ["accept_editing_not_confirmed", "切换后仍未能确认 Overleaf 处于 Editing 模式；为避免重写又留下留痕，Codex 没有重放本轮改动。"],
    ["accept_editing_not_confirmed", "本次操作前未能确认 Overleaf 处于 Editing 模式；为避免重写又留下留痕，Codex 没有继续重放本轮剩余改动。"],
    ["accept_editing_not_confirmed", "Codex could not re-confirm Editing mode before replaying {file}; Codex stopped to avoid landing a tracked write."],
    ["accept_editing_not_confirmed", "Codex could not confirm Editing mode for the untracked Accept replay, so the run was not finalized."],
    ["accept_editing_not_confirmed", "Codex could not switch Overleaf to Editing mode for the untracked Accept replay, so the run was not finalized."],
    ["accept_editing_not_confirmed", "Codex toggled Overleaf to Editing, but the post-toggle state did not positively confirm Editing — Codex did not replay the run."],
    ["accept_editing_not_confirmed", "Codex could not confirm Overleaf Editing mode. It stopped replaying this run to avoid creating new tracked changes."],
    ["accept_editing_not_confirmed", "无法确认 Overleaf 已进入编辑模式；Codex 已停止重放本轮改动，以免产生新的留痕。"],
    ["accept_editing_not_stable", "Overleaf Editing mode did not remain stable long enough for an untracked Accept All replay; Codex did not replay this write."],
    ["accept_editing_not_stable", "Overleaf Editing mode did not remain stable long enough for an untracked Accept replay. Codex did not replay this write."],
    ["accept_editing_not_stable", "Overleaf 编辑模式未保持稳定，无法无留痕地重放接受的改动；Codex 未重放此次写入。"],
    ["accept_replay_rollback_missing_content", "Accept All detected fresh tracked changes, but could not roll back because the pre/post content was unavailable."],
    ["accept_replay_rollback_missing_content", "Accept created fresh tracked changes, but rollback could not run because the pre-write or post-write content was unavailable."],
    ["accept_replay_rollback_missing_content", "接受改动时产生了新的留痕，但缺少写入前或写入后的内容，无法回滚。"],
    ["review_scope_unavailable", "The native tracked-change scope could not be safely isolated. No review mutation was attempted. Use Overleaf Review to handle the changes individually."],
    ["review_scope_unavailable", "The native tracked-change scope could not be safely isolated. No review mutation was attempted. Check the changes individually in Overleaf Review."],
    ["review_scope_unavailable", "无法安全确认本轮原生留痕的范围；尚未尝试审阅写入。请在 Overleaf 审阅面板逐项检查。"],
    ["review_request_unverified", "The native review request could not be fully verified; some target changes may already be accepted. No text replay was attempted. Check Overleaf Review before retrying."],
    ["review_request_unverified", "原生审阅请求未能完全核实，部分目标改动可能已接受；未尝试文本重放。请先在 Overleaf 审阅面板检查，再决定是否重试。"],
    ["review_owner_disconnected", "The Undo owner disconnected; no further review writes were started."],
    ["review_owner_disconnected", "撤销操作的连接已断开；未再启动后续审阅写入。"],
    ["review_deadline_exceeded", "The review time budget expired; no further review writes were started."],
    ["review_deadline_exceeded", "The review time budget expired."],
    ["review_deadline_exceeded", "审阅操作已超时；未再启动后续审阅写入。"],
    ["review_cancelled", "The review was cancelled; no further review writes were started."],
    ["review_cancelled", "审阅操作已取消；未再启动后续审阅写入。"],
    ["review_project_changed", "The original review project is no longer active."],
    ["review_project_changed", "原审阅项目已不再处于活动状态。"],
    ["tracked_change_not_found", "没有在 Overleaf 页面里找到这轮写入对应的留痕记录；Codex 没有用文本补丁伪撤销。"],
    ["tracked_change_not_found", "No matching tracked changes were found on the Overleaf page for this run."],
    ["tracked_change_not_found", "No matching tracked changes were found on the Overleaf page for this run. Codex did not undo with text patches."],
    ["snapshot_undo_current_mismatch", "{file} 当前内容或文档身份与本轮撤销检查点不一致；Codex 保留恢复材料并停止撤销。"],
    ["snapshot_undo_current_mismatch", "{file} 当前内容已经不是本轮写入后的内容；为避免覆盖你的后续修改，Codex 不执行快照撤销。"],
    ["snapshot_undo_current_mismatch", "The current content or document identity does not match this run's undo checkpoint. Codex stopped Undo and kept the recovery data."],
    ["snapshot_undo_current_mismatch", "当前内容或文档身份与本轮撤销检查点不一致；Codex 已停止撤销并保留恢复材料。"],
    ["snapshot_undo_open_failed", "无法打开 {file} 来执行快照撤销。"],
    ["snapshot_undo_open_failed", "Codex could not open the file to restore its saved checkpoint."],
    ["snapshot_undo_open_failed", "Codex 无法打开文件来恢复已保存的检查点。"],
    ["snapshot_undo_unavailable", "The saved checkpoint is unavailable for this undo."],
    ["snapshot_undo_unavailable", "The saved checkpoint is unavailable for this Undo. Codex kept the remaining recovery data."],
    ["snapshot_undo_unavailable", "本次撤销所需的检查点不可用；Codex 已保留剩余恢复材料。"]
  ].sort((a, b) => Number(a[1].includes('{file}')) - Number(b[1].includes('{file}')))
    .map(([code, template]) => ({ code, template,
      pattern: new RegExp('^' + template.split('{file}').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)') + '$') }));

  function safeDisplayProjectPath(value) {
    if (typeof value !== 'string' || !value || value.length > 300 || /[\r\n]/.test(value)) return '';
    const path = value.replace(/\\/g, '/');
    return !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && !path.split('/').includes('..') ? path : '';
  }

  function recoverDisplayFailure(failure, allowFilePrefix = true) {
    if (!failure || typeof failure !== 'object') return failure;
    const originalCode = failure.evidence?.originalCode;
    const explicitCode = REVIEW_DISPLAY_CODES.has(originalCode) ? originalCode
      : REVIEW_DISPLAY_CODES.has(failure.code) ? failure.code : '';
    const message = String(failure.userMessage || '');
    for (const { code, pattern } of REVIEW_DISPLAY_TEMPLATES) {
      if (explicitCode && code !== explicitCode) continue;
      const match = pattern.exec(message);
      if (!match) continue;
      const captured = ['当前文件', 'The target file', 'the next file'].includes(match[1]) ? '' : match[1];
      if (captured && safeDisplayProjectPath(captured) !== captured) continue;
      return { ...failure, code, file: failure.file || captured || '' };
    }
    // Catalog defaults are also product-owned exact messages in older compact
    // records. Recover only a display code; their old retry semantics stay put.
    const catalogCode = Object.keys(FAILURE_CODE_CATALOG).find(code => code !== 'unknown_legacy_failure'
      && FAILURE_CODE_CATALOG[code].fallbackUserMessage === message);
    if (!explicitCode && catalogCode) return { ...failure, code: catalogCode };
    // Earlier formatters persisted "file: message". Only accept one safe file
    // prefix whose complete remaining body resolves to a known product message.
    const prefixed = allowFilePrefix && /^([^:\r\n]+): (.+)$/.exec(message);
    if (prefixed && safeDisplayProjectPath(prefixed[1]) === prefixed[1]) {
      const body = { ...failure, userMessage: prefixed[2], file: failure.file || prefixed[1] };
      const recovered = recoverDisplayFailure(body, false);
      if (recovered !== body && recovered.code !== 'unknown_legacy_failure') return recovered;
    }
    return explicitCode ? { ...failure, code: explicitCode } : failure;
  }

  // A single renderer prevents the Notice and expanded results from using
  // different code lists or emitting a dynamic filename twice.
  function formatFailureReasonForDisplay(failure, locale, i18nLookup) {
    const display = recoverDisplayFailure(failure);
    const lookup = typeof i18nLookup === 'function' ? i18nLookup : () => undefined;
    const key = display?.code ? 'failureReason_' + display.code + '_user' : '';
    const template = key ? lookup(key) : '';
    const file = safeDisplayProjectPath(display?.file);
    const localized = localizeFailureReason(display ? { ...display, file } : display, locale, lookup);
    const message = template?.includes('{file}') ? localized.userMessage
      : [file, localized.userMessage].filter(Boolean).join(': ');
    return { ...localized, message, file, localized: Boolean(template && template !== key) };
  }

  function localizeFailureMessage(message, locale, i18nLookup) {
    return formatFailureReasonForDisplay({ code: 'unknown_legacy_failure', userMessage: message }, locale, i18nLookup).message;
  }

  // Writeback consumers share catalog normalization, including file context,
  // while retaining the mutation evidence carried by older result envelopes.
  function normalizeWritebackFailure(result, operation) {
    if (!result || typeof result !== 'object' || (!result.failure && !result.code && result.ok !== false)) return null;
    const failure = normalizeFailureReason(result, operation);
    const explicit = result.failure && typeof result.failure === 'object' ? result.failure : {};
    const changedDocument = typeof explicit.changedDocument === 'boolean' ? explicit.changedDocument : result.changedDocument;
    if (typeof changedDocument === 'boolean') failure.changedDocument = changedDocument;
    if (explicit.mayHaveMutated === true || result.mayHaveMutated === true) failure.mayHaveMutated = true;
    const terminalState = explicit.terminalState || result.terminalState;
    if (ALLOWED_SEVERITY_PER_TERMINAL[terminalState]?.has(failure.severity)) failure.terminalState = terminalState;
    // An unrecognized transport code can still carry a valid write-stage hint.
    if (failure.code === 'unknown_legacy_failure') {
      const stage = explicit.stage || result.stage;
      if (FAILURE_STAGES.has(stage)) failure.stage = stage;
    }
    return failure;
  }

  function isUnconfirmedWriteFailure(failure) {
    if (!failure || typeof failure !== 'object') return false;
    return failure.terminalState === 'needs_review' || failure.mayHaveMutated === true
      || ['write_timeout', 'partial_write_needs_review', 'writeback_result_unconfirmed', 'write_result_missing'].includes(failure.code)
      || (failure.changedDocument === true && ['write', 'verify', 'undo', 'accept'].includes(failure.stage));
  }

  // A potentially changed document needs review before unrelated blockers can
  // offer a retry. Keep the generic severity/stage order within each group.
  function selectPrimaryWritebackFailure(failures) {
    if (!Array.isArray(failures)) return null;
    const review = failures.filter(isUnconfirmedWriteFailure);
    return selectPrimaryFailure(review.length ? review : failures);
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
    failure = recoverDisplayFailure(failure);
    const lookup = key => {
      const value = typeof i18nLookup === 'function' ? i18nLookup(key) : undefined;
      return value && value !== key ? value : undefined;
    };
    const code = failure && typeof failure.code === 'string' ? failure.code : '';
    const userTemplate = code ? lookup('failureReason_' + code + '_user') : undefined;
    const nextTemplate = (code ? lookup('failureReason_' + code + '_next') : undefined)
      || (REVIEW_DISPLAY_CODES.has(code) ? lookup('failureReason_review_detail_next') : undefined);
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
    normalizeWritebackFailure,
    isUnconfirmedWriteFailure,
    selectPrimaryWritebackFailure,
    selectPrimaryFailure,
    localizeFailureReason,
    formatFailureReasonForDisplay,
    localizeFailureMessage
  };
});
