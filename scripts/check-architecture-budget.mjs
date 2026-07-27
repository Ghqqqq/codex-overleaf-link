#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Freeze-line ceilings for the large production files that don't yet have a
// proper "target" split — the rule is "must not grow further from here". The
// number is `current size + ~1%` so a true freeze; future growth requires
// raising the ceiling (which makes the growth deliberate + visible in diff).
// Files marked "split target" have an explicit lower aspirational ceiling
// (`maxLines`) the codebase should converge to; today they're frozen at
// `current + headroom` until the split lands.
export const ARCHITECTURE_FILE_BUDGETS = Object.freeze([
  {
    path: 'extension/src/contentScript.js',
    maxLines: 4500
  },
  {
    // v1.9.12 moved save-state detection into page/saveState.js and locks the
    // orchestration shell below 2000 lines.
    path: 'extension/src/pageBridge.js',
    maxLines: 2000
  },
  {
    path: 'extension/src/page/saveState.js',
    maxLines: 350
  },
  {
    // Elephant. 12341 lines is unhealthy but a real split needs its own
    // multi-week refactor (panel renderer, run controller, settings, skills,
    // recent-projects, writeback orchestration are all interleaved here).
    // Bumped 12300 → 12400 (v1.3.9 cancel), 12400 → 12600 (v1.3.10 timeline),
    // 12600 → 12700 (v1.4.2 theme), 12700 → 12780 (v1.4.3 diagnostics run-all),
    // 12780 → 12850 (v1.4.4 session management). The split (task #69) is now
    // underway and the ceiling LOWERS with each phase to lock the gain:
    // v1.4.5 carved the markdown/assistant-text renderer + the diagnostics
    // controller (12850 → 11850); v1.4.6 carved the run-timeline render
    // pipeline (11850 → 11000); v1.4.7 carved session management + the
    // apply-result formatters (11000 → 10450); v1.4.8 carved the model picker
    // + the recent-projects dashboard (10450 → 9600); v1.4.9 carved the OT
    // warm-mirror glue (9600 → 8800). The split stops here: what remains is
    // the genuinely cohesive run-orchestration core.
    // + the recent-projects dashboard.
    // 8800 -> 8850 in v1.5.1: the hotfix moved the module-composition wiring
    // above its consumers and documents the hoisted-safe zone (+13 lines).
    // v1.6.3 phase 6 carved the sync-writeback orchestration into
    // writebackOrchestrator.js (8850 -> 8330, gain locked). 8330 -> 8380 in
    // v1.6.4 for the UI-polish pack (attach input wiring, composer autogrow +
    // send availability, destructive-confirm focus safety, Esc dismissals,
    // native-missing badge copy). 8380 -> 8560 in v1.7.0 for the @ file
    // autocomplete cluster + the first-run setup prompt; the @ cluster
    // (getAtFileTrigger/renderAtFileMenu/applyAtFileSelection, ~130 lines) is
    // a candidate for a future composer-menu carve. 8560 -> 8900 in v1.7.5
    // for the journey pack: recovery-action handlers (retry refill, open
    // file, storage settings), the history & storage settings card, the
    // change-history read path, cross-tab hints, and the mirror barriers.
    // The recovery/history cluster (~300 lines) is the next carve candidate.
    // Phase 8 (v1.8.0): the recovery-action handlers, change-history read
    // path, history & storage card, and compaction notice moved to
    // panelMaintenance.js. 8900 -> 8750.
    // v1.8.0 B3 raised 8750 -> 8830: history-row jump, per-file undo
    // selection wiring, and composer-attachment refresh persistence.
    // v1.8.1 raised 8830 -> 8900: dashboard shell mount, debounced dashboard
    // refresh with interaction preservation, and the in-run activity bump.
    // v1.9.12 moved project-scoped settings, governance, skill toggles and
    // theme coordination into projectSettingsCoordinator.js.
    // v2.1.6 extracted provider selection, guidance lifecycle, and session
    // persistence (8858 -> 8717). 8720 freezes the remaining orchestration
    // wiring without forcing another artificial split.
    path: 'extension/src/content/contentRuntime.js',
    maxLines: 8000
  },
  {
    path: 'extension/src/content/pageBridgeClient.js',
    maxLines: 260
  },
  {
    path: 'extension/src/content/nativeCompatibilityController.js',
    maxLines: 360
  },
  {
    path: 'extension/src/content/projectSettingsCoordinator.js',
    maxLines: 420
  },
  {
    path: 'extension/src/content/projectProviderSelection.js',
    maxLines: 120
  },
  {
    path: 'extension/src/content/sessionPersistence.js',
    maxLines: 140
  },
  {
    path: 'extension/src/content/runGuidanceController.js',
    maxLines: 120
  },
  {
    path: 'extension/src/content/sessionMenuView.js',
    maxLines: 280
  },
  {
    // Carved from contentRuntime in v1.8.0 (phase 8): recovery handlers +
    // change-history + storage card + compaction notice.
    // v1.8.0 B3 raised 300 -> 420: the change-history entry/jump rows and
    // the per-file undo selection overlay live here.
    path: 'extension/src/content/panelMaintenance.js',
    maxLines: 420
  },
  {
    // Carved from contentRuntime in v1.4.5: markdown/inline rendering, the
    // assistant-visible sanitizers, and line-reference resolution/buttons.
    path: 'extension/src/content/markdownText.js',
    maxLines: 700
  },
  {
    // Bounded markdown-it token-to-DOM adapter. Parsing and structural
    // rendering stay isolated from runtime orchestration and sanitization.
    path: 'extension/src/content/markdownDomRenderer.js',
    maxLines: 600
  },
  {
    // Carved from contentRuntime in v1.4.5: the diagnostics check runners
    // (inspect*) and result formatters behind the diagnostics menu.
    path: 'extension/src/content/diagnosticsController.js',
    maxLines: 700
  },
  {
    // Carved from contentRuntime in v1.4.6: the run-timeline render pipeline
    // (scroll engine, run cards, stream events, completion report, run-card
    // Undo/Accept controls). Raised 950 -> 1080 in v1.7.5 for the
    // recovery-action registry (per-failure-code buttons), the compile-fix /
    // rejected-redo report actions, and the jump-to-turn navigator.
    // v1.8.0 B3 raised 1080 -> 1160 for the in-session run search.
    path: 'extension/src/content/runTimelineView.js',
    maxLines: 1160
  },
  {
    // Carved from contentRuntime in v1.4.7: the session lifecycle + list
    // surface (create/switch/rename/delete, header bar, running guards).
    // Raised 400 -> 460 in v1.5.0 for the header session dropdown switcher;
    // 460 -> 490 in v1.7.5 for the eviction-consent and running-run switch
    // confirms.
    path: 'extension/src/content/sessionManager.js',
    maxLines: 320
  },
  {
    // Carved from contentRuntime in v1.4.7: apply-result / failure-reason
    // formatters (skipped details, bilingual apply/bridge reasons).
    path: 'extension/src/content/applyResultFormatters.js',
    maxLines: 450
  },
  {
    // Carved from contentRuntime in v1.4.8: model/reasoning/speed catalog,
    // discovery, selects, and the config popover.
    path: 'extension/src/content/modelPicker.js',
    maxLines: 550
  },
  {
    // Carved from contentRuntime in v1.4.8: the cross-project recent-projects
    // dashboard (name cache, welcome/empty/degraded states, row rendering).
    // Raised 520 -> 800 in v1.5.2 for per-project session management (expand
    // row to list/rename/delete sessions without entering the project).
    // 800 -> 880 in v1.5.3: cleanup action for dead (invalid-projectId) rows.
    // v1.8.1 raised 880 -> 1080 for the dashboard-trust pack: zombie-run
    // settling, dashboard shell, degraded retry, session activate-and-open,
    // relative-time ticker, and the stats/count surfaces.
    path: 'extension/src/content/recentProjects.js',
    maxLines: 1080
  },
  {
    // Carved from contentRuntime in v1.4.9: the experimental OT warm-mirror
    // glue (toggle flow, poll/flush timers, prefetch, warm-start, status).
    path: 'extension/src/content/otWarmMirror.js',
    maxLines: 1000
  },
  {
    // Carved from contentRuntime in v1.6.3 (phase 6): the sync-writeback
    // orchestration (applySyncChangesToOverleaf + post-write verify/mirror/
    // compile pipeline). Raised 800 -> 820 in v1.7.5 for the backgrounded
    // mirror refresh (pendingMirrorRefresh) and the skipped-failure
    // promotion that feeds the recovery-action registry.
    // v1.8.0 B2 raised 820 -> 880 for the in-place mirror confirm path.
    // The settlement evidence handoff adds one cohesive return contract while
    // keeping terminal policy in WritebackSettlement: 880 -> 920.
    path: 'extension/src/content/writebackOrchestrator.js',
    maxLines: 920
  },
  {
    path: 'extension/src/content/runSettlementPersistence.js',
    maxLines: 80
  },
  {
    // Content-side adapter over the shared scoped transaction policy.
    path: 'extension/src/content/scopedPersistenceCoordinator.js',
    maxLines: 140
  },
  {
    path: 'extension/src/shared/runExecutionSnapshotCodec.js',
    maxLines: 190
  },
  {
    path: 'extension/src/shared/runExecutionSnapshot.js',
    maxLines: 260
  },
  {
    path: 'extension/src/shared/settlementFacts.js',
    maxLines: 360
  },
  {
    path: 'extension/src/shared/writebackEvidenceProjection.js',
    maxLines: 220
  },
  {
    path: 'extension/src/shared/writebackSettlement.js',
    maxLines: 760
  },
  {
    path: 'extension/src/shared/scopedPersistenceQueuePolicy.js',
    maxLines: 210
  },
  {
    path: 'extension/src/shared/scopedPersistenceBrowserAdapter.js',
    maxLines: 180
  },
  {
    // Owns account/project/generation-scoped hydration and monotonic commits.
    path: 'extension/src/shared/scopedPersistenceTransaction.js',
    maxLines: 250
  },
  {
    // Declarative Page RPC metadata consumed by caller and dispatcher.
    path: 'extension/src/shared/pageRpcContract.js',
    maxLines: 160
  },
  {
    // Canonical managed-update phases, progress, deadlines, and recovery.
    path: 'extension/src/shared/managedUpdateProjection.js',
    maxLines: 340
  },
  {
    // Writeback router: large but cohesive. v1.3.9 added the cross-world
    // cancel racer + per-op race wrapping (~80 lines). 3300 -> 3400 in
    // v1.6.3: deliberate headroom so bugfixes are not squeezed (was 8 lines
    // from the ceiling). The real relief is the phase-7 split target: the
    // tracked-changes lifecycle cluster (accept/rejectTrackedChanges + the
    // accept-replay/no-trace-undo helpers, ~1100 lines) is a cohesive carve
    // candidate that deserves its own dedicated, test-locked phase.
    // Phase 7 (v1.8.0, #117): the tracked-changes lifecycle (~1500 lines)
    // moved to trackedChangesLifecycle.js; the router keeps applyOperations,
    // the write pipeline, and the failure catalog. 3400 -> 1950.
    path: 'extension/src/page/writebackRouter.js',
    maxLines: 1950
  },
  {
    // Carved from writebackRouter in v1.8.0 (phase 7, #117): accept/reject
    // tracked-changes flows, accept-replay + editor-undo recovery, blocked
    // -result builders, and the tracked-change DOM collectors.
    path: 'extension/src/page/trackedChangesLifecycle.js',
    maxLines: 1650
  },
  {
    path: 'extension/src/page/treeOperations.js',
    maxLines: 1650
  },
  {
    path: 'extension/src/shared/storageDb.js',
    maxLines: 1360
  },
  {
    // Single Native transport entry point over framing, quotas, and reduction.
    path: 'native-host/src/nativeTransportEnvelope.js',
    maxLines: 180
  },
  {
    path: 'native-host/src/codexSessionRunner.js',
    maxLines: 1500
  },
  {
    // v1.6: parallel-subagents broker (file job queue, worker pool, wave
    // ownership attribution). 620 -> 640 in v1.6.2 for the liveness hardening
    // (queued-job settle on stop, bounded final settle, fillSlots start guard,
    // drain partial-edit withholding, grace-timer cleanup).
    path: 'native-host/src/subagentBroker.js',
    maxLines: 640
  },
  {
    path: 'native-host/src/taskRunner.js',
    maxLines: 1000
  },
  {
    path: 'native-host/src/taskRunnerRuntime.js',
    maxLines: 1350
  }
]);

