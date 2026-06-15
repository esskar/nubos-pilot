'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const planLint = require('./plan-lint.cjs');

const _sandboxes = [];
function _mkRoot(files) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pl-'));
  if (files) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(r, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
    }
  }
  _sandboxes.push(r);
  return r;
}
afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {}
  }
});

// ===========================================================================
// D1 — lintVerifyCommands
// ===========================================================================

test('PL-VC-1: passes for known np-tools verb', () => {
  const findings = planLint.lintVerifyCommands(
    '<verify>node .nubos-pilot/bin/np-tools.cjs commit-task M001-S001-T0001</verify>',
    { knownVerbs: ['commit-task', 'state'] },
  );
  assert.equal(findings.length, 0);
});

test('PL-VC-2: catches unknown np-tools verb (the M004 bug class)', () => {
  const findings = planLint.lintVerifyCommands(
    '<verify>node .nubos-pilot/bin/np-tools.cjs codebase doc-lint</verify>',
    { knownVerbs: ['commit-task', 'state', 'help'] },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'verify-command-unknown');
  assert.equal(findings[0].severity, 'critical');
  assert.equal(findings[0].raw.reason, 'np-tools-unknown-verb');
});

test('PL-VC-3: catches np-tools call without a verb', () => {
  const findings = planLint.lintVerifyCommands(
    '<verify>node .nubos-pilot/bin/np-tools.cjs --help</verify>',
    { knownVerbs: ['commit-task'] },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].raw.reason, 'np-tools-missing-verb');
});

test('PL-VC-4: passes for declared composer script', () => {
  const r = _mkRoot({
    'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }),
  });
  const findings = planLint.lintVerifyCommands(
    '<verify>composer test</verify>',
    { cwd: r },
  );
  assert.equal(findings.length, 0);
});

test('PL-VC-5: catches undeclared composer script', () => {
  const r = _mkRoot({
    'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }),
  });
  const findings = planLint.lintVerifyCommands(
    '<verify>composer phantom-script</verify>',
    { cwd: r },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].raw.reason, 'composer-script-not-declared');
});

test('PL-VC-6: composer builtin (install/update/dump-autoload) always passes', () => {
  const r = _mkRoot({});
  const findings = planLint.lintVerifyCommands(
    '<verify>composer dump-autoload</verify>',
    { cwd: r },
  );
  assert.equal(findings.length, 0);
});

test('PL-VC-7: passes for declared npm script', () => {
  const r = _mkRoot({
    'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
  });
  const findings = planLint.lintVerifyCommands(
    '<verify>npm run lint</verify>',
    { cwd: r },
  );
  assert.equal(findings.length, 0);
});

test('PL-VC-8: catches undeclared npm script', () => {
  const r = _mkRoot({
    'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
  });
  const findings = planLint.lintVerifyCommands(
    '<verify>npm run nonexistent</verify>',
    { cwd: r },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].raw.reason, 'npm-script-not-declared');
});

test('PL-VC-9: passes for vendor/bin/* path even if file is absent (post-install)', () => {
  const r = _mkRoot({});
  const findings = planLint.lintVerifyCommands(
    '<verify>vendor/bin/phpstan analyse</verify>',
    { cwd: r },
  );
  assert.equal(findings.length, 0);
});

test('PL-VC-10: passes for POSIX baseline (echo, test, [, sed)', () => {
  const findings = planLint.lintVerifyCommands(
    '<verify>echo ok && test -f file.txt</verify>',
    {},
  );
  assert.equal(findings.length, 0);
});

test('PL-VC-11: catches non-existent path command', () => {
  const r = _mkRoot({});
  const findings = planLint.lintVerifyCommands(
    '<verify>./scripts-elsewhere/run.sh</verify>',
    { cwd: r },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].raw.reason, 'path-not-found');
});

test('PL-VC-12: multi-line verify, only first non-comment validated per line', () => {
  const findings = planLint.lintVerifyCommands(
    `<verify>
# this is a comment
echo "step 1"
node .nubos-pilot/bin/np-tools.cjs nonexistent-verb
</verify>`,
    { knownVerbs: ['existing-verb'] },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].raw.reason, 'np-tools-unknown-verb');
});

test('PL-VC-13: env-var prefix is stripped before validation', () => {
  const findings = planLint.lintVerifyCommands(
    '<verify>FOO=bar BAZ=qux node .nubos-pilot/bin/np-tools.cjs commit-task X</verify>',
    { knownVerbs: ['commit-task'] },
  );
  assert.equal(findings.length, 0);
});

test('PL-VC-14: shell pipe — only validates first sub-command', () => {
  const findings = planLint.lintVerifyCommands(
    '<verify>echo data | grep pattern</verify>',
    {},
  );
  assert.equal(findings.length, 0); // echo is POSIX baseline
});

// ===========================================================================
// D2 — lintParallelTaskRaces
// ===========================================================================

