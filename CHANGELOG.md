# Changelog

## v2.3.2 - 2026-08-06

### Added

- Added run-result copy and turn-level Session Fork actions with stable duplicate naming and durable Session cleanup.
- Added chunked binary-asset transfer from the Native Host to Overleaf so generated images and PDFs avoid Native Messaging frame limits.

### Fixed

- Restored tracked-change evidence across asset-aware writeback so Accept and Undo remain available after root and nested-file writes and after reload.
- Made nested-file navigation, delayed write verification, binary upload fallbacks, and run settlement preserve accurate applied and skipped evidence.
- Updated Page RPC contracts, release packaging coverage, large-project benchmarks, and VM integration harnesses for the binary upload transport.
- Split run-result actions from the timeline renderer to keep the content runtime within its architecture budget.

## v2.3.1 - 2026-08-02

### Changed

- Completed the first post-2.3 architecture stabilization pass with canonical run snapshots, scoped persistence receipts, and consolidated settlement projections while preserving the existing Ask, Auto, Track, Accept, and Undo workflows.
- Removed Suggest mode and its dormant paths so the product surface matches the maintained execution modes.
- Improved Markdown and LaTeX recovery for malformed display-math output, long formulas, and responsive panel rendering.

### Fixed

- Persist terminal run state before reload recovery so completed and cancelled runs retain their correct status.
- Strengthened writeback settlement, delayed verification, provider-state hydration, cancellation labels, and session deletion persistence.
- Cleared obsolete managed-update rollback journals from replaceable runtime code while preserving the immutable v2.3.0 bootstrap update boundary.

## v2.3.0 - 2026-07-31

### Changed

- Bundle the isolated-world Extension runtime from an explicit module graph into one generated content-script artifact, while leaving page-world scripts unbundled and preserving their existing load boundaries.
- Add generated provenance metadata, dependency-graph checks, hidden-global detection, and release-package verification for the bundled runtime.
- Keep a narrow legacy-global compatibility adapter while migrating runtime modules toward explicit dependency registration.
- Split runtime orchestration into explicit execution snapshot, writeback settlement, scoped persistence, Page RPC, managed update, and Native transport owners while preserving existing product behavior.
- Added a source-hygiene verification mode for pull requests while keeping release metadata checks strict on version tags.

### Fixed

- Make the provider dialog, Settings summary, model catalog, and run routing consistently describe the current project's provider, while surfacing failed Save-and-Use projection instead of leaving a misleading active state.
- Restore cross-project dashboard history reads by removing bundled dependency self-shadowing, and reject declaration self-assignment regressions during module-graph validation.
- Include the generated isolated-world content bundle and provenance metadata in Extension, npm, and coordinated-update release artifacts.
- Build the isolated-world content bundle during macOS/Linux and Windows source installation, and reject incomplete managed runtime trees before activation.
- Continue queued follow-ups after a directly submitted run completes or is manually cancelled, without incorrectly pausing the queue.
- Prevent stale cross-tab snapshots from overwriting a terminal run state.
- Preserve project scope while flushing terminal state after navigation and surface detached settlement persistence failures.
- Complete the paired session action after a scoped persistence fence has been written, preventing queue claim or removal half-commits.
- Preserve governance and confirmation skip evidence in zero-write completion reports so the final summary matches the run activity and next action.
- Stop injecting isolated-world governance rules into the page world, eliminating the module-registry initialization error on every Overleaf page load.
- Document the required dependency installation and content-bundle build steps for manual checkout installations.

## v2.2.1 - 2026-07-24

### Fixed

- Exclude changed root-level PDF build artifacts from binary writeback when a matching root TeX source exists, including case-insensitive filename matching, so locally compiled outputs no longer trigger asset confirmation.

## v2.2.0 - 2026-07-23

- Establish Bootstrap protocol 2 as the durable managed-update baseline; v2.1.x installations require one pinned managed reinstall.
- Harden update consent, ETag recovery, safe-point locking, staged archive verification, runtime health confirmation, rollback timeouts, and release publication recovery.
- Preserve concurrent Session deletions across multiple Overleaf tabs with per-session tombstones.

Release candidate focused on controllable long-running tasks and resilient managed updates.

### Added

- Added in-run follow-up guidance with a visible queue, immediate steering, removal controls, and automatic dispatch after the active task settles.
- Preserved partial run output and queued input state across interruption and storage compaction so a later `continue` retains useful context.
- Added managed-update boundary and previous-version hop verification to catch runtime files that cannot safely update in place.
- Added a bounded, inert Markdown DOM renderer for final answers, including headings, nested lists, tables, blockquotes, code blocks, links, and KaTeX-aware math flow.

### Fixed

- Restored inline KaTeX baseline flow without per-formula scroll artifacts, separated display equations from prose blocks, and made long equations responsive without shrinking their notation.
- Prevented display equations containing a standalone `=` line from being misclassified as Markdown Setext headings.
- Bundled Markdown and KaTeX runtime assets with verified managed-install font paths so local and packaged extension rendering stay aligned.
- Included the complete allowlisted Markdown renderer runtime in coordinated update bundles.
- Made update progress durable across Overleaf tabs, surfaced terminal update failures with a manual-install fallback, and prevented stale safe-point state from spinning indefinitely.
- Cleared sent composer attachments together with text while keeping queued attachments attached to their own pending input.
- Unified provider stream lifecycle handling across Chat Completions and Anthropic Messages: active output refreshes the idle deadline, protocol terminal events finish immediately, and interrupted partial reasoning receives at most two context-preserving continuation attempts.

## v2.1.5 - 2026-07-20

### Fixed

- Treat `@context` as the primary editing context when a complete project snapshot is available, while preserving focus-only writeback for partial and OT warm snapshots.
- Localize large-diff fallback summaries from the run locale and default missing locale metadata to English.

## v2.1.4 - 2026-07-20

### Fixed

- Localized Native Host fallback reports using the requested panel locale, with English as the safe default when locale metadata is absent.
- Standardized missing-locale behavior across transcript, session-history, and writeback formatters without changing model prompts or model-authored responses.
- Preserved each session's provider/model/reasoning/speed tuple through storage compaction and cleared stale provider models before explicit provider switches.
- Captured user-selected Fast speed before capability controls rerender, preventing the previous Standard value from immediately overriding it.

## v2.1.3 - 2026-07-19

### Fixed

- Made the Native Host pin one Codex executable identity per process and report its selected path, version, and source consistently.
- Added duplicate Codex installation detection with candidate versions to `doctor`, `bridge.ping`, and per-run technical events.
- Preserved existing `PATH` priority while making the selected runtime observable instead of silently routing between installations.

## v2.1.2 - 2026-07-19

### Fixed

- Bind Provider, model, reasoning, and speed selection to each Session so switching conversations restores the correct runtime endpoint.
- Route model discovery and runs through the Session's explicit Provider identity, with revision checks and fail-closed handling for deleted Providers.
- Discard stale model-catalog responses and persist sanitized Provider snapshots in run and audit history.

## v2.1.1 - 2026-07-18

Visual polish release for the experimental third-party Provider configuration experience.

### Changed

- Reworked the connection test area into a compact, themed dock with a dark model selector, clear hierarchy, and a restrained connection action.
- Preserved native select accessibility, keyboard behavior, cancellation behavior, and existing Provider test semantics while improving responsive layout and status feedback.

## v2.1.0 - 2026-07-17

Stable release adding experimental third-party model providers while preserving the built-in Codex path as the stable default and retaining the v2 writeback safety model.

### Added

- Added an experimental third-party provider dialog with profile-specific endpoints, models, credentials, reasoning controls, connection testing, and explicit activation from Settings.
- Added an experimental Native Host provider runtime with redacted profile storage, OpenAI-compatible Chat Completions and Responses bridging, Anthropic Messages support, provider-aware reasoning translation, model discovery, and Codex app-server launch integration.
- Added staged project-context loading with file-tree readiness feedback, warmed ZIP snapshots, cache reuse, and resilient snapshot fallbacks.
- Added model-scoped `Auto`, `Streaming`, and `Buffered` upstream response modes for Chat Completions providers.

### Fixed

- Added an independent `Use` action for saved, verified provider profiles, so any configured provider can be activated without editing or resaving it.
- Kept long provider names and status content inside the provider sidebar, with stable ellipsis and full-name hover disclosure.
- Activated a newly saved provider on its first use and kept model choices isolated between providers.
- Preserved Markdown block headings such as `## Education (main.tex:56-60)` in provider responses and rendered them consistently in run conclusions.
- Bypassed system proxies for the local provider bridge, preventing intermittent `502` failures when Codex connects to the loopback runtime.
- Restored prompt cancellation across long asynchronous run stages and kept Edit & resend usable after provider failures.
- Hardened custom-provider reasoning defaults and response normalization to avoid invalid DeepSeek requests and repeated streamed content.
- Let `Auto` connection tests retry through buffered upstream responses when a gateway cannot parse streamed tool calls, while preserving Responses SSE toward Codex.
- Detected leaked tool-call control tokens as an actionable provider compatibility failure without interpreting them as executable tools.
- Restored edits to files inside collapsed nested folders by attempting Overleaf's expand-and-open flow before classifying a target path as missing.
- Replaced oversized provider capability checkboxes with compact, accessible controls scoped correctly to the centered provider dialog.

### Changed

- Marked third-party provider integration as experimental throughout Settings, the provider dialog, and public documentation because tool calling, streaming, and reasoning metadata vary across providers and gateways. Built-in Codex remains the stable default.

## v2.0.0 - 2026-07-14

Release candidate focused on preserving user state and making Reviewing-mode lifecycle actions reliable across reloads. The Extension and Native Host move to protocol `2` while retaining protocol `1` compatibility during the transition.

### Fixed

- Preserved actionable Accept and Undo payloads for recent runs when session records are migrated into IndexedDB, so a reload no longer strips lifecycle controls from otherwise recoverable runs.
- Kept the IndexedDB schema at monotonic version `3`, preventing profiles already opened by the RC from falling back to compact storage and appearing to lose session history.
- Added a guarded snapshot fallback when Overleaf's in-memory editor undo history disappears after refresh; the fallback verifies the persisted post-write checkpoint before restoring or replaying content.
- Rebased exact run checkpoints when Overleaf wraps the tracked edit with unrelated prefix or suffix text, while refusing ambiguous or drifted content.
- Waited for asynchronously rendered Reviewing markers after normal writes, removing the intermittent state where Undo appeared without Accept.
- Propagated the run project identity through lifecycle writeback so stale tabs cannot replay Accept or Undo into another Overleaf project.

### Changed

- Advanced the Extension and Native Host handshake to protocol `2`; protocol `1` hosts remain accepted when they provide the required capabilities.
- Published the candidate as GitHub prerelease `v2.0.0-rc.1`. npm publication and stable-update discovery remain withheld until long-running local signoff is complete.

## v1.9.13 - 2026-07-12

### Fixed

- Stable update discovery now runs once when Chrome/Chromium or the extension starts, so a newly published release is discovered without waiting for the next 24-hour periodic check.
- Manual checks, the existing periodic check, user consent, safe-point gating, signature verification, and rollback behavior remain unchanged.

## v1.9.12 - 2026-07-12

### Changed

- Extracted Overleaf save-state detection from the page bridge into a dedicated factory-injected page module while preserving `verified_saved`, `verified_quiet`, timeout, and unavailable semantics.
- Extracted project instructions, governance rules, skill toggles, settings navigation, and theme coordination from the content runtime into a dedicated coordinator.
- Extracted the active-session menu, header state, and inline rename surface from the session lifecycle manager into a dedicated view module.
- Tightened architecture budgets around the smaller orchestration modules and updated production load order plus browser VM fixtures for the new seams.

### Fixed

- Removed a dormant undefined local-skill normalizer from the new settings seam after local managed-install verification exposed it as an eager startup dependency that prevented the panel from mounting.

### Release metadata

- Release metadata alignment keeps the package, extension manifest, compatibility target, README, and tests on v1.9.12.
- Published artifacts are `codex-overleaf-link-extension-v1.9.12.zip`, `codex-overleaf-native-host-v1.9.12.tar.gz`, and `codex-overleaf-link-1.9.12.tgz`.
- Native protocol `1` remains the compatibility contract between the Extension and Native Host.

## v1.9.11 - 2026-07-12

### Fixed

- Added an update-only `verified_quiet` save-state proof for current Overleaf editors that no longer expose a Saved/Saving DOM indicator.
- Required the browser to be online, the editor to be readable, the visible save indicator to be completely absent, and the editor text signature to remain stable before accepting quiet evidence.
- Kept the existing 30-second user-activity window, three-second cross-probe stability window, busy-operation gates, and Native Host lock gate around the new proof.
- Left writeback and compile save verification on the stricter `verified_saved` contract; the quiet fallback is opt-in only for coordinated update safety.

### Release metadata

- Release metadata alignment keeps the package, extension manifest, compatibility target, README, and tests on v1.9.11.
- Published artifacts are `codex-overleaf-link-extension-v1.9.11.zip`, `codex-overleaf-native-host-v1.9.11.tar.gz`, and `codex-overleaf-link-1.9.11.tgz`.
- Native protocol `1` remains the compatibility contract between the Extension and Native Host.

## v1.9.10 - 2026-07-12

### Fixed

- Added a dedicated Software Updates icon built from a software package and coordinated update loop instead of reusing the Appearance icon.
- Restricted save-state safety probes to real `/project/<project-id>` editors while keeping the Overleaf project homepage available as an update surface.
- Recovered stale loaded editor tabs by reinjecting the managed runtime without reloading or bypassing save verification, and excluded Chrome-discarded tabs from active-editor gating.
- Reloaded every loaded Overleaf surface after coordinated replacement so project homepages and editors converge on the same committed state.
- Treated the expected message-channel disconnect during Extension restart as health verification in progress and reconciled ordinary errors against the authoritative background state before showing Retry.

### Release metadata

- Release metadata alignment keeps the package, extension manifest, compatibility target, README, and tests on v1.9.10.
- Published artifacts are `codex-overleaf-link-extension-v1.9.10.zip`, `codex-overleaf-native-host-v1.9.10.tar.gz`, and `codex-overleaf-link-1.9.10.tgz`.
- Native protocol `1` remains the compatibility contract between the Extension and Native Host.

## v1.9.9 - 2026-07-12

### Fixed

- Kept update installation, safe-point progress, retry, failure, and completion controls inside the active Overleaf tab without opening a separate Update Center window.
- Prevented clicks inside the Codex panel from resetting the editor-idle timer, and added bounded save verification with fast transient retries.
- Serialized safe-point application attempts so the retry timer and Chrome alarm cannot apply the same staged update concurrently.
- Reported every concrete tab, save-state, Codex, review-action, and Native Host blocker instead of a generic waiting message.

### Release metadata

- Release metadata alignment keeps the package, extension manifest, compatibility target, README, and tests on v1.9.9.
- Published artifacts are `codex-overleaf-link-extension-v1.9.9.zip`, `codex-overleaf-native-host-v1.9.9.tar.gz`, and `codex-overleaf-link-1.9.9.tgz`.
- Native protocol `1` remains the compatibility contract between the Extension and Native Host.

