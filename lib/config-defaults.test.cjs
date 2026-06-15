const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInstallConfig,
  DEFAULT_WORKFLOW,
  DEFAULT_MODEL_PROFILE,
  DEFAULT_SCOPE,
} = require('./config-defaults.cjs');

test('CFD-1: buildInstallConfig defaults preserve commit_artifacts:true (back-compat)', () => {
  const cfg = buildInstallConfig({ runtime: 'claude' });
  assert.equal(cfg.workflow.commit_artifacts, true);
});

test('CFD-2: buildInstallConfig honors explicit commit_artifacts:false from init interview', () => {
  const cfg = buildInstallConfig({ runtime: 'claude', commit_artifacts: false });
  assert.equal(cfg.workflow.commit_artifacts, false);
});

test('CFD-3: buildInstallConfig honors explicit commit_artifacts:true', () => {
  const cfg = buildInstallConfig({ runtime: 'claude', commit_artifacts: true });
  assert.equal(cfg.workflow.commit_artifacts, true);
});

test('CFD-4: non-boolean commit_artifacts is ignored (defends against bad input)', () => {
  const cfg = buildInstallConfig({ runtime: 'claude', commit_artifacts: 'no' });
  assert.equal(cfg.workflow.commit_artifacts, true);
});

test('CFD-5: defaults: scope=local, model_profile=frontier, response_language=en', () => {
  const cfg = buildInstallConfig({ runtime: 'claude' });
  assert.equal(cfg.scope, DEFAULT_SCOPE);
  assert.equal(cfg.model_profile, DEFAULT_MODEL_PROFILE);
  assert.equal(cfg.response_language, 'en');
});

test('CFD-6: workflow.commit_docs default mirrors DEFAULT_WORKFLOW', () => {
  const cfg = buildInstallConfig({});
  assert.equal(cfg.workflow.commit_docs, DEFAULT_WORKFLOW.commit_docs);
});

test('CFD-7: end-to-end — user answers "true" via askUser → commit_artifacts persists as true', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cfd-affirm-'));
  try {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md\n');
    const install = require('../bin/install.js');
    const answers = {};
    const askUser = async (spec) => {
      if (spec.question && spec.question.includes('commit nubos-pilot planning artefacts')) {
        answers.asked_commit_artifacts = true;
        return { value: true, source: 'test' };
      }
      if (spec.type === 'multiselect') return { value: ['claude'], source: 'test' };
      if (spec.type === 'select') return { value: spec.default || spec.options[0], source: 'test' };
      return { value: spec.default == null ? 'en' : spec.default, source: 'test' };
    };
    await install.runInstall({
      cwd: root, mode: 'init', askUser,
      flags: { agent: 'claude', scope: 'local' },
    });
    assert.equal(answers.asked_commit_artifacts, true, 'init must ask the commit_artifacts question');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'config.json'), 'utf-8'));
    assert.equal(cfg.workflow.commit_artifacts, true);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('CFD-SEC-1: buildInstallConfig writes always-on security defaults', () => {
  const cfg = buildInstallConfig({ runtime: 'claude' });
  assert.equal(cfg.security.enabled, true);
  assert.equal(cfg.security.scan_on_write, true);
  assert.equal(cfg.security.review_on_stop, true);
  assert.equal(cfg.security.review_on_commit, true);
  assert.equal(cfg.security.custom_rules_path, null);
  assert.equal(cfg.security.max_files_per_review, 30);
});

test('CFD-CONF-1: buildInstallConfig writes conformance.inject_criteria default', () => {
  const cfg = buildInstallConfig({ runtime: 'claude' });
  assert.equal(cfg.conformance.inject_criteria, true);
});
