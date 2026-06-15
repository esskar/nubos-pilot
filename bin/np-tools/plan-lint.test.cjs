'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const planLintCli = require('./plan-lint.cjs');

const _sandboxes = [];

function _mkProject(milestoneTree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pl-cli-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  // Mark project root via STATE.md (findProjectRoot anchors on .nubos-pilot/).
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'),
    '---\nschema_version: 2\ncurrent_phase: null\ncurrent_plan: null\ncurrent_task: null\n---\n', 'utf-8');
  if (milestoneTree) {
    for (const [rel, content] of Object.entries(milestoneTree)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
    }
  }
  _sandboxes.push(root);
  return root;
}

function _cap() {
  let buf = '';
  return { stub: { write: (s) => { buf += s; return true; } }, get: () => buf };
}

afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {}
  }
});

function _taskMd(id, filesModified, dependsOn, verifyText) {
  return `---
id: ${id}
files_modified: ${JSON.stringify(filesModified)}
depends_on: ${JSON.stringify(dependsOn)}
---
# ${id}

<verify>${verifyText}</verify>
`;
}

test('PLCLI-1: refuses without --milestone or path', () => {
  assert.throws(
    () => planLintCli.run([], { cwd: _mkProject({}), stdout: _cap().stub }),
    (err) => err && err.code === 'plan-lint-missing-target',
  );
});

test('PLCLI-2: rejects malformed --milestone value', () => {
  assert.throws(
    () => planLintCli.run(['--milestone', 'm1'], { cwd: _mkProject({}), stdout: _cap().stub }),
    (err) => err && err.code === 'plan-lint-invalid-milestone',
  );
});

test('PLCLI-3: rejects nonexistent milestone directory', () => {
  assert.throws(
    () => planLintCli.run(['--milestone', 'M999'], { cwd: _mkProject({}), stdout: _cap().stub }),
    (err) => err && err.code === 'plan-lint-milestone-not-found',
  );
});

