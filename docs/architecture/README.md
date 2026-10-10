# Codex Overleaf Link Architecture Guide

Codex Overleaf Link connects Overleaf project reading, local Codex execution, file writeback, and Undo recovery. This guide explains where features are implemented, who owns their state, how they call each other, their known limitations, and which modules must change together.

Initial reference product version: `2.5.0`; initial runtime mapping baseline: `2073ae74747431aab8d529803d4e9f8197262388`. The guide stays in sync with the currently maintained code in this repository. Verify the versions of installed copies and browser-loaded code separately.

All new features, debugging, and other code changes follow the [Feature Development and Bug-Fix SOP](change-workflow.md). During maintenance, check the affected sections and their baseline statements. Updating part of the guide does not constitute a fresh acceptance review of the entire repository; Git history identifies specific changes.

## Reading Paths

| Task | Chapter | Main topics |
| --- | --- | --- |
| Begin feature development, debugging, or another code change | [Development and Bug-Fix SOP](change-workflow.md) | Navigation, contracts/reproduction, implementation validation, guide synchronization, and completion criteria |
| Understand the project for the first time | [System Overview](system-overview.md) | Execution contexts, loading entry points, primary call chains, and domain concepts |
| Locate where to change a feature | [Feature Change Index](feature-map.md) | Entry points, state owners, required related changes, and tests |
| Change file writeback, saving, Accept, or Undo | [Auto Editing and Undo](auto-edit-undo.md) | Diffs, patches, text and binary transfer, save evidence, and recovery |
| Change tasks, queues, sessions, or refresh recovery | [Run State and Recovery](run-state-and-recovery.md) | Execution snapshots, shared history, persistence, forks, and state projections |
| Change local messages, processes, cancellation, or locks | [Native Execution](native-execution.md) | Request ownership, app-server, retries, terminal states, and exit evidence |
| Change message admission, identity checks, or compatibility policy | [Protocols and Trust Boundaries](protocols-and-trust.md) | Channels, senders, Page tokens, the Native gate, and method consumers |
| Change model connections, protocols, or credential configuration | [Providers and Protocols](providers-and-protocols.md) | Configuration revisions, protocol conversion, streaming lifecycles, and data boundaries |
| Change subagent scheduling or result adoption | [Parallel Subagents](parallel-subagents.md) | The broker, telemetry, shared files, isolation, and adoption |
| Change style references, generation, or skill application | [Writing Styles and Skills](writing-style-and-skills.md) | Reference reading, asset versions, cancellation, run references, and skill installation |
| Change the panel, settings, attachments, or module loading | [UI and Loading](ui-and-loading.md) | Registration, control state, configuration scope, and result presentation |
| Change installation, updates, or releases | [Installation and Updates](installation-and-updates.md) | Version identity, authorization, safe points, transactions, and distribution |
| Change scanning, context scope, or write rules | [Context and Governance](context-and-governance.md) | Scan inputs, path permissions, conditions for proceeding, and auditing |

For routine maintenance, start from the feature index, open the relevant domain pages, and then read code through entry-point symbols, callers, and nearest tests. Loading every chapter is unnecessary. Related chapters jointly explain features that cross domains; for example, Undo involves page operations, mirror baselines, and run-record persistence.

## Relationships to Confirm Before Making Changes

1. **Execution context**: code runs in content, the page main world, the extension background, or Native, each with different permissions and lifetimes.
2. **State owner**: identify the module responsible for writing a fact, and the consumers that only display or cache it.
3. **Identity and timing**: trace accounts, projects, sessions, runs, requests, and configuration revisions through asynchronous calls.
4. **Failure and recovery**: examine cancellation, timeout, partial success, navigation, and reload branches to confirm how completed operations and recovery materials are preserved.
5. **Related changes**: check protocols, registration, compatibility handling, persistence allowlists, UI projections, and tests together.

Domain pages distinguish current implementation, target contracts, and known limitations. Current implementation is grounded in the corresponding source; target contracts state requirements to preserve; known limitations identify paths that do not yet satisfy those requirements or require further validation. A local helper's capability does not automatically guarantee the complete run chain.

## Choosing Validation for a Change

Each domain page lists the nearest tests and their integration scope. Pure functions, source assertions, simulated messages, synthetic subprocesses, and real-browser scenarios provide different levels of evidence; select them according to the change. A test filename containing `browser` or `e2e` does not by itself establish that real Chrome or a real model ran. Check the test setup, substitutes, and actual call chain.

The runner supports selecting files and listing the selection without executing it:

```sh
node scripts/run-tests.mjs --list test/ordinaryUndoRouting.test.js test/undoMirrorInvalidation.test.js
node scripts/run-tests.mjs test/ordinaryUndoRouting.test.js test/undoMirrorInvalidation.test.js
```

The first command only lists tests; the second executes the selected tests. Run both from the repository root.

The runner's discovery list consistently uses `/` path separators. Inputs may be bare filenames, `test/<filename>`, or Windows paths with backslashes. `--list` and actual focused execution share the same selection logic. [testRunnerSelection.test.js](../../test/testRunnerSelection.test.js) checks both the selection function and the real CLI's listing/execution entry points.

