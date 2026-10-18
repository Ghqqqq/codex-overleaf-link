# Feature Development and Bug-Fix SOP

This SOP (standard operating procedure) defines the sequence and completion criteria for maintenance tasks. It applies to new features, feature adjustments, debugging, refactoring, and changes to configuration, protocols, storage, loading, installation, and validation tools. Every code task must assess guide impact. Complete implementation changes and necessary guide revisions within the same task and the same reviewable change.

The basic sequence is **locate through the guide → establish the contract or reproduce the failure → change the implementation → validate behavior → synchronize the guide → check delivery criteria**. Guide errors may be corrected during analysis and implementation; review them again against the final code before delivery.

**Fix scope.** Use the existing features and primary interactions before the fix as the baseline. Record confirmed defects, risks awaiting validation, and capability limitations separately. A capability limitation does not automatically create a new feature requirement. New entry points, manual finalization workflows, extra confirmation steps, or expanded support must fall within the work explicitly requested by the user. Prefer correcting errors within existing entry points, and follow existing language and style for error messages. When withdrawing incidental additions, trace necessary protections, older persisted records, and recovery for operations already performed along the call chain, so that a wholesale rollback does not also discard valid fixes.

## 1. Start the Task: Map the Change

1. Read [AGENTS.md](../../AGENTS.md), inspect the current Git status, task scope, and existing uncommitted changes, and preserve unrelated work.
2. Use the [feature change index](feature-map.md) to reach the affected domain pages. Expand only relevant sections and cross-layer dependencies; ordinary tasks do not require reviewing the entire guide again.
3. Follow the guide's symbols to verify actual source and tests, forming a change map: **user entry point → execution context → state owner → consumers and persistence → validation entry point**. An owner is the module responsible for writing a fact or making a behavioral decision.
4. Check the current description, target contract, and known limitations. When the guide and code disagree, assess intended behavior and actual implementation separately instead of directly treating either as the fix target.

The change map may live in the task description or current plan; a separate report is unnecessary for every small change. At minimum, identify the modules to change, the related guide sections, and the validation method. Keep uncertain behavior as questions awaiting validation.

## 2. Choose the Starting Point by Task Type

| Task | Establish before implementation | Demonstrate after implementation |
| --- | --- | --- |
| New feature or behavior adjustment | User-observable results, inputs and outputs, state ownership, compatibility requirements, and applicable failure/cancellation/recovery branches | The new capability is reachable from the actual entry point, parameters and state pass through the complete consumer chain, and exceptional behavior matches the target |
| Debugging or logic fix | Trigger conditions, differences between expected and actual behavior, run identity/version, and a minimal reproduction or failure evidence that permits localization; identify parts not yet reproduced | The result is corrected under the original failure conditions, and adjacent normal and exceptional branches have been checked; capture a behavioral regression test where needed |
| Refactoring or internal adjustment | Existing behavior contracts, responsibilities/dependencies/symbols to move, and entry points and side effects to preserve | Behavior is preserved, callers and loading remain valid, and the guide's navigation paths and division of responsibilities remain accurate |
| Configuration, build, installation, or validation tools | Defaults, scope, consumption timing, platform/permissions, and the relationship between generated outputs and existing installations | Actual consumers use the new behavior, and validation commands' effects and evidence scope match their descriptions |
| Read-only diagnosis or documentation-only correction | Evidence sources and claims to correct; make clear whether the implementation will change | Conclusions match the evidence, and reading test definitions alone is not described as passing tests |

Label designs that have not yet been implemented as `Target contract`. After completion, document verified implementation as current behavior; retain any unmet parts as explicit limitations. Keep failure root causes, temporary probes, and investigation history in separate issue records or task materials.

## 3. Check Cross-Layer Impact by Trigger

Use the following table to select the affected scope; running every check for every task is unnecessary.

