---
name: reviewer-response
description: >
  Use only when the user asks to respond to peer-review or reviewer comments,
  write a rebuttal or response letter, or plan a revision from reviews.
---

# Reviewer Response

Map reviewer comments to evidence in the paper, proposed edits, and reply
drafts. Keep missing evidence visible instead of filling it with assumptions.

## Workflow

1. Split the reviews into atomic comments with stable IDs R<reviewer>.<n>,
   such as R1.2. Keep the reviewer's own numbering when present; retain the
   original label when splitting a numbered comment into smaller items.
2. For each comment, look for evidence in the project files. Cite actual
   source lines as plain-text path:line or path:start-end, for example
   main.tex:212-230. Do not wrap references in backticks: the panel turns
   plain-text references into clickable links. If evidence is absent, write
   "Not found"; distinguish files not read from files searched without a match.
3. Output a compact ledger table with these columns:

   ID | Comment | Evidence in the paper | Proposed change | Status

   Keep cells short for the narrow panel, with each Comment at most about
   12 words. Put necessary explanations below the table. Use only these
   statuses, adding a short reason:
   - Ready to edit: the evidence supports a specific local edit.
   - Needs an experiment: new experimental evidence is required.
   - Needs author input: facts or a decision must come from the author.
   - Unresolved: the comment remains open for another stated reason.
   - No change: explain why the current paper already addresses the comment
     or why a change is unwarranted.

   Write the table and explanations in the user's language, translating
   headings, statuses, and "Not found" accordingly. Keep the IDs unchanged.
4. After the ledger, draft replies only for the comments the user asked
   about, or for every comment when they requested a full response letter.
   Write reply drafts in English unless the user asks otherwise. Label each
   draft with its comment ID and distinguish proposed work from completed work.
5. Finish with one "Next:" line, localized to the user's language, explaining
   how to apply approved items. For example: Next: after approving R1.2,
   switch to Auto and send "Apply R1.2".

## Integrity rules

- Never invent results, numbers, experiments, citations, or completed changes.
- Anything needed for a response that is not present in the paper or provided
  by the user must be marked Needs an experiment or Needs author input.
- Reply drafts must not promise results. State missing evidence or pending
  author input explicitly; do not describe planned edits as already made.
- Cite only files and lines actually inspected. User-provided facts are not
  evidence already in the paper; identify their source separately.

## Editing rules

- In Ask mode, never edit files.
- In Auto mode, edit only the comment IDs the user explicitly approves.
  Keep edits minimal and local, leaving unrelated text untouched. An approved
  ID does not authorize inventing missing evidence or results.
- After editing, report which IDs changed with plain-text path:line or
  path:start-end references. Keep pending items separate and do not claim
  an edit, save, or experiment completed without evidence.