export function collectArchitectureBudgetResults(options = {}) {
  const rootDir = path.resolve(options.rootDir || getRepoRoot());
  return ARCHITECTURE_FILE_BUDGETS.map(budget => {
    const fullPath = path.join(rootDir, budget.path);
    const lineCount = fs.existsSync(fullPath) ? countLines(fs.readFileSync(fullPath, 'utf8')) : 0;
    const ceiling = budget.maxLines;
    return {
      path: budget.path,
      lineCount,
      maxLines: budget.maxLines,
      ceiling,
      ok: lineCount > 0 && lineCount <= ceiling,
      targetMet: lineCount > 0 && lineCount <= budget.maxLines
    };
  });
}

export function collectArchitectureBudgetErrors(options = {}) {
  const results = collectArchitectureBudgetResults(options);
  return results
    .filter(result => !result.ok)
    .map(result => {
      if (result.lineCount <= 0) {
        return `${result.path} must exist for architecture budget checks.`;
      }
      return `${result.path} has ${result.lineCount} lines; limit is ${result.ceiling}.`;
    });
}

function countLines(text) {
  if (!text) {
    return 0;
  }
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function getRepoRoot() {
  const __filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(__filename), '..');
}

function runCli() {
  const results = collectArchitectureBudgetResults();
  for (const result of results) {
    const status = result.ok ? 'ok' : 'fail';
    console.log(`${status}\ttarget\t${result.lineCount}/${result.ceiling}\t${result.path}`);
  }
  const errors = collectArchitectureBudgetErrors();
  if (errors.length) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
