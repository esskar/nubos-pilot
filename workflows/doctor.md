---
command: np:doctor
description: 12-check install-integrity scan (manifest, version, hooks, Codex config, askUser, codebase docs, layout, Nubosloop, output schemas). Use --fix to apply auto-safe fixes.
argument-hint: [--fix]
---

# np:doctor

Run a 12-check integrity scan of the nubos-pilot install: manifest integrity,
version mismatch, missing hooks, trapped Codex `[features]`, askUser broken,
codebase docs freshness, milestone/slice layout, the three Nubosloop checks
(critics present, knowledge store, config), orphan temp files, and output
schemas. Use `--fix` to apply auto-safe fixes; anything touching user files
outside the manifest will prompt via `askUser()` (SC-5).

```bash
node .nubos-pilot/bin/np-tools.cjs doctor "$@"
```
## Definition of Done

This workflow exits cleanly only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — every check runs; no skips. `--fix` only fixes what is mechanically safe.
- Rule 5 (Genuinely impress) — failures cite the exact file, the exact mismatch, the exact remediation command.
- Rule 11 (Ship the complete thing) — no `--fix` half-applies; either fully fixed or unchanged with the failure surfaced.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