| Change or validation purpose | Entry point | Effect and evidence scope |
| --- | --- | --- |
| Guide admission to the repository and source hygiene | `npm run verify:source`; `node --test test/architectureGuidePublication.test.js` | The [source rules](../../scripts/verify-release.mjs) allow only the designated official guide pages; other documentation and local handoff materials remain rejected. The [focused test](../../test/architectureGuidePublication.test.js) also checks `.gitignore` alignment and npm exclusion. |
| Domain-focused regression | `node scripts/run-tests.mjs <files…>`; add `--list` to inspect the selection first | Runs the selected files directly. Individual tests may create fixtures, subprocesses, or build outputs. `npm run test:focus -- <files…>` also runs the module-graph check first. |
| Fast regression | `npm run test:fast` | Runs the fixed selection in `FAST_TEST_FILE_NAMES` in [run-tests.mjs](../../scripts/run-tests.mjs). It does not automatically select tests based on the diff; add relevant focused checks. Use `node scripts/run-tests.mjs --fast --list` to inspect the list. |
| Full Node test suite | `npm test` | Runs all top-level `.test.js` files discovered in `test/` by the runner. The suite includes different setups such as source assertions, VMs, and synthetic processes; it does not establish successful real-browser acceptance. |
| Content loading and build | `npm run check:module-graph` | The [check script](../../scripts/check-content-module-graph.mjs) regenerates the bundle and metadata and checks inputs, implicit dependencies, and bundle-size limits. `npm test`, `test:fast`, and `test:focus` all run this step first. |
| Changes to modules subject to budgets | `npm run check:architecture` | The [architecture budget](../../scripts/check-architecture-budget.mjs) checks that the listed files exist and do not exceed their individual line-count limits. Passing proves only those numerical constraints; full responsibilities and dependencies still require review. |
| Mirror, diff, patch, and large-project regression | `npm run benchmark:large` | The [synthetic benchmark](../../scripts/benchmark-large-project.mjs) calls production modules and also uses approximate metrics. It creates and cleans up temporary mirrors. The command includes `--gate` and fails when timing limits are exceeded. `--output <path>` additionally writes a report. |
| OT clicking, scrolling, and repaint timing | [Local fixture in real Chrome](../../test/browser/README.md) | `node scripts/serve-ui-regression.mjs` starts a local HTTP service for subsequent interaction in Chrome; real pointer clicks are required. The fixture does not connect to Overleaf or Native. Stop the service after the checks. |
| Loaded extension and real-project connection | [Project smoke command](../../README.md#development) and [smoke-extension.mjs](../../scripts/smoke-extension.mjs) | `npm run smoke:extension` builds first, then starts Chrome. Probes cover the panel, Native handshake, project summary, and diagnostics entry point. Project writeback, saving, Accept, Undo, and model execution require additional specific scenarios. The default is a temporary profile; specifying a profile uses its login state. `--json` writes redacted results. |
| Install a local build for Chrome acceptance | `npm run smoke:prepare:chrome` | Runs the build, fast selection, and real `install:managed` in order, modifying the local Managed installation. The extension must still be reloaded and Overleaf refreshed afterward; preparation alone is not acceptance evidence. |

The build writes `extension/src/content/generated/content.bundle.js` and its companion metadata as defined by [build-content-bundle.mjs](../../scripts/build-content-bundle.mjs); do not edit these generated files manually. Calling the runner directly with `--list` returns before test execution. Passing `--list` through an npm test command still builds first.

Mirror synchronization, status, change collection, diff, and patch in the synthetic benchmark call production modules. `snapshot.zip_parse_ms` actually measures `JSON.parse`, `context_tray.render_ms` measures construction of a synthetic directory tree, and `storage.prepare_ms` measures object preparation inside the script. These metrics compare regressions for fixed synthetic inputs. Real ZIP decompression, browser rendering, and IndexedDB write timings require separate evidence.

For cross-platform validation, refer to the macOS, Ubuntu, Windows, and Node version configuration in [CI](../../.github/workflows/test.yml). Local results cover only the platforms and paths actually executed. Chrome loading, the Overleaf DOM, real saving, and refresh recovery still require corresponding interaction checks. Use `npm run verify:source` for source hygiene and development metadata. See [Installation and Updates](installation-and-updates.md) for npm package scope, update boundaries, and packaging, signing, and update rehearsals for official releases.

## Maintenance Conventions

- Every code task assesses guide impact according to the [SOP](change-workflow.md). Deliver necessary body and index changes with the code; when no changes are needed, state the reviewed scope and reasons.
- When entry points, state ownership, protocols, loading, or recovery strategies change, update the corresponding domain pages and feature index.
- Source constants and protocol catalogs remain authoritative. The guide uses repository-relative links and actual symbols, avoiding copies of complete configuration catalogs.
- Documentation describes the project's current structure and behavior; clearly label the target state of future designs.
- Keep known limitations in the owning feature chapter, alongside the affected call chain, source, and test entry points.
- Maintain the official guide through an exact allowlist of Git-tracked paths. When adding a page, check [.gitignore](../../.gitignore) and the [source-hygiene rules](../../scripts/verify-release.mjs) together. npm packages and release archives still exclude `docs/`. Assess source collaboration scope separately from product distribution scope.
