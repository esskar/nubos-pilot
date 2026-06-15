'use strict';


const CRITIC_AGENTS = Object.freeze(['np-critic']);
const LEGACY_CRITIC_AXIS_AGENTS = Object.freeze([
  'np-critic-style',
  'np-critic-tests',
  'np-critic-acceptance',
]);
const SUPPORTED_CRITIC_AXES = Object.freeze(['critic', 'style', 'tests', 'acceptance']);

const EXECUTOR_AGENT = 'np-executor';
const BUILD_FIXER_AGENT = 'np-build-fixer';

const RESEARCHER_AGENT = 'np-researcher';

const AUDITED_AGENTS = Object.freeze([
  EXECUTOR_AGENT,
  BUILD_FIXER_AGENT,
  RESEARCHER_AGENT,
  ...CRITIC_AGENTS,
]);

module.exports = {
  CRITIC_AGENTS,
  LEGACY_CRITIC_AXIS_AGENTS,
  SUPPORTED_CRITIC_AXES,
  EXECUTOR_AGENT,
  BUILD_FIXER_AGENT,
  RESEARCHER_AGENT,
  AUDITED_AGENTS,
};
