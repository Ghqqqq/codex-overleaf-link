---
name: parallel-subagents
description: >
  When a task decomposes into independent slices — separate files, OR
  separate sections of ONE file — fan it out: write job files to the subagent
  queue and the host runs real parallel Codex workers for you. For a single
  file, extract per-section slice files into the queue's work/ zone, let
  workers polish them in parallel, then reassemble (scatter-gather). Every
  job must state an explicit, non-overlapping scope.
---

# Parallel Subagents

The native host can run parallel Codex workers for you. You cannot spawn
processes yourself (the sandbox forbids it) — instead you write **job files**
into a queue directory and poll for **result files**. Each worker is a full
Codex agent confined to the files you assign it.

## 1. When to use

Use this when ALL of these hold:
- The task splits into ≥ 2 independent slices: different **files**, or
  different **sections of one file** (use the scatter-gather workflow in §5).
- Slices do not depend on each other's output.
- Each slice is small enough to finish in a few minutes.

Do NOT use it (work sequentially yourself instead) when:
- Slices are deeply cross-referenced and must be edited together.
- There are fewer than 2 real slices.
- The handshake file below is missing or not `ready`.

## 1b. Explicit scope — the iron rule

Every job's `task` MUST state its exact working scope, and scopes MUST NOT
overlap:
- multi-file job: name the file(s) and what inside them is in scope;
- single-file slice job: name the section (`\section{...}` title) and quote
  the slice's exact first and last source lines.
Never write two jobs whose scopes could touch the same text. If you cannot
state a slice's boundaries precisely, do that slice yourself instead.

## 2. Handshake

Read `.codex-overleaf-subagents/broker.json`. If it is missing or its
`status` is not `ready`, the broker is off — do everything yourself. Respect
`maxWorkers`, `maxJobsPerRun`, and `perWorkerTimeoutMs` (size each job to
finish well inside it).

## 3. Write jobs

One job per slice. Each job OWNS its `files` exclusively — no file may appear
in two jobs. Write atomically: create a temp file, then `mv` it to its final
`.json` name.

```bash
cat > .codex-overleaf-subagents/jobs/.tmp-ch3 <<'JSON'
{
  "id": "ch3",
  "title": "Polish chapter 3",
  "task": "Polish sections/ch3.tex for grammar, flow, and concision. Keep all math and citations intact. Follow the shared style notes: <paste the style guidance here>.",
  "files": ["sections/ch3.tex"],
  "readOnlyContext": ["main.tex", "macros.tex"]
}
JSON
mv .codex-overleaf-subagents/jobs/.tmp-ch3 .codex-overleaf-subagents/jobs/ch3.json
```

Rules:
- `id`: lowercase letters/digits/hyphens, ≤ 32 chars, unique.
- `task`: complete, self-contained instructions — workers cannot ask
  questions. Repeat shared style guidance in EVERY job.
- `files`: workspace-relative paths the job may edit — project files or
  slice files under `.codex-overleaf-subagents/work/`. Jobs that share a
  file are admitted but run ONE AT A TIME (the broker serializes them);
  disjoint jobs run in parallel.
- `readOnlyContext`: files the worker may read but must not edit.

## 4. Poll for results

```bash
tries=0
while [ "$(ls .codex-overleaf-subagents/results/*.json 2>/dev/null | wc -l)" -lt <jobCount> ]; do
  sleep 10
  tries=$((tries + 1))
  if [ "$tries" -ge 120 ]; then break; fi  # bounded wait; also respect broker.json
  ls .codex-overleaf-subagents/results/ 2>/dev/null
done
```

If the loop hits the cap, a result never arrived (e.g. a lost or duplicate
`id`). Do not keep waiting: read whatever results exist and finish the
remaining slices yourself inline.

Then read each `results/<id>.json` (`status`: completed | failed | rejected |
timeout | cancelled; `summary`; `changedFiles`) and, when you need the full
close-out, `results/<id>.last-message.md`.

## 5. Single file? Two safe modes

Two workers must NEVER edit the same file at the same moment (whole-file
writes race and silently drop each other's edits) — the broker guarantees
this for you. Pick per task:

**Mode A — serialized scoped jobs (simple, no slicing).** Just write one job
per section, all owning the same file, each `task` stating its exact section
scope (iron rule §1b). The broker runs them one at a time, each seeing the
previous job's output. No parallel speedup within that file (jobs on OTHER
files still run alongside), but zero assembly work. Prefer this for 2-3
sections or quick passes.

**Mode B — scatter-gather slices (true parallelism).** For a big file where
wall-clock matters, give each worker its own physical slice:

1. **Scatter** — for each independent section, copy its EXACT text (from its
   `\section{...}` line up to, not including, the next `\section`) into a
   slice file, verbatim, atomically:
   `cat > .codex-overleaf-subagents/work/.tmp-sec2 <<'EOF' ... EOF` then
   `mv .codex-overleaf-subagents/work/.tmp-sec2 .codex-overleaf-subagents/work/sec2.tex`.
   Preamble, frontmatter, and anything you cannot bound precisely stays with
   you.
2. **Jobs** — one per slice. `files` = that slice file only. The `task` must
   say: this is a fragment of `<original file>` covering section `<title>`
   (quote first + last line); polish it IN PLACE; do not add a preamble or
   document wrapper; keep the project's edit conventions (e.g.
   annotated-rewrite). Put the original file in `readOnlyContext` so the
   worker sees surrounding context.
3. **Gather** — after all results: verify each slice still starts with its
   `\section{...}` line, then replace the corresponding original block in
   the source file with the slice content, one section at a time, yourself.
   If a slice lost its boundary line, treat that slice as failed and redo it
   inline.

Slice files live inside the queue zone, so they are scratch: they never sync
to Overleaf — only your reassembled edits to the real file do.

## 6. Wave discipline (important)

While any job is queued or running, do **not** edit project files yourself —
write jobs, poll, wait. Do your own edits before the first job or after the
last result. Files changed during a wave that no job owns are reported as
ownership violations and **excluded from the Overleaf writeback**.

## 7. Integrate

- For each `completed` job: read its summary, spot-check the owned files, and
  smooth terminology/transitions ACROSS slice boundaries yourself.
- For each `failed` / `timeout` / `cancelled` job: wait for all workers to stop,
  then review and complete that slice inline. An unfinished worker's files
  remain quarantined even after edits; explicitly adopt their final bytes as
  described below. Renaming a file is not a substitute for reviewing it.
- For a `rejected` job that never ran, do the slice inline after the wave.
- Mention any violations in your close-out so the user knows those edits were
  withheld from writeback.

### Adopt reviewed output

After every worker has stopped, read `broker.json` again. `activeWorkers`
must be zero and `adoptionToken` must be non-empty. The token is issued only
after workers exit and changes when another worker wave starts.

Read and finish the files, perform the checks allowed by the task, and compute
SHA-256 hashes of the FINAL bytes. Atomically write a uniquely named JSON file
to `.codex-overleaf-subagents/adoptions/<id>.json`:

```json
{
  "token": "<current adoptionToken>",
  "reviewed": true,
  "files": [
    { "jobId": "ch3", "path": "sections/ch3.tex", "sha256": "<64 lowercase hex digits>" }
  ]
}
```

Read `adoption-results/<id>.json` and require `ok: true` before claiming the
file is ready to sync. Ownership violations cannot be adopted. A later edit
invalidates the adoption hash; review the final content and submit a new
request. Never claim all files synced merely because local compilation passed.

## 8. Close out

End with a per-slice one-liner (job → what changed) plus an overall summary.
This becomes the run report the user reads.