| Change trigger | Chain that must be traced | Guide |
| --- | --- | --- |
| Add configuration, input, or a run option | Follow each field's actual consumption path through drafts, capture timing, execution snapshots, queues, Native, persistence/reload, defaults, and migration. Identify inapplicable stages and whether the field is in the snapshot allowlist; separately check capture timing for fields outside it | [Run State](run-state-and-recovery.md), [UI](ui-and-loading.md), [Providers](providers-and-protocols.md) |
| Change state, asynchronous waiting, cancellation, or recovery | Actual owner, identity and generation, late results, partial completion, and finalization; check reports, settlement, buttons, and history projections separately | [Run State](run-state-and-recovery.md), [Native](native-execution.md), [UI](ui-and-loading.md) |
| Change file reading, writeback, Accept, or Undo | Path/project/baseline identity, empty content, patch coordinates, per-item results, receipts, saving, and recovery materials; obtain separate evidence for applied/readback/saved/mirrored/compiled/settled | [Auto Editing and Undo](auto-edit-undo.md) |
| Change storage or data lifecycle | Actual writers/readers, account and project scope, migration markers, actual consumers of compaction, and deletion/retention rules; cover legacy data and failure paths | [Run State](run-state-and-recovery.md), [Context and Governance](context-and-governance.md) |
| Change Page/Native methods, messages, or permissions | Producers, catalog/dispatcher, sender and project admission, compatibility sets, timeout/cancellation/replay, error mapping, and consumers | [Protocols and Trust Boundaries](protocols-and-trust.md), [Native](native-execution.md) |
| Add or move a module | Content imports/registry/composition root and build; Page contract/dispatcher, ordered injection, WAR, and the Managed allowlist; never edit the generated bundle manually | [Feature Index Loading Checklist](feature-map.md#loading-checklist-for-new-modules-and-capabilities), [UI and Loading](ui-and-loading.md) |
| Change models, subagents, styles, or skills | Configuration identity, protocol conversion, shared working directories, asset reading/writing and limits, concurrency/cancellation, and credential and corpus flows | [Providers](providers-and-protocols.md), [Subagents](parallel-subagents.md), [Styles and Skills](writing-style-and-skills.md), [Governance](context-and-governance.md) |
| Change sites, installation, updates, or distribution | Injection permissions and each channel's host set; separate validation of source/build/disk installation/loaded code/distribution artifacts; fixed launchers and recovery paths | [Installation and Updates](installation-and-updates.md), [System Overview](system-overview.md) |

For cross-layer changes, check whether intermediate layers lose parameters, whether state has a second writer, whether failures skip cleanup, and whether the nearest tests substitute critical dependencies. A new filename or the existence of a helper test is insufficient to prove that a feature is wired into the production chain.

## 4. Implement and Validate: Obtain Evidence Proportional to Risk

Implement changes around the smallest coherent call chain identified. For logic fixes, preserve the original failure conditions first. Tests should check user-observable behavior and key contracts, avoiding mere duplication of implementation details. Use appropriate existing checks for low-impact changes with no behavior changes; additional tests are not mechanically required.

Keep the permanent suite small: add or extend a behavior contract only for a consequential failure absent from existing coverage. Source spelling, private function layout, CSS snippets, full UI wording and repeated status permutations do not justify a release gate. Temporary probes can be discarded after diagnosis. Product requirements or external integration changes may legitimately require maintenance; internal rearrangements should not require fixture reconstruction.

Select focused checks from the [validation table at the guide entry point](README.md#choosing-validation-for-a-change). Pure-function, integration/contract, subprocess, browser, and real-model tests provide different levels of evidence. Run relevant checks first; expand scope only when changes, failures, or unresolved concerns require it. Still complete mandatory repository checks that apply to the code being changed.

Conclusions about real editors, saving, refresh, loaded extensions, or platform registration require evidence from the corresponding environment. If only partial validation is currently possible, delivery notes must list the missing scenarios, and the guide must retain an accurate scope of guarantees. Passing tests does not turn substitute behavior into acceptance of the full chain.

**Acceptance procedure after a local fix.** Once a runtime-code fix passes the relevant automated checks, run `npm run build:content` directly by default, back up the existing Managed installation and its Native bridge/browser registration, then run `npm run install:managed`. Installation permission is already part of this project's local maintenance convention and does not need to be requested each time. After verifying the disk extension, Native version, and source/installation digests, ask the user to click Reload on the existing Chrome extension entry. After the user confirms the reload, refresh the authorized test project and perform CUA acceptance testing. An ordinary page refresh does not replace reloading the extension background, and a successful disk installation does not replace browser runtime identity and functional acceptance checks. Use the available Chrome smoke skill for a short check of loaded identity, reading, reversible two-file write/Undo, cleanup and refresh; add only the interactions affected by the change. Real file writes and cleanup must follow existing authorization and a verifiable recovery plan. Documentation-only changes do not trigger installation.

Use Luna for all real-model acceptance tests and smoke tests, first verifying the model identifier actually available in the UI. Check the selected model before every submission, and record its actual identifier together with that run ID. If Luna is unavailable, mark the relevant model checks as blocked; do not automatically substitute Sol or another model. This requirement only specifies model selection during acceptance testing; it does not change the product's default model, nor does it treat test-model selection itself as a fix for model behavior.

## 5. Synchronize the Guide with the Final Implementation

After completing code changes, reassess documentation impact against the actual diff and change map. Synchronization must cover at least the affected parts of the following:

- **Domain pages**: entry points, owners, call order, data and identity, success/failure semantics, cancellation/recovery, support scope, and nearest validation entry points.
- **Feature index**: new user capabilities or change paths, module moves/renames, required related changes, and test paths; new features must be discoverable through the index.
- **System overview and protocol pages**: update when cross-context responsibilities, state authority, channels, or trust boundaries change.
- **Guide entry point and AGENTS**: update when reading paths, development commands, or maintenance contracts change.

When fixing a known issue, recheck the corresponding `Known gap`: replace resolved descriptions with current behavior, and preserve remaining conditions and limitations for partial fixes. Do not merely add a "fixed" paragraph while leaving conflicting old descriptions. If a separate issue record already exists, update its fix status and validation evidence. Its absence does not block normal maintenance or require creating or operating an external ticket.

**When body changes are unnecessary.** Purely internal adjustments, or fixes that restore behavior already accurately described in the guide, may need no body changes. Still check affected sections, navigation symbols, limitations, and validation entry points, and name those sections and specific reasons in delivery notes. When entry points, behavior, or known limitations actually change, make the corresponding documentation changes. "The change is small" does not replace impact assessment.

**Baselines and versions.** Maintain the guide alongside the currently maintained code in this repository; historical commits identify initial references. When a change affects a page with a fixed version/source baseline, check that statement too. A local update may explicitly say "initial reference baseline; the body is maintained with the current repository" to avoid continuing to claim that new behavior comes solely from an older commit. Determine applicable product versions from actual metadata. Do not invent commit hashes for uncommitted changes; a documentation commit does not constitute a product release or a fresh acceptance review of the entire repository.

Keep the body in the form of a project guide: final behavior, necessary rationale, known boundaries, and maintenance paths. Review reports, investigation history, temporary plans, issue lists, and validation statistics remain separate. The official guide must be usable without depending on private files.

## 6. New Pages, Links, and Distribution Rules

Prefer updating existing domain pages; split out a new topic only when it provides independent reading value. When adding, renaming, or deleting an official page, update the following together:

1. The [guide entry point](README.md) and related feature-index entries/cross-links.
2. The corresponding per-page declaration in [.gitignore](../../.gitignore) and the exact [PUBLIC_ARCHITECTURE_GUIDE_PATHS](../../scripts/verify-release.mjs) list; remove old entries when moving or deleting pages.
3. Check that both allowlists name the same existing guide files, then run `npm run verify:source` to check tracked-path admission. Maintain Git tracking scope separately from npm/release distribution scope; actual release artifact verification checks distribution contents.

Use actual files, symbols, and relative links in documentation; check inbound links when source files are deleted or moved. Released extensions open `README.md#faq-and-troubleshooting` (`CODEX_CLI_TROUBLESHOOTING_URL` in [runRecoveryActions](../../extension/src/content/runRecoveryActions.js)), so a README restructure keeps that anchor. Before committing, check that links, anchors, and commands remain valid, and run the applicable checks:

```sh
git diff --check
npm run verify:source
```

These commands check formatting, repository admission boundaries, and development metadata. They do not automatically establish semantic consistency between code and guide, and do not replace link/symbol checks. Maintainers must still synchronize meaning by following source and consumers. Select detailed runtime tests according to Section 4.

## 7. Completion Criteria and Delivery Notes

Before finishing a task, confirm each item:

- The actual implementation has been located through the guide, with clear distinctions among current behavior, targets, and unresolved items.
- Code changes and necessary guide revisions belong to the same task and reviewable change scope. They may be split into commits when the logical relationship is clear; required guide synchronization cannot be left to an unspecified future task.
- All affected navigation, symbols, old limitations, and version statements have been checked. Specific evidence supports any decision to leave the body unchanged.
- Validation results match the scope actually executed, and missing environment validation or unresolved issues remain explicit.
- The guide contains only project knowledge. Separate issue records reflect the evidence obtained, and documentation revisions have not been treated as product fixes.

The final reply or existing PR/task description includes at least the following information. Scale the wording to the change; a separate delivery report is unnecessary:

```text
Behavior: The capability completed or failure condition eliminated.
Guide: Updated sections/index entries, or the sections checked and specific reasons no change was needed.
Validation: Checks actually executed, their results, and evidence scope.
Remaining: Unresolved issues or missing validation for this task; explicitly state when this task has no known remaining items.
```

This procedure defines task completion criteria. It does not grant additional authorization for publishing, external communication, or operations on real projects; those actions follow the current task scope and existing repository rules.
