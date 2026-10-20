# Codex Overleaf Link Maintenance Entry Point

This repository provides local Codex conversations, project understanding, editing, and recovery for Overleaf. Start maintenance work by locating the feature's actual entry point, state owner, and protocols.

## Keeping Code and the Guide in Sync

Defect fixes preserve the existing feature scope and primary interactions by default. Distinguish confirmed defects from capability limitations first; do not automatically turn a capability limitation into feature development, or substitute new buttons, manual workflows, or extra confirmation steps for a fix. New capabilities must fall within the task scope explicitly requested by the user. Necessary error messages must follow the existing presentation, language setting, and style. When withdrawing incidental feature additions, preserve the underlying protections and recovery compatibility for operations already performed.

All new features, behavior changes, debugging, refactoring, and configuration/tool changes follow the [Feature Development and Bug-Fix SOP](docs/architecture/change-workflow.md). At the start, use the guide to verify the actual entry points, owners, call chains, and validation methods. Before delivery, update the affected domain pages, feature index, and obsolete limitations to match the final code. Both the code and the necessary guide revisions are part of the task's completion criteria.

Every code task must assess its impact on the guide. If the existing description remains complete and accurate, the body may stay unchanged, but the final reply or existing PR/task description must name the sections checked and give specific reasons. Changes to actual behavior, navigation paths, or limitations require the corresponding revisions. Delivery notes include behavior changes, guide synchronization, validation actually performed, and remaining items. Review proceedings and separate issue records stay outside the guide.

Once a local fix involving runtime code passes the relevant automated checks, build, back up, and update the existing Managed installation directly by default; do not ask for installation permission again. After verifying the on-disk extension and Native versions and the source/installation digests for both runtimes, ask the user to click Reload on the existing Chrome extension entry. The Chrome smoke preflight checks version metadata and source/installed content-bundle SHA-256 only; full extension-runtime and Native digest verification require separate evidence. After the user confirms the reload, refresh the project and continue CUA acceptance testing. Documentation-only changes do not trigger installation; publishing and writes to real projects still follow their respective authorization scopes. The SOP's local acceptance procedure specifies the delivery order.

Use Luna for all real-model acceptance tests and smoke tests. Verify the model identifier actually available in the UI, and record the model used for each run. If Luna is unavailable, record the blocker; do not automatically substitute Sol or another model. This convention governs test selection only and does not change the product's default model.

New subagent tasks inherit the main agent's model without a separate model override. This convention applies to development, validation, and review subtasks; real-model acceptance testing still follows the Luna convention above.

## Read as Needed

1. On first taking over, read the [guide entry point](docs/architecture/README.md) and [system overview](docs/architecture/system-overview.md).
2. Use the [feature change index](docs/architecture/feature-map.md) for the task at hand, and expand only the relevant domains and source files.
3. For edits, saving, Accept, and Undo, read [Auto Editing and Undo](docs/architecture/auto-edit-undo.md). For submission, queues, persistence, and refresh, read [Run State and Recovery](docs/architecture/run-state-and-recovery.md).
4. For local processes and messages, read [Native Execution](docs/architecture/native-execution.md); for model connections, read [Providers and Protocols](docs/architecture/providers-and-protocols.md). Use the feature index to reach other domain topics.
5. For outbound context, sensitive-content scanning, and read-only/writable path rules, read [Context and Governance](docs/architecture/context-and-governance.md). These checks have separate entry points and data scopes.
6. For message admission, the Page handshake, the Native compatibility gate, and local bridge identity, read [Protocols and Trust Boundaries](docs/architecture/protocols-and-trust.md). Distinguish senders, project ownership, and version capabilities for each actual channel.
7. Known limitations, exception paths, and test boundaries are documented in the relevant domain pages. Actual changes still require checking callers and tests.

The official guide contains only project architecture, implementation paths, known limitations, and maintenance methods. Review reports, investigation and acceptance records, change statistics, and temporary research materials stay outside the guide and are not reading dependencies. Apply review conclusions directly to the corresponding sections.

## Evidence and Working Method

Distinguish `Current behavior` (source-code facts), `Target contract` (requirements to preserve), and `Known gap` (known limitations or missing validation) in important conclusions. Assess the existence of a test definition, a passing test execution, and successful browser acceptance separately.

