<!--
  Placeholders: slice_id, slice_full_id, slice_name, milestone_id, created_date, requirements_json, tasks_xml
  Every `TBD` below is a MUST-FILL slot before the slice can enter /np:execute-phase.
  np-planner fills these; np-plan-checker rejects any remaining `TBD` as `issues_found`.
-->
---
slice: "{{slice_full_id}}"
milestone: "{{milestone_id}}"
type: plan
status: pending
requirements: {{requirements_json}}
---

<objective>
<!-- MUST FILL — one sentence describing the outcome of this slice. -->
TBD — what does this slice deliver?

Purpose: TBD — why this slice exists in the milestone arc.
Output: TBD — list of artifacts (files, schemas, endpoints) the slice produces.
</objective>

<context>
<!-- MUST FILL — @-reference the docs the executor needs to internalize. -->
TBD — list CONTEXT, RESEARCH, prior SUMMARY files, and any code modules whose public surface this slice consumes.
</context>

<tasks>
{{tasks_xml}}
</tasks>

<verification>
<!-- MUST FILL — bullet list of automated checks that prove the slice is done.
     Each bullet maps to ≥1 task's <verify> block. Empty list = slice cannot pass /np:validate-phase. -->
- TBD
</verification>

<success_criteria>
<!-- MUST FILL — observable acceptance criteria. Maps to milestone-level SC-N entries.
     Empty list = no acceptance gate = critic-acceptance routes everything to issues_found. -->
- TBD
</success_criteria>

<output>
<!-- INFORMATIONAL (no fill needed) — describes what happens at slice close. -->
After completion, fill `{{slice_full_id}}-SUMMARY.md` with:
- What changed (summary across tasks)
- Tests run + results
- Follow-ups or deviations
Then run `/np:validate-phase {{milestone_id}}` to run UAT against `{{slice_full_id}}-UAT.md`.
</output>

---
*Slice plan drafted: {{created_date}}*
