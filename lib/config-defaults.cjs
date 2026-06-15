'use strict';

const DEFAULT_RESEARCH_TOOLS = Object.freeze({
  WebFetch: true,
  Context7: true,
});

const DEFAULT_WORKFLOW = Object.freeze({
  commit_docs: true,
  commit_artifacts: true,
  worktree_isolation: false,
  tier_routing: false,
  research_tools: DEFAULT_RESEARCH_TOOLS,
});

const DEFAULT_AGENTS = Object.freeze({
  parallelization: true,
  research: true,
  plan_checker: true,
  verifier: true,
});

const DEFAULT_LOOP = Object.freeze({
  maxRounds: 3,
  verify_runs: 1,
});

const DEFAULT_SWARM_RESEARCH = Object.freeze({
  k: 3,
  threshold: 0.9,
  minOccurrence: 3,
});

const DEFAULT_SWARM_CRITIC = Object.freeze({
  style_tier: 'haiku',
  tests_tier: 'sonnet',
  acceptance_tier: 'sonnet',
});

const DEFAULT_SWARM = Object.freeze({
  research: DEFAULT_SWARM_RESEARCH,
  critic: DEFAULT_SWARM_CRITIC,
  knowledge_adapter: 'local',
});

const DEFAULT_SECURITY = Object.freeze({
  enabled: true,
  scan_on_write: true,
  review_on_stop: true,
  review_on_commit: true,
  custom_rules_path: null,
  guidance_path: null,
  review_timeout_ms: 180000,
  max_stop_reviews_in_a_row: 3,
  max_commit_reviews_per_hour: 20,
  max_files_per_review: 30,
});

const DEFAULT_CONFORMANCE = Object.freeze({
  inject_criteria: true,
});

const DEFAULT_LEARNINGS = Object.freeze({
  auto_capture: true,
  max_captures_per_hour: 10,
  max_in_a_row: 3,
  timeout_ms: 120000,
  max_files: 30,
});

const DEFAULT_AUTO_LOG_LEARNING = true;

const DEFAULT_SPAWN_HEADLESS = Object.freeze({
  enabled: false,
  agents: Object.freeze(['np-critic', 'np-researcher']),
  timeout_ms: 10 * 60 * 1000,
  fallback_on_error: true,
});

const DEFAULT_SPAWN = Object.freeze({
  headless: DEFAULT_SPAWN_HEADLESS,
});

const DEFAULT_MODEL_PROFILE = 'frontier';
const DEFAULT_SCOPE = 'local';
const DEFAULT_RESPONSE_LANGUAGE = 'en';

const DEFAULT_CONFIG_TREE = Object.freeze({
  scope: DEFAULT_SCOPE,
  model_profile: DEFAULT_MODEL_PROFILE,
  response_language: DEFAULT_RESPONSE_LANGUAGE,
  workflow: DEFAULT_WORKFLOW,
  agents: DEFAULT_AGENTS,
  loop: DEFAULT_LOOP,
  swarm: DEFAULT_SWARM,
  spawn: DEFAULT_SPAWN,
  security: DEFAULT_SECURITY,
  conformance: DEFAULT_CONFORMANCE,
  learnings: DEFAULT_LEARNINGS,
  auto_log_learning: DEFAULT_AUTO_LOG_LEARNING,
});

function buildInstallConfig(answers) {
  const a = answers || {};
  const workflowOverride = { ...DEFAULT_WORKFLOW, research_tools: { ...DEFAULT_RESEARCH_TOOLS } };
  if (typeof a.commit_artifacts === 'boolean') {
    workflowOverride.commit_artifacts = a.commit_artifacts;
  }
  return {
    runtime: a.runtime || null,
    runtimes: Array.isArray(a.runtimes) ? a.runtimes.slice() : (a.runtime ? [a.runtime] : []),
    scope: a.scope || DEFAULT_SCOPE,
    model_profile: a.model_profile || DEFAULT_MODEL_PROFILE,
    response_language: a.response_language || DEFAULT_RESPONSE_LANGUAGE,
    workflow: workflowOverride,
    agents: { ...DEFAULT_AGENTS },
    loop: { ...DEFAULT_LOOP },
    swarm: {
      research: { ...DEFAULT_SWARM_RESEARCH },
      critic: { ...DEFAULT_SWARM_CRITIC },
      knowledge_adapter: DEFAULT_SWARM.knowledge_adapter,
    },
    spawn: {
      headless: {
        enabled: DEFAULT_SPAWN_HEADLESS.enabled,
        agents: [...DEFAULT_SPAWN_HEADLESS.agents],
        timeout_ms: DEFAULT_SPAWN_HEADLESS.timeout_ms,
        fallback_on_error: DEFAULT_SPAWN_HEADLESS.fallback_on_error,
      },
    },
    security: { ...DEFAULT_SECURITY },
    conformance: { ...DEFAULT_CONFORMANCE },
    learnings: { ...DEFAULT_LEARNINGS },
    auto_log_learning: DEFAULT_AUTO_LOG_LEARNING,
  };
}

module.exports = {
  DEFAULT_WORKFLOW,
  DEFAULT_RESEARCH_TOOLS,
  DEFAULT_AGENTS,
  DEFAULT_LOOP,
  DEFAULT_SWARM,
  DEFAULT_SWARM_RESEARCH,
  DEFAULT_SWARM_CRITIC,
  DEFAULT_SPAWN,
  DEFAULT_SPAWN_HEADLESS,
  DEFAULT_SECURITY,
  DEFAULT_CONFORMANCE,
  DEFAULT_LEARNINGS,
  DEFAULT_AUTO_LOG_LEARNING,
  DEFAULT_MODEL_PROFILE,
  DEFAULT_SCOPE,
  DEFAULT_RESPONSE_LANGUAGE,
  DEFAULT_CONFIG_TREE,
  buildInstallConfig,
};
