'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const subcmd = require('./close-project.cjs');
const layout = require('../../lib/layout.cjs');

const _sandboxes = [];

function _sandbox(milestones, milestoneArtifacts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cp-'));
  _sandboxes.push(root);
  const sd = path.join(root, '.nubos-pilot');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'PROJECT.md'), '# Demo Project\n\nbody\n', 'utf-8');
  fs.writeFileSync(
    path.join(sd, 'roadmap.yaml'),
    YAML.stringify({ schema_version: 2, milestones }),
    'utf-8',
  );
  for (const m of (milestoneArtifacts || [])) {
    const mDir = layout.milestoneDir(m.number, root);
    fs.mkdirSync(mDir, { recursive: true });
    if (m.verification) fs.writeFileSync(path.join(mDir, 'M' + String(m.number).padStart(3, '0') + '-VERIFICATION.md'), m.verification, 'utf-8');
    if (m.validation) fs.writeFileSync(path.join(mDir, 'M' + String(m.number).padStart(3, '0') + '-VALIDATION.md'), m.validation, 'utf-8');
  }
  return root;
}

afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {}
  }
});

function _capture() {
  let buf = '';
  return { stub: { write: (s) => { buf += s; return true; } }, get: () => buf };
}

function _verified() {
  return '# M001\n\n**Verified:** 2026-05-11\n**Milestone Status:** verified\n\n## Success Criteria\n\n### SC-1: x\n- **Status:** Pass\n- **Classified by:** np-verifier\n- **Evidence:** abc\n';
}

function _validation() {
  return '# M001 Validation\n- REQ-01: COVERED\n';
}

test('CP-1: init returns completion payload', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [{ number: 1, verification: _verified(), validation: _validation() }],
  );
  const cap = _capture();
  subcmd.run(['init'], { cwd: sb, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload._workflow, 'close-project');
  assert.equal(payload.project_exists, true);
  assert.equal(payload.completion.status, 'complete');
});

test('CP-2: write-summary writes PROJECT-SUMMARY.md', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [{ number: 1, verification: _verified(), validation: _validation() }],
  );
  const cap = _capture();
  subcmd.run(['write-summary'], { cwd: sb, stdout: cap.stub });
  const summaryPath = path.join(sb, '.nubos-pilot', 'PROJECT-SUMMARY.md');
  assert.ok(fs.existsSync(summaryPath));
  const md = fs.readFileSync(summaryPath, 'utf-8');
  assert.match(md, /Project Summary/);
});

test('CP-3: mark-completed sets project_status in roadmap.yaml', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [{ number: 1, verification: _verified(), validation: _validation() }],
  );
  subcmd.run(['mark-completed'], { cwd: sb, stdout: _capture().stub });
  const doc = YAML.parse(fs.readFileSync(path.join(sb, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.project_status, 'completed');
});

test('CP-4: unknown verb throws NubosPilotError', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [],
  );
  assert.throws(
    () => subcmd.run(['frobnicate'], { cwd: sb, stdout: _capture().stub }),
    (err) => err.code === 'close-project-unknown-verb',
  );
});

test('CP-5: check verb prints completion JSON', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'pending', success_criteria: ['x'], slices: [] }],
    [],
  );
  const cap = _capture();
  subcmd.run(['check'], { cwd: sb, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.status, 'incomplete');
  assert.ok(payload.blockers.length > 0);
});
