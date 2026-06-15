'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const schema = require('./config-schema.cjs');
const { validateConfig, mergeNewDefaults, VALID_MODEL_PROFILES } = schema;

test('CS-1 known top-level keys produce zero warnings', () => {
  const w = validateConfig({
    scope: 'local',
    model_profile: 'balanced',
    response_language: 'de',
    auto_log_learning: true,
    workflow: { commit_docs: true, commit_artifacts: false },
    agents: { parallelization: true },
    loop: { maxRounds: 5 },
  });
  assert.deepEqual(w, []);
});

test('CS-2 unknown top-level key flagged', () => {
  const w = validateConfig({ commit_artifacttt: true });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'unknown-key');
  assert.equal(w[0].path, 'commit_artifacttt');
});

test('CS-3 unknown nested key flagged with dotted path', () => {
  const w = validateConfig({ workflow: { commit_artifact: true } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'unknown-key');
  assert.equal(w[0].path, 'workflow.commit_artifact');
});

test('CS-4 invalid enum value (model_profile) flagged', () => {
  const w = validateConfig({ model_profile: 'premium' });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'invalid-enum');
  assert.equal(w[0].path, 'model_profile');
  assert.deepEqual(w[0].allowed, VALID_MODEL_PROFILES);
});

test('CS-5 unsupported knowledge_adapter (pinecone) flagged as invalid-enum', () => {
  const w = validateConfig({ swarm: { knowledge_adapter: 'pinecone' } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'invalid-enum');
  assert.equal(w[0].path, 'swarm.knowledge_adapter');
});

test('CS-6 invalid tier for critic flagged', () => {
  const w = validateConfig({ swarm: { critic: { style_tier: 'gold' } } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'invalid-enum');
  assert.equal(w[0].path, 'swarm.critic.style_tier');
});

test('CS-7 invalid type for boolean field flagged', () => {
  const w = validateConfig({ agents: { parallelization: 'yes' } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'invalid-type');
  assert.equal(w[0].path, 'agents.parallelization');
  assert.equal(w[0].expected, 'boolean');
  assert.equal(w[0].actual, 'string');
});

test('CS-8 typo in swarm.* flagged at correct depth', () => {
  const w = validateConfig({ swarm: { research: { kk: 5 } } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'unknown-key');
  assert.equal(w[0].path, 'swarm.research.kk');
});

test('CS-9 multiple warnings collected, not short-circuited', () => {
  const w = validateConfig({
    model_profile: 'premium',
    workflow: { commit_artifact: true },
    swarm: { knowledge_adapter: 'pinecone' },
  });
  assert.equal(w.length, 3);
  const kinds = w.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['invalid-enum', 'invalid-enum', 'unknown-key']);
});

test('CS-10 null/empty config returns no warnings (graceful)', () => {
  assert.deepEqual(validateConfig(null), []);
  assert.deepEqual(validateConfig(undefined), []);
  assert.deepEqual(validateConfig({}), []);
});

test('MERGE-1 mergeNewDefaults adds missing keys without overwriting user values', () => {
  const existing = { workflow: { commit_artifacts: false } };
  const defaults = {
    scope: 'local',
    workflow: { commit_docs: true, commit_artifacts: true },
    loop: { maxRounds: 3 },
  };
  const merged = mergeNewDefaults(existing, defaults);
  assert.equal(merged.workflow.commit_artifacts, false, 'user value preserved');
  assert.equal(merged.workflow.commit_docs, true, 'new key filled from default');
  assert.equal(merged.scope, 'local', 'top-level new key filled');
  assert.equal(merged.loop.maxRounds, 3, 'nested new tree filled');
});

test('MERGE-2 mergeNewDefaults strips prototype-pollution keys', () => {
  const poisoned = JSON.parse('{"__proto__":{"polluted":true},"foo":1}');
  const merged = mergeNewDefaults({}, poisoned);
  assert.equal(merged.foo, 1);
  assert.equal(({}).polluted, undefined);
});

test('MERGE-3 mergeNewDefaults handles null/undefined existing', () => {
  const defaults = { a: 1, b: { c: 2 } };
  assert.deepEqual(mergeNewDefaults(null, defaults), { a: 1, b: { c: 2 } });
  assert.deepEqual(mergeNewDefaults(undefined, defaults), { a: 1, b: { c: 2 } });
});

test('MERGE-4 mergeNewDefaults replaces a null user value with the default tree', () => {
  // user wrote `workflow: null` (typo, copy/paste, partial migration) — the
  // re-install merge must heal that, not preserve null, otherwise readConfig
  // hits invalid-type warnings on every call and downstream readConfigPath
  // falls back silently. Memory `feedback_nubos_pilot_fix_doctrines.md`
  // — "Config-Reader sind LOUD" — bedeutet auch silent-null muss aufgelöst werden.
  const merged = mergeNewDefaults(
    { workflow: null, scope: 'local' },
    { workflow: { commit_docs: true, commit_artifacts: true }, scope: 'local' },
  );
  assert.deepEqual(merged.workflow, { commit_docs: true, commit_artifacts: true });
  assert.equal(merged.scope, 'local');
});

test('SCHEMA-SYNC-1 every top-level key in DEFAULT_CONFIG_TREE has a SCHEMA entry', () => {
  // Drift-Sperre (CW1-2): wer einen Default zufügt MUSS auch SCHEMA pflegen.
  const defaults = require('./config-defaults.cjs');
  const { SCHEMA: liveSchema, SCHEMA_ONLY_KEYS } = require('./config-schema.cjs');
  for (const key of Object.keys(defaults.DEFAULT_CONFIG_TREE)) {
    assert.ok(liveSchema[key], 'DEFAULT_CONFIG_TREE.' + key + ' has no SCHEMA entry');
  }
  // Reverse: every SCHEMA top-level key is either in DEFAULT_CONFIG_TREE or
  // in the schema-only allowlist (vars like runtime/runtimes/agent_skills
  // that exist only on disk, not as a default).
  for (const key of Object.keys(liveSchema)) {
    const inDefaults = Object.prototype.hasOwnProperty.call(defaults.DEFAULT_CONFIG_TREE, key);
    const inAllowlist = SCHEMA_ONLY_KEYS.includes(key);
    assert.ok(inDefaults || inAllowlist,
      'SCHEMA.' + key + ' is neither in DEFAULT_CONFIG_TREE nor SCHEMA_ONLY_KEYS — drift');
  }
});

test('SEC-CFG-1 valid security block produces zero warnings', () => {
  const w = validateConfig({
    security: {
      enabled: true,
      scan_on_write: true,
      review_on_stop: false,
      review_on_commit: true,
      custom_rules_path: '.nubos-pilot/security-rules.json',
      guidance_path: null,
      review_timeout_ms: 120000,
      max_stop_reviews_in_a_row: 3,
      max_commit_reviews_per_hour: 20,
      max_files_per_review: 30,
    },
  });
  assert.deepEqual(w, []);
});

test('SEC-CFG-2 wrong type in security flags is flagged', () => {
  const w = validateConfig({ security: { enabled: 'yes', max_files_per_review: 'lots' } });
  assert.equal(w.length, 2);
  assert.ok(w.every((x) => x.kind === 'invalid-type'));
});

test('SEC-CFG-3 unknown security sub-key is flagged', () => {
  const w = validateConfig({ security: { scan_everywhere: true } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'unknown-key');
  assert.equal(w[0].path, 'security.scan_everywhere');
});

test('SEC-CFG-4 default security tree validates clean', () => {
  const defaults = require('./config-defaults.cjs');
  assert.deepEqual(validateConfig({ security: defaults.DEFAULT_SECURITY }), []);
});

test('CONF-CFG-1 valid conformance block produces zero warnings', () => {
  assert.deepEqual(validateConfig({ conformance: { inject_criteria: true } }), []);
});

test('CONF-CFG-2 wrong type in conformance.inject_criteria is flagged', () => {
  const w = validateConfig({ conformance: { inject_criteria: 'yes' } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'invalid-type');
  assert.equal(w[0].path, 'conformance.inject_criteria');
});

test('CONF-CFG-3 unknown conformance sub-key is flagged', () => {
  const w = validateConfig({ conformance: { review_on_executor_stop: true } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'unknown-key');
});

test('CONF-CFG-4 default conformance tree validates clean', () => {
  const defaults = require('./config-defaults.cjs');
  assert.deepEqual(validateConfig({ conformance: defaults.DEFAULT_CONFORMANCE }), []);
});
