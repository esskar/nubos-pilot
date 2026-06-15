'use strict';


const VALID_SCOPES = Object.freeze(['local', 'global']);
const VALID_MODEL_PROFILES = Object.freeze(['frontier', 'quality', 'balanced', 'budget', 'inherit']);
const VALID_KNOWLEDGE_ADAPTERS = Object.freeze(['local']);
const VALID_TIERS = Object.freeze(['haiku', 'sonnet', 'opus']);

const SCHEMA = Object.freeze({
  scope:            { type: 'enum', values: VALID_SCOPES, optional: true },
  model_profile:    { type: 'enum', values: VALID_MODEL_PROFILES, optional: true },
  response_language:{ type: 'string', optional: true },
  runtime:          { type: 'string', optional: true },
  runtimes:         { type: 'array', element: 'string', optional: true },
  auto_log_learning:{ type: 'boolean', optional: true },
  agent_skills:     { type: 'object', shape: 'any', optional: true },
  workflow: {
    type: 'object', optional: true, shape: {
      commit_docs:        { type: 'boolean', optional: true },
      commit_artifacts:   { type: 'any', optional: true },  // coerceBool handles string/bool
      worktree_isolation: { type: 'boolean', optional: true },
      research_tools:     { type: 'object', shape: 'any', optional: true },
      text_mode:          { type: 'boolean', optional: true },
      tier_routing:       { type: 'boolean', optional: true },
    },
  },
  agents: {
    type: 'object', optional: true, shape: {
      parallelization: { type: 'boolean', optional: true },
      research:        { type: 'boolean', optional: true },
      plan_checker:    { type: 'boolean', optional: true },
      verifier:        { type: 'boolean', optional: true },
    },
  },
  loop: {
    type: 'object', optional: true, shape: {
      maxRounds: { type: 'number', optional: true },
      verify_runs: { type: 'number', optional: true },
    },
  },
  swarm: {
    type: 'object', optional: true, shape: {
      research: {
        type: 'object', optional: true, shape: {
          k:             { type: 'number', optional: true },
          threshold:     { type: 'number', optional: true },
          minOccurrence: { type: 'number', optional: true },
        },
      },
      critic: {
        type: 'object', optional: true, shape: {
          style_tier:      { type: 'enum', values: VALID_TIERS, optional: true },
          tests_tier:      { type: 'enum', values: VALID_TIERS, optional: true },
          acceptance_tier: { type: 'enum', values: VALID_TIERS, optional: true },
        },
      },
      knowledge_adapter: { type: 'enum', values: VALID_KNOWLEDGE_ADAPTERS, optional: true },
    },
  },
  spawn: {
    type: 'object', optional: true, shape: {
      headless: {
        type: 'object', optional: true, shape: {
          enabled:           { type: 'boolean', optional: true },
          agents:            { type: 'array', element: 'string', optional: true },
          timeout_ms:        { type: 'number', optional: true },
          fallback_on_error: { type: 'boolean', optional: true },
        },
      },
    },
  },
  security: {
    type: 'object', optional: true, shape: {
      enabled:                    { type: 'boolean', optional: true },
      scan_on_write:              { type: 'boolean', optional: true },
      review_on_stop:             { type: 'boolean', optional: true },
      review_on_commit:           { type: 'boolean', optional: true },
      custom_rules_path:          { type: 'any', optional: true },  // string | null
      guidance_path:              { type: 'any', optional: true },  // string | null
      review_timeout_ms:          { type: 'number', optional: true },
      max_stop_reviews_in_a_row:  { type: 'number', optional: true },
      max_commit_reviews_per_hour:{ type: 'number', optional: true },
      max_files_per_review:       { type: 'number', optional: true },
    },
  },
  conformance: {
    type: 'object', optional: true, shape: {
      inject_criteria: { type: 'boolean', optional: true },
    },
  },
  learnings: {
    type: 'object', optional: true, shape: {
      auto_capture:          { type: 'boolean', optional: true },
      max_captures_per_hour: { type: 'number', optional: true },
      max_in_a_row:          { type: 'number', optional: true },
      timeout_ms:            { type: 'number', optional: true },
      max_files:             { type: 'number', optional: true },
    },
  },
});