test('PLCLI-4: returns exit 0 + zero findings on a clean milestone', () => {
  const root = _mkProject({
    '.nubos-pilot/milestones/M001/M001-PLAN.md': '# Milestone\n\n<verify>echo ok</verify>\n',
    '.nubos-pilot/milestones/M001/slices/S001/S001-PLAN.md': '# Slice\n\n<verify>echo ok</verify>\n',
    '.nubos-pilot/milestones/M001/slices/S001/tasks/T0001/T0001-PLAN.md': _taskMd(
      'M001-S001-T0001', ['src/foo.ts'], [], 'echo ok',
    ),
  });
  const cap = _cap();
  const code = planLintCli.run(['--milestone', 'M001'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(code, 0);
  assert.equal(payload.summary.critical, 0);
  assert.equal(payload.summary.total, 0);
});

test('PLCLI-5: catches the exact M004 plan-bug — verify uses unknown np-tools verb', () => {
  const root = _mkProject({
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0002/T0002-PLAN.md': _taskMd(
      'M004-S001-T0002', [], [],
      'node .nubos-pilot/bin/np-tools.cjs codebase doc-lint',
    ),
  });
  const cap = _cap();
  const code = planLintCli.run(['--milestone', 'M004'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(code, 2, 'must exit non-zero on critical findings');
  const verifyFinding = payload.files
    .flatMap((f) => f.findings)
    .find((f) => f.category === 'verify-command-unknown');
  assert.ok(verifyFinding, 'expected verify-command-unknown finding');
  assert.equal(verifyFinding.severity, 'critical');
  assert.equal(verifyFinding.raw.reason, 'np-tools-unknown-verb');
});

test('PLCLI-6: catches the exact M004 plan-bug — parallel race against working-tree-reading verify', () => {
  const root = _mkProject({
    // T0001 modifies migration files
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0001/T0001-PLAN.md': _taskMd(
      'M004-S001-T0001',
      ['database/migrations/2024_01_01_000000_install_cashier.php'],
      [],
      'php artisan migrate',
    ),
    // T0002 runs update-docs which hashes working tree → implicit dep
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0002/T0002-PLAN.md': _taskMd(
      'M004-S001-T0002', [], [],
      'node .nubos-pilot/bin/np-tools.cjs update-docs --check',
    ),
  });
  const cap = _cap();
  const code = planLintCli.run(['--milestone', 'M004'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(code, 2);
  const raceFinding = payload.parallel_race_findings.find(
    (f) => f.category === 'parallel-task-implicit-dependency',
  );
  assert.ok(raceFinding, 'expected parallel-task-implicit-dependency finding');
  assert.equal(raceFinding.target, 'M004-S001-T0002');
  assert.deepEqual(raceFinding.raw.conflicts, ['M004-S001-T0001']);
});

test('PLCLI-7: catches over-specification (Schema::create DDL in PLAN body)', () => {
  const root = _mkProject({
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0001/T0001-PLAN.md': _taskMd(
      'M004-S001-T0001', ['x.php'], [], 'echo ok',
    ).replace('# M004-S001-T0001\n',
      '# M004-S001-T0001\n\nSchema::create(\'subscriptions\', function () {});\n'),
  });
  const cap = _cap();
  const code = planLintCli.run(['--milestone', 'M004'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  // Major (advisory) is not enough to fail the gate by default — exit 0.
  assert.equal(code, 0);
  const finding = payload.files
    .flatMap((f) => f.findings)
    .find((f) => f.category === 'plan-over-specifies-implementation');
  assert.ok(finding);
  assert.equal(finding.severity, 'major');
});

test('PLCLI-8: lints a single file when given a path argument', () => {
  const root = _mkProject({
    'mytask.md': _taskMd('M001-S001-T0001', [], [], 'node .nubos-pilot/bin/np-tools.cjs nonexistent-verb'),
  });
  const cap = _cap();
  const code = planLintCli.run(['mytask.md'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(code, 2);
  assert.equal(payload.files.length, 1);
  assert.ok(payload.files[0].findings.find((f) => f.category === 'verify-command-unknown'));
});

test('PLCLI-9: file-not-found surfaces a clear error', () => {
  assert.throws(
    () => planLintCli.run(['nonexistent.md'], { cwd: _mkProject({}), stdout: _cap().stub }),
    (err) => err && err.code === 'plan-lint-file-not-found',
  );
});

test('PLCLI-10: end-to-end — all three M004 plan-bug classes surfaced together', () => {
  const root = _mkProject({
    // T0001 modifies migration files (race target)
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0001/T0001-PLAN.md': _taskMd(
      'M004-S001-T0001',
      ['database/migrations/0001_01_01_000004_create_customer_columns_table.php'],
      [],
      'php artisan migrate',
    ),
    // T0002 has working-tree-reader verify (creates implicit race) AND
    // an unknown np-tools verb on the second line.
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0002/T0002-PLAN.md': _taskMd(
      'M004-S001-T0002', [], [],
      'node .nubos-pilot/bin/np-tools.cjs update-docs --check\nnode .nubos-pilot/bin/np-tools.cjs codebase doc-lint',
    ),
  });
  const cap = _cap();
  const code = planLintCli.run(['--milestone', 'M004'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(code, 2);
  const cats = new Set([
    ...payload.files.flatMap((f) => f.findings).map((f) => f.category),
    ...payload.parallel_race_findings.map((f) => f.category),
  ]);
  assert.ok(cats.has('verify-command-unknown'),
    'must catch verify-command-unknown — saw: ' + [...cats].join(', '));
  assert.ok(cats.has('parallel-task-implicit-dependency'),
    'must catch parallel-task-implicit-dependency — saw: ' + [...cats].join(', '));
  assert.ok(cats.has('plan-over-specifies-implementation'),
    'must catch plan-over-specifies-implementation (framework-timestamped filename) — saw: '
      + [...cats].join(', '));
});
