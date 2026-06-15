---
command: np:verify-work
description: Two-pass goal-backward verification after execution. Verifier agent classifies deterministic evidence; Pass-2 askUser loop resolves needs_user_confirm flags.
argument-hint: <milestone-number>
---

# /np:verify-work

<objective>
Verify that a just-executed milestone actually satisfies the ROADMAP `success_criteria`. Pass 1 = verifier subagent emits Pass/Fail/Defer with evidence; Pass 2 = workflow askUser resolves any `needs_user_confirm` items. Final artifact: `<milestone_dir>/<milestone_id>-VERIFICATION.md`.

Slice-level acceptance (UAT) is validated separately by `/np:validate-phase <N>` which reads each slice's `S<NNN>-UAT.md`.
</objective>

## Initialize

```bash
PHASE="$1"
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init verify-work init "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_VERIFIER=$(node .nubos-pilot/bin/np-tools.cjs agent-skills verifier 2>/dev/null)
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for user-facing output, askuser
prompts, and pass it into the np-verifier spawn prompt so VERIFICATION.md
prose (Pass/Fail findings, root-cause notes) follows the project language.
Test-case IDs, file paths, and stack traces stay canonical. Supersedes
CLAUDE.md.

Parse: `milestone`, `milestone_id`, `milestone_dir`, `milestone_name`, `success_criteria`, `draft_results`, `verification_path`, `slice_uat`, `verifier_tier`, `text_mode`, `text_mode_source`, `agent_skills`.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below (including the Pass-2 `needs_user_confirm` gate) is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

## Skills (Nubos library)

Instruct the verifier (in its spawn prompt) to load the matching Nubos skill before classifying — the skill's "Verification bar" is the standard the SC is judged against, not just the SC's own wording:

| SC type | Skill to use |
|---|---|
| Visual polish, layout, hierarchy, motion | `np-impeccable` (`.claude/skills/np-impeccable/SKILL.md`) |
| Accessibility, semantic HTML, keyboard/contrast | `np-web-design-guidelines`, `np-accessibility-audit` |
| Component architecture, design-system fit | `np-design` |
| API / endpoint / contract behaviour | `np-api-design` |
| Security, auth, input handling, secrets, crypto | `np-secure-code-review` (and `np-threat-model` if a new trust boundary) |
| Authorization — roles, permissions, ownership, access rules | `np-access-control` |
| Encryption, hashing, TLS, key/secret management | `np-encryption` |
| Personal/sensitive data handling, retention, logging | `np-data-privacy` |
| Schema / migration / data correctness | `np-data-modeling` |
| Error handling, retries, failure modes | `np-error-handling` |
| Resilience under dependency failure — timeout, circuit-breaker, fallback | `np-resilience-patterns` |
| Caching correctness / invalidation | `np-caching-strategy` |
| Async job / queue / worker behaviour — idempotency, ordering, DLQ | `np-queue-design` |
| Module/service boundary, coupling, contract integrity | `np-service-boundary` |
| Performance, latency, query/loop cost | `np-performance` |
| LLM / agent / retrieval behaviour | `np-llm-app-architecture`, `np-rag-design` |

For borderline Pass/Fail calls in Pass 2 (deterministic evidence inconclusive **and** the SC carries real consequences), pressure-test with **`np-council`** before flipping `needs_user_confirm` → `Pass`/`Fail`. An SC with no matching skill is judged on evidence alone.

## Output-Schema (pre-spawn injection)

The verifier MUST produce `M<NNN>-VERIFICATION.md` conforming to the `verification` output schema (frontmatter `schema_version: 2`, required counts, body `### SC-N: …` blocks with `Status / Classified by / Evidence`, no `[object Object]` titles). Inject the schema into the spawn prompt so the agent sees the contract verbatim:

```bash
VERIFICATION_SCHEMA=$(node .nubos-pilot/bin/np-tools.cjs output-lint prompt --schema verification)
```

Pass `$VERIFICATION_SCHEMA` as a literal section in the np-verifier spawn prompt (heading "## Output Schema — verification"). The agent has the schema in front of it before writing.

## Pass 1 — verifier agent