## v1.9.8 - 2026-07-12

### Fixed

- Authorized the dedicated Update Center as an exact trusted extension surface, including the browser-window sender shape.
- Removed duplicate update controls from the Chrome toolbar Popup and moved manual update checks into Overleaf Settings.
- Added the exact Overleaf `/project` dashboard route to the managed runtime so update notices also appear on the project homepage.
- Kept dashboard tabs out of editor save-state probes so an open homepage cannot block a safe update.

### Release metadata

- Release metadata alignment keeps the package, extension manifest, compatibility target, README, and tests on v1.9.8.
- Published artifacts are `codex-overleaf-link-extension-v1.9.8.zip`, `codex-overleaf-native-host-v1.9.8.tar.gz`, and `codex-overleaf-link-1.9.8.tgz`.
- Native protocol `1` remains the compatibility contract between the Extension and Native Host.

## v1.9.7 - 2026-07-12

### Added

- Added a dedicated Update Center that stays open when focus moves away from the toolbar popup.
- Added a persistent three-stage view for download verification, safe-point waiting, and restart health checks.

### Changed

- Routed update and retry actions from the toolbar popup into one named Update Center window.
- Restored update progress from saved state after runtime restarts and made transient reconnects explicit.
- Required Update Center assets in managed installs and verified release archives.

### Release metadata

- Release metadata alignment keeps the package, extension manifest, compatibility target, README, and tests on v1.9.7.
- Published artifacts are `codex-overleaf-link-extension-v1.9.7.zip`, `codex-overleaf-native-host-v1.9.7.tar.gz`, and `codex-overleaf-link-1.9.7.tgz`.
- Native protocol `1` remains the compatibility contract between the Extension and Native Host.

## v1.9.6 - 2026-07-11

- Release metadata alignment: package, extension manifest, compatibility target, README commands, and release tracking now resolve to v1.9.6; native protocol `1` remains unchanged. Release artifacts resolve to codex-overleaf-link-extension-v1.9.6.zip, codex-overleaf-native-host-v1.9.6.tar.gz, and codex-overleaf-link-1.9.6.tgz.

## v1.9.5 - 2026-07-11

- Consent-update validation release: runtime behavior is unchanged from v1.9.4; this version exists as the first real target for the check, prompt, authorization, progress, coordinated apply, and health-confirmation flow.
- Release metadata alignment: package, extension manifest, compatibility target, README commands, and release tracking now resolve to v1.9.5; native protocol `1` remains unchanged. Release artifacts resolve to codex-overleaf-link-extension-v1.9.5.zip, codex-overleaf-native-host-v1.9.5.tar.gz, and codex-overleaf-link-1.9.5.tgz.

## v1.9.4 - 2026-07-11

- Consent-driven stable updates: automatic checks now stop at a signed update offer; downloading and installation require an explicit target-bound **Update now** authorization.
- Update experience: Runtime takes over the Popup update card, adds an Overleaf panel banner, truthful phase progress, concrete safe-point blockers, a persistent action badge, and a 24-hour target-bound **Later** action.
- Release metadata alignment and Native transaction safety: update.authorize and update.revoke bind consent to one source/target pair, serialize revoke against apply, clean staged artifacts before reporting a snooze, and retain coordinated health-confirmation rollback.
- Package, extension manifest, compatibility target, README commands, and release tracking now resolve to v1.9.4; native protocol `1` remains unchanged. Release artifacts resolve to codex-overleaf-link-extension-v1.9.4.zip, codex-overleaf-native-host-v1.9.4.tar.gz, and codex-overleaf-link-1.9.4.tgz.

## v1.9.3 - 2026-07-11

- Update wait visibility: the stable-update popup now reports every concrete Overleaf and native-host idle blocker instead of showing an opaque waiting state.
- Idempotent staging: repeated checks reuse an already verified transaction, and completed or replaced transactions remove orphan `staging-*` directories.
- Release metadata alignment: package, extension manifest, compatibility target, README commands, and release tracking now resolve to `1.9.3`; native protocol `1` remains unchanged. Successful apply and rollback transactions also update both extension and native managed markers alongside the manifest and active-version pointer.
- Release artifacts resolve to `codex-overleaf-link-extension-v1.9.3.zip`, `codex-overleaf-native-host-v1.9.3.tar.gz`, `codex-overleaf-link-1.9.3.tgz`, `codex-overleaf-update-v1.9.3.tar.gz`, and the detached signed manifest.

## v1.9.2 - 2026-07-11

- Native command trust boundary: Auto mode no longer approves `awk` or `sed` interpreters, and LaTeX commands reject shell escape, external output directories, unsafe Lua execution, and executable `latexmk` configuration paths.
- Mirror containment: snapshot sync, partial overlays, change collection, writeback confirmation, and OT patching fail closed when an existing workspace path segment is a symlink.
- Managed installation convergence: macOS/Linux and Windows one-command installers now install the coordinated managed extension/native pair; the POSIX installer refuses dangerous, symlinked, or unmarked existing source directories.
- Immutable release bytes: npm publishes the already verified release tarball, verifies registry integrity against that tarball, refuses reused versions/releases, and disables GitHub asset overwrite.
- Release metadata alignment: package, extension manifest, compatibility target, README commands, and release tracking now resolve to `1.9.2`; native protocol `1` remains unchanged.
- Release artifacts resolve to `codex-overleaf-link-extension-v1.9.2.zip`, `codex-overleaf-native-host-v1.9.2.tar.gz`, `codex-overleaf-link-1.9.2.tgz`, `codex-overleaf-update-v1.9.2.tar.gz`, and the detached signed manifest.

## v1.9.1 - 2026-07-11

- Reasoning stream display: removes empty `<!-- -->` placeholders emitted by current Codex reasoning-summary events before they reach the visible run timeline.
- Historical-session cleanup: applies the same reasoning-only sanitizer while rendering persisted events, including placeholders split across stream-delta boundaries.
- Safe rendering remains unchanged: assistant messages and meaningful HTML comments are preserved, and visible text continues to use text nodes rather than HTML injection.
- Release metadata alignment: package, extension manifest, compatibility target, README badge/commands, and release tracking metadata now resolve to `1.9.1`; native protocol `1` remains unchanged.
- Release artifacts remain `codex-overleaf-link-extension-v1.9.1.zip`, `codex-overleaf-native-host-v1.9.1.tar.gz`, `codex-overleaf-link-1.9.1.tgz`, the coordinated update bundle, and the detached signed manifest.

## v1.9.0 - 2026-07-10

- Managed automatic updates: introduced a stable Manifest V3 Bootstrap, replaceable extension runtime, versioned native runtime, coordinated idle-only apply, health confirmation, and automatic rollback foundation.
- Release authenticity: stable GitHub updates require an Ed25519-signed release manifest plus exact SHA-256 and size verification for `codex-overleaf-update-v1.9.0.tar.gz`.
- One-time migration: `npm exec --yes codex-overleaf-link@1.9.0 -- install-managed` creates the stable unpacked extension path and managed native-host launcher; legacy `install-native` remains available.
- Release metadata alignment: package, extension manifest, compatibility target, README badge/commands, and release tracking metadata now resolve to `1.9.0`; native protocol `1` remains unchanged.
- Release artifacts now include `codex-overleaf-link-extension-v1.9.0.zip`, `codex-overleaf-native-host-v1.9.0.tar.gz`, `codex-overleaf-link-1.9.0.tgz`, the coordinated update bundle, and a detached signed manifest.

## v1.8.6 - 2026-07-10

Codex Desktop executable discovery compatibility. The native protocol stays `1`.

### Fixed

- **The native host now finds Codex after the macOS desktop-app path change.** Codex may now be bundled at `/Applications/ChatGPT.app/Contents/Resources/codex`; native discovery supports that location, the legacy `Codex.app` bundle, and user-local copies under `~/Applications`.
- **Fresh native-host launchers include both macOS app resource directories.** Chrome's restricted launch environment can resolve the bundled Codex binary without relying on an interactive shell `PATH`.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.8.6` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.8.6.zip`, `codex-overleaf-native-host-v1.8.6.tar.gz`, and `codex-overleaf-link-1.8.6.tgz`.
- Native host install is `npm exec --yes codex-overleaf-link@1.8.6 -- install-native`.

## v1.8.5 - 2026-07-09

Panel icon polish. The native protocol stays `1`.

### Fixed

- **The project header no longer carries a redundant clock icon.** Change history remains available inside Settings, so the top action strip now focuses on refresh, diagnostics, new session, and settings.
- **Settings section icons now use the same linear SVG system as the header.** Emoji icons were replaced with theme-aware stroke icons so the settings screen matches the rest of the panel.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.8.5` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.8.5.zip`, `codex-overleaf-native-host-v1.8.5.tar.gz`, and `codex-overleaf-link-1.8.5.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.8.5 -- install-native`.

## v1.8.4 - 2026-07-09

Dashboard data hygiene fix. The native protocol stays `1`.

### Fixed

- **The Overleaf project-list dashboard no longer shows phantom “Project link unavailable” rows.** The extension now treats `/project` as the account dashboard rather than a real project, so it no longer persists the homepage URL as a session `projectId`.
- **Recent-projects queries now filter legacy invalid project ids.** Old URL-shaped or non-Overleaf project ids stay out of the dashboard even if they already exist in local storage.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.8.4` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.8.4.zip`, `codex-overleaf-native-host-v1.8.4.tar.gz`, and `codex-overleaf-link-1.8.4.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.8.4 -- install-native`.

## v1.8.3 - 2026-07-05

Dashboard visual alignment fix. The native protocol stays `1`.

### Fixed

- **The dashboard expand chevron is now part of the card.** Project rows keep the session expand control inside the card's right edge instead of floating as a detached icon outside the row.
- **Old pending dashboard rows no longer look active.** Display-only `pending` rows older than 30 minutes now render as `stale` / `久未处理` while preserving the stored session state.
- **The dashboard subtitle reads like product copy.** Release-facing commands and version metadata now point to `1.8.3`, and the welcome stats avoid the debug-style `project(s)` wording.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.8.3` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.8.3.zip`, `codex-overleaf-native-host-v1.8.3.tar.gz`, and `codex-overleaf-link-1.8.3.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.8.3 -- install-native`.

## v1.8.2 - 2026-07-04

Dashboard proportion fix — the expand toggle is a slim icon again. The native protocol stays `1`.

### Fixed

- **The expand toggle no longer dwarfs its row.** v1.8.1 put the session count ("▾ 3 sessions") inside the expand button and widened it to 44px, making the control visually outweigh the slim project row — and the expanded-state 180° rotation flipped the embedded text upside-down. The toggle is back to a proportionate 32px icon strip (still wider than the original 26px for the miss-click fix), and the session count moved into the row's meta line at its type scale.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.8.2` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.8.2.zip`, `codex-overleaf-native-host-v1.8.2.tar.gz`, and `codex-overleaf-link-1.8.2.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.8.2 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.8.2 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.8.2 -- uninstall-native`.

## v1.8.1 - 2026-07-04

Dashboard trust — a full review of the extension's surface on the Overleaf project list (/project): every status it shows is now honest, every dead-end got an exit, and the first screen stops flashing the wrong UI. Fleet-reviewed twice (4 review dimensions: 8 confirmed defects + 9 improvements; then a P1 caught in the fix itself: the 30-minute zombie heuristic would have mislabeled genuinely-live long runs because activity timestamps were pinned to run start — sessions now bump their activity once a minute during a run, any stored-running delete keeps the stronger warning, and the auto-refresh preserves expanded lists, scroll and in-progress renames). The native protocol stays `1`.

### Fixed

- **Zombie "running" sessions.** A run orphaned by a closed tab/crash kept its project row spinning "running" forever, and the session could be neither renamed nor deleted from the dashboard. A persisted running state older than 30 minutes now displays (and behaves) as interrupted, and deleting a fresh-running session goes through a stronger confirm instead of a hard dead-end.
- **False green badges.** The storage layer's status whitelist dropped `interrupted`, silently rewriting it to `completed` — interrupted runs showed a success badge and the v1.7.6 amber dashboard badge was unreachable. The status now round-trips.
- **The dashboard now refreshes itself.** It was a one-shot render: runs finishing in other tabs, cleared history or new sessions never appeared. It now re-renders (debounced) on tab visibility and on cross-tab run signals, relative timestamps tick every minute, and deleting a session updates the list in place without resetting scroll.
- **Cold-load flash.** Opening /project painted the full per-project editor UI (composer, header buttons, probe line) for a few hundred ms before swapping to the project list. The dashboard shell now mounts synchronously.
- **"Clear all history" now also clears cached project names** (they live in chrome.storage outside the IndexedDB stores and could retain sensitive titles); the confirm copy says so.
- **Light-theme freeze.** 18 CSS declarations referenced `--codex-*` variables that never existed, so their dark-value fallbacks always won — the show-all button, run search, history rows and more ignored the light theme. All now use the real `--tl-*` tokens.
- Session titles got hover tooltips; the "Project · <id>" fallback name is localized.

### Added

