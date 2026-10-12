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

The maintained suite is intentionally small. Its contracts protect document integrity, operation ownership, durable recovery, transport boundaries and installation. They exercise production modules and replace external I/O where necessary. Passing these checks does not establish full browser, model or operating-system coverage.

| Purpose | Entry point | Evidence scope |
| --- | --- | --- |
| Core behavior and content build | `npm test` | Builds the actual content bundle, then runs the small top-level contract suite in `test/`. Core JavaScript behavior runs once on Ubuntu in CI. |
| Focused change | `node --test test/<contract>.test.js` | Runs an existing relevant contract directly. For UI or external integration changes, use a temporary reproduction or the affected real interaction as needed. |
| Native installation and recovery | `npm run test:platform` | Isolated real installation, framed Native startup/confirmation, rollback retry, and child-process shutdown. CI runs these on macOS, Ubuntu and Windows; local execution proves only the local platform. |
| Source and metadata | `npm run verify:source` | Checks the repository's admitted files and development version metadata. The official guide has a separate Git allowlist and remains excluded from npm packages. |
| Release artifacts and compatibility | `npm run build:release`, `npm run verify:release-artifacts`, `npm run verify:update-boundary`, `npm run verify:update-hop:local` | Validates actual packages, fixed-layer compatibility and an isolated upgrade from a supported published version. Use the release skill for signing and publication; local rehearsal uses a temporary test key. |
| Short Chrome acceptance | Existing logged-in QA project, using the Chrome smoke skill | Confirm loaded build and connection, Ask with zero writes, two-file reversible write/Undo, actual editor cleanup and refreshed history. Add only interactions affected by the change. Use Luna and verify it before every submission. |
| Prepare local runtime acceptance | `npm run smoke:prepare:chrome` | Runs the core checks and updates the existing Managed installation. User-operated extension Reload and actual Chrome acceptance still follow. |

The build writes `extension/src/content/generated/content.bundle.js` and its metadata through [build-content-bundle.mjs](../../scripts/build-content-bundle.mjs); do not edit generated files manually. `check:module-graph` is a compatibility command for the actual content build. No source-line, file-size or synthetic performance budget gates remain.

The [runner](../../scripts/run-tests.mjs) expands the small suite for Node and Windows without relying on shell globbing. Platform files live under `test/platform/`. [CI](../../.github/workflows/test.yml) runs on pushes to `main` and `codex/**` work branches, on pull requests, and when called by the [release workflow](../../.github/workflows/release.yml). These entry points share the same small selection. Branch checks do not publish; the release workflow is triggered only by version tags. The final signed release follows its own artifact and update-hop checks; running the core suite cannot substitute for them.

A permanent test must protect a consequential observable failure that the retained suite does not already cover. Prefer extending one existing contract. Do not add tests for internal names, source spelling/order, exact UI copy, CSS snippets, line counts, fixed tool versions or every combination of equivalent states. Temporary diagnostic probes need not become permanent release requirements. Intentional public-contract changes and external platform changes can still require test maintenance.

## Maintenance Conventions

- Every code task assesses guide impact according to the [SOP](change-workflow.md). Deliver necessary body and index changes with the code; when no changes are needed, state the reviewed scope and reasons.
- When entry points, state ownership, protocols, loading, or recovery strategies change, update the corresponding domain pages and feature index.
- Source constants and protocol catalogs remain authoritative. The guide uses repository-relative links and actual symbols, avoiding copies of complete configuration catalogs.
- Documentation describes the project's current structure and behavior; clearly label the target state of future designs.
- Keep known limitations in the owning feature chapter, alongside the affected call chain, source, and test entry points.
- Maintain the official guide through an exact allowlist of Git-tracked paths. When adding a page, check [.gitignore](../../.gitignore) and the [source-hygiene rules](../../scripts/verify-release.mjs) together. npm packages and release archives still exclude `docs/`. Assess source collaboration scope separately from product distribution scope.