test('PL-PR-1: detects update-docs race against sibling that modifies files', () => {
  const tasks = [
    { id: 'M001-S001-T0001', files_modified: ['src/foo.ts'], depends_on: [],
      verifyText: 'php artisan test', slice: 'S001' },
    { id: 'M001-S001-T0002', files_modified: [], depends_on: [],
      verifyText: 'node .nubos-pilot/bin/np-tools.cjs update-docs --check', slice: 'S001' },
  ];
  const findings = planLint.lintParallelTaskRaces(tasks);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'parallel-task-implicit-dependency');
  assert.equal(findings[0].target, 'M001-S001-T0002');
  assert.deepEqual(findings[0].raw.conflicts, ['M001-S001-T0001']);
});

test('PL-PR-2: detects phpstan-analyse race', () => {
  const tasks = [
    { id: 'M001-S001-T0001', files_modified: ['src/a.php'], depends_on: [],
      verifyText: '', slice: 'S001' },
    { id: 'M001-S001-T0002', files_modified: [], depends_on: [],
      verifyText: 'vendor/bin/phpstan analyse', slice: 'S001' },
  ];
  const findings = planLint.lintParallelTaskRaces(tasks);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].target, 'M001-S001-T0002');
});

test('PL-PR-3: skips when explicit depends_on already declared', () => {
  const tasks = [
    { id: 'M001-S001-T0001', files_modified: ['src/foo.ts'], depends_on: [],
      verifyText: 'php artisan test', slice: 'S001' },
    { id: 'M001-S001-T0002', files_modified: [], depends_on: ['M001-S001-T0001'],
      verifyText: 'node .nubos-pilot/bin/np-tools.cjs update-docs --check', slice: 'S001' },
  ];
  const findings = planLint.lintParallelTaskRaces(tasks);
  assert.equal(findings.length, 0);
});

test('PL-PR-4: ignores stateless verify (php artisan test alone)', () => {
  const tasks = [
    { id: 'M001-S001-T0001', files_modified: ['src/foo.ts'], depends_on: [],
      verifyText: 'echo hi', slice: 'S001' },
    { id: 'M001-S001-T0002', files_modified: ['src/bar.ts'], depends_on: [],
      verifyText: 'echo there', slice: 'S001' },
  ];
  const findings = planLint.lintParallelTaskRaces(tasks);
  assert.equal(findings.length, 0);
});

test('PL-PR-5: cross-slice tasks are not pairs (different slice keys)', () => {
  const tasks = [
    { id: 'M001-S001-T0001', files_modified: ['src/foo.ts'], depends_on: [],
      verifyText: 'php artisan test', slice: 'S001' },
    { id: 'M001-S002-T0001', files_modified: [], depends_on: [],
      verifyText: 'update-docs --check', slice: 'S002' },
  ];
  const findings = planLint.lintParallelTaskRaces(tasks);
  assert.equal(findings.length, 0);
});

// ===========================================================================
// D3 — lintOverSpecification (heuristic)
// ===========================================================================

test('PL-OS-1: catches Schema::create DDL block', () => {
  const findings = planLint.lintOverSpecification(`
## Migration

Schema::create('subscriptions', function (Blueprint $table) {
    $table->bigIncrements('id');
});
`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'plan-over-specifies-implementation');
  assert.equal(findings[0].raw.signal, 'schema-ddl');
});

test('PL-OS-2: catches framework-controlled migration filename', () => {
  const findings = planLint.lintOverSpecification(`
files_modified:
  - database/migrations/0001_01_01_000004_create_customer_columns_table.php
`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].raw.signal, 'framework-timestamped-filename');
});

test('PL-OS-3: catches a large inline code block', () => {
  const big = Array(20).fill('  some_field: value').join('\n');
  const findings = planLint.lintOverSpecification('```yaml\n' + big + '\n```');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].raw.signal, 'inline-code-snippet');
});

test('PL-OS-4: clean intent-only PLAN body produces zero findings', () => {
  const findings = planLint.lintOverSpecification(`
## Goal
Install Cashier billing into the project.

## Boundary
- App service provider
- Test surface

## Acceptance
- Pest tests for Cashier integration green
- Migrations applied successfully
`);
  assert.equal(findings.length, 0);
});

// ===========================================================================
// Integration
// ===========================================================================

test('PL-INT-1: lintPlan combines verify-command + over-specification', () => {
  const findings = planLint.lintPlan(`
<verify>node .nubos-pilot/bin/np-tools.cjs codebase doc-lint</verify>

Schema::create('tbl', function () {});
`, { knownVerbs: ['commit-task'] });
  assert.equal(findings.length, 2);
  const cats = findings.map((f) => f.category).sort();
  assert.deepEqual(cats, ['plan-over-specifies-implementation', 'verify-command-unknown']);
});

test('PL-INT-2: lintTaskFile reads frontmatter + body and runs full lint', () => {
  const r = _mkRoot({
    'task.md': `---
id: M001-S001-T0001
files_modified: []
---
<verify>node .nubos-pilot/bin/np-tools.cjs codebase doc-lint</verify>
`,
  });
  const result = planLint.lintTaskFile(path.join(r, 'task.md'), { knownVerbs: ['commit-task'] });
  assert.equal(result.frontmatter.id, 'M001-S001-T0001');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'verify-command-unknown');
});
