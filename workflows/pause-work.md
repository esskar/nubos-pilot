---
command: np:pause-work
description: Stamp STATE.session.stopped_at and resume_file for explicit session handoff. No git stash (D-08 semantic).
---

# /np:pause-work

<objective>
Record the session boundary in STATE.md so the next session (or a
different operator) can re-enter via `/np:resume-work`. The in-flight
checkpoint, if any, is untouched — it continues to capture the executor's
progress.
</objective>

## Execution

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
node .nubos-pilot/bin/np-tools.cjs init pause-work
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
Obey `$LANG_DIRECTIVE` for the resume-hint narration and any status lines
printed around the JSON payload. Supersedes CLAUDE.md.

Output is a small JSON payload `{ ok, stopped_at, resume_file }`. The
workflow simply displays it.

## Scope Guardrail

**Do:** stamp STATE.session; print the resume hint.
**Don't:** stash, discard, or modify the working tree; delete checkpoints
(resume-work needs them).

## Output

- STATE.md updated with `session.stopped_at = <ISO>` and
  `session.resume_file = .nubos-pilot/checkpoints/<task-id>.json` (or null
  if no active task).
## Definition of Done

Session boundary. Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 7 (Never leave a dangling thread) — every checkpoint is closed or explicitly preserved with reason.
- Rule 11 (Ship the complete thing) — `np:resume-work` can pick up exactly where this left off, no manual fixup.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