function _typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function _validateNode(value, schema, pathSoFar, warnings) {
  if (value === undefined) {
    if (!schema.optional) {
      warnings.push({ kind: 'missing-required', path: pathSoFar });
    }
    return;
  }
  if (schema.type === 'any') return;
  if (schema.type === 'string' || schema.type === 'boolean' || schema.type === 'number') {
    if (_typeOf(value) !== schema.type) {
      warnings.push({
        kind: 'invalid-type', path: pathSoFar,
        expected: schema.type, actual: _typeOf(value),
      });
    }
    return;
  }
  if (schema.type === 'enum') {
    if (typeof value !== 'string' || !schema.values.includes(value)) {
      warnings.push({
        kind: 'invalid-enum', path: pathSoFar,
        allowed: schema.values, actual: value,
      });
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      warnings.push({ kind: 'invalid-type', path: pathSoFar, expected: 'array', actual: _typeOf(value) });
      return;
    }
    if (schema.element) {
      value.forEach((el, i) => {
        if (_typeOf(el) !== schema.element) {
          warnings.push({
            kind: 'invalid-array-element', path: pathSoFar + '[' + i + ']',
            expected: schema.element, actual: _typeOf(el),
          });
        }
      });
    }
    return;
  }
  if (schema.type === 'object') {
    if (_typeOf(value) !== 'object') {
      warnings.push({ kind: 'invalid-type', path: pathSoFar, expected: 'object', actual: _typeOf(value) });
      return;
    }
    const childShape = schema.shape;
    if (childShape === 'any') return;
    for (const key of Object.keys(value)) {
      const childSchema = childShape[key];
      if (!childSchema) {
        warnings.push({ kind: 'unknown-key', path: pathSoFar ? pathSoFar + '.' + key : key });
        continue;
      }
      _validateNode(value[key], childSchema, pathSoFar ? pathSoFar + '.' + key : key, warnings);
    }
  }
}

function validateConfig(parsed) {
  if (parsed === null || parsed === undefined) return [];
  const warnings = [];
  if (_typeOf(parsed) !== 'object') {
    warnings.push({ kind: 'invalid-type', path: '<root>', expected: 'object', actual: _typeOf(parsed) });
    return warnings;
  }
  for (const key of Object.keys(parsed)) {
    const childSchema = SCHEMA[key];
    if (!childSchema) {
      warnings.push({ kind: 'unknown-key', path: key });
      continue;
    }
    _validateNode(parsed[key], childSchema, key, warnings);
  }
  return warnings;
}

function mergeNewDefaults(existing, defaults) {
  if (existing === null || existing === undefined) {
    return _clone(defaults);
  }
  if (_typeOf(existing) !== 'object' || _typeOf(defaults) !== 'object') {
    return existing;  // user wins on type mismatch
  }
  const out = _clone(existing);
  for (const key of Object.keys(defaults)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = _clone(defaults[key]);
      continue;
    }
    if (out[key] === null && defaults[key] != null) {
      out[key] = _clone(defaults[key]);
      continue;
    }
    if (_typeOf(out[key]) === 'object' && _typeOf(defaults[key]) === 'object') {
      out[key] = mergeNewDefaults(out[key], defaults[key]);
    }
  }
  return out;
}

function _clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(_clone);
  const out = {};
  for (const k of Object.keys(v)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = _clone(v[k]);
  }
  return out;
}

const SCHEMA_ONLY_KEYS = Object.freeze(['runtime', 'runtimes', 'agent_skills']);

module.exports = {
  SCHEMA,
  SCHEMA_ONLY_KEYS,
  VALID_SCOPES,
  VALID_MODEL_PROFILES,
  VALID_KNOWLEDGE_ADAPTERS,
  VALID_TIERS,
  validateConfig,
  mergeNewDefaults,
};
