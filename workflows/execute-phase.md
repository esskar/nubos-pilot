---
command: np:execute-phase
description: Executes a milestone wave-by-wave (slice = wave). Tasks inside a slice run in parallel; slices run serially. One executor agent per task, atomic commit per task via np-tools.cjs commit-task. Pass --verify-work to chain into /np:verify-work on success.
argument-hint: <milestone-number> [--verify-work]
---

# /np:execute-phase

<objective>
Execute every slice of a milestone in wave order: slice S001 first (all its tasks in parallel), then S002, etc. Per task: start a checkpoint, spawn `agents/np-executor.md` (sonnet), verify, and invoke `node .nubos-pilot/bin/np-tools.cjs commit-task <task-full-id>` for the atomic commit. All git operations route through lib/git.cjs — agents NEVER call `git` directly (ADR-0004, CLAUDE.md §Git operations).

**Wave semantics:** one slice == one wave. Tasks in a slice have no intra-slice deps (they're parallel-safe by planner contract). Cross-slice deps flow forward only: a task in S002 may depend on a task in S001.
</objective>

## Initialize

```bash
PHASE="$1"
shift || true

AUTO_VERIFY="false"
for arg in "$@"; do
  case "$arg" in
    --verify-work) AUTO_VERIFY="true" ;;
  esac
done

LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT_ARGS=("init" "execute-milestone" "init" "$PHASE")
if [[ "$AUTO_VERIFY" == "true" ]]; then INIT_ARGS+=("--verify-work"); fi
INIT=$(node .nubos-pilot/bin/np-tools.cjs "${INIT_ARGS[@]}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_EXECUTOR=$(node .nubos-pilot/bin/np-tools.cjs agent-skills executor 2>/dev/null)
RUNTIME=$(node .nubos-pilot/bin/np-tools.cjs detect-runtime)
WORKTREE_ISOLATION=$(node .nubos-pilot/bin/np-tools.cjs config-get workflow.worktree_isolation 2>/dev/null || echo "false")
TIER_ROUTING=$(node .nubos-pilot/bin/np-tools.cjs config-get workflow.tier_routing 2>/dev/null || echo "false")
VERIFY_RUNS=$(node .nubos-pilot/bin/np-tools.cjs config-get loop.verify_runs 2>/dev/null || echo "1")
```

When `--verify-work` is passed, the init payload's `auto_verify: true` flag tells this workflow to chain into `/np:verify-work $PHASE` after every slice committed and `finalize-milestone` ran. Without the flag the workflow stops after finalize as before — verify-work then remains a separate manual step.

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative for this workflow. Obey it for all user-
facing output, askuser prompts, and status updates. Pass `$LANG_DIRECTIVE`
into every np-executor spawn prompt as a system-level rule so task summaries
and checkpoint notes follow the project language. This supersedes any
directive in CLAUDE.md managed block.

Parse JSON for: `milestone`, `milestone_id`, `milestone_dir`, `waves[]` (each with `wave` (= slice number), `slice_id`, `slice_full_id`, `slice_dir`, `tasks[]`), `total_tasks`, `slice_count`, `executor_tier`, `auto_verify` (boolean — `true` when `--verify-work` was passed), `text_mode`, `text_mode_source`, `agent_skills`.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below (including the orphan-checkpoint and empty-milestone prompts) is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

`PLAN_ID` is iterated per slice as `${milestone_id}-${slice_id}` (e.g. `M001-S001`). `TASK_ID` is iterated from each slice's `tasks[]` (e.g. `M001-S001-T0001`).

## Skills (Nubos library)

Nubos ships a skill library under `.claude/skills/np-*/` (auto-installed by `npx nubos-pilot`, present only on Claude Code). For each task in a wave, before spawning `np-executor`, classify the task by reading its `T<NNNN>-PLAN.md` and inject the matching skill triggers into the executor's spawn prompt as a "Use these skills" directive. The executor then loads each skill's `SKILL.md` via the runtime's skill mechanism and follows its rules during implementation.

Match the task against **both** tables below — a task can match rows in each (e.g. a new authenticated endpoint backed by a migration is UI-free but matches `np-api-design` + `np-secure-code-review` + `np-data-modeling`). Skills **stack**: trigger every row whose signal the task matches. The only exception is the UI style anchor (pick exactly one). If more than ~4 rows match, keep the most task-critical and always retain any security row (`np-secure-code-review` / `np-threat-model`) and `np-test-strategy` for behaviour changes.

**UI / frontend** (match the dominant signal in `files_modified` + task description):

| Task signal | Skills to trigger |
|---|---|
| Any UI/component edit (`.tsx`, `.jsx`, `.vue`, `.svelte`, `views/**`, `components/**`, `pages/**`, `app/**`) | `np-impeccable` (polish/audit), `np-frontend-design` (build), `np-design` (review), `np-web-design-guidelines` (a11y/UX), `np-accessibility-audit` (WCAG AA bar) |
| `components.json` present in repo OR shadcn/ui imports in modified files | `np-shadcn` (in addition to UI skills above) |
| React/Next.js component or hook edit | `np-react-best-practices`, `np-composition-patterns` |
| Page/route transitions, `<ViewTransition>`, `startViewTransition` | `np-react-view-transitions` |
| React Native / Expo source (`*.tsx` under `app/`, `screens/`, `mobile/**`) | `np-react-native-skills` |
| Restyling an existing surface (no greenfield) | `np-redesign-existing-projects` |
| New surface needing visual direction | Pick exactly **one** style anchor: `np-high-end-visual-design` (default agency premium), `np-minimalist-ui`, `np-industrial-brutalist-ui`, or `np-stitch-design-taste` |

**Engineering / non-UI** (these stack — include each row the task matches):

| Task signal | Skills to trigger |
|---|---|
| Adds/changes a consumed contract — HTTP route, RPC/GraphQL handler, controller, resolver, public SDK/library function, CLI flag | `np-api-design` |
| Touches auth, authz, session, secrets, crypto, SQL/query construction, file upload, deserialization, or any untrusted input reaching a sink | `np-secure-code-review` |
| Introduces or alters a trust boundary — new ingress, webhook/callback, queue consumer, third-party integration, or a new store for credentials/PII | `np-threat-model` (with `np-secure-code-review`) |
| DB schema, migration, ORM model/entity, or any backfill/transform of persisted data | `np-data-modeling` |
| Backend/service/integration/IO path that can fail — external calls, retries, timeouts, batch work | `np-error-handling` |
| Calls an external/unreliable dependency (other service, third-party API, DB under load) | `np-resilience-patterns` (with `np-error-handling`) |
| New service/handler/job/integration path, or a new failure path that must be diagnosable | `np-observability` |
| Data access, queries, loops over collections, hot paths — anything that scales with input size | `np-performance` |
| Adds or changes a cache / memoization layer (in-memory, distributed, HTTP/CDN) | `np-caching-strategy` |
| Message queue, background job, worker, async consumer, or event handler | `np-queue-design` |
| Introduces or changes a module/service boundary, splits a service, or makes a cross-module change | `np-service-boundary` |
| Roles, permissions, policies, resource ownership, or access-rule changes (RBAC/ABAC, authz checks) | `np-access-control` (with `np-secure-code-review`) |
| Encryption, hashing, password storage, TLS, tokens, signing/HMAC, or key/secret management | `np-encryption` |
| Adds or upgrades a third-party dependency, or edits a manifest/lockfile | `np-dependency-audit` |
| Collects, stores, processes, exports, or logs personal/sensitive data (PII) | `np-data-privacy` |
| Refactor / cleanup / restructure where behaviour must be preserved | `np-refactoring` |
| Risky / hard-to-reverse / high-blast-radius change — feature flags, migration coupled to code, change to an external integration | `np-incident-response` |
| LLM / agent / prompt / tool-use / structured-output / AI feature | `np-llm-app-architecture` (add `np-rag-design` if it retrieves from a corpus) |
| Any change to logic or behaviour (almost all non-trivial tasks) | `np-test-strategy` |
| Pure docs/config with no behaviour change | None — skip the skill block |

**Spawn-prompt injection format.** Append to the executor prompt verbatim (one line per matched skill):

```
Use the following Nubos skills for this task: <skill-1>, <skill-2>, ...
Each skill is installed at .claude/skills/<skill>/SKILL.md and encodes a
quality bar you must satisfy before invoking commit-task.
```

**Consultation audit (counterpart to Rule 9).** Whenever you inject a non-empty skill block, BEFORE spawning the executor record the expected set so the post-critics gate can verify the executor actually consulted them:

```bash
node .nubos-pilot/bin/np-tools.cjs skill-audit expect --task "$TASK_ID" --skills "<skill-1>,<skill-2>,..."
```

The executor stamps each skill it reads via `skill-audit ack`. At post-critics, any injected-but-unconsulted skill becomes a `skill-bar-unconsulted` finding that routes the task back to the executor (once per round, bounded by `loop.maxRounds`) — exactly like a Rule-9 search miss. Skip the `expect` call only when zero skills were injected.

If zero skills match, omit the block — do **not** invent skills. Adding new skills under `skills/np-*/` in the source repo is sufficient: the next `npx nubos-pilot update` rolls them out and you extend this mapping in one PR.

## Pre-Flight — orphan-checkpoint guard

Detect stale checkpoints from a prior run before starting new work:

```bash
RESUME=$(node .nubos-pilot/bin/np-tools.cjs init resume-work)
RESUME_STATUS=$(echo "$RESUME" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).status))")
if [ "$RESUME_STATUS" = "orphan" ]; then
  CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Verwaiste Checkpoints gefunden",
    "question": "Vor dem Milestone-Start wurden Checkpoint-Dateien ohne passenden STATE.current_task gefunden. Was tun?",
    "options": [
      {"label": "Clean working tree (reset-slice)", "description": "Verwirft die in-flight Task und löscht ihren Checkpoint."},
      {"label": "Resume the orphan task",            "description": "Setzt STATE.current_task auf den Checkpoint-Eintrag und spawnt den Executor."},
      {"label": "Abort",                              "description": "Exit, User entscheidet manuell."}
    ]
  }')
  case "$CHOICE" in
    "Abort") exit 0 ;;
  esac
fi
```

## Pre-Flight — empty milestone guard

```bash
TOTAL_TASKS=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).total_tasks))")
if [ "$TOTAL_TASKS" = "0" ]; then
  echo "execute-phase: milestone $PHASE has 0 tasks. Did /np:plan-phase $PHASE run with task files scaffolded?" >&2
  echo "  Try: /np:plan-phase $PHASE --repromote" >&2
  exit 1
fi
```

## Execution — per-task Nubosloop, slices serial

Every task runs through the **Nubosloop** (ADR-0010, `lib/nubosloop.cjs`) — pre-flight cache lookup → researcher-schwarm (on miss) → executor or build-fixer → mechanical checks + tool-use audit → critic-schwarm → route. The loop terminates only on (a) `loop-evaluate.next_action == "commit"` (zero blocking findings) followed by `commit-task` (atomic commit per ADR-0004), or (b) `loop.maxRounds` cap (default `3`) reached → `loop-run-round --phase stuck` writes the marker, dashboard surfaces it, orchestrator escalates via `askuser`. Single-pass `executor → commit-task` is forbidden — the loop is the only sanctioned path.

**Wave shape (slices serial, tasks parallel within a slice):**

1. Dispatch **all tasks in the slice in parallel** — each task is one independent Nubosloop instance.
2. Wait until every task in the slice committed OR is `stuck` OR hit `plan-checker`.
3. If any task is `stuck` or hit `plan-checker` → stop the wave and exit non-zero. Previously committed tasks remain committed.
4. Move to the next slice.

**Per-task driver (single agent-native CLI surface):** `node .nubos-pilot/bin/np-tools.cjs loop-run-round <task-id> --phase <preflight|post-executor|post-critics|commit|stuck>`. Every non-LLM transition lives in this verb; LLM spawns (researcher, executor / build-fixer, critics) remain extern and feed their results back via `--query` / `--verify-exit-code` / `--critic-outputs`. A non-LLM runtime can drive the loop with five shell-outs per round.

**Per-task, per-round protocol:**

1. **Pre-flight cache lookup** (Round 1 only) — `loop-run-round --phase preflight --query "$TASK_QUERY"`. A hit at similarity ≥ `swarm.research.threshold` and `occurrence ≥ swarm.research.minOccurrence` short-circuits the Researcher-Schwarm; the cached pattern enters the Executor prompt with provenance `[CACHED]`. Soft cache failures (adapter-unknown) downgrade to a miss with `cache_miss_reason` populated; hard failures (corrupt store, version mismatch) propagate.
2. **Researcher-Schwarm (on cache miss, or on `next_action=researcher` re-route)** — orchestrator spawns `swarm.research.k=3` independent `np-researcher` agents IN PARALLEL (single message, three Agent blocks) and merges their outputs through `lib/researcher-swarm.cjs::mergeConsensus` (Mehrheit / Union / Schnittmenge). The merged consensus enters the Executor prompt with provenance.
3. **Executor (R1) or Build-Fixer (R≥2)** — single LLM spawn. Round 1 spawns `agents/np-executor.md`. Round ≥ 2 spawns `agents/np-build-fixer.md` with prior critic findings + verify output appended. Edits ONLY paths in `files_modified` (D-04 — no scope expansion). Does NOT call `commit-task`.
4. **Mechanical Checks (orchestrator, NOT the agent)** — run task's `<verify>` command + stack linters (`phpstan`, `pint`, `tsc`, `eslint`); capture exit code + output to `$VERIFY_LOG`. Then `loop-audit-tool-use "$TASK_ID" --agent "$EXECUTOR_AGENT" --tool-use-log <json>` confirms the spawn invoked a knowledge-search tool ≥ 1× (Rule 9). The audited agent satisfies Rule 9 by running `node np-tools.cjs knowledge-search "<query>" --task "$TASK_ID"` via Bash, then stamping the exact string `knowledge-search` in `--tool-use-log`. The full accepted set is the `SEARCH_TOOLS` constant in `lib/nubosloop.cjs`; that constant is the single source of truth — do not re-enumerate it here. Audit findings get round-stamped and feed `loop-evaluate` alongside critic findings. Then call `loop-run-round --phase post-executor --verify-exit-code "$VERIFY_EXIT" --verify-output-path "$VERIFY_LOG"`. On verify-red the verb returns `next_action: spawn-build-fixer` — skip critics, advance to next round directly.
5. **Critic (verify-green only)** — one Critic agent spawns: `agents/np-critic.md` (sonnet). It writes the full findings JSON to `$CRITIC_REPORT_PATH` and emits a small verdict envelope as its final message (ADR-0010 §L5 Verdict-Only Contract, 2026-05-05). Single-critic revision per §Trust Layer 2026-05-05 — the prior 3-critic schwarm collapsed because three parallel spawns added latency without proportional finding-quality gains; the Verdict-Only Contract on top reduces per-round main-context tokens by an order of magnitude (verbatim findings reports were the dominant Nubosloop cost-driver).
6. **Route** — `loop-run-round --phase post-critics --critic-outputs-path "$CRITIC_REPORT_PATH"` (or legacy `--critic-outputs "$CRITIC_JSON"` when the Verdict-Only Contract is unavailable) returns `next_action ∈ {commit, executor, researcher, askuser, plan-checker, stuck}`:

   | `next_action`    | Trigger                            | Action                                                          |
   |------------------|------------------------------------|-----------------------------------------------------------------|
   | `commit`         | Zero blocking findings             | `loop-run-round --phase commit` + `commit-task` (atomic)        |
   | `executor`       | Style/Bug/Test/Acceptance findings | R≥2: spawn `np-build-fixer` with prior findings (next round)    |
   | `researcher`     | `information-missing` finding      | Re-run Researcher-Schwarm with the gap as input (next round)    |
   | `askuser`        | `question-to-user` finding         | Block on user reply via `askuser`; resume same round            |
   | `plan-checker`   | `locked-decision-violation`        | Abort wave; orchestrator escalates                              |
   | `stuck`          | `loop.maxRounds` reached           | `loop-run-round --phase stuck` + dashboard + askuser escalation |

7. **Commit** — `loop-run-round --phase commit --learning-pattern "$CONSENSUS_PATTERN" --learning-outcome verified` stamps the checkpoint to `pre-commit` and auto-logs the learning (when `auto_log_learning=true`, default — feeds future Round-1 cache hits). Then `node .nubos-pilot/bin/np-tools.cjs commit-task "$TASK_ID"` performs the atomic commit per ADR-0004.

   **Two terminal outcomes**, both exit 0 and complete the task:

   | `committed` | `skip_reason`           | When it fires                                                              | Wave handling |
   |-------------|-------------------------|----------------------------------------------------------------------------|---------------|
   | `true`      | _(absent)_              | At least one `files_modified` entry is tracked → atomic commit lands       | Continue      |
   | `false`     | `artifacts-gitignored`  | Every `files_modified` entry is gitignored (e.g. `.nubos-pilot/codebase/modules/*.md` when artifacts aren't versioned) | Continue — task is done, no commit produced |

   The orchestrator checks `git check-ignore --quiet --` per file: exit 0 = ignored, exit 1 = tracked, exit ≥ 2 = real failure (propagate). Soft-skip is not a failure mode — `commit-task` deletes the checkpoint and sets task status to `done` symmetric to a real commit. **Mixed paths** (some tracked, some ignored) commit only the tracked subset and emit a `[nubos-pilot warn] gitignored (skipping): …` line; the task is `committed: true` with `files_ignored` populated for audit. Gitignore state is a routing signal, never a hard stop — symmetric to the container-state doctrine.

**Per-task loop control values (read once at wave start):**

```bash
LOOP_MAX_ROUNDS=$(node .nubos-pilot/bin/np-tools.cjs config-get loop.maxRounds 2>/dev/null || echo 3)
SWARM_K=$(node .nubos-pilot/bin/np-tools.cjs config-get swarm.research.k 2>/dev/null || echo 3)
SWARM_THRESHOLD=$(node .nubos-pilot/bin/np-tools.cjs config-get swarm.research.threshold 2>/dev/null || echo 0.9)
SWARM_MIN_OCC=$(node .nubos-pilot/bin/np-tools.cjs config-get swarm.research.minOccurrence 2>/dev/null || echo 3)
AUTO_LOG_LEARNING=$(node .nubos-pilot/bin/np-tools.cjs config-get auto_log_learning 2>/dev/null || echo true)
SPAWN_HEADLESS_ENABLED=$(node .nubos-pilot/bin/np-tools.cjs config-get spawn.headless.enabled 2>/dev/null || echo false)
SPAWN_HEADLESS_AGENTS=$(node .nubos-pilot/bin/np-tools.cjs config-get spawn.headless.agents 2>/dev/null || echo '["np-critic","np-researcher"]')
SPAWN_HEADLESS_FALLBACK=$(node .nubos-pilot/bin/np-tools.cjs config-get spawn.headless.fallback_on_error 2>/dev/null || echo true)
CONF_INJECT_CRITERIA=$(node .nubos-pilot/bin/np-tools.cjs config-get conformance.inject_criteria 2>/dev/null || echo true)
# Milestone success_criteria as the executor's acceptance target (rendered once from the INIT payload).
# Intent-level only (ADR-0019): these describe what "done right" means, NOT how to build it.
SUCCESS_CRITERIA_BLOCK=$(echo "$INIT" | node -e 'process.stdin.on("data",d=>{try{const c=JSON.parse(d).success_criteria||[];console.log(c.map(x=>"- "+(x.id?x.id+": ":"")+(x.text||x)).join("\n"))}catch(e){console.log("")}})')
```

## Spawn dispatch — agent-tool vs. headless subprocess (ADR-0010 §L6)

By default, `np-researcher` and `np-critic` spawns go through the runtime's
native Agent tool — the parent context picks up the spawn's final message as a
tool result. When `spawn.headless.enabled=true` AND the agent name appears in
`spawn.headless.agents`, the orchestrator instead shells out to
`node .nubos-pilot/bin/np-tools.cjs spawn-headless --agent <name> ...`, which
runs the agent inside an isolated `claude -p` subprocess. The subprocess'
final-message is captured to disk; the parent context only sees an exit code
plus the path. This buys true context detach for the verbose-but-bounded
critic/researcher passes — at the cost of an own prompt cache, separate auth,
and a cold-start per spawn.

**Dispatch helper (use at every np-researcher / np-critic spawn point):**

```bash
_spawn_dispatch_is_headless() {
  local agent="$1"
  [ "$SPAWN_HEADLESS_ENABLED" = "true" ] || return 1
  echo "$SPAWN_HEADLESS_AGENTS" | node -e \
    "let l=''; process.stdin.on('data',d=>l+=d); process.stdin.on('end',()=>{
      try { const arr = JSON.parse(l); process.exit(arr.includes(process.argv[1]) ? 0 : 1); }
      catch (e) { process.exit(1); }
    })" "$agent"
}
```

For each headless spawn the orchestrator (a) writes the rendered prompt to
`${TMPDIR:-/tmp}/nubos-pilot/prompts/<agent>-<task-id>-r<round>.md`,
(b) calls `spawn-headless --agent <name> --prompt-path … --output-path …`,
(c) on non-zero exit AND `spawn.headless.fallback_on_error=true`, falls back to
the regular agent-tool spawn. Falling back is logged on the checkpoint
(`spawn_headless_fallbacks[]`) so the fallback rate is visible on
`/np:dashboard`. **The Layer-C `loop-audit-tool-use` stamp is identical for
both paths** — it is the orchestrator's responsibility to call it after the
spawn returns, regardless of whether the spawn went through the agent tool or
the headless subprocess. Bypassing the audit by going headless is a Layer-C
violation by the same definition as before.

`np-executor` and `np-build-fixer` are NEVER eligible for headless spawn —
they edit files in the working tree and depend on the parent runtime's file
write semantics. `spawn.headless.agents` defaults to `['np-critic','np-researcher']`
for exactly this reason; do not extend it without understanding which agents
mutate the working tree.

**Per-task max-rounds override (T3, ADR-0010 Trust-Layer):** before entering the per-task while-loop, check the task's checkpoint for a `max_rounds_override` (set when the operator answered the stuck-dialog with "Weitermachen +5 Runden"). If present, it beats the config default — both for the bash while-cap and for the `post-critics` `evaluateLoop` cap.

```bash
OVERRIDE=$(node .nubos-pilot/bin/np-tools.cjs loop-state-read "$TASK_ID" 2>/dev/null \
  | node -e 'process.stdin.on("data",d=>{try{const j=JSON.parse(d);const o=j&&j.nubosloop&&j.nubosloop.max_rounds_override;console.log(Number.isInteger(o)&&o>=1?o:"")}catch(e){console.log("")}}')
[ -n "$OVERRIDE" ] && LOOP_MAX_ROUNDS="$OVERRIDE"
```

**Wave + per-task pseudocode (this is the executable shape — the orchestrator drives this verbatim, not just „shape but not concrete syntax"):**

```bash
for WAVE_INDEX in 0 1 2 ...; do
  WAVE=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.stringify(JSON.parse(d).waves[$WAVE_INDEX])))")
  [ -z "$WAVE" ] || [ "$WAVE" = "undefined" ] && break

  SLICE_FULL_ID=$(echo "$WAVE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).slice_full_id))")
  TASK_IDS=$(echo "$WAVE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).tasks.map(t=>t.id).join(' ')))")

  echo "=== Wave $((WAVE_INDEX+1)): $SLICE_FULL_ID — tasks: $TASK_IDS ===" >&2

  # Worktree-Isolation (ADR-0008): when workflow.worktree_isolation=true,
  # create an isolated git worktree for this slice. Nubosloop instances
  # run inside the worktree (cwd = worktree path); commits land on the
  # slice branch np/<slice-full-id>; FF-merged back on success.
  SLICE_CWD="$PWD"
  if [ "$WORKTREE_ISOLATION" = "true" ]; then
    WT_CREATE=$(node .nubos-pilot/bin/np-tools.cjs worktree-create "$SLICE_FULL_ID")
    SLICE_CWD=$(echo "$WT_CREATE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).path))")
    echo "[np:execute-phase] worktree created at $SLICE_CWD (branch np/$SLICE_FULL_ID)" >&2
  fi

  # PARALLEL DISPATCH per task — one Nubosloop instance per task.
  # The orchestrator's parallel primitive dispatches each task's loop
  # body in a single message (one Agent block per task per LLM step).
  for TASK_ID in $TASK_IDS; do
    # IN PARALLEL across tasks in the slice:

    node .nubos-pilot/bin/np-tools.cjs checkpoint start "$TASK_ID" \
      --phase "$PHASE" --plan "$SLICE_FULL_ID" --wave "$((WAVE_INDEX+1))"

    TASK_JSON=$(node .nubos-pilot/bin/np-tools.cjs init execute-milestone execute-task "$PHASE" "$TASK_ID")
    if [[ "$TASK_JSON" == @file:* ]]; then TASK_JSON=$(cat "${TASK_JSON#@file:}"); fi
    TASK_QUERY=$(echo "$TASK_JSON" | node -e "process.stdin.on('data', d => { const j=JSON.parse(d); console.log(j.query || j.name || ''); })")
    TASK_TIER=$(echo "$TASK_JSON" | node -e "process.stdin.on('data', d => { const j=JSON.parse(d); console.log(j.tier || 'sonnet'); })")

    EXECUTOR_START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
    CONSENSUS_PATTERN=""
    NEXT_ACTION=""
    CACHE_HIT="false"
    ROUND=1
    # T3: honor a max_rounds_override stamped by a prior stuck-dialog
    # ("Weitermachen +5 Runden"). Survives /np:resume-work after a crash.
    TASK_OVERRIDE=$(node .nubos-pilot/bin/np-tools.cjs loop-state-read "$TASK_ID" 2>/dev/null \
      | node -e 'process.stdin.on("data",d=>{try{const j=JSON.parse(d);const o=j&&j.nubosloop&&j.nubosloop.max_rounds_override;console.log(Number.isInteger(o)&&o>=1?o:"")}catch(e){console.log("")}}')
    [ -n "$TASK_OVERRIDE" ] && LOOP_MAX_ROUNDS="$TASK_OVERRIDE"

    while [ "$ROUND" -le "$LOOP_MAX_ROUNDS" ]; do

      # === Step 1: pre-flight cache lookup (Round 1 only) ===
      if [ "$ROUND" -eq 1 ]; then
        PREFLIGHT=$(node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
          --phase preflight --query "$TASK_QUERY")
        CACHE_HIT=$(echo "$PREFLIGHT" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).cache_hit||false))')
      fi

      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # ACTION CONTRACT — Step 2: Researcher-Schwarm
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # WHEN: Round 1 cache-miss ($CACHE_HIT != "true") OR $NEXT_ACTION=researcher.
      # SKIP-GUARD: loop-post-researcher-missing-spawn-audit (needs $SWARM_K audits).
      # NO short-circuit. NO synthetic consensus. NO topic-split.
      #
      # Execute EXACTLY these three groups, in order:
      #
      # (1) ONE message with $SWARM_K PARALLEL Agent tool-calls (real tool-calls,
      #     not bash). Default $SWARM_K=3:
      #       Agent(subagent_type="np-researcher", prompt=<spawn_specs[0]>)
      #       Agent(subagent_type="np-researcher", prompt=<spawn_specs[1]>)
      #       Agent(subagent_type="np-researcher", prompt=<spawn_specs[2]>)
      #     Every prompt: <task_query>=$TASK_QUERY verbatim (identical for all k),
      #     <seed_delta>=swarm.spawn_specs[i].seed_delta (one line, per-spawn),
      #     <files_to_read>=task plan + slice plan + prior slice SUMMARYs +
      #     CONTEXT.md + codebase docs. Each spawn writes structured output to
      #     $TMPDIR/np-spawn-${TASK_ID}-r${ROUND}-${i}.json.
      #
      # (2) $SWARM_K Bash audit-stamps (one per returned spawn, same round):
      #       node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" \
      #         --agent np-researcher --tool-use-log <tool_use_json_array>
      #
      # (3) ONE Bash advance:
      #       node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
      #         --phase post-researcher
      #
      # Then merge: CONSENSUS_PATTERN=$(node .nubos-pilot/bin/researcher-merge.cjs
      # "${SPAWN_OUT_PATHS[@]}") — provenance [VERIFIED] on majority+citation,
      # else [PROVISIONAL]. Cache-hit branch (R1, $CACHE_HIT=true) skips (1)-(3)
      # and leaves $CONSENSUS_PATTERN empty (commit auto-log skips on cache_hit).
      #
      # Rationale: ADR-0010 §Gap-#6 — synthetic-consensus-bypass mechanisch
      # geblockt (2026-05-05). Topic-splitting collapses agreement_score → 0.
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if { [ "$ROUND" -eq 1 ] && [ "$CACHE_HIT" != "true" ]; } || [ "$NEXT_ACTION" = "researcher" ]; then
        SPAWN_SPECS=$(echo "$PREFLIGHT" | node -e \
          'process.stdin.on("data",d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify((j.swarm&&j.swarm.spawn_specs)||[]))})')
        # → execute groups (1) + (2) per ACTION CONTRACT above, then:
        CONSENSUS_PATTERN=$(node .nubos-pilot/bin/researcher-merge.cjs \
          "${SPAWN_OUT_PATHS[@]}")
        node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" --phase post-researcher
      elif [ "$CACHE_HIT" = "true" ] && [ -z "$CONSENSUS_PATTERN" ]; then
        CONSENSUS_PATTERN=""
      fi

      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # ACTION CONTRACT — Step 3: Executor (R1) / Build-Fixer (R≥2)
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # Execute EXACTLY:
      #
      # (1) ONE Agent tool-call (real, not bash) — R1: np-executor, R≥2: np-build-fixer:
      #       Agent(subagent_type="$EXECUTOR_AGENT", model="$EXECUTOR_MODEL", prompt=<…>)
      #     Prompt fields:
      #       <files_to_read>: task plan, slice plan, prior slice SUMMARYs, CONTEXT.md
      #       <consensus_pattern>: $CONSENSUS_PATTERN (with [VERIFIED]/[PROVISIONAL]/[CACHED])
      #       <success_criteria>: when $CONF_INJECT_CRITERIA = true, include the milestone
      #         acceptance target — $SUCCESS_CRITERIA_BLOCK plus the slice UAT path
      #         (.nubos-pilot/milestones/M<NNN>/slices/S<NNN>/S<NNN>-UAT.md). Frame it as
      #         "what done-right means (intent, ADR-0019) — NOT a build spec, NOT a scope
      #         expansion". Omit the field entirely when the flag is false.
      #       <prior_findings>: critic findings JSON   (R≥2 only)
      #       <verify_excerpt>: tail of $VERIFY_LOG    (R≥2 only)
      #       <lang_directive>: $LANG_DIRECTIVE
      #       <skills>: $AGENT_SKILLS_EXECUTOR
      #     RULES — Agent MUST: edit ONLY paths in files_modified (D-04 scope guard) —
      #     success_criteria are the acceptance target, NEVER a licence to touch other files,
      #     run `node np-tools.cjs knowledge-search "<q>" --task $TASK_ID` via Bash
      #     ≥1× (Rule 9 — the --task flag writes the audit evidence ledger),
      #     NOT call commit-task. Capture tool_use stream for audit (group (3) below).
      #
      # (2) Checkpoint transition (Bash, runs AFTER Agent returns):
      #       node .nubos-pilot/bin/np-tools.cjs checkpoint transition "$TASK_ID" verifying
      #
      # (3) Tool-use audit-stamp (Bash) — see Step 4 below; this is the
      #     post-executor evidence required by Layer-C guard
      #     `loop-post-executor-missing-spawn-audit`.
      #
      # Rationale: ADR-0010 Layer-C — verify-green stamped without an actual
      # Agent spawn is the canonical bypass; the audit-stamp is what makes the
      # gate's "the executor actually ran" check non-fakeable.
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if [ "$ROUND" -eq 1 ]; then
        EXECUTOR_AGENT="np-executor"
      else
        EXECUTOR_AGENT="np-build-fixer"
      fi
      # Model resolution. Default (tier_routing off): the executor always runs at
      # the `frontier` profile — every task gets the strongest model. Opt-in
      # tier-routing (config `workflow.tier_routing: true`) instead honours the
      # planner's per-task `tier` under the project's configured `model_profile`
      # (default `balanced`), so trivial→haiku / standard→sonnet / large→opus —
      # ECC-style cost-aware routing. Round-2+ build-fixer always stays frontier:
      # fixing a failing task wants the strongest model regardless of routing.
      if [[ "$TIER_ROUTING" == "true" && "$ROUND" -eq 1 ]]; then
        EXECUTOR_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model "$TASK_TIER")
      else
        EXECUTOR_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model "$EXECUTOR_AGENT" --profile frontier)
      fi
      # → execute group (1) per ACTION CONTRACT above, then:

      node .nubos-pilot/bin/np-tools.cjs checkpoint transition "$TASK_ID" verifying

      # === Step 4: Mechanical Checks + spawn-evidence audit (orchestrator-side) ===
      VERIFY_LOG="${TMPDIR:-/tmp}/np-verify-${TASK_ID}-r${ROUND}.log"
      # Orchestrator (NOT the agent) runs the task's <verify> command + stack
      # linters; redirect stdout+stderr to $VERIFY_LOG.
      #
      # pass@k reliability (opt-in, $VERIFY_RUNS, default 1): run the SAME verify
      # command $VERIFY_RUNS times, collecting one exit code per run into a
      # comma-separated list ($VERIFY_CODES, e.g. "0,1,0"). With the default of 1
      # this is a single run, identical to before. Then fold the runs:
      #   VERIFY_EXIT=$?                                   # when $VERIFY_RUNS == 1
      #   # when $VERIFY_RUNS > 1:
      #   REL=$(node .nubos-pilot/bin/np-tools.cjs verify-reliability --codes "$VERIFY_CODES")
      #   VERIFY_EXIT=$(echo "$REL" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).aggregate_exit_code))')
      #   # append the human verdict so a FLAKY task tells the build-fixer why it is red:
      #   echo "$REL" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).description))' >> "$VERIFY_LOG"
      # aggregate_exit_code is 0 only when EVERY run passed (pass^k); a flaky task
      # (some pass, some fail) aggregates to red and flows through the normal
      # spawn-build-fixer path below — no new critic category, no spurious stuck.
      VERIFY_EXIT=$?
      # Stamp executor spawn-evidence into the audit log. EXECUTOR_TOOL_LOG is
      # the tool-name JSON array harvested from the spawn's tool_use stream
      # (e.g. '["Read","knowledge-search","Edit","Bash"]'). For AUDITED_AGENTS
      # this drives Rule 9 enforcement: a `knowledge-search` entry is credited
      # only when the spawn ran the CLI with --task (which writes the evidence
      # ledger) — a fabricated log entry fails as rule-9-search-tool-unverified.
      # The round number is sourced automatically from the checkpoint by
      # loop-audit-tool-use. The post-executor gate (Layer C) refuses to advance
      # unless this evidence stamp exists for the current round.
      node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" \
        --agent "$EXECUTOR_AGENT" --tool-use-log "$EXECUTOR_TOOL_LOG"

      POST_EXEC=$(node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
        --phase post-executor \
        --verify-exit-code "$VERIFY_EXIT" --verify-output-path "$VERIFY_LOG")
      POST_EXEC_NEXT=$(echo "$POST_EXEC" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).next_action))')

      # Verify-red short-circuits to build-fixer next round (skip critics).
      if [ "$POST_EXEC_NEXT" = "spawn-build-fixer" ]; then
        ROUND=$((ROUND+1))
        continue
      fi

      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # ACTION CONTRACT — Step 5: Critic (verify-green only, one spawn)
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      # SKIP-GUARD: loop-post-critics-missing-critic-audit (needs 1 critic audit).
      # NO synthetic --critic-outputs JSON without a real Agent spawn.
      #
      # Execute EXACTLY these four steps, in order:
      #
      # (1) Bash — pre-create the report path:
      #       mkdir -p "${TMPDIR:-/tmp}/nubos-pilot/critic-reports"
      #       CRITIC_REPORT_PATH="${TMPDIR:-/tmp}/nubos-pilot/critic-reports/critic-${TASK_ID}-r${ROUND}.json"
      #
      # (2) ONE Agent tool-call (real, not bash) — np-critic, sonnet by default:
      #       Agent(subagent_type="np-critic", prompt=<…>)
      #     Prompt fields:
      #       <files_to_read>
      #         - <task plan path>
      #         - <slice UAT path>
      #         - <milestone CONTEXT path>
      #         - <verify output path>
      #         - agents/np-critic-style.md
      #         - agents/np-critic-tests.md
      #         - agents/np-critic-acceptance.md
      #       <report_path>$CRITIC_REPORT_PATH</report_path>
      #     Agent MUST: Write the full findings JSON to $CRITIC_REPORT_PATH,
      #     emit ONLY the verdict-envelope as final message (~150 bytes):
      #       { critic, task_id, round, verdict, blockers_count, report_path, run_id }
      #
      # (3) Bash audit-stamp (MANDATORY, AFTER the Agent returns):
      #       node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" \
      #         --agent np-critic --tool-use-log '[]'
      #     --tool-use-log may be '[]' (critic isn't AUDITED_AGENT for Rule 9);
      #     supplying the real tool list is preferred for np:dashboard.
      #
      # (4) Bash route (reads findings JSON from disk, NOT the envelope):
      #       node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
      #         --phase post-critics --critic-outputs-path "$CRITIC_REPORT_PATH"
      #
      # Rationale: ADR-0010 §L5 (Verdict-Only Contract, 2026-05-05) — verbose
      # findings stay on disk; ADR-0010 Trust-Layer L3 — synthetic critic JSON
      # without (3) audit-stamp is mechanically blocked.
      # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      mkdir -p "${TMPDIR:-/tmp}/nubos-pilot/critic-reports"
      CRITIC_REPORT_PATH="${TMPDIR:-/tmp}/nubos-pilot/critic-reports/critic-${TASK_ID}-r${ROUND}.json"
      # → execute group (2) per ACTION CONTRACT above, then:
      node .nubos-pilot/bin/np-tools.cjs loop-audit-tool-use "$TASK_ID" --agent np-critic --tool-use-log '[]'
      POST_CRIT=$(node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
        --phase post-critics --critic-outputs-path "$CRITIC_REPORT_PATH")
      NEXT_ACTION=$(echo "$POST_CRIT" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).next_action))')

      case "$NEXT_ACTION" in
        commit)        break ;;
        executor)      ROUND=$((ROUND+1)); continue ;;
        researcher)    ROUND=$((ROUND+1)); continue ;;
        askuser)       # ADR-0010 Trust-Layer L3: persisted re-entry — without
                       # this stamp the next while-iteration would loop forever
                       # because the critic emits the same `question-to-user`
                       # finding. Pull the spec from POST_CRIT.routing, stamp
                       # it on the checkpoint (so /np:resume-work can recover),
                       # block on the user, then stamp the reply.
                       ASKUSER_SPEC=$(echo "$POST_CRIT" | node -e 'process.stdin.on("data",d=>{const j=JSON.parse(d); const askq=(j.routing&&j.routing.askuser)||[]; console.log(JSON.stringify(askq[0]||{}))}')
                       node .nubos-pilot/bin/np-tools.cjs loop-state-record "$TASK_ID" \
                         --json "{\"pending_askuser_spec\":$ASKUSER_SPEC,\"last_action\":\"awaiting-user\"}"
                       USER_REPLY=$(node .nubos-pilot/bin/np-tools.cjs askuser --json "$ASKUSER_SPEC")
                       node .nubos-pilot/bin/np-tools.cjs loop-state-record "$TASK_ID" \
                         --json "{\"user_reply\":$(printf %s "$USER_REPLY" | node -e 'process.stdin.on("data",d=>console.log(JSON.stringify(String(d).trim())))'),\"pending_askuser_spec\":null,\"last_action\":\"user-replied\"}"
                       # Gap #2 from the 2026-05-05 review: bump bash ROUND to
                       # match the checkpoint round (which post-critics already
                       # advanced when next_action=askuser). The Layer-C audit
                       # for the next executor re-spawn now has to be FRESH
                       # (round=N+1); the old N-stamped audit no longer
                       # satisfies the gate. Without this bump the bash counter
                       # would lag the checkpoint and maxRounds-stuck could
                       # mis-fire.
                       ROUND=$((ROUND+1))
                       continue ;;
        plan-checker)  # Locked-decision-violation or infrastructure-mismatch:
                       # the plan or the environment is wrong, the executor
                       # cannot fix it. Mirror the stuck-dialog and let the
                       # operator pick a recovery path (Gap #5 — doctrine
                       # consistency: every plan-bug class gets the user
                       # pulled into the discussion, no silent exit 2).
                       PLAN_ASK=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
                         "type": "select",
                         "header": "Plan-Bug erkannt",
                         "question": "Task '"$TASK_ID"' hat eine plan-checker-Route ausgelöst (locked-decision-violation oder infrastructure-mismatch). Der Executor kann das nicht selbst fixen — der Plan oder das Environment muss korrigiert werden. Was tun?",
                         "options": [
                           {"label": "Plan neu prüfen (plan-checker)",   "description": "Task wird als plan-bug markiert, plan-checker korrigiert PLAN.md, Task neu gestartet. Greift bei locked-decision-violation und Plan-Inkonsistenzen."},
                           {"label": "Task als stuck markieren",          "description": "Task wird als stuck in STATE.md persistiert, Wave wird abgebrochen. /np:resume-work nach manueller Klärung."},
                           {"label": "Manuell fixen, dann resumen",       "description": "Workflow pausiert hier. Du editierst Code/Plan/Dockerfile und rufst /np:execute-phase '"$PHASE"' nochmal auf (passt für infrastructure-mismatch)."}
                         ]
                       }')
                       case "$PLAN_ASK" in
                         "Plan neu prüfen"*)
                           node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
                             --phase stuck --reason "user-requested-replan" --findings-path "$CRITIC_REPORT_PATH"
                           echo "[np:execute-phase] $TASK_ID flagged for plan-checker. Run /np:plan-phase $PHASE --repromote, then re-run /np:execute-phase $PHASE." >&2
                           exit 4 ;;
                         "Task als stuck"*)
                           node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
                             --phase stuck --reason "plan-checker-user-stuck" --findings-path "$CRITIC_REPORT_PATH"
                           echo "[np:execute-phase] $TASK_ID marked stuck (user choice from plan-checker dialog)." >&2
                           exit 3 ;;
                         "Manuell fixen"*)
                           node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
                             --phase stuck --reason "manual-fix-pending" --findings-path "$CRITIC_REPORT_PATH"
                           echo "[np:execute-phase] $TASK_ID paused for manual fix. Resume via /np:execute-phase $PHASE when ready." >&2
                           exit 0 ;;
                       esac ;;
        stuck)         # Hitting maxRounds = "this task may be mis-planned, discuss".
                       # Don't exit — askuser, give the operator four concrete options
                       # to recover. The operator-facing options match the failure modes
                       # we've actually seen in production.
                       STUCK_ASK=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
                         "type": "select",
                         "header": "Task stuck",
                         "question": "Task '"$TASK_ID"' hat '"$LOOP_MAX_ROUNDS"' Runden im Critic-Loop ohne convergence durchlaufen. Wahrscheinlich ist der Plan falsch oder unvollständig. Was tun?",
                         "options": [
                           {"label": "Weitermachen (+5 Runden)",       "description": "Loop-Cap wird um 5 erhöht, Critic bekommt nochmal 5 Chancen. Sinnvoll wenn der Critic sichtbaren Progress macht."},
                           {"label": "Task neu planen (plan-checker)", "description": "Task wird als plan-bug markiert, plan-checker wird aufgerufen, PLAN.md wird korrigiert, Task neu gestartet."},
                           {"label": "Task als stuck markieren",        "description": "Task wird als stuck in STATE.md persistiert, Wave wird abgebrochen. /np:resume-work nach manueller Klärung."},
                           {"label": "Manuell fixen, dann resumen",    "description": "Workflow pausiert hier. Du editierst Code/Plan und rufst /np:execute-phase '"$PHASE"' nochmal auf."}
                         ]
                       }')
                       case "$STUCK_ASK" in
                         "Weitermachen"*)
                           LOOP_MAX_ROUNDS=$((LOOP_MAX_ROUNDS + 5))
                           # T3: persist override on the checkpoint so post-critics
                           # honors it AND /np:resume-work survives a crash with the
                           # extended cap. Bash-only mutation is lost on resume.
                           node .nubos-pilot/bin/np-tools.cjs loop-state-record "$TASK_ID" \
                             --json "{\"max_rounds_override\":$LOOP_MAX_ROUNDS}"
                           echo "[np:execute-phase] $TASK_ID Loop-Cap auf $LOOP_MAX_ROUNDS erweitert per askuser (persistiert)." >&2
                           continue ;;
                         "Task neu planen"*)
                           node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
                             --phase stuck --reason "user-requested-replan" --findings-path "$CRITIC_REPORT_PATH"
                           echo "[np:execute-phase] $TASK_ID flagged for plan-checker. Run /np:plan-phase $PHASE --repromote, then re-run /np:execute-phase $PHASE." >&2
                           exit 4 ;;
                         "Task als stuck"*)
                           node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
                             --phase stuck --reason "max-rounds-user-stuck" --findings-path "$CRITIC_REPORT_PATH"
                           echo "[np:execute-phase] $TASK_ID marked stuck after $LOOP_MAX_ROUNDS rounds (user choice)." >&2
                           exit 3 ;;
                         "Manuell fixen"*)
                           node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
                             --phase stuck --reason "manual-fix-pending" --findings-path "$CRITIC_REPORT_PATH"
                           echo "[np:execute-phase] $TASK_ID paused for manual fix. Resume via /np:execute-phase $PHASE when ready." >&2
                           exit 0 ;;
                       esac ;;
      esac
    done

    # Defensive: if the while loop exited without NEXT_ACTION=commit (shouldn't
    # happen — loop-evaluate emits stuck at maxRounds), stamp stuck and bail.
    if [ "$NEXT_ACTION" != "commit" ]; then
      node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" \
        --phase stuck --reason "loop-exited-without-commit"
      exit 3
    fi

    # === Step 7: atomic commit ===
    node .nubos-pilot/bin/np-tools.cjs loop-run-round "$TASK_ID" --phase commit \
      --learning-pattern "$CONSENSUS_PATTERN" --learning-outcome verified
    node .nubos-pilot/bin/np-tools.cjs commit-task "$TASK_ID"
    COMMIT_STATUS=$?

    EXECUTOR_END=$(node .nubos-pilot/bin/np-tools.cjs metrics end-timestamp)
    EXECUTOR_STATUS=ok
    [ "$COMMIT_STATUS" -ne 0 ] && EXECUTOR_STATUS=error
    node .nubos-pilot/bin/np-tools.cjs metrics record \
      --agent "$EXECUTOR_AGENT" --tier sonnet --resolved-model "$EXECUTOR_MODEL" \
      --phase "$PHASE" --plan "$SLICE_FULL_ID" --task "$TASK_ID" \
      --started "$EXECUTOR_START" --ended "$EXECUTOR_END" \
      --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
      --retry-count "$((ROUND-1))" --status "$EXECUTOR_STATUS" --runtime "$RUNTIME"

    if [ "$COMMIT_STATUS" -ne 0 ]; then
      echo "[np:execute-phase] commit-task failed for $TASK_ID — aborting wave $SLICE_FULL_ID." >&2
      if [ "$WORKTREE_ISOLATION" = "true" ]; then
        echo "  Worktree $SLICE_CWD left in place for inspection. Clean up with: /np:reset-slice $TASK_ID" >&2
      fi
      exit "$COMMIT_STATUS"
    fi
  done
  # Wait for all parallel Nubosloop instances in this wave to finish before next wave.

  # After every task in the slice committed: aggregate per-task summaries into
  # the slice-level S<NNN>-SUMMARY.md so /np:validate-phase can audit it.
  SLICE_NUM=$(echo "$WAVE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).wave))")
  node .nubos-pilot/bin/np-tools.cjs init execute-milestone finalize-slice "$PHASE" "$SLICE_NUM" >/dev/null

  # Worktree merge-back (ADR-0008 D-8.7): fast-forward-only merge the slice
  # branch back onto the invoking workspace's current branch. Non-FF (e.g.
  # because the base branch advanced during execution) fails hard — that
  # surfaces the drift to the user rather than silently rewriting task SHAs.
  if [ "$WORKTREE_ISOLATION" = "true" ]; then
    FF_RESULT=$(node .nubos-pilot/bin/np-tools.cjs worktree-ff-merge "$SLICE_FULL_ID" 2>&1)
    FF_STATUS=$?
    if [ "$FF_STATUS" -ne 0 ]; then
      echo "[np:execute-phase] ff-merge for $SLICE_FULL_ID failed — worktree left in place for inspection:" >&2
      echo "  $FF_RESULT" >&2
      echo "  To resolve: cd into $SLICE_CWD, rebase onto current base, then re-run this workflow." >&2
      exit "$FF_STATUS"
    fi
    node .nubos-pilot/bin/np-tools.cjs worktree-remove "$SLICE_FULL_ID" >/dev/null
    echo "[np:execute-phase] worktree $SLICE_FULL_ID merged + removed." >&2
  fi
done

# Milestone done — regenerate every slice summary so retroactive / resumed
# runs also end with a complete audit surface.
node .nubos-pilot/bin/np-tools.cjs init execute-milestone finalize-milestone "$PHASE" >/dev/null
```

## Auto-Chain — verify-work (opt-in via `--verify-work`)

When `auto_verify == true` (set by `--verify-work` at invocation), this workflow chains into `/np:verify-work $PHASE` as soon as `finalize-milestone` returns. The chain is unconditional on success — same hard-fail contract as a manual `/np:verify-work` call (exit 1 on any `Fail` SC). Without the flag the workflow stops here and the operator runs verify-work manually.

```bash
if [[ "$AUTO_VERIFY" == "true" ]]; then
  echo "[np:execute-phase] --verify-work set — chaining into /np:verify-work $PHASE." >&2
  /np:verify-work "$PHASE"
else
  echo "[np:execute-phase] done. Next: /np:verify-work $PHASE (or pass --verify-work next time to auto-chain)." >&2
fi
```

The chain runs AFTER `finalize-milestone` — verify-work needs every slice's `S<NNN>-SUMMARY.md` aggregated, plus every task commit landed. Running verify earlier would race the audit surface.

After verify-work returns, point the operator at `/np:validate-phase $PHASE` to run the UAT per slice (validate is intentionally NOT auto-chained — it has its own runtime cost and asks for a separate decision point).

## Scope Guardrail

<!-- scope_guardrail -->
**Do:**
- Dispatch all tasks in a slice **in parallel** — one Nubosloop instance per task.
- Move to next slice **only after** every task in the current slice committed (or `stuck`/`plan-checker` aborted the wave).
- Start one checkpoint per task before kicking off the loop.
- Run `loop-run-round --phase preflight` BEFORE every Round-1 executor spawn — never skip the cache lookup.
- Spawn `agents/np-executor.md` on Round 1, `agents/np-build-fixer.md` on Round ≥ 2 — once per round, with only that task's `files_modified` in scope (D-04, no scope expansion).
- Spawn the single Critic agent (`np-critic`) once per round, after a verify-green post-executor. It writes the full findings JSON to `$CRITIC_REPORT_PATH` and emits a small verdict envelope as its final message (ADR-0010 §L5 Verdict-Only Contract).
- Pre-create `${TMPDIR:-/tmp}/nubos-pilot/critic-reports/` before the critic spawn so the agent's `Write` cannot fail on a missing parent directory.
- Pass `--critic-outputs-path "$CRITIC_REPORT_PATH"` to `loop-run-round --phase post-critics` so the full findings JSON is read from disk rather than replayed through the spawn's final message.
- Run `loop-run-round --phase post-executor` AFTER mechanical checks; honor `next_action: spawn-build-fixer` (verify-red short-circuit, skip critics this round).
- Run `loop-run-round --phase post-critics` AFTER critics return, to obtain the routing `next_action`.
- Run `loop-audit-tool-use` per round per spawn — for executor/build-fixer this drives Rule 9 enforcement, AND for `np-critic` this is the spawn-evidence required by the Layer-C audit-trail gate (`loop-post-executor-missing-spawn-audit` / `loop-post-critics-missing-critic-audit`). After the Single-Critic Revision (ADR-0010, 2026-05-05) the per-round audit count is **two** in rounds ≥ 2 (`np-build-fixer` + `np-critic`) and **`swarm.research.k` + 2** in round 1 (k × `np-researcher` + `np-executor` + `np-critic`). All audits in the active round are mandatory before the corresponding `loop-run-round --phase post-{researcher|executor|critics}` invocation.
- Route every commit through `node .nubos-pilot/bin/np-tools.cjs commit-task` so `classifyCommittablePaths` runs (gitignored entries are split into a `files_ignored` audit list; mixed paths commit only the tracked subset; all-ignored soft-skips with `skip_reason: artifacts-gitignored` and exit 0).
- Hard-stop the wave when `commit-task` returns non-zero, OR a task hits `stuck`/`plan-checker`. **Soft-skip is exit 0 — wave continues.**

**Don't:**
- Run tasks across slices in parallel — slices are serial.
- Run intra-slice tasks serially — they're parallel by planner contract.
- Skip the Nubosloop and call `commit-task` directly after the executor (single-pass executor → commit is forbidden — ADR-0010).
- Spawn the Critic agent BEFORE the post-executor verify-green check — verify must pass first; the critic only runs on verify-green.
- Use `np-executor` on Round ≥ 2 — use `np-build-fixer` (it gets prior critic findings + verify output excerpt).
- Skip `loop-audit-tool-use` for ANY spawn (researcher / executor / build-fixer / `np-critic`). Skipping the executor audit silences Rule 9; skipping the critic audit means the orchestrator cannot prove the critic actually ran, and the post-critics gate refuses. Synthesizing `--critic-outputs` JSON without spawning the real `np-critic` agent is the canonical bypass — Layer C blocks it mechanically.
- Bypass the Verdict-Only Contract by inlining the full findings JSON in the spawn's final message or by reconstructing `$CRITIC_REPORT_PATH` content from the envelope. Both defeat the cost-control purpose of ADR-0010 §L5; the critic is required to `Write` the findings file itself, and the orchestrator is required to read that file via `--critic-outputs-path` rather than the envelope.
- Extend a task's scope beyond `files_modified` — D-04 violations route to `plan-checker`, not post-hoc PLAN.md mutations.
- Invoke `git commit`, `git add`, or any bare git command from this workflow or the spawned agent (CLAUDE.md §Git operations).
- Bundle two tasks into one commit (ADR-0004 atomicity).
- Skip the checkpoint start step — it's the crash-safety primitive `resume-work` depends on.
- Pass `--no-verify` or `--force` anywhere in the pipeline.
- **Introduce ad-hoc pre-flight checks beyond the two sanctioned guards** (orphan-checkpoint, empty-milestone). Container-status (`docker ps`), runtime-version probes (`php -v`, `node -v`), DB-connectivity, port-binding — none of these belong in the orchestrator's pre-flight. Tasks edit code; environment failures surface inside the Nubosloop as `verify-red` (→ `spawn-build-fixer`) or as `np-critic-acceptance` `information-missing` findings (→ researcher / plan-checker). They are **never** workflow-level halts.
- **Declare a "hard blocker" because of infrastructure state.** Container down, PHP version skew, missing image, exited service — all of these are routing signals inside the loop, not reasons to abort the wave. The wave only halts on `commit-task` non-zero, `stuck` after `loop.maxRounds`, or `plan-checker` (locked-decision-violation). Infrastructure mismatch routes via critic findings to researcher/plan-checker; if it's truly out-of-scope for any task in the milestone, the operator handles it separately and re-runs the workflow.
<!-- /scope_guardrail -->

## Output

- One git commit per completed task (`task(<milestone-id>-<slice-id>-T<NNNN>): <name>`).
- Per-task checkpoint lifetime: `start` → (`transition verifying`)+ → `pre-commit` (set by `loop-run-round --phase commit`) → `deleteCheckpoint` (inside commit-task on success).
- Per-task `nubosloop` state block on the checkpoint envelope: `last_phase`, `last_action`, `round`, `findings`, `committed_at` / `stuck_at` — surfaced on `np:dashboard`.
- Auto-`learning-log` entry per committed task (when `auto_log_learning=true`, default) — feeds future Round-1 cache hits.
- STATE.md updated via `startTask`'s coordinated lock-cycle (D-08).
- Per slice: updated `S<NNN>-SUMMARY.md` aggregated from task summaries (triggered after the last task in the wave).
- Verified work surface for `/np:validate-phase $PHASE`.

## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — every task in every slice ran its Nubosloop to `next_action=commit` and committed; no partial slices, no `stuck` left silent.
- Rule 3 (Do it with tests) — every commit ships verify-green; mechanical checks per round are a hard gate; `commit-task` refuses commits without a `verifying` → `pre-commit` transition.
- Rule 4 (Do it with documentation) — `update-docs` ran for every committed task; stale module docs surface as a `np-critic-acceptance` finding and route the loop back, not forward.
- Rule 9 (Tool-use audit) — `loop-audit-tool-use` confirms every audited spawn invoked a knowledge-search tool ≥ 1× — canonically the `knowledge-search` CLI (`node np-tools.cjs knowledge-search "<q>" --task <id>`, run via Bash); the accepted set is the `SEARCH_TOOLS` constant in `lib/nubosloop.cjs`. Violations — including a `knowledge-search` claim with no matching evidence ledger — route as `rule-9-violation` findings into `loop-evaluate`.
- Rule 10 (Test before shipping) — verify-green is a hard gate per round, not advice.
- Rule 12 (Boil the ocean) — no task left in `stuck` state; the orchestrator escalates via askuser rather than silently downgrading or retrying past `loop.maxRounds`.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
