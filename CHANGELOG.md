# Changelog

All notable changes to nubos-pilot are documented in this file. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [1.2.4] - 2026-06-15

Fixed a recursion fault in the in-session hooks that could spawn an unbounded cascade of headless `claude -p` processes.

- The Stop-hook security review and continuous-learning capture each spawn a headless `claude -p` to do their work. That headless run re-fires the same SessionStart/Stop hooks, which spawned another headless run, and so on — a fork bomb of `claude`, `np-tools` and duplicated MCP servers that survived closing the terminal. nubos-pilot now marks every headless spawn with `NUBOS_PILOT_HEADLESS=1` and a `NUBOS_PILOT_HOOK_DEPTH` counter; the hooks no-op immediately inside a headless run, so the chain stops at exactly one level.
- Three independent guards back this up: the hook scripts and the `security`/`learnings` backends exit early when `NUBOS_PILOT_HEADLESS` is set; `spawn-headless` refuses to start a nested headless run (reentrancy + depth cap, default one level); and a per-agent lockfile under `.nubos-pilot/run/` bounds concurrent headless runs to one per agent even if the environment is not inherited. Headless runs already carry a hard timeout with SIGKILL, so a hung review cannot linger.
- Escape hatch: the guard keys off `NUBOS_PILOT_HEADLESS`, set automatically on the spawned `claude` — do not set it in your own shell or the in-session hooks will silently no-op. Raise the depth cap with `NUBOS_PILOT_MAX_HOOK_DEPTH` only if you understand the recursion risk.

## [1.2.3] — 2026-06-14

Three opt-in layers that make execution cheaper, more reliable, and self-improving.

- Cost-aware model routing: with `workflow.tier_routing` enabled, each task's executor runs at the model tier the plan assigned it — trivial work on a smaller model, structural or security-sensitive work on the strongest — instead of every task running at the top tier. The new `np:derive-tier` command suggests a tier from a task's observable signals (files touched, security/data sensitivity), so the choice is evidence-based. Off by default; behaviour is unchanged until you turn it on.
- Reliability checks (pass@k): set `loop.verify_runs` above 1 and nubos-pilot runs a task's verify command several times per round. A task goes green only when every run passes; a flaky task (passes sometimes, fails sometimes) is treated as red and handed to the build-fixer with a clear note, instead of slipping through on a lucky run. Defaults to a single run.
- Continuous learning: at the end of a session, a lightweight background reviewer reads what changed and distils reusable, durable lessons into the same learnings store the planner consults on the next similar task — so the system improves with use, not only inside the execution loop. On by default and rate-limited to bound cost; disable with `learnings.auto_capture`.

Full documentation at <https://pilot.nubos.cloud>.

## [1.2.2] — 2026-06-05

A dependency graph for the codebase you work in, plus stricter checks on nubos-pilot's own data.

- `np:scan-codebase` now builds a module dependency graph and writes it to `.nubos-pilot/codebase/.graph.json`. The new `np:graph-impact` command shows what a change touches before you make it. It reports which modules depend on a file, what that file depends on, and any dependency cycle it sits in. The graph reads relative imports only. It builds no AST and adds no dependencies.
- Persisted state files are now validated on read against versioned schemas. A corrupt single-document store fails with a clear error code. A bad line in an append-only log is skipped, not fatal.
- The reference docs now list every error code. That list is generated from source and checked on each build, so it cannot drift from the code.
- Internal logging goes through one structured logger. A test keeps `console.*` out of `lib/` and `bin/np-tools/`.
- Added `ATTRIBUTIONS.md`. It names the third-party packages nubos-pilot uses and their licenses.

Full documentation at <https://pilot.nubos.cloud>.

## [1.2.1] — 2026-06-02

Two always-on quality layers that act while the agent writes code.

- In-session security review: nubos-pilot reviews the code it writes for
  vulnerabilities while it works and fixes findings in the same session,
  before they reach a pull request. Three non-blocking depths — an instant
  per-edit pattern scan with no model call, a background semantic review of
  the turn's diff at end of turn, and a deeper review that reads surrounding
  code on each commit or push the agent makes.
- The security reviewer runs independently with a fresh context, reports each
  finding once, and never blocks a write or commit. Extend it with custom
  pattern rules and a review guidance file; built-in checks stay on.
- Requirements-aware executor: `/np:execute-phase` injects the milestone
  success criteria into the executor as its acceptance target, so it writes
  against the requirements from the first round, not just the verify command.
- New configuration blocks `security.*` and `conformance.*`.

Full documentation at <https://pilot.nubos.cloud>.

## [1.2.0] — 2026-05-25

Public release.

- Plan, execute, and verify code changes through a researcher + critic
  agent loop.
- Wave-based milestone execution; one atomic git commit per task.
- Multi-runtime install for 14 host CLIs (Claude Code, Codex, Gemini,
  OpenCode, Cursor, and more) via `npx nubos-pilot`.
- Local vector memory for cross-task learnings.
- Inter-agent messages, handoffs, and project archive with crash-safe
  resume.
- Hardened filesystem operations: symlink-rejecting locks, restricted
  permissions on audit logs, path containment for file-input flags,
  frontmatter sanitisation, and a memory-model allow-list.

Full documentation at <https://pilot.nubos.cloud>.
