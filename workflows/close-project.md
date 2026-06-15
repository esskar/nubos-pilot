---
command: np:close-project
description: Aggregate verification of every milestone in the project. Runs the verifier on each M<NNN>, writes PROJECT-SUMMARY.md, and sets project_status=completed in roadmap.yaml when all milestones pass.
argument-hint: 
---

# /np:close-project

<objective>
Project-level closing step. Aggregates every milestone's `M<NNN>-VERIFICATION.md` and `M<NNN>-VALIDATION.md`, reports blockers, and on success records `project_status: completed` in `.nubos-pilot/roadmap.yaml` plus a flat `PROJECT-SUMMARY.md`. The project is then eligible for archive via `/np:new-project` (archive-then-init flow) or via `archive-project do`.

This workflow is the answer to "verify every milestone at the end of the project" — it is the single sammelcheck. Per-milestone verification still happens at execution time via `/np:verify-work <N>` and `/np:validate-phase <N>`; this workflow does not re-run them, it aggregates their output.
</objective>

## Initialize

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init close-project)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for user-facing output, askuser prompts, and any prose in `PROJECT-SUMMARY.md`. Milestone IDs, SC ids, file paths, and YAML keys stay canonical English. Supersedes CLAUDE.md.

Parse JSON for: `project_exists`, `completion.status`, `completion.milestones[]`, `completion.blockers[]`, `summary_path`, `text_mode`, `text_mode_source`.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

## Pre-Flight

If `project_exists == false`, hard-stop:

```bash
echo "[np:close-project] No PROJECT.md found — nothing to close." >&2
exit 1
```

## Aggregate report

Render the completion status to the main chat. Each milestone gets one block:

```
M001 — <name>
  Verification: <verified|failed|deferred|missing> — <sc_count> SC, <failed> failed, <pending> pending
  Validation:   <missing|N uncovered, N under-sampled>
  Roadmap:      <done|pending>
```

Followed by:

```
Blockers (<N>):
  - M001: 1 SC failed
  - M003: VALIDATION.md missing
  …
```

If `completion.status == complete` and `completion.blockers` is empty, jump to **Write summary**. Otherwise:

## Resolve blockers

For each blocker, give the user a targeted ask:

- `M<NNN>: VERIFICATION.md missing` → suggest `/np:verify-work <NNN>`.
- `M<NNN>: VALIDATION.md missing` → suggest `/np:validate-phase <NNN>`.
- `M<NNN>: N SC failed` → load `M<NNN>-VERIFICATION.md`, list the failing SCs, ask the user to either fix the code (re-spawn execute-phase) or accept the failure via askuser.
- `M<NNN>: N requirement(s) UNCOVERED` → suggest re-running `/np:validate-phase <NNN>` after adding tests.

Use askuser to confirm whether the user wants to proceed (with blockers recorded) or abort:

```bash
CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Close project?",
  "question": "Es gibt Blocker. Wie möchtest du fortfahren?",
  "options": [
    {"label": "Abort",                  "description": "Aktuelle Blocker zuerst beheben (empfohlen)."},
    {"label": "Close with blockers",    "description": "PROJECT-SUMMARY.md schreibt Blocker-Liste; project_status bleibt active."},
    {"label": "Force complete",         "description": "project_status=completed setzen trotz Blocker. Im Manifest forced=true."}
  ]
}')
```

Map the choice:
- `Abort` → `exit 1`
- `Close with blockers` → write summary, **do not** mark completed.
- `Force complete` → write summary AND mark completed (`forced=true` in manifest later when archived).

## Write summary

```bash
node .nubos-pilot/bin/np-tools.cjs close-project write-summary
```

Writes `.nubos-pilot/PROJECT-SUMMARY.md` with the milestone-by-milestone aggregate.

## Mark completed (only on no-blockers or Force-complete)

```bash
node .nubos-pilot/bin/np-tools.cjs close-project mark-completed
```

Sets `roadmap.yaml.project_status = "completed"` and `roadmap.yaml.completed_at` (ISO timestamp). Subsequent `/np:new-project` calls in the same workspace will detect this and offer archive-then-init.

## Output

- `.nubos-pilot/PROJECT-SUMMARY.md` written.
- (on success) `roadmap.yaml.project_status = completed`.
- User sees the aggregate report + next-step suggestion:

```
Project closed.

Summary: .nubos-pilot/PROJECT-SUMMARY.md
Status:  <complete|complete-with-blockers>
Next:
  - /np:new-project to scaffold a successor (will offer to archive this one)
  - or archive-project do --carry-over learnings,solutions
```

## Scope Guardrail

**Do:** read every M<NNN> VERIFICATION/VALIDATION, render aggregate, write `PROJECT-SUMMARY.md`, optionally flip `project_status`.
**Don't:** re-run `verify-work` or `validate-phase` (those are separate workflows); never modify milestone artefacts; never archive (that's `/np:new-project` or `archive-project do`).

## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — every milestone in `roadmap.yaml` is represented in `PROJECT-SUMMARY.md` (no skipped milestones).
- Rule 5 (Genuinely impress) — blockers are surfaced verbatim with file paths so the user can fix them deterministically; no "good enough" silent passes.
- Rule 10 (Test before shipping) — `project_status: completed` is only set when no blocker remains OR the user explicitly chose Force complete (recorded in the manifest as `forced=true`).
- Rule 11 (Ship the complete thing) — `PROJECT-SUMMARY.md` is fully populated on exit; no `_TBD` placeholders.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