Spawn `agents/np-verifier.md` (tier: sonnet, READ-ONLY tools) with:

- `<files_to_read>` = `[M<NNN>-ROADMAP.md, M<NNN>-CONTEXT.md, every S<NNN>-PLAN.md, every S<NNN>-SUMMARY.md, every T<NNNN>-PLAN.md + T<NNNN>-SUMMARY.md, all task commits via git log --grep='^task(M<NNN>-']`
- `success_criteria` list from `$INIT`.
- `$VERIFICATION_SCHEMA` (the rendered schema-prompt — agent treats it as a hard contract, not advice).

The agent emits a structured verdict per SC: Pass | Fail | Needs-User-Confirm | Defer (never invents a SC, never edits source).

Persist the deterministic draft:

```bash
node .nubos-pilot/bin/np-tools.cjs init verify-work emit-draft "$PHASE"
```

## Pass 2 — user-driven gate for needs_user_confirm

For each result flagged `needs_user_confirm` by Pass 1, ask the user:

```bash
# Example — iterated by the workflow over each needs_user_confirm SC.
CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "header": "SC-3: UX feels responsive",
  "question": "Ist dieses Kriterium erfüllt?",
  "options": [
    {"label": "Pass",            "description": "Kriterium ist erfüllt."},
    {"label": "Fail",            "description": "Kriterium ist nicht erfüllt — Defekt."},
    {"label": "Defer",           "description": "Absichtlich zurückgestellt, später prüfen."},
    {"label": "Re-investigate", "description": "Brauche mehr Evidence — spawn Verifier nochmal."}
  ]
}')
node .nubos-pilot/bin/np-tools.cjs init verify-work record-sc "$PHASE" "SC-3" "$CHOICE"
```

## Hard-gate — Schema lint

Before declaring success, the just-written `M<NNN>-VERIFICATION.md` is lint-checked against the `verification` schema. Drift in frontmatter, missing required keys, wrong `Milestone Status` enum, broken `### SC-N: …` blocks, or `[object Object]` titles abort the workflow loudly:

```bash
LINT_PATH="$(node .nubos-pilot/bin/np-tools.cjs init verify-work init "$PHASE" | grep verification_path || true)"
node .nubos-pilot/bin/np-tools.cjs output-lint check \
  --file "${MILESTONE_DIR}/${MILESTONE_ID}-VERIFICATION.md" \
  --schema verification \
  --enforce \
  --text
LINT_RC=$?
if [[ "$LINT_RC" -ne 0 ]]; then
  echo "[np:verify-work] VERIFICATION.md violates output schema — re-spawn np-verifier with violation feedback above, or fix the agent prompt. Do NOT edit the file by hand." >&2
  exit 1
fi
```

This gate fires at write-time, not at `/np:close-project` aggregation time. Drift breaks here, not 7 milestones later.

## Hard-stop on Fail

If any result ends with `status: Fail` after Pass 1 or Pass 2:

```bash
echo "[np:verify-work] Milestone $PHASE hat Fail-Ergebnisse — LOUD FAIL." >&2
exit 1
```

## Scope Guardrail

**Do:** spawn `agents/np-verifier.md` with read-only tools; persist SC updates via `record-sc`; exit non-zero on any Fail.
**Don't:** let the verifier edit source files; self-classify subjective criteria; mask a Fail as Defer.

## Output

- `<milestone_dir>/<milestone_id>-VERIFICATION.md` written.
- Milestone status recorded as `verified | failed | deferred`.
- Ready for `/np:validate-phase $PHASE` to validate each slice's UAT.
## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 5 (Genuinely impress) — every success_criterion gets a Pass / Fail / Needs-User-Confirm verdict with deterministic evidence.
- Rule 10 (Test before shipping) — Pass requires commit SHA + test name + grep hit; manual evidence is Fail.
- Rule 11 (Ship the complete thing) — `M<NNN>-VERIFICATION.md` is fully populated on exit, no `null` rows.
- Rule 3 (Do it with tests / mechanical-check class) — `output-lint check --schema verification --enforce` is green; schema drift is a hard-stop, not a warning. ADR-0017.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