| Question | Preferred evidence |
| --- | --- |
| How does it execute now? | Actual callers, runtime source, effective manifests, and generated entry points |
| Who determines the state? | Writers of that state, protocol definitions, and persistence owners |
| What do automated checks cover? | The nearest behavior or contract tests and validation scripts |
| What should be implemented? | Current task requirements and explicitly labeled target contracts |
| Why was an older design chosen? | The corresponding historical decision; still verify the applicable version |

Before editing, locate the owning execution context, state owner, protocol boundaries, and nearest tests. Preserve unrelated working-tree changes and modify the smallest coherent scope. Begin validation with the relevant focused checks. When documentation conflicts with code, record the discrepancy; do not describe desired behavior as an implemented fact.

## Contracts to Preserve When Making Changes

| Topic | Maintenance constraint |
| --- | --- |
| Content loading | `extension/entries/content-entry.mjs` manages source inclusion. Pass module dependencies explicitly through the registry or composition root; both manifests inject the generated bundle. Do not edit generated files manually. |
| Page world | Check `pageBridgeClient.PAGE_WORLD_SCRIPTS`, the publicly exposed resource list, the Managed allowlist, the dispatcher, `pageRpcContract`, and tests. |
| Identity | Write operations must verify the captured project and run ownership; stop when identity is missing or mismatched. See the writeback chapter and `pageRpcContract` for existing page-state RPC exceptions. |
| Queue | The execution snapshot and submissionContext capture configuration and queued instructions/skills respectively. Queued attachments are unsupported; promotion must not read attachments or one-turn skills from a later draft. See the run-state page for legacy-item compatibility, capacity, and other input capture timing; do not generalize this to freezing all project content. |
| Empty files | `""` is valid content. Distinguish missing, unread, and blank content. A valid empty baseline participates in freshness checks; an empty editor overlay requires evidence of a successful read. See the writeback chapter. |
| Evidence of success | Express applied, readback, saved, mirrored, compiled, and settled separately. Partial failure and unknown save status must not be collapsed into complete success. |
| Credentials and body text | Isolate Provider configuration credentials through dedicated fields and `providerStore`; do not mix them into sessions, run events, or diagnostics. Do not automatically replace user tasks, model answers, or conversation body text based on secret-like formats. Pre-send sensitive-content checks and diagnostic summaries each use their existing entry points. Manage local dedicated credential storage and recovery-transaction storage according to `providerStore` permissions and lifecycle rules. |
| Protocols | Check the owner, producers, consumers, compatibility handling, error mapping, and contract tests together; retries must respect operation idempotency. |
| Mirrors | Use Overleaf mirrors according to `overleafWorkspaceRules`; never run Git inside them. Use Git normally in the development repository. |

## Documentation and Validation

Maintain a small, durable test suite. Keep permanent tests only for consequential user-visible contracts with no equivalent retained coverage: document bytes and recovery, identity/ownership, durable history, transport and installation/update integrity. Extend an existing contract before adding a new test file. Avoid source-string/order checks, private-function extraction, exact UI copy/CSS assertions, architecture line budgets, synthetic performance gates and exhaustive state permutations. Temporary debugging probes normally remain temporary. `npm test` runs the core suite; `npm run test:platform` runs actual isolated installation/process contracts. Real Chrome acceptance stays short and expands only for the changed behavior. Do not restore retired checks or broad release matrices without a concrete uncovered risk.

When entry points, state ownership, protocols, loading, or recovery strategies change, update the corresponding guide pages and feature index. Use repository-relative links and actual symbols in documentation; refer important numerical values to their authoritative constants where possible.

When adding an official guide page, update the exact allowlists in `.gitignore` and `scripts/verify-release.mjs`; private materials and reports remain excluded. Maintain Git tracking scope separately from npm and release distribution scope.

For high-risk contracts, trace whether parameters pass through every layer, whether other writers can change the state, whether cancellation or disconnection skips finalization, and whether tests cover the actual call chain. A local function's properties do not automatically guarantee the full chain; keep unproven claims explicitly scoped.

The [guide entry point](docs/architecture/README.md) lists validation methods. Focused tests and real Chrome/Overleaf acceptance each provide different evidence. For documentation-only changes, check links, symbols, baselines, and the usability of navigation paths; do not claim runtime tests passed on that basis.

For release work, use the `codex-overleaf-link-release` skill available in the environment and derive the version from current package metadata. Older release records and workflows at older tags are historical evidence only. This guide does not authorize republishing, moving tags, overwriting assets, or operating on real papers.