- **Glanceable first screen.** The welcome header's boilerplate subtitle becomes a real summary (N projects · M sessions) once rows load; each project row shows its session count on a wider (miss-click-resistant) expand control.
- **Session rows are now clickable.** Clicking a session opens the project straight into that session (it records the editor's active-session preference before navigating). Enter works too; rows are keyboard-reachable with proper `aria-controls`/region wiring.
- **A degraded dashboard explains itself.** When the account scope can't be identified, the copy now says what actually happened (instead of telling a signed-in user to sign in) and offers a Retry button. Loading got the arc-ring spinner.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.8.1` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.8.1.zip`, `codex-overleaf-native-host-v1.8.1.tar.gz`, and `codex-overleaf-link-1.8.1.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.8.1 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.8.1 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.8.1 -- uninstall-native`.

## v1.8.0 - 2026-07-03

Structure, speed & workflow — phase-7/8 carves retire ten versions of structural debt, verified text writebacks skip the full project re-download, and four workflow features land. Adversarially fleet-verified (5 findings fixed pre-release, including a P1 the whole test suite missed: the carved page module was in the manifest but never injected into the page world, which would have killed the writeback pipeline on every page — now locked by an injection-sequence test). The native protocol stays `1`.

### Changed

- **Post-write mirror refresh is near-instant for text-only runs.** The written content originates in the local Codex workspace, so after a save-verified writeback the workspace already equals Overleaf. The refresh now calls the new `mirror.confirmWriteback` — the native host re-hashes the written files in place and renews the baseline freshness — instead of re-downloading the whole project just to rewrite what it uploaded. Tree operations, binary writes, dirty mirrors and older native hosts all fall back to the unchanged full resync; next-run reuse still passes the freshness + focus-overlay checks and the page-side base-content guard.
- **Structural phase 7 (#117, deferred since v1.6.3):** the tracked-changes lifecycle (accept/reject flows, accept-replay + editor-undo recovery, tracked-change DOM collectors — ~1550 lines) moved out of `writebackRouter.js` (3293 → 1876 lines) into `trackedChangesLifecycle.js` with 30+ factory-injected collaborators.
- **Structural phase 8:** the recovery-action handlers, change-history read path, history & storage card and compaction notice moved out of `contentRuntime.js` into `panelMaintenance.js`, with mutable runtime state behind getter/setter accessors.

### Added

- **Change history is a first-class surface.** A 🕘 header button opens the history card directly, and every history row jumps to the run it describes — switching sessions if needed, scrolling to the card and flashing it (trimmed runs explain themselves in a toast).
- **Search this session's runs.** With 3+ turns, a search box above the log filters run cards by task or report text.
- **Undo by file.** Multi-file undos now confirm through a per-file checkbox list. Undoing a subset keeps the Undo button usable for the rest — re-undoing an already-restored file is safely skipped by the base-content check.
- **Attachments survive a refresh.** Small composer attachments (up to 3 files, 1MB each) persist across page reloads; oversized ones simply don't persist rather than bloating storage.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.8.0` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.8.0.zip`, `codex-overleaf-native-host-v1.8.0.tar.gz`, and `codex-overleaf-link-1.8.0.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.8.0 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.8.0 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.8.0 -- uninstall-native`.

## v1.7.7 - 2026-07-03

Process readability & liveliness — narration is never cut off, and a working run finally looks like it's working. Adversarially fleet-verified (2 findings fixed pre-release: a checkpoint-divider collision with the breathing ellipsis, and a 2-line clamp on error titles that lost its overflow anchor). The native protocol stays `1`.

### Fixed

- **Activity lines wrap instead of vanishing into an ellipsis.** Timeline narration ("I will first understand your request, then inspect the relevant Overleaf files.", step announcements, warnings) was styled single-line with `text-overflow: ellipsis` — no panel width could reliably show it in full. Narration now wraps (long paths/commands break instead of overflowing), with the status glyph and timestamp aligned to the first line. The welcome panel's probe line wraps too.
- **Truncated list rows gained full-text tooltips.** Diff file paths, session-menu titles, dashboard project names, context-tray file names and change-history task summaries keep their compact single line but now show the full text on hover.

### Added

- **Indeterminate scan line.** While a run is working, a thin sweep animates under the sticky current-step header — the "in progress" signal stays alive even when no new lines are streaming. Hosted on a dedicated element (the header's `::after` is the expand/collapse chevron) and disabled under reduced motion like every other animation.
- **Breathing ellipsis on the live step.** The line currently being worked on (the same "run is running and nothing newer landed" condition that keeps its ring spinning) pulses a trailing `…`.
- **Rows slide in.** New timeline lines enter with a 3px slide + fade (previously fade only) — transform+opacity, composited, never reflows neighbors.

### CI

- The Test workflow's matrix is now `fail-fast: false`, so the observational macos-latest leg (GitHub's macOS pool is still degraded — #118 stays open) can never cancel the ubuntu/windows legs.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.7.7` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.7.7.zip`, `codex-overleaf-native-host-v1.7.7.tar.gz`, and `codex-overleaf-link-1.7.7.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.7.7 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.7.7 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.7.7 -- uninstall-native`.

## v1.7.6 - 2026-07-03

Motion & running-state consistency — the wobbling half-circle is gone, and no spinner ever spins forever. Adversarially fleet-verified (a P1 caught pre-release: the new CLI-guide button — and several v1.7.5 recovery buttons — keyed off failure objects that were never built). The native protocol stays `1`.

### Fixed

- **The wobbling spinner.** The timeline's running indicators (the per-line status glyph and the collapsed-header current step) used the `◐` character rotated by CSS — a font glyph spins around its bounding box, not its visual center, so it wobbled. Both are now CSS-drawn arc rings, identical to the send-button/session spinners, on one unified 800ms cadence (the old glyphs ran at 1.4s).
- **Spinners that never stop.** Any activity line written with a running status kept spinning forever — the background mirror refresh's "checking latest Overleaf content" line after the report landed, and every historical "started X" line when expanding an old run's process log. Two CSS guards settle them to the neutral dot: a running line only spins while its run card is itself running AND no newer activity line has landed below it.
- **Recovery buttons for shared failure codes were unreachable.** `buildContentFailure` only knew the 8 content-local codes and returned `null` for every shared-catalog code — so `codex_timeout`, `codex_output_limit`, `stale_source_changed` and `native_protocol_incompatible` failures never carried a structured failure onto their report, and the v1.7.5 "Edit & resend" / "Fix the native host" buttons never fired for them. It now falls back to the shared §9 catalog, locked by a behavioral test (not a source grep).
- **Reduced motion now actually stops the rings.** The `prefers-reduced-motion` reset targeted `#codex-overleaf-panel *`, which never matches `::before` pseudo-elements — exactly where every spinner lives. The reset now covers `*::before`/`*::after`.

### Added

- **`codex_not_found` gets a recovery action.** A "Codex CLI was not found" failure now renders a "Codex CLI troubleshooting guide" button that opens the README's PATH/login checks — previously it was the one common failure with no clickable next step.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.7.6` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.7.6.zip`, `codex-overleaf-native-host-v1.7.6.tar.gz`, and `codex-overleaf-link-1.7.6.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.7.6 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.7.6 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.7.6 -- uninstall-native`.

## v1.7.5 - 2026-07-03

Journey pack — the three walkthrough audits (daily loop, failure recovery, long-term use) shipped as one release: every dead-end now has a next action you can click. Adversarially fleet-verified (5 findings fixed pre-release, including a mirror-barrier ordering race, an unreachable open-file recovery branch, and a clear-history flow that left deleted cards on screen). The native protocol stays `1`.

### Added

- **Recovery-action registry.** A failure's completion report now renders the executable next step, per failure code: retryable failures (timeout, no usable result, stale source, write errors, …) get **Edit & resend** (the run's task text refills the composer); native-bridge failures get **Fix the native host** (opens the install/update guidance); file-targeting failures get **Open the file in Overleaf**; storage failures get **Open history & storage cleanup**; a locked project keeps its force-release button. Latent bug fixed on the way: the structured failure was never forwarded onto the report event, so the v1.6.2 force-release button could never actually render.
- **Fix compile errors in one click.** When the post-write compile fails, the report carries the structured error list and a **Fix N compile error(s)** button that prefills a task with `@compile-log` and the captured errors.
- **Redo rejected changes.** Hunks you reject during review are summarized onto the run's report (file, line, snippet — persisted across reloads); a **Redo N rejected change(s) differently** button prefills a task quoting each one so Codex can try another approach.
- **History & storage settings card.** Session/run counts plus site storage usage, and a destructive-confirmed **Clear all history** (all projects; settings and rules are kept) wired to the previously write-only store cleaner.
- **Change history finally has a read path.** A Settings card lists this project's audit log (newest 50 runs: time, task, files written) with a file/task filter — the audit store was previously write-only.
- **Jump to a turn.** Once a session holds 3+ runs, a dropdown above the log jumps straight to any turn's card.
- **Dashboard "Show all projects".** The recent-projects list shows 10 and now offers expanding to everything instead of silently hiding the rest.
- **Cross-tab heads-up (coarse).** Starting a run announces itself on a BroadcastChannel; other tabs on the same project show a "another tab is running" toast.

### Changed

- **Interrupted, not failed.** A run orphaned by a page refresh is now marked `interrupted` (amber) instead of `failed`, and its notice is a report event carrying a retryable failure code — so the registry's **Edit & resend** appears right on the card.
- **Mirror refresh runs in the background.** The post-write zip snapshot + `mirror.sync` (often the slowest tail step) no longer blocks the completion report. Undo and the next run barrier on the in-flight promise, so a late `mirror.sync` can never push a pre-undo snapshot as the local baseline.
- **Attachments persist across turns.** Submitting a task keeps the attachments in the tray (screenshots usually anchor several follow-up questions); only the task text resets. The retry-refill toast says when attachments must be re-added by hand.
- **Aggressive storage compaction announces itself.** When the state exceeds the 4MB target and history limits silently halve, a one-per-load toast now points at the history & storage card.
- **Truncation is labeled.** The run log tops out with "showing the most recent 20 runs" (the note existed since B1 but was never rendered) and long event lists carry their existing 300-event note.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.7.5` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.7.5.zip`, `codex-overleaf-native-host-v1.7.5.tar.gz`, and `codex-overleaf-link-1.7.5.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.7.5 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.7.5 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.7.5 -- uninstall-native`.

## v1.7.1 - 2026-07-02

Settings page redesign — clearer operation logic, safety guardrails, and visual unification. Adversarially verified (9 findings fixed pre-release, including an inverted OT switch). The native protocol stays `1`.

### Changed

- **Cards re-cut by topic.** Governance no longer mixes concerns: 🛡 File protection holds the read-only/writable globs, 🔒 Privacy holds the sensitive-content switches, and every card carries an icon title. The two-scope skeleton (This project / All projects) stays.
- **Per-card save feedback.** The ✓ Saved badge appears on the card you actually changed (the far-away global header chip is gone), including the Experimental card when toggling OT.
- **One OT control.** The hidden-checkbox + button pair became a single visible switch with a plain-language subtitle and a separate status line; the confirm-before-enable flow is preserved (and its direction verified — the first cut inverted it: a checkbox's click fires after the checked state flips).
- **Collapse memory.** Card open/closed state persists per browser profile; Experimental stays collapsed by default.

### Added

- **Protection-glob guardrails (warn, never block).** A read-only rule that matches every file (probed against the real governance matcher, so `./**` — which the engine ignores — does not cry wolf while `***` — which really matches everything — does warn) shows an amber note: the rule is saved, but Codex will not be able to write anything. A non-empty writable list shows a neutral "allowlist active" note. Notes re-render on language switch.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.7.1` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.7.1.zip`, `codex-overleaf-native-host-v1.7.1.tar.gz`, and `codex-overleaf-link-1.7.1.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.7.1 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.7.1 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.7.1 -- uninstall-native`.

## v1.7.0 - 2026-07-02

Feature release — **@ file autocomplete** and a **first-run setup prompt**. Both adversarially verified (17 findings fixed pre-release, including two P1s). The native protocol stays `1`.

### Added

- **Type `@` to add files.** Typing `@` anywhere in the composer opens an inline autocomplete over the project's files (filter as you type, `.tex` first, arrows/Enter/Esc/click, capped at 8) plus the `@compile-log` builtin. Selecting a file inserts the `@path` token and selects it as a focus file — the selection is what actually attaches the file to the run. Works after CJK text with no space (`润色@` triggers; emails like `a@b` never do), is IME-safe (a composition-commit Enter is never hijacked), skips binary files, namespaces the builtin against same-named project files, ignores stale menus (caret moved → nothing is silently attached), and surfaces the 5-file focus cap instead of silently evicting. The composer copy promises `@` again — now truthfully.
- **First-run setup prompt.** When the panel loads and the native host has never been installed, the install guidance opens once automatically (per browser profile; a dismissal is final; profiles that ever had a working host are exempt, so transient outages can never misfire it). The guidance modal now speaks "one step left: install" with a clear status line instead of update framing.

### Fixed

- **`@compile-log` actually triggers now.** The run-time gate used `\b@compile-log\b`, whose leading `\b` requires a word character before the `@` — exactly the positions a typed token never occupies. The gate now matches start-of-text/after-whitespace tokens (mid-word stays inert).

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.7.0` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.7.0.zip`, `codex-overleaf-native-host-v1.7.0.tar.gz`, and `codex-overleaf-link-1.7.0.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.7.0 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.7.0 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.7.0 -- uninstall-native`.

## v1.6.4 - 2026-07-02

UI polish pack — ~25 small display/interaction fixes from a full UI/UX audit, adversarially verified item-by-item before release. The native protocol stays `1`.

### Fixed

- **Honest composer copy.** The placeholder/hints promised "Type @ to add context" but no `@` trigger exists (only `/` is wired); the copy now points at the ＋ button (typed `@compile-log` still resolves and still documented). Real `@` autocomplete lands in 1.7.
- **Failed reports read as failed.** The failed completion report's alert color was silently reset by the conclusion's base style; failure now stays red.
- **Destructive confirms are keyboard-safe.** Delete dialogs open focused on Cancel, a bare Enter no longer confirms them, and Tab cycles inside the dialog (focus trap) instead of drifting onto Overleaf.
- **Readable action buttons in both themes.** New `--tl-on-solid` ink token replaces white-on-pastel text on the confirm/undo/accept solid fills (was ~1.7:1 in dark theme); hover states no longer turn white-on-light-grey in the light theme.
- **Subagent rows get their own visual track.** Parallel-subagent timeline lines are indented with a left rail (flag carried through the event bridge and both storage compactors, so the track survives reloads).
- **High-signal rows stop truncating.** Warning/failed timeline lines wrap to two lines instead of clipping mid-sentence.

### Added

- **Attachments are discoverable.** A file-picker button in the ＋ context tray (paste/drop still work); the ＋ hint now mentions attachments.
- **Diff hunks show where they land.** Each hunk carries a "Line N · M lines" location header (the data existed, it was never rendered).
- **Composer ergonomics.** The task box auto-grows with content (58-160px, single height mechanism), Send disables on an empty composer (Cancel is never disabled), and Esc closes the model popover and the context tray (layered: one Esc, one layer).
- **Visibility polish.** Active session row gets an accent bar; the dashboard's expand caret is brighter; dashboard/session lists show loading placeholders instead of blank panes; the diagnostics dot has per-state tooltips; toasts fade in; themed scrollbars everywhere in the panel.
- **Accessibility.** aria-labels on the diff icon buttons and jump-to-latest pill; the completion report is an aria-live region.

### Changed

- A missing native host now says "not responding — click for setup steps" instead of claiming an update is available; the experimental OT setting describes itself in plain language; diff colors joined the theme-token system (with an AA-safe light-theme green); `×` glyphs unified.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.6.4` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.6.4.zip`, `codex-overleaf-native-host-v1.6.4.tar.gz`, and `codex-overleaf-link-1.6.4.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.6.4 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.6.4 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.6.4 -- uninstall-native`.

## v1.6.3 - 2026-07-02

Structural patch — debt phase 6. No behavior changes intended; the native protocol stays `1`.

### Changed

- **Sync-writeback orchestration carved out of `contentRuntime.js`.** `applySyncChangesToOverleaf` and the post-write pipeline (save verification, mirror refresh, auto recompile, compile/unsupported-change summaries) now live in `extension/src/content/writebackOrchestrator.js` (758 lines), factory-wired like the earlier carves. Code moved verbatim; the only rewrites route the mutable runtime bindings through accessors (`state` → `getState()`, `currentRunView` → `getCurrentRunView()`). `contentRuntime.js` shrinks 8849 → 8257 lines and its architecture ceiling LOWERS 8850 → 8330 to lock the gain (it was 1 line from the ceiling).
- **`writebackRouter.js` gets deliberate headroom** (ceiling 3300 → 3400; it was 8 lines from the ceiling) so bugfixes are not squeezed. The real relief — carving the ~1100-line tracked-changes lifecycle cluster — is earmarked as structural phase 7 with its own dedicated, test-locked pass.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.6.3` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.6.3.zip`, `codex-overleaf-native-host-v1.6.3.tar.gz`, and `codex-overleaf-link-1.6.3.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.6.3 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.6.3 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.6.3 -- uninstall-native`.

## v1.6.2 - 2026-06-17

Quality patch — correctness, safety, and localization fixes for the parallel-subagents and writeback paths. The native protocol stays `1`.

### Fixed

- **Undo survives a cancel during post-write bookkeeping.** When a writeback's edits had already landed in Overleaf, cancelling during the follow-up save-verify or mirror refresh discarded the "Undo written parts" checkpoint, leaving real changes with no one-click revert. The undo checkpoint is now recorded the moment writes land, before any cancellable await — matching the manual-confirm path.
- **A subagent's partial edits never reach Overleaf.** If a worker is force-stopped mid-edit at drain time, its half-written files are now withheld from writeback (treated like an ownership violation) instead of being synced as-is.
- **The "Force-release the stuck task" button tells the truth.** It previously reported success unconditionally; it now reports the real outcome and re-enables itself for a retry when the release did not go through.
- **No wasted save-verify on zero-write runs.** A run where every operation was skipped no longer blocks ~5s probing save-state nor emits a misleading "could not verify saved" warning; the probe gates on the count of applied writes.
- **A disabled OT warm mirror no longer looks like an error.** With the experimental OT feature off, diagnostics now report a clean "disabled" state instead of degrading to a generic "This check could not run" — an off feature is healthy, not failing.
- **Native host client version is synced.** The version the native host reports to the Codex app-server now tracks the package version instead of a hardcoded `0.1.0`.

### Changed

- **Subagent broker liveness hardening.** Still-queued jobs now get a `cancelled` result when the broker stops (so a polling lead never hangs), the final settle is bounded (a worker that ignores its abort can no longer strand the run or leak the project lock), a job that throws as it starts emits a `failed` result instead of vanishing, the drain grace timer is cleared once workers settle, and the skill's documented poll loop has a wall-clock cap.
- **More Chinese localization.** The partial-writeback and run-cancelled failures (plus several common write/undo/accept failures) now render in Chinese instead of falling back to English, the parallel-subagent "withheld edit" timeline line is reworded into plain language with a next step, and the reasoning/speed controls plus a couple of stray toasts are localized.

### Release

- Release metadata alignment: bumped package, extension manifest, compatibility target, README release commands / badges, and release tracking metadata to `1.6.2` while keeping native protocol `1`.
- The release gate now also verifies the compatibility `BUILD_TARGET_VERSION` against the package version and pins the CHANGELOG date check to the tagged commit's date; CI workflows moved to non-deprecated action majors and Node 22.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.6.2.zip`, `codex-overleaf-native-host-v1.6.2.tar.gz`, and `codex-overleaf-link-1.6.2.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.6.2 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.6.2 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.6.2 -- uninstall-native`.

## v1.6.1 - 2026-06-03

Feature patch — **single-file fan-out** for parallel subagents, two safe modes. The native protocol stays `1`.

### Added

- **One `.tex` file can now fan out too — pick a mode.** Concurrent writes to the same file remain forbidden (whole-file writes race and silently drop each other's edits); both modes work around the physics:
  - **Mode A — serialized scoped jobs (simple).** Jobs may now share a file: the broker admits them and the scheduler runs them strictly one at a time (FIFO with skip — jobs on other files keep running in parallel). Each job's prompt states its exact section scope; temporal exclusivity makes prompt-scoped same-file delegation safe with zero slicing or assembly work. The old `file_conflict` rejection is retired.
  - **Mode B — scatter–gather slices (true parallelism).** The lead extracts each independent section verbatim into a slice file under the queue's `work/` scratch zone, workers polish their slices in parallel (slice paths are the only ownable queue subpath; the control plane — jobs/results/logs/broker.json — remains forbidden), and the lead reassembles the original file with per-slice boundary verification. Slices never sync to Overleaf; only the lead's reassembled edits to the real file do.
- **Explicit-scope iron rule.** Every job's task must state its exact working scope — file(s) + what is in scope, or for slices the section title plus its exact first and last source lines — and scopes must never overlap. If a boundary cannot be stated precisely, the lead does that slice itself.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.6.1 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.6.1` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.6.1.zip`, `codex-overleaf-native-host-v1.6.1.tar.gz`, and `codex-overleaf-link-1.6.1.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.6.1 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.6.1 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.6.1 -- uninstall-native`.

## v1.6.0 - 2026-06-03

Feature release — **parallel subagents (experimental)**. The native protocol stays `1`; the feature is fully off unless the new official skill is enabled for a project.

### Added

- **Parallel subagents via the `parallel-subagents` official skill.** When the skill is enabled (Settings → Skills, per project) and a task decomposes into independent slices over separate files — the canonical case: polish one chapter per agent — the model writes job files into a workspace queue (`.codex-overleaf-subagents/`) and the native host **broker** runs real parallel Codex workers for it: fresh sandbox per worker (no nesting — a sandboxed model cannot spawn processes itself), same project mirror, at most 3 concurrent, each bounded by a wall-clock deadline and a 15-minute all-waves budget.
- **Safety model**: jobs must own disjoint file sets (validated before admission); files changed during a wave that no job owns are reported as wave-level ownership violations and **hard-blocked from Overleaf writeback** (demoted to the unsupported-changes report — this holds even when Reviewing is off and writes would otherwise land directly). Cancel kills every worker and marks the mirror dirty so partial edits are deterministically discarded. Workers inherit the parent's skills except `parallel-subagents` itself (no recursive fan-out). Queue/result/log files never enter writeback or the diagnostics bundle.
- **Timeline**: bilingual one-line lifecycle events per subagent (queued / started with slot count / completed with duration / failed / violation warnings / drained); full worker output stays in the queue's result files for the parent to integrate.
- **Multi-file writeback fixed (from E2E)**: writing to a file that was not already open timed out as `target_editor_not_ready` — the file-switch confirmation depended solely on an editor-identity comparison that newer Overleaf view lifecycles break. Confirmation now accepts the strongest available proof first: the editor showing exactly the target file's expected base content (always true for pre-write sync targets), with identity change as a fast path and a content-moved acceptor reserved for unknown-base targets only (a weakly-anchored patch must never land in a wrong-but-different document). Skipped writeback rows now always surface the navigation debug payload (signatures, active paths, open diagnostics) so any future failure is diagnosable from the run card.
- **Robustness (from first E2E)**: the broker gate now survives panel reloads (the skills catalog it reads is persisted through the storage compactor instead of living only in a page-load cache); runs without the broker clear any stale queue directory so the model can never read a leftover `closed` handshake and report the feature as half-available; and `skills.list` installs/restores official skills before listing, so a freshly shipped skill appears in the Skills UI immediately after a runtime update.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.6.0 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.6.0` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.6.0.zip`, `codex-overleaf-native-host-v1.6.0.tar.gz`, and `codex-overleaf-link-1.6.0.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.6.0 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.6.0 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.6.0 -- uninstall-native`.

## v1.5.3 - 2026-06-03

Patch release — dead dashboard entries can now be removed. The native protocol stays `1`.

### Fixed

- **"Project link unavailable" rows are no longer stuck.** These dead dashboard entries are backed by session records with an empty/garbage project id, so they could not be opened — and the v1.5.2 expand/delete tools deliberately skipped them. They now carry a × cleanup action: after a destructive-confirm, all of that entry's session records are deleted (account-scoped, full-scan matched since an undefined project id is not indexed) with best-effort native history clearing per record, and the row disappears. The per-project panel-state blob is deliberately left untouched for these entries — an empty project id would map onto the global legacy storage key.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.5.3 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.5.3` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.5.3.zip`, `codex-overleaf-native-host-v1.5.3.tar.gz`, and `codex-overleaf-link-1.5.3.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.5.3 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.5.3 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.5.3 -- uninstall-native`.

## v1.5.2 - 2026-06-03

Feature release — manage sessions from the `/project` dashboard. The native protocol stays `1`.

### Added

- **Per-project session management on the dashboard.** Each project row on the recent-projects view (overleaf.com/project) now has an expand toggle (▾) that lists that project's sessions — newest first, running sessions marked and protected — with per-session **delete** and **inline rename**, no need to enter the project. Delete mirrors the in-project flow exactly: confirmation modal, panel-state writeback through the same normalize/compact pipeline `saveState` uses, IndexedDB record removal, native `codex.history.clearPlugin`, and the same success/skip/failure toasts. Rename routes through a new shared `renameSession` helper so the placeholder/derived-title ghost guard is a single source of truth for both the in-panel header rename and the dashboard.
- Known limitation: if the same project is open in another tab, that tab's in-memory state wins on its next save; the session record removal still holds.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.5.2 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.5.2` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.5.2.zip`, `codex-overleaf-native-host-v1.5.2.tar.gz`, and `codex-overleaf-link-1.5.2.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.5.2 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.5.2 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.5.2 -- uninstall-native`.

## v1.5.1 - 2026-06-03

Critical hotfix — the panel did not mount at all in the browser on v1.4.6 through v1.5.0.

### Fixed

- **Panel never mounted (regression since v1.4.6).** The structural-split releases left the module-composition wiring (`const { scrollLogToBottom, ... } = runTimelineView`, and seven sibling blocks) *after* the controller creations that consume those exports by value, so `init()` died in the temporal dead zone before the panel could mount. The wiring (plus the four shared consts it passes by value) now runs at the top of `init()`, before any consumer. The whole test suite stayed green across four releases because no test executed the load path — see below.

### Added

- **Load-order smoke test.** `test/contentScriptLoadOrder.test.js` loads every manifest content script in order inside a minimal DOM/chrome sandbox and runs the real `init()` end to end (panel mount included), failing on any load-order / TDZ / missing-global regression in the composition path. It fails on v1.4.6–v1.5.0 and passes on this release.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.5.1 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.5.1` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.5.1.zip`, `codex-overleaf-native-host-v1.5.1.tar.gz`, and `codex-overleaf-link-1.5.1.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.5.1 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.5.1 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.5.1 -- uninstall-native`.

## v1.5.0 - 2026-06-03

Feature release — the session switcher comes to the header, plus composer polish. The native protocol stays `1`.

### Added

- **Header session dropdown.** The active-session title is now a switcher: click it to list every saved session (newest first, active highlighted, running marked with a spinner), switch with one click, or start a **+ New Session** from the same menu. Escape or clicking anywhere else closes it; the embedded Sessions list below stays as the always-visible overview. Inline rename/delete on the header keep working as before.
- **Empty-timeline hint.** The idle panel now teaches the two composer affordances: "Type @ to add files, / to run commands."

### Changed

- **Model picker reads as a control.** The model/reasoning selector rests as a quiet pill (subtle surface + reserved border) instead of looking like static text, with a thin separator between the model and reasoning labels.
- Release flow now leans on the existing tag-triggered CI pipeline (3-OS test matrix → npm publish with provenance → GitHub release); local builds remain a pre-flight check.

### Fixed

- Run teardown paths that bypass the normal finish flow now stop the live-elapsed ticker explicitly (it previously self-healed within one tick).
- Settings panel teardown clears its transient Saved-flash timer; dead `tl-pulse` keyframes removed from the stylesheet.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.5.0 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.5.0` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.5.0.zip`, `codex-overleaf-native-host-v1.5.0.tar.gz`, and `codex-overleaf-link-1.5.0.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.5.0 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.5.0 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.5.0 -- uninstall-native`.

## v1.4.9 - 2026-06-03

Maintenance release — structural debt, phase 5: the final planned carve. No user-visible behavior changes; the native protocol stays `1`.

### Changed

- **`contentRuntime.js` carved down 9,573 → 8,791 lines** (cumulative since the split began: 12,837 → 8,791, **−32%**). The experimental OT warm-mirror glue moved verbatim into `otWarmMirror.js` (new): the per-project enable toggle flow, the poll/flush timers and patch queue, mirror prefetch, warm-start resolution, and the OT status display. The OT/prefetch state moved with the code that owns it; the runtime reads it through exported accessors and clears it on project navigation via two small APIs (`clearMirrorPrefetchTimer` / `releaseOtWarmMirrorProject`). The diagnostics controller now sources its OT getters from the module.
- **Architecture ceiling lowered again, 9,600 → 8,800.** This completes the planned split (task #69): what remains in `contentRuntime.js` is the genuinely cohesive run-orchestration core (run task, writeback application, result handling) plus the wiring that composes the ten carved modules.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.4.9 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.4.9` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.4.9.zip`, `codex-overleaf-native-host-v1.4.9.tar.gz`, and `codex-overleaf-link-1.4.9.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.4.9 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.4.9 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.4.9 -- uninstall-native`.

## v1.4.8 - 2026-06-03

Maintenance release — structural debt, phase 4. Continues the `contentRuntime.js` split. No user-visible behavior changes; the native protocol stays `1`.

### Changed

- **`contentRuntime.js` carved down 10,384 → 9,573 lines** (cumulative since the split began: 12,837 → 9,573, −25%). Two more cohesive clusters moved verbatim into focused modules wired back through factory injection:
  - `modelPicker.js` (new): the model/reasoning/speed catalog, native discovery, the selects, and the config popover. The model-discovery status lives with the code that maintains it; the runtime reads it for the diagnostics bundle through `getModelDiscovery()`.
  - `recentProjects.js` (new): the cross-project recent-projects dashboard — the account-scoped project-name cache + DOM enrichment, the welcome/empty/degraded states, row rendering, and the variant switchers.
- **Architecture ceiling lowered again, 10,450 → 9,600**, with the two new modules under their own 550/520-line budgets.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.4.8 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.4.8` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.4.8.zip`, `codex-overleaf-native-host-v1.4.8.tar.gz`, and `codex-overleaf-link-1.4.8.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.4.8 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.4.8 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.4.8 -- uninstall-native`.

## v1.4.7 - 2026-06-03

Maintenance release — structural debt, phase 3. Continues the `contentRuntime.js` split. No user-visible behavior changes; the native protocol stays `1`.

### Changed

- **`contentRuntime.js` carved down 10,965 → 10,384 lines** (cumulative since the split began: 12,837 → 10,384). Two more cohesive clusters moved verbatim into focused modules wired back through factory injection:
  - `sessionManager.js` (new): the session lifecycle + list surface — create/switch/rename/delete, the active-session header bar, running guards, and the find/replace state helpers. Session mutations are immutable-update: the module rebuilds panel state through the shared `sessionState` helpers and hands it back to the runtime via an injected `setState`.
  - `applyResultFormatters.js` (new): the apply-result / failure-reason formatters — skipped-change details and the bilingual apply/bridge reason texts.
- **Architecture ceiling lowered again, 11,000 → 10,450**, with the two new modules under their own 400/450-line budgets.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.4.7 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.4.7` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.4.7.zip`, `codex-overleaf-native-host-v1.4.7.tar.gz`, and `codex-overleaf-link-1.4.7.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.4.7 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.4.7 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.4.7 -- uninstall-native`.

## v1.4.6 - 2026-06-03

Maintenance release — structural debt, phase 2. Continues the `contentRuntime.js` split begun in v1.4.5 and consolidates the test-sandbox boilerplate that made each refactor expensive. No user-visible behavior changes; the native protocol stays `1`.

### Changed

- **`contentRuntime.js` carved down 11,742 → 10,965 lines.** The run-timeline render pipeline moved verbatim into `runTimelineView.js` (new): the scroll engine + jump-to-latest button, the live-elapsed tick and collapsed-header summary, run-card / stream-event / activity rendering, the completion report, and the run-card Undo/Accept controls. Runtime collaborators are factory-injected; mutable runtime state is read through lazy getters; the view-local scroll/timer state moved with the code that owns it (the runtime re-arms auto-follow through a small `resetAutoFollow()` API).
- **Architecture ceiling lowered again, 11,850 → 11,000** (cumulative since the split began: 12,850 → 11,000), with `runTimelineView.js` under its own 950-line budget.
- **Test-sandbox stub registry (task #68).** The `Function(...)` sandboxes in the p0 suite each hand-declared 10–30 no-op runtime stubs, so every new runtime collaborator had to be patched into each sandbox individually. A shared registry (`test/_helpers/runtimeSandbox.js`) now emits the defaults — one place to stub the next dependency — and the seven heaviest harnesses were migrated to it.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.4.6 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.4.6` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.4.6.zip`, `codex-overleaf-native-host-v1.4.6.tar.gz`, and `codex-overleaf-link-1.4.6.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.4.6 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.4.6 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.4.6 -- uninstall-native`.

## v1.4.5 - 2026-06-03

Maintenance release — structural debt, phase 1. `contentRuntime.js` had grown to ~12,800 lines against a ceiling that five consecutive releases had to raise; this release lands the first real split and **lowers** the ceiling to lock the gain. No user-visible behavior changes; the native protocol stays `1`.

### Changed

- **`contentRuntime.js` carved down 12,837 → 11,742 lines.** Two cohesive clusters moved verbatim into focused modules wired back through factory injection, so every existing call site (and the behavior) is unchanged:
  - `markdownText.js` (new): block + inline markdown rendering, the assistant-visible sanitizers, and line-reference resolution/jump buttons.
  - `diagnosticsController.js` (new): the diagnostics check runners, Run-all aggregation, and result formatters behind the diagnostics menu.
- **Architecture ceiling lowered 12,850 → 11,850** for `contentRuntime.js` (after five consecutive raises), with the two new modules under their own 700-line budgets — future growth must justify itself in the diff again.
- Source-contract tests now treat the runtime + its carved modules as one logical source (`test/_helpers/contentScriptSource.js` concatenates them), so the function-level test contracts keep holding wherever code lives.
- Closed the remaining `typeof` audit (task #70) by policy: the survivors are feature-detection on foreign Overleaf DOM/editor objects — the legitimate category the v1.3.9 cleanup deliberately kept; no DI guards remain.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.4.5 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.4.5` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.4.5.zip`, `codex-overleaf-native-host-v1.4.5.tar.gz`, and `codex-overleaf-link-1.4.5.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.4.5 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.4.5 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.4.5 -- uninstall-native`.

## v1.4.4 - 2026-06-03

Session-management release. Managing Codex sessions was awkward from the main panel — delete/rename were reachable only from the small hover-revealed per-row controls, the session you actually work in had no controls and could even be blank, and a hidden data-loss path could evict real history. v1.4.4 makes session management work from the main interface and fixes that bug. No change to runs or writeback; the native protocol stays `1`.

### Added

- **Active-session header bar.** The thread-title line is now a bar: the active session's title on the left, inline **rename** (✎) and **delete** (×) on the right — so the session you're working in can be renamed or deleted in place. Both reuse the existing delete/rename paths (no session-model change). The header always shows a title, falling back to the New Session placeholder for an empty session that has no list row (previously it was blank and unmanageable).
- **Keyboard navigation in the session list.** Up/Down move between sessions, Enter switches, Delete removes the focused session.

### Fixed

- **Ghost-session data loss.** "New Session" reused an empty, idle active session instead of minting a new one, and a normalize-time prune drops inactive empty sessions (the active one is always kept). Empty sessions are invisible in the list yet still consume the storage cap, so the old behavior could silently evict real run history. The header rename was also hardened so renaming an empty session (or a no-op blur) can never promote the placeholder / auto-derived title into a pinned manual title — which would have re-created the ghost and frozen an English label across locales.
- **Friendlier, more honest delete flow.** Deleting an empty session skips the destructive confirm (nothing to lose) and shows a brief toast; deleting the only session now reads as **Reset** (it actually starts a fresh session) instead of "Delete"; deleting the sole empty session is correctly disabled rather than a dead click; running sessions stay protected.

### Changed

- **Session-list polish.** Per-row delete/rename are now visible at rest (were hover-only / the rename pencil fully hidden) with a distinct red × hover; the list head reads **Sessions** (was "Tasks") and the header new-session glyph changed `✎` → `+` so it no longer collides with the per-row rename `✎`; **View all** stays expanded across re-renders; and an empty list shows a short hint instead of a blank gap.
- Architecture budget for `contentRuntime.js` raised for the header bar + inline rename/delete; the deferred `contentRuntime.js` module split remains tracked.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.4.4 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.4.4` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.4.4.zip`, `codex-overleaf-native-host-v1.4.4.tar.gz`, and `codex-overleaf-link-1.4.4.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.4.4 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.4.4 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.4.4 -- uninstall-native`.

## v1.4.3 - 2026-06-03

Diagnostics release. The header `⋯` menu had become a grab-bag — diagnostic checks mixed with an experimental feature toggle and a language switch. v1.4.3 makes it a focused diagnostics panel: settings moved to Settings, the trigger reads as a health indicator, and results are friendlier. No functional change to runs or writeback; the native protocol stays `1`.

### Changed

- **The diagnostics menu is now purely diagnostics.** The Experimental OT Mirror toggle and the language switch moved out of the `⋯` menu into Settings — the OT toggle to a new **Experimental** group under "This project", the language selector to **Appearance** under "All projects" (next to Theme). The menu now holds only the checks plus a new **Run all checks**.
- **The trigger is a health indicator, not a `⋯`.** It shows a status dot that turns green / amber / red from the native-host compatibility state (and after a Run-all pass), so the panel surfaces a problem without being opened.
- **Friendlier diagnostics feedback.** Running all checks produces one scannable health report — a status row per check (pass / attention / problem) with a plain-language summary and, when relevant, an actionable next step — instead of four separate result screens. Raw output stays tucked under "Technical details". The report reuses the run-timeline tokens and glyph language.
- Architecture budget for `contentRuntime.js` raised for the run-all aggregation + health wiring; the deferred `contentRuntime.js` module split remains tracked.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.4.3 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.4.3` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.4.3.zip`, `codex-overleaf-native-host-v1.4.3.tar.gz`, and `codex-overleaf-link-1.4.3.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.4.3 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.4.3 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.4.3 -- uninstall-native`.

## v1.4.2 - 2026-06-02

Theme release. The Codex panel was hard-dark; v1.4.2 adds a theme you pick in Settings (All projects): **Dark** (default), **Light**, or **Follow system**. The panel is now token-driven, so a theme is just a value swap — and unifying the panel onto those tokens also lands a batch of cohesion polish. No functional change to runs or writeback; the native protocol stays `1`.

### Added

- **Panel theme switching (dark / light / follow-system).** A theme selector in the Settings "All projects" scope (English + 中文). The preference is global — one setting applies across every Overleaf project and survives reload — and is applied to the panel on open and on SPA navigation. **Follow system** tracks the OS `prefers-color-scheme` and flips live when you change your OS appearance. A new isolated `extension/src/content/themeController.js` resolves the preference (auto → dark/light), writes `data-theme` on the panel root, and watches the OS for changes.

### Changed

- **The panel is now token-driven (the foundation of theming).** The existing `--tl-*` design tokens (4-step text ladder, surfaces, border, accent, state colors) are extended with `--tl-surface-0`, `--tl-border-strong`, `--tl-hover`, and ok/fail/review wash tokens, and the panel's ad-hoc hex sprawl (~13 popover surfaces, ~25 borders, the gray ladder, five competing accent blues) is migrated onto them. `#codex-overleaf-panel[data-theme="light"]` then remaps the token values for a light surface (state colors darkened for WCAG-AA on light); dark is the baseline and needs no override.
- **Cohesion polish folded into the tokenization.** The accent is unified to a single `--tl-accent` (teal reserved for the running state); the composer gains a real focus ring (and a no-op placebo shadow is removed); the Ask/Suggest/Auto mode switch becomes a proper segmented control with hover distinct from active; the send button is the accent primary with a stop-red hover while a run is in flight; the idle/empty state is calmer (smaller icon, entrance fade-in); the first-run onboarding tip gets real callout styling (it was unstyled floating text); panel buttons get a hover transition and a keyboard `:focus-visible` ring; and reduced-motion now also neutralizes transitions.
- Architecture budget for `contentRuntime.js` raised for the theme wiring; the deferred `contentRuntime.js` module split remains tracked.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.4.2 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.4.2` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.4.2.zip`, `codex-overleaf-native-host-v1.4.2.tar.gz`, and `codex-overleaf-link-1.4.2.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.4.2 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.4.2 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.4.2 -- uninstall-native`.

## v1.4.1 - 2026-05-31

Patch release. Fixes a cosmetic regression from the v1.4.0 timeline redesign, widens the local-path redaction layers to the canonical Unix top-level set so paths under /root /Volumes /etc /opt /usr /srv /mnt /media no longer leak, and makes the sensitive-content scan count every distinct secret. No writeback behavior changes; the native protocol stays `1`.

### Fixed

- **Jump-to-latest button never hid (v1.4.0 regression).** `.tl-jump-latest` declared `display: inline-flex` at id+class specificity, which out-specified the UA `[hidden]` rule, so the `button.hidden` toggle had no effect and the floating "↓ Latest" affordance stayed visible even at the bottom of the log. Added a `.tl-jump-latest[hidden] { display: none }` override so the button hides as intended.
- **Sensitive-content scan under-counted repeated secret types.** The per-finding dedup key omitted the match offset, so multiple distinct secrets of the same type in one source (e.g. several keys in one `.env`) collapsed into a single finding — under-reporting the "found N item(s)" total and the confirm-dialog list. The dedup key now includes `match.index`, so each distinct occurrence is reported. The scan still fail-closes.

### Security

- **Local-path redaction widened to the canonical Unix top-level set.** Three redaction layers — the line-reference sanitizer (live run-event render + persisted detail), the storage/audit sanitizers, and the native-host compile-log redactor — only matched `/Users /home /private /var /tmp` and passed `/root /Volumes /etc /opt /usr /srv /mnt /media` through verbatim. All three now match the canonical `pathRedaction.js` UNIX_TOPLEVELS set, so absolute paths from Linux hosts and external volumes no longer leak into the run timeline, persisted history/audit records, or the Codex prompt. The compile-log redactor still maps `/usr/local/texlive` to its `<TEXLIVE_PATH>` placeholder (the TeX-specific rules run first).

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.4.1 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.4.1` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.4.1.zip`, `codex-overleaf-native-host-v1.4.1.tar.gz`, and `codex-overleaf-link-1.4.1.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.4.1 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.4.1 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.4.1 -- uninstall-native`.

## v1.4.0 - 2026-05-31

Experience-and-hardening release. v1.4.0 redesigns the two surfaces the user lives in — the streaming run timeline and the Settings panel — to match the agent panels in VSCode Claude Code / Codex / Cursor, lands the seven BLOCKER fixes from the 10-agent security review (compile-log redaction, modern-token detection, oversize-frame survival, storage-quota corruption, cancel-during-write truthfulness, file-tree partial-mutation, single fetch wrapper), and closes the completion-report status/answer separation so run metadata never reads as part of Codex's answer — on a fresh run, after reload, or from a quota-compacted fallback. No core writeback behavior changes; the native protocol stays `1`.

### Changed

- **Streaming timeline redesign (Cursor-style stepped view).** The run timeline is rebuilt around a typographic status system and a smoother scroll engine, grounded in a code-mapped analysis of the real render pipeline. No information shown changes — only how it looks, scrolls, and feels.
  - `scrollLogToBottom` coalesces a streaming burst into one `requestAnimationFrame` write per frame (was a synchronous write plus a second rAF write — two forced reflows, up to ~25/sec while streaming) and re-checks follow-intent **at paint time**, so a user who flicks up between schedule and paint is never snapped back. A forced scroll survives the coalesce and re-arms auto-follow.
  - New floating **jump-to-latest** button (`.tl-jump-latest`): appears only while scrolled up, carries an unread-step counter (discrete activity/report steps, not streaming deltas), and is pinned in the non-scrolling thread section.
  - Status glyphs (idle / running-spinner / completed / failed) replace the colored-dot rail; the run-process summary pins to the top of the scroller with a **live elapsed tick** so a working run is distinguishable from a hung one; the collapsed header appends the step count; stream rows get a role-colored left rule.
  - A shared design-token system (`--tl-*`: a 4-step gray ladder replacing eight near-identical grays, surfaces, one accent, semantic state colors, radii), opacity-only row fade-in that never reflows neighbors, a `prefers-reduced-motion` opt-out, and a dark-themed scrollbar on the log column.
- **Settings panel redesign (cards + collapsible groups).** Personalization, Governance Rules, and Skills are now collapsible `<details>` groups, each a bordered card reusing the timeline `--tl-*` tokens, with per-field help text (English + 中文). The two governance booleans (sensitive-content check, explicit-confirmation) adopt the same sliding switch as the skill toggles, the previously-inert "Saved" label now flashes `✓ Saved` on each auto-save, and the local-skill Remove / Confirm / Cancel actions get real bordered button styling (Confirm in a danger variant).
- **Completion-report meta block bumped 11.5px → 12px** with token colors to clear WCAG-AA at the muted color.
- Architecture budget for `contentRuntime.js` raised to fit the scroll engine, timeline, and completion-report split helpers; the deferred `contentRuntime.js` module split remains tracked.

### Fixed

- **Completion-report status lines now demote in every render path.** `Write result` / `Undo` / `Next` / `Why nothing changed` are run metadata, not part of the answer. The structured render already demoted them into a muted, separated block, but any event lacking a structured payload — persisted before structured reports existed, restored from a quota-compacted prefs-only fallback, or reloaded — fell back to a flat render that mixed them into the conclusion. The fallback now splits those trailing status sections out of the flat text into the same demoted meta block (`splitFlatCompletionReport` + the shared `appendCompletionMetaBlock`), with a single-line guard so conclusion prose containing "Next: …" is never mis-demoted.
- **Completion-report structured payload survives reload (B-series follow-up).** Run-event storage compaction whitelisted event fields and dropped `detailStructured` + `failure`, so the meta demotion reverted to the flat render and the `codex_project_locked` "Force-release the stuck task" button disappeared after a reload. Both fields are now preserved through all three compaction sites (`sessionState.normalizeRunEvents`, `sessionState.compactRunEvents`, `storageDb.compactRunEventsForStorage`) — the IndexedDB path via a dedicated bounded structured compactor so the generic detail compactor can't redact the `{conclusion, body, meta[]}` shape to a hash summary.
- **B1 — native host survives oversize frames.** `writeResponse` wraps `encodeMessage` in try/catch with a truncated-event fallback and a final `native_response_too_large` error, instead of throwing out of the stdout handler into an `uncaughtException` that exited the process mid-run.
- **B4 — storage-quota fallback no longer corrupts task text.** `prepareCompactFallbackState` writes a `__codexOverleafCompactFallback`-tagged prefs-only blob (task / sessions / runs stripped) instead of redacted `[task omitted]` markers, and the loader returns prefs-only on that marker so the markers can never be re-persisted as real session data.
- **B2 — cancel-during-write reports the truth.** The operation that was mid-write when cancel landed is reported with `changedDocument: true` and warning severity (the editor may already hold part of that write), distinct from the not-yet-started tail ops which stay `changedDocument: false`.
- **B3 — file-tree op stops instead of stacking a partial change.** Once a tree-manager method has been invoked, a throw returns `file_tree_operation_unverified` rather than falling through to the next method and stacking a second partial mutation on inconsistent state.
- **B7 — compile bridge fetch wrapper installs once.** The interceptor state lives on a page-window sentinel and bails when our wrapper is already current, so extension re-injection on upgrade no longer stacks fetch wrappers.

### Security

- **B5 — compile log no longer leaks to Codex verbatim.** `redactCompileLogText` strips Bearer / AWS / Google / Hugging Face / GitLab / Stripe / JWT secrets and local absolute paths (`/Users`, `/private/var`, `/var/folders`, `/tmp`, TeX-Live, Windows) from the compile log, errors, and warnings before they reach the Codex model.
- **B6 — sensitive-content scan detects modern token formats.** Added AWS access-key (`AKIA…`), Google API-key (`AIza…`), Hugging Face (`hf_…`), GitLab (`glpat-…`), Stripe live-secret (`sk_live_…`), and JWT detectors, so these secrets are caught at the preflight gate instead of being mirrored to disk and read by Codex.

### Release

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, README release commands / badges, and release tracking metadata for the v1.4.0 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.4.0` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.4.0.zip`, `codex-overleaf-native-host-v1.4.0.tar.gz`, and `codex-overleaf-link-1.4.0.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.4.0 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.4.0 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.4.0 -- uninstall-native`.

## v1.3.9 - 2026-05-27

Cancellation and concurrency hardening release. v1.3.9 makes the cancel button responsive sub-100 ms in every phase of a Codex run (Codex thinking, mid-writeback, post-write verification), adds a force-release recovery for stuck project locks, eliminates the cross-project write race introduced by long per-op pipelines, and ships a cleanup batch (debt registry, architecture budgets, extractFunction helper) that returned the codebase to a maintainable state after the v1.3.8 P0 churn.

### Added

- **Sub-100 ms cancel during writeback.** The content-side `sendPageBridgeRequest` now registers a per-request reject handler in `activePageBridgeCancellationHandlers` for the writeback methods (`applyOperations`, `acceptTrackedChanges`, `rejectTrackedChanges`). `cancelActiveRun` synchronously rejects every in-flight handler before doing anything else, so the run-card's spinner stops on the very next microtask instead of waiting for the page bridge to finish its loop. The native `codex.cancel` and the page-side `cancelActiveWrite` signals are now fire-and-forget (`Promise.allSettled`) — UI no longer waits for either round-trip. A new page-side cross-world cancel mechanism (`pageBridge.cancelActiveWrite` + `writebackRouter.applyOperationsCore`'s sequence-bump check + per-op `Promise.race` against a 50 ms poller) tells the background writeback to also stop cleanly so abandoned ops do not keep mutating Overleaf state.
- **Force-release recovery for stuck project locks.** When a run leaks the native-host project lock (Codex CLI hangs past the idle watchdog, a previous extension version crashed mid-writeback, etc.), `codex.cancel` now accepts a `projectKey` to find the controller without the original `requestId` and a `force: true` flag to drop the lock entry when no controller is registered. The completion-report renders a one-click **"Force-release the stuck task"** button under `codex_project_locked` failures so the user no longer has to restart Chrome to escape a stuck lock.
- **Mid-run project-change guard inside `applyOperationsCore`.** Each per-op iteration re-checks the editor's current project against the run's bound `runProjectId`. If the user SPA-navigates Overleaf to a different project mid-writeback, the remaining operations are skipped with `aborted_project_changed` instead of landing in the wrong project. `ensureReviewing` / `ensureEditing` dispatchers now run the same guard so the pre-flight toggle cannot flip Track Changes in a wrong project.
- **Hydration-tolerant write-guard.** The page-side editor project-id reader now retries with 100/300/700 ms backoff (~1.1 s ceiling) before failing closed, so a writeback that starts during Overleaf's editor hydration window no longer reports the misleading "Refresh Overleaf and retry" error. URL is accepted as a third source only when it exactly matches the immutable run project id.
- **Codex app-server idle watchdog.** `codexSessionRunner` now has a default 10-minute idle timeout (`CODEX_OVERLEAF_CODEX_IDLE_TIMEOUT_MS` overridable) that aborts a Codex session if it stays silent past the deadline and releases the project lock — covers the "Codex sends `turn/started` and hangs forever" case.
- **New FailureReason catalog codes**: `codex_project_locked`, `codex_timeout`, `codex_output_limit`, `codex_not_found`, plus bilingual i18n strings. `translateRawError`'s eleven regex branches now also return a `failureCode` so callers attach structured failure data alongside the human text.
- **Structured run-state persistence**: `runProjectId` is now persisted on every run record (`sessionState` + `storageDb`), so writeback / Accept / Undo on a restored run targets the original project rather than the editor's current one. `getRunProjectIdForWriteback` fails closed when the run record has no `runProjectId` instead of falling back to the current project id.
- **Native-host transient reconnect filter.** The Codex app-server's `error: 'Reconnecting X/Y'` notifications during network blips are recognized as transient and surfaced as warnings — they no longer abort the turn. The reconnect text is surfaced as the visible event title so the run timeline reads `Reconnecting... 2/5` instead of a generic `error`.

### Changed

- **Completion-report visual demotion of system meta**: the human-language conclusion keeps its 13 px / `#d4d4d4` styling; `Why nothing changed` / `Write result` / `Undo` / `Next` render in a dedicated `<dl>` block beneath a thin separator at 11.5 px in muted color, so they read as run metadata rather than part of Codex's answer. Failed-status reports keep their alert color on the conclusion while the meta stays muted.
- **`applyOperations` page-bridge timeout raised 8 s → 30 s.** Page-side `openFileByPath` alone can wait 5 s × 4 fallback methods on slow file trees; the pre-fix 8 s timeout fired mid-write and left zombie writes running while the content side reported failure. 30 s covers the realistic slow path; cancel responsiveness is now driven by the cross-world cancel mechanism above, not by the timeout.
- **Misleading "no usable result" fallback retired.** `translateRawError` now accepts a `codexReturned` context flag; when Codex's `assistantMessage` arrived on the stream before an unrelated exception escaped, the conclusion reads "Codex returned a result, but local post-processing of this run failed" instead of claiming Codex returned nothing. The legacy copy still fires for genuine no-result paths.
- **`needs_review` tracked-change runs** now render the same primary Accept / Undo buttons as `pending` — the previous "needs review" labels conflated an internal retryable proof state with a different UX.
- **Settings back-button respects the current route**: clicking Back from Settings on the `/project` Recent-projects URL now returns to Recent rather than unconditionally showing the per-project session view.
- **Codex Overleaf skills entry** now displays a single clean row name (with the underlying id as the tooltip) and the enabled count refreshes immediately after toggles.
- **Architecture budget enforcement** added freeze-line ceilings for the four largest unbudgeted files (`contentRuntime.js`, `writebackRouter.js`, `treeOperations.js`, `storageDb.js`). The write-guard surface was extracted from `pageBridge.js` to `extension/src/page/writeGuard.js`, returning `pageBridge.js` under the 2200-line budget; the v1.3.8 budget shim was removed.
- **Shared test helper for `extractFunction`** (consolidated from five duplicate copies; the parser now walks past the parenthesized signature so default-value braces like `function foo(input = {}) { … }` no longer break extraction — the dormant bug that bit v1.3.8 work three times).
- **`translateRawError`** regex branches now also return `failureCode` so callers attach structured FailureReason events alongside the existing text; three new catalog codes (`codex_timeout`, `codex_output_limit`, `codex_not_found`) cover branches that previously had no structured match.
- **DI `typeof X === 'function'` guards collapsed** to destructuring defaults in `contextTray.js`, `localSkillsPanel.js`, `writebackRouter.js`, `treeOperations.js` — 34+13 occurrences eliminated; passing `null` or a non-function value now fails loudly rather than silently swapping in a noop.
- **Stale `v1.3.8 add-on` framing comments** (~30 sites) rewritten as plain feature descriptions now that v1.3.8 has shipped.
- **`contentRuntime.js` source reads centralized**: the 145 `fs.readFileSync(.../contentRuntime.js)` repetitions in `test/p0ProductExperience.test.js` are replaced with a cached `getContentScriptSource()` helper; 77 `extractFunction(contentScript, name)` call sites adopt the `extractFromContentScript(name)` shortcut.
- **Six unused exports trimmed** from `staleGuard.js` / `sensitiveScan.js` / `pathRedaction.js`, and one truly-dead function (`mightContainLocalPath`) removed.
- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, and release tracking metadata for the v1.3.9 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.3.9` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.3.9.zip`, `codex-overleaf-native-host-v1.3.9.tar.gz`, and `codex-overleaf-link-1.3.9.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.3.9 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.3.9 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.3.9 -- uninstall-native`.

### Fixed

- **Write-guard batch-skip crash that masked partial-sync conclusions** (v1.3.8 add-on): the guard emitted `operation: null` skip entries; `summarizeOperationForAudit(operation = {}, ...)` only defaulted on `undefined` so `null.path` threw and the outer catch swallowed the partial-sync report. The summarizer now normalizes null/undefined; both emit sites push `operation: {}`.
- **`saveStateSoon` in-flight race**: a debounce timer firing while an async `saveState()` was still writing could let an older snapshot land after newer state mutations. Tracks an in-flight flag and queues at most one trailing run.
- **Settings back-button** on `/project` URL no longer renders an empty per-project session view.

### Notes

- Native protocol stays `1`; this release adds cancellation responsiveness, structured cancellation cleanup, the writeback project-ID guard, the force-release recovery, and the native-host idle watchdog, not the native messaging protocol.
- The page-side `Promise.race` cancel mechanism is preserved as the cleanup path for abandoned background writes — the user-perceived "instant cancel" is delivered by the content-side reject path, but the page-side race still tells the background work to stop so abandoned ops do not keep mutating Overleaf.

## v1.3.8 - 2026-05-25

Reliability and clarity release. This version adds structured failure reasons, a Recent-projects welcome panel on the `/project` URL, a writeback project-ID guard that fails closed on mid-run navigation, and a native-host filter for transient Codex reconnect notifications that was the root cause of "local Codex returned no usable result" failures during network blips. The completion report now visually separates Codex's answer from run metadata, and several UX papercuts around skipped writebacks, post-navigation runs, and tracked-change buttons are smoothed over.

### Added

- **Specific Failure Reasons v1**: a 47-code FailureReason catalog with stage / severity / retryable / terminalState fields. Page-side and content-side writeback paths now emit structured failures, the run card and completion report render the localized userMessage + nextAction, and the same shape persists through the run record so failure reasons survive reload.
- **Recent-projects welcome panel**: on the `/project` URL (no specific project) the panel now renders a cross-project list of recent runs with status badges, instead of an empty per-project session view. Accounts are scoped via a SHA-256 hashed account identity (no display-name fallback) so projects from different Overleaf accounts stay isolated.
- **Writeback project-ID guard**: every `applyOperations` / `acceptTrackedChanges` / `rejectTrackedChanges` dispatch is gated by a `runProjectId` vs page-side `editorProjectId` check. Mid-run SPA navigation to a different project aborts with `aborted_project_changed`; an unhydrated editor produces `editor_project_id_unavailable`. The guard is hydration-tolerant — it retries the page-side reader with a 100/300/700 ms backoff (~1100 ms ceiling) before failing closed, so runs that start during Overleaf's initial hydration window now succeed instead of misleadingly reporting "Refresh Overleaf and retry".
- **`codex_project_locked` failure reason**: when a second Codex task is started for the same Overleaf project while the first is still running, the run card shows "Codex task already running" with a `blocked` (not `failed`) status and clear next-step guidance.
- **Native-host transient reconnect filter**: Codex app-server "Reconnecting X/Y" notifications during network blips are now classified as warnings instead of fatal errors, so the turn keeps running and surfaces the actual answer once the connection recovers. The reconnect line is shown in the run timeline as its visible title (e.g. "Reconnecting... 2/5") instead of a generic "error".
- **Run record carries `runProjectId`**: the project the run was bound to is persisted on the run record across reload (used by the writeback guard, the post-navigation settlement, and the undo writeback path).

### Changed

- **Completion report visually separates conclusion from system metadata**: the human-language conclusion keeps the existing 13 px contrast, while `Why nothing changed` / `Write result` / `Undo` / `Next` render in a dedicated `<dl>` meta block beneath a thin separator at 11.5 px in muted color. Failed-status reports keep the alert color on the conclusion but the meta stays muted so it reads as run metadata rather than amplifying the alert.
- **Post-navigation run settlement**: after the user navigates away from the project a still-running task was bound to, the run settles into one of `background_completed` (writeback applied), `needs_review_after_navigation` (partial), or `abandoned_after_navigation` (no usable result). Each carries a human-readable statusText, and the panel CSS gives `needs_review_after_navigation` its own warning color and `abandoned_after_navigation` the same red as `failed` so the run timeline no longer shows two visually inconsistent "Failed" badges.
- **Misleading "no usable result" fallback retired when Codex actually returned**: `translateRawError` now accepts a `codexReturned` context flag. When Codex's assistant message landed on the stream before an unrelated exception escaped the outer catch, the conclusion now reads "Codex returned a result, but local post-processing of this run failed" instead of "local Codex returned no usable result, so no writes were confirmed". The legacy copy still fires for genuine no-result paths.
- **Better "empty result" copy**: when Codex completes a turn with no assistant message and no file changes, the run report now reads "Codex completed, but it produced no assistant response and no local file changes" with explicit retry guidance instead of the generic "Codex finished but did not return a usable result".
- **`needs_review` tracked-change runs** now show the same primary Accept / Undo buttons as `pending` — the previous "needs review" labels were confusing UX for an internal retryable proof state.
- **Settings back button respects the current route**: clicking Back from Settings on the `/project` URL now returns to the Recent-projects variant instead of unconditionally rendering the per-project session view.
- **Codex Overleaf skills entry** now shows a single, clean row name (with the underlying id as the tooltip) and the enabled count refreshes immediately after toggles.
- **Batch-level guard skip header** now reads "writeback process was not written" instead of the misleading "unknown file: process was not written" when the write-guard fires before any per-op dispatch.
- **`recentProjects_badge_needs_review` / `_needs_review_after_navigation`** simplified to "pending" / "待处理" to match the executable state the buttons present.
- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, and release tracking metadata for the v1.3.8 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.3.8` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.3.8.zip`, `codex-overleaf-native-host-v1.3.8.tar.gz`, and `codex-overleaf-link-1.3.8.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.3.8 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.3.8 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.3.8 -- uninstall-native`.

### Fixed

- **Write-guard batch-skip crash that masked partial-sync conclusions**: when the guard fired, the skip entry carried `operation: null` but `summarizeOperationForAudit(operation = {}, ...)` only defaulted on `undefined` — `null.path` threw `TypeError`, the outer catch swallowed the partial-sync report, and the user saw the misleading "local Codex returned no usable result" fallback. The summarizer now normalizes null/undefined inside the body, and both guard emit sites use `operation: {}` to match the function's signature intent.

### Notes

- Native protocol stays `1`; this release adds structured FailureReason content, the welcome panel, the writeback project-ID guard, and the reconnect-tolerant native host path, not the native messaging protocol.
- The write-guard hydration retry adds up to ~1100 ms of latency only on writes that hit Overleaf's hydration window; the steady-state happy path is unchanged.

## v1.3.7 - 2026-05-23

Accept changes release. This version adds a per-run **Accept changes** control on the run card so a Codex run's Overleaf tracked changes can be accepted in one click — the accept counterpart of the existing Undo — along with release metadata alignment for the v1.3.7 packaging, compatibility, and release tracking surfaces.

### Added

- Per-run **Accept changes** control on the run card (positioned before Undo) that accepts all of the current run's Overleaf tracked changes in one click and drives the run to a terminal accepted state. The mechanism first reverts the run's tracked writeback via the same editor-undo path the existing Undo relies on, then replays the run's own original forward patches as a non-tracked edit so the run's content lands as plain permanent text. The replay waits for Overleaf's Editing mode to remain stable before each per-op write, watches for fresh tracked changes during the write, and rolls back via editor-undo if Overleaf reintroduces tracked changes — leaving the run pending and the document unchanged rather than silently double-tracking.
- New `trackedChangeStatus` per-run lifecycle field with three stable values (`pending` / `accepted` / `rejected`); Accept changes and Undo are mutually exclusive terminal actions and both buttons stay visible but disabled at terminal so the run card always shows the lifecycle clearly.

### Changed

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, and release tracking metadata for the v1.3.7 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.3.7` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.3.7.zip`, `codex-overleaf-native-host-v1.3.7.tar.gz`, and `codex-overleaf-link-1.3.7.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.3.7 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.3.7 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.3.7 -- uninstall-native`.

### Notes

- Native protocol stays `1`; this release adds the Accept changes UI and lifecycle, not the native messaging protocol.
- Accept changes leaves Overleaf in Editing mode after a successful replay (Track Changes is not auto-re-enabled) to avoid Overleaf re-tracking the just-replayed text; turn Reviewing / Track Changes back on manually once Overleaf has saved the accepted text.

## v1.3.6 - 2026-05-22

Writeback patch granularity release, with release metadata alignment for the v1.3.6 packaging, compatibility, and release tracking surfaces. This version makes Overleaf writeback patches match editing intent so reviewed changes land as coherent units, and fixes Reviewing-mode undo and a hardcoded-Chinese restored-run message.

### Changed

- Overleaf writeback patches are now generated to match editing intent: a paragraph rewrite produces one coherent paragraph patch/hunk, a sentence rewrite one sentence patch, and a newly inserted annotated-rewrite `% [original]` / `% [revised]` block one block patch, while small word fixes stay small token patches and far-apart edits stay independent. This replaces the previous token-minimizing strategy that fragmented a paragraph rewrite into many tiny tracked changes in Overleaf Reviewing.
- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, and release tracking metadata for the v1.3.6 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.3.6` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.3.6.zip`, `codex-overleaf-native-host-v1.3.6.tar.gz`, and `codex-overleaf-link-1.3.6.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.3.6 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.3.6 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.3.6 -- uninstall-native`.
- Reorganized the README install section into two clear paths — the installer script (sets up the native host and the extension) and npm (native host only).

### Fixed

- Reviewing-mode undo could leave a wide paragraph rewrite only partially reverted; undo now uses the writeback's verified post-write content instead of a re-derivation that could drift from the editor state.
- The restored-run "stopped tracking after a page refresh" messages were hardcoded in Chinese and showed Chinese text in the English UI; they are now localized.

### Notes

- Native protocol stays `1`; this release changes writeback patch granularity, undo handling, localization, and packaging metadata, not the native messaging protocol.

## v1.3.5 - 2026-05-22

Personalization isolation and settings experience release, with release metadata alignment for the v1.3.5 packaging, compatibility, and release tracking surfaces. This version stops the plugin Codex home from inheriting global Codex personalization, ships a new bundled annotated-rewrite skill, and reworks settings into a full-screen view with unified auto-save and per-skill enable toggles.

### Added

- Bundled the official `annotated-rewrite` Codex Overleaf skill: when rewriting `.tex` content it comments out the original under a `% [original]` marker and writes the replacement under a `% [revised]` marker so the before/after diff stays visible in the source.
- Added a save-status indicator to the settings panel that reflects unified auto-save state.
- Added per-skill enable/disable toggles so each Codex Overleaf skill can be turned on or off individually, honored at run time.

### Changed

- Release metadata alignment: bumped the package, lockfile, extension manifest, compatibility target, and release tracking metadata for the v1.3.5 release.
- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.3.5` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.3.5.zip`, `codex-overleaf-native-host-v1.3.5.tar.gz`, and `codex-overleaf-link-1.3.5.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.3.5 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.3.5 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.3.5 -- uninstall-native`.
- The plugin Codex home no longer inherits the user's global Codex personalization: it no longer copies `~/.codex/AGENTS.md`, strips the top-level `personality` key from the copied `config.toml`, and no longer symlinks the `rules` and `memories` directories, with stale-state cleanup of those entries from previously prepared Codex homes.
- Reworked the settings panel into a full-screen in-panel view with back navigation instead of a floating popup overlay.
- Unified settings auto-save: every settings field now saves automatically and the explicit Save button was removed.
- Moved Codex Overleaf skill management to a dedicated settings sub-page with sliding-switch controls, an inline remove-confirmation, and loading states.

### Fixed

- Stopped fullwidth CJK punctuation from being absorbed into file-path tokens when parsing clickable line references.

### Notes

- Native protocol stays `1`; this release changes packaging metadata, personalization isolation, and the settings experience, not the native messaging protocol.

## v1.3.0 - 2026-05-20

Nested Overleaf file writeback stabilization release. This version focuses on making subdirectory file edits reliable after the user switches between files, and on aligning extension/native version surfaces for release diagnostics.

### Changed

- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.3.0` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.3.0.zip`, `codex-overleaf-native-host-v1.3.0.tar.gz`, and `codex-overleaf-link-1.3.0.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.3.0 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.3.0 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.3.0 -- uninstall-native`.

### Fixed

- Hardened nested file-tree navigation so writeback waits for the target CodeMirror document to load before replacing editor content.
- Fixed blank target-file readiness handling so empty subdirectory files do not falsely match before Overleaf has switched the editor document.
- Preserved structured writeback diagnostics in skipped-result reporting for future stale-write investigations.

## v1.2.6 - 2026-05-20

Release metadata alignment patch for v1.2.6 packaging, compatibility, and release tracking surfaces, plus a nested Overleaf file writeback safety fix.

### Fixed

- Fixed nested Overleaf file-tree path resolution for folder-list DOM layouts where a folder row and its child file list are siblings instead of DOM ancestors.
- Hardened writeback so Codex verifies the active CodeMirror document belongs to the requested project-relative path before applying edits.
- Forced a target-file reopen when the file tree selected path and the active editor document are out of sync, preventing edits intended for files such as `example/test.tex` from being applied to `main.tex`.

### Changed

- Bumped package, extension manifest, compatibility target, README release commands, and release tracking metadata to `1.2.6` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.2.6.zip`, `codex-overleaf-native-host-v1.2.6.tar.gz`, and `codex-overleaf-link-1.2.6.tgz`.
- Native host install remains `npm exec --yes codex-overleaf-link@1.2.6 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.2.6 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.2.6 -- uninstall-native`.

## v1.2.1 - 2026-05-15

Stability patch for the public v1.2 distribution path.

### Changed

- Hardened content runtime initialization against duplicate injection on long-lived Overleaf tabs.
- Added compact overlay panel behavior for narrow browser windows so the Overleaf editor is not squeezed below a usable width.
- Hardened the tag release workflow to build and verify GitHub Release artifacts before npm publication, with retrying npm visibility checks.
- Updated uninstall documentation to lead with npm-first native host commands.
- Added a total composer attachment size limit while preserving the existing per-file and count limits.
- Expanded line reference handling for complex Markdown/local path cases while preserving local path sanitization.
- Native host install remains `npm exec --yes codex-overleaf-link@1.2.1 -- install-native`.
- Native host diagnostics remain `npm exec --yes codex-overleaf-link@1.2.1 -- doctor`.
- Native host uninstall is `npm exec --yes codex-overleaf-link@1.2.1 -- uninstall-native`.

## v1.2.0 - 2026-05-13

Release metadata alignment patch for v1.2 packaging, compatibility, and release tracking surfaces.

### Changed

- Bumped package, extension manifest, compatibility target, README release commands, and native ping metadata to `1.2.0` while keeping native protocol `1`.
- Current release artifact names now resolve to `codex-overleaf-link-extension-v1.2.0.zip`, `codex-overleaf-native-host-v1.2.0.tar.gz`, and `codex-overleaf-link-1.2.0.tgz`.
- Release tracking tests now assert v1.2.0 package, lockfile, extension, and compatibility metadata alignment.

## v1.1.3 - 2026-05-12

Release pipeline hardening patch for checksum-verifiable GitHub assets and npm-first release consistency.

### Changed

- Release builds now publish top-level native helper assets whose names match `SHA256SUMS` and `release-manifest.json`.
- CI now runs release metadata/source hygiene and npm package manifest checks on normal main and PR workflows.
- The tag release workflow now publishes or verifies the npm package before publishing the GitHub Release.
- README installation guidance is npm-first for native-host setup and uses the GitHub Release extension zip as the primary unpacked extension source.
- Bumped package, extension manifest, compatibility target, and native ping metadata to `1.1.3` while keeping native protocol `1`.

## v1.1.2 - 2026-05-11

Release hygiene patch for public source and package surfaces.

### Changed

- Removed internal roadmap and release-planning docs from the public tracked source tree and release source archives.
- Updated release verification to reject tracked `ROADMAP.md`, `docs/`, and generated npm package manifest artifacts.
- Kept npm/native release artifacts document-free while preserving npm-first install, doctor, and uninstall commands.
- Bumped package, extension manifest, compatibility target, and native ping metadata to `1.1.2` while keeping native protocol `1`.

### Fixed

- Avoided fake secret literals in tests that can trigger external secret scanners despite not being real credentials.

## v1.1.1 - 2026-05-08

Small native-host update guidance patch for npm-first local installs.

### Changed

- Popup and panel native-host mismatch guidance now recommends the pinned npm CLI command: `npm exec --yes codex-overleaf-link@1.1.1 -- install-native`.
- Official release update commands omit `--extension-id` for the bundled stable extension id, while custom/dev unpacked extension ids still preserve the explicit `--extension-id` recovery path.
- README and manual release checklist now treat GitHub Release `install.sh` / `install.ps1` scripts as fallback installers instead of the primary native-host update command.
- Bumped package, extension manifest, compatibility target, and native ping metadata to `1.1.1` while keeping native protocol `1`.

## v1.1.0 - 2026-05-08

Version alignment and manual GitHub Release distribution guidance for the v1.1 native-host package.

### Added

- npm native installer CLI guidance with release-pinned `npm exec` install, doctor, and uninstall commands.
- Native doctor command documentation for diagnosing the installed native host without installing the Chrome extension.
- npm package content gates that verify the package includes only the intended native-host runtime files.
- Manual extension release checklist for the current GitHub Release/unpacked-extension distribution path.

### Changed

- Bumped package, extension manifest, compatibility target, and native ping metadata to `1.1.0` while keeping native protocol `1`.
- Documented that npm installs, updates, uninstalls, and diagnoses the native host only, and that the Chrome extension must be installed separately.
- Kept official native-host installs one-command by defaulting to the bundled stable extension id, while preserving `--extension-id` for custom or mismatched unpacked builds.
- Documented the safe runtime root copy used by the npm/native installer path.
- Shifted v1.1.0 release guidance to GitHub Release artifacts plus manual unpacked extension loading without requiring normal users to copy an extension id.

## v1.0.0 - 2026-05-07

Production-stable release documentation and gate hardening for regular academic writing workflows across macOS, Windows, Linux Chrome, and Linux Chromium.

### Added

- Synthetic large-project regression gate support for v1.0 CI, including snapshot, mirror sync, diff/patch, context tray, storage preparation, native frame size, and internal benchmark failure assertions.
- Static HTML privacy policy page for Chrome Web Store listing and GitHub Pages publication.
- README Quick Start and Common Workflows sections for first-time install, safe Ask/Suggest usage, compile-error repair, paragraph rewrite, and translation workflows.

### Changed

- Bumped package metadata, README install/update commands, release artifact names, Chrome Web Store checklist references, and release docs to `v1.0.0`.
- `npm run check:architecture` now enforces final v1.0 `maxLines` budgets by default with no `currentCeiling` exceptions.
- CI release gates now include architecture budget enforcement and the synthetic large-project regression gate on macOS, Windows, and Linux with one retry for runner variance.
- ROADMAP v1.0 status now reflects production-stable release criteria and the required gate checklist.

### Notes

- Chrome Web Store approval remains a soft gate; rejection is handled as a follow-up `v1.0.1` patch while the GitHub Release path remains available.
- Manual smoke signoff records startup timing as observations only; synthetic CI ceilings are regression guards, not real-world latency promises.

## v0.9.5 - 2026-05-07

Architecture hardening release for the v0.9 release-candidate line. This version focuses on reducing maintenance risk in the largest files, correcting project skill activation semantics, and tightening release gates without adding major user-facing surface area.

### Added

- Focused content-script modules for composer attachments, diff review rendering, and the context tray while keeping `contentScript.js` as the composition root.
- Focused page-bridge capability guard, native request quota, and native response-budget modules.
- Architecture budget checks for the largest content, page-bridge, and native runner files, including explicit exceptions for files that still need follow-up splitting.
- Regression tests for Codex Overleaf skill auto-trigger availability, slash-selected forced skill invocation, and hidden project-local skill non-exposure.
- Release tracking tests that ensure manifest-loaded extension files and native relative `require()` targets are git-tracked before packaging.

### Changed

- Bumped package, extension, README, release artifact, and native compatibility metadata to `0.9.5`.
- Codex Overleaf skills remain materialized into the plugin-scoped Codex home when enabled, so unselected plugin skills can participate in normal Codex skill triggering without exposing the user's global Codex local skills.
- Slash-selected Codex Overleaf skills are treated as forced turn-scoped invocations, while stale selections are ignored when their skill scope is disabled.
- Project-local skills are no longer shown in settings or exposed to normal UI runs; the legacy native API remains for compatibility.
- Architecture checks now fail if oversized files grow beyond their documented v0.9.5 exception ceilings.

### Fixed

- Disabled user-local Codex skills no longer leak back into runs through the project skill path.
- Release hygiene now catches newly split extension/native modules that would otherwise be omitted by `git ls-files`-based artifact packaging.

## v0.9.0 - 2026-05-07

Release-candidate hardening release. This version focuses on release gates, real workflow smoke coverage, payload safety, security/privacy hardening, and public documentation accuracy rather than new product surface area.

### Added

- A redacted Chrome smoke runner with `panel`, `native`, `project`, `diagnostics`, and `all` probes, plus JSON output for release-candidate evidence.
- A real Overleaf release-candidate checklist covering install/update, ask/suggest/auto/undo/compile/context, attachments, governance, sensitive preflight, local skills, stale conflicts, and diagnostics redaction.
- A synthetic large-project benchmark with 250+ files, long `.tex` files, binary assets, oversized binary degradation, repeated session state, and required performance metrics.
- Public compatibility and troubleshooting documentation for Chrome/Chromium support, native host paths, local data cleanup, diagnostics, skill toggles, and issue reports.
- Regression tests for diagnostics/session redaction, task/native request quotas, smoke redaction, final native response sizing, and issue-template release triage fields.

### Changed

- Bumped package, extension, README, release artifact, and native compatibility metadata to `0.9.0`.
- Native compatibility now requires a v0.9 native host so extension and bridge agree on release-candidate gates, quotas, diagnostics behavior, and skill-installer containment.
- Diagnostics export now favors allowlisted summaries over broad raw object redaction.
- Smoke and diagnostics paths report counts, byte sizes, capability status, and error categories without project text, prompt bodies, compile logs, diffs, binary data, or raw secrets.
- Windows pinned install/update and native mismatch recovery docs now explicitly set `CODEX_OVERLEAF_REF`.

### Fixed

- Final native responses now degrade oversized text writeback before native message encoding instead of allowing content, previous content, diffs, or patches to exceed the output frame limit.
- Oversized binary writeback now produces explicit unsupported-change guidance instead of inlining payloads that can exceed native message limits.
- Page-bridge requests now reject spoofed or unsafe paths before browser mutation while preserving authorized e2e writeback flows.
- Skill installer command approval is constrained to safe read-only inspection and contained HTTPS `git clone` writes under Codex Overleaf skill roots.
- Native request quotas now cover project snapshots, file overlays, proposed operations, secondary operations, compile logs, attachments, and skill content before mirror mutation or confirm-plan creation.
- Project file listing preserves real Overleaf folder hierarchy and ZIP byte-size metadata without reading or exposing file contents for list-only contexts.

### Notes

- Native protocol remains `1`; this release uses version and capability gates because v0.9 extension and native host behavior must match.
- Actual Chrome Web Store submission and real Overleaf manual smoke signoff remain release-process steps after artifacts are built.
- There is still no hosted telemetry; diagnostics and audit data remain local and redacted by default.

## v0.8.0 - 2026-05-06

Governed attachment, binary asset, and local skill release. This version completes the remaining v0.7 turn-scoped attachment and local skill workflows, then adds the v0.8 collaboration governance layer for safer shared Overleaf projects.

### Added

- Composer paste/drop attachments for PDFs, images, and files as turn-scoped Codex context without writing them to Overleaf.
- Binary asset change collection for Codex-created PDFs and images, with explicit confirmation before create or overwrite writeback.
- Project-local skill install, list, enable, remove, and prompt injection through the native host without touching the user's global Codex configuration.
- Local audit records for Codex runs, including prompt metadata, selected files, summaries, skipped changes, governance decisions, and result status.
- Project-level writable and read-only file rules that block matching writeback operations before browser mutation.
- Sensitive-content preflight checks before sending project context to Codex.
- Exportable diagnostic bundles that redact project content by default while preserving platform, native host, compatibility, audit, and failure metadata.

### Changed

- Bumped package, extension, README, release artifact, and native compatibility metadata to `0.8.0`.
- Native compatibility now requires the `localSkills` capability so older native hosts cannot silently miss v0.8 project skill requests.
- Writeback mapping now preserves binary create and overwrite operations through the extension and reports unsupported browser binary paths instead of downgrading them to empty text files.
- Root-level PDFs are treated as user assets unless they match known generated output names or a matching root TeX source.

### Fixed

- Binary deletions from the local mirror are reported as unsupported changes instead of disappearing from the final summary.
- Sensitive scanning now catches modern `sk-...` OpenAI-style API tokens as well as older secret formats.
- Governance move and rename checks now evaluate the destination path when applying read-only and writable rules.
- Missing selected local skills now produce explicit run timeline events and prompt context.

### Notes

- Native protocol remains `1`; this release uses the capability and version compatibility gate because extension and native host must both understand governed assets and local skills.
- Diagnostics, audit logs, rules, and selected skills are local browser/native state only; this release adds no hosted telemetry.

## v0.7.0 - 2026-05-06

Project personalization release. This version adds project-scoped custom instructions that are injected into Codex runs while keeping the v0.6 hunk review workflow intact.

### Added

- A settings entry in the panel header for project-scoped custom instructions.
- A personalization settings view with a large custom instruction editor and saved per-project storage.
- Native run prompt injection so saved custom instructions are included as additional Codex context for the active Overleaf project.

### Changed

- Bumped package, extension, and native compatibility metadata to `0.7.0`.
- Updated install, update, README badge, native mismatch recovery command, and release artifact references for `v0.7.0`.

### Fixed

- Native Codex runs now preserve recoverable thread resume failures so the panel can surface session recovery issues instead of flattening them into generic failures.

### Notes

- Native protocol remains `1`; this release uses a version compatibility bump because the extension and native host both participate in custom instruction delivery.
- Custom instructions are user-defined project preferences stored locally by project id and injected only for that project's runs.

## v0.6.0 - 2026-05-06

Editor-native review UX release. This version adds hunk-level review controls and editor jump support while preserving the v0.5 cross-platform native host packaging and guarded browser writeback model.

### Added

- Hunk-level diff review metadata and panel controls for accepting, rejecting, and jumping to individual text edits.
- Editor jump plumbing for review hunks, with large-diff rendering safeguards and scoped keyboard review shortcuts.

### Changed

- Review decisions now collapse completed hunks and advance focus to the next pending hunk for faster keyboard and button review.
- Bulk accept/reject actions now fill only pending hunks while preserving manual hunk choices, including file-level hunk actions.
- Bumped package and extension metadata to `0.6.0`.
- Updated install, update, README badge, and release artifact references for `v0.6.0`.
- Release verification now derives the required release reference from `package.json` instead of a stale fixed v0.5 value.
- Release workflow now fails early when the pushed tag does not match the package version.
- Chrome Web Store preparation copy now reflects macOS, Windows, and Linux native host support.

### Fixed

- Patch-backed review hunks now render their own diff text when a display diff has fewer hunks than the underlying text patches, preventing later hunks from appearing blank.
- Truncated or unsafe hunk mappings fall back to file-level review instead of exposing misleading per-hunk choices.

### Notes

- Native protocol remains `1`; this release does not require a protocol bump.
- The v0.5 macOS / Windows / Linux packaging and installer notes remain historically intact below.

## v0.5.0 - 2026-05-06

Cross-platform native host release. This version extends the native installer, runtime paths, and release packaging beyond the original macOS-only preview while preserving the v0.4 user workflow and release safeguards.

### Added

- Windows Native Messaging host installation through `install.ps1`, including user-level Chrome registry registration and `.cmd` bridge launch support.
- Linux Chrome and Chromium Native Messaging host manifest paths under the user's config directory.
- Release artifacts for the v0.5.0 extension package, native host runtime, macOS / Linux installer, Windows PowerShell installer, uninstaller, checksums, and release manifest.
- Cross-platform CI coverage for macOS, Ubuntu, and Windows, with release publishing gated by the test matrix.

### Changed

- Bumped package and extension metadata to `0.5.0`.
- Updated install, update, release artifact, and uninstall documentation for macOS, Windows, and Linux.
- Replaced macOS-only platform requirements with macOS / Windows / Linux support guidance.

### Notes

- Release publishing remains tag-based and uploads artifacts from a single release job after the matrix passes.
- Chrome still requires manual unpacked-extension approval after the native host installer finishes.

## v0.4.0 - 2026-05-06

Distribution and update foundation release. This version keeps the v0.3 sync and writeback behavior intact while adding compatibility diagnostics, release artifacts, installer update guidance, and Chrome Web Store preparation material.

### Added

- Compatibility diagnostics for missing, old, future, protocol-incompatible, or unhealthy native hosts.
- Native request gates that block execution and mirror mutation when the installed native host is not compatible with the extension.
- Reproducible GitHub Release artifact generation for the Chrome extension package, native host runtime, installer scripts, checksums, and release manifest.
- Chrome Web Store preparation docs for permissions, privacy posture, listing copy, and the pre-submission release checklist.

### Changed

- Bumped package and extension metadata to `0.4.0`.
- Documented the v0.4.0 version-pinned installer command as the canonical update and native mismatch recovery path.
- Improved installer output with source ref, checked-out package version, extension path, native host paths, and reload/refresh next steps.

### Fixed

- Browser writeback now waits for the target file's editor document to finish loading after file-tree navigation before running stale guards or applying patches, preventing false stale conflicts during multi-file writes.

### Notes

- Actual Chrome Web Store submission is outside v0.4.
- Automatic native host updates are not included; updates remain explicit and user-driven.
- The experimental OT warm mirror remains off by default and continues to fall back to full snapshots.

## v0.3.0 - 2026-05-06

Experimental OT warm mirror release. This version focuses on reducing startup sync work for focused-file tasks while keeping the normal full snapshot path as the safe source of truth.

### Added

- Experimental read-only OT warm mirror for focused Overleaf editor changes.
- Active-editor observation for known text files, with verified native `mirror.patchFiles` updates to the local mirror.
- Per-file OT freshness metadata in mirror status, used only when focused files are fresh and covered.
- OT diagnostics showing status, fresh files, fallback state, and safe next steps without exposing project content.
- Project-scoped experimental OT preference persisted separately per Overleaf project.

### Changed

- Moved the experimental OT control out of the composer toolbar and into the diagnostics menu with a first-use confirmation prompt.
- Added lightweight `OT Live` status to the probe footer only when the experimental mirror is enabled.
- Shortened the composer compile toggle to `Compile` and made Track/Compile visual states self-contained.
- Reworked the composer toolbar layout so Track, Compile, model selection, and Send stay in stable columns.
- Kept English and Chinese UI strings locale-specific instead of mixing both languages in one control.

### Fixed

- Fixed the experimental OT toggle so it gives visible feedback, can be clicked from the diagnostics menu, and does not appear as a dead `Off` label.
- Fixed model picker alignment in the bottom toolbar after adding the Compile/Track pills.
- Preserved fallback to normal project reads whenever OT is unavailable, stale, inconsistent, or missing focused-file coverage.

### Notes

- OT warm mirror is off by default.
- Full snapshot sync remains the project-level source of truth and fallback.
- OT warm mirror is read-only with respect to Overleaf realtime channels; browser writeback still uses the existing guarded write path.
- Browser writeback, stale guards, verified save gates, and undo remain unchanged.

## v0.2.0 - 2026-05-05

Reliability and daily-use update for the macOS + Chrome preview.

### Added

- Native host reconnect handling for safe read and mirror sync requests without silently rerunning active Codex tasks.
- Dynamic Codex model discovery through the native host, with fallback to the v0.1.1 model list when local discovery is unavailable.
- Non-invasive mirror prefetch and warm-start reuse so recent local workspaces can reduce task startup wait without switching Overleaf files.
- Mirror status metadata for freshness, dirty state, project key, file count, and sync timestamps.
- Compact model configuration UI for model, reasoning effort, and speed tier.

### Fixed

- Added a verified Overleaf save-state gate before refreshing the mirror baseline after browser writeback.
- Hardened warm mirror fallback, stale mirror retry, partial snapshot boundaries, and dirty workspace detection.
- Required Editing mode for untracked browser writes and preserved Reviewing requirements per submitted run.
- Improved post-write compile handling when Overleaf save state is unavailable or unverified.
- Kept plugin session deletion feedback out of the task transcript and below the task list.

## v0.1.1 - 2026-05-04

Security and reliability hotfix for the initial stable preview.

### Fixed

- Removed the legacy shell-command external agent path; the native host now launches the bundled agent with an explicit executable and argument list.
- Restricted background native-host requests to Overleaf project pages.
- Added same-origin checks to page-bridge messages.
- Avoid replaying stale Overleaf compile request templates.
- Tightened plugin Codex home permissions for copied auth state.
- Prevented ambiguous native framing errors from being applied to unrelated pending requests.
- Prevented user-facing task diagnostics from exposing raw stack traces.
- Hardened markdown links and session-list rendering in the panel.

## v0.1.0 - 2026-05-04

Initial stable preview for using Codex from inside Overleaf.

### Added

- Chrome side panel for running Codex directly in Overleaf projects.
- Native host bridge that uses the user's local Codex CLI account.
- Per-project local mirror workspaces under `~/.codex-overleaf/projects`.
- Plugin-isolated Codex history under `~/.codex-overleaf/codex-home`.
- Full-project snapshot sync with binary asset mirroring for LaTeX checks.
- File-focused context picker with Overleaf folder hierarchy.
- Ask, suggest, and auto-write task modes.
- Optional Overleaf Reviewing / Track Changes guard for write tasks.
- Diff review, stale-write protection, and undo checkpoints.
- Auto-recompile integration and `@compile-log` context support.
- English and Chinese UI language toggle.
- One-command macOS installer and native host uninstall command.

### Notes

- This release targets macOS and Chrome with an unpacked extension install.
- Overleaf writeback and compile detection depend on Overleaf page internals and may need updates if Overleaf changes its frontend.
- The bridge runs locally, but Codex processing uses the user's configured Codex CLI account.
