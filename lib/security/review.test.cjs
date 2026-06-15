'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const review = require('./review.cjs');
const ledger = require('./ledger.cjs');

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sec-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t.test']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'app.js'), 'function ok(){ return 1; }\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}
function headOf(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

let _c = 0;
function freshSid() { _c += 1; return 'rev-test-' + process.pid + '-' + _c; }
function cleanup(sid) { ledger.removeLedger(sid); try { fs.unlinkSync(ledger.ledgerPath(sid) + '.lock'); } catch {} }

test('REV-1 computeStopDiff captures tracked + untracked changes since baseline', () => {
  const dir = tempRepo();
  try {
    const base = headOf(dir);
    fs.appendFileSync(path.join(dir, 'app.js'), 'const x = eval(input);\n');
    fs.writeFileSync(path.join(dir, 'new.js'), 'el.innerHTML = data;\n');
    const diff = review.computeStopDiff(dir, { head: base }, 30);
    assert.ok(diff.files.includes('app.js'));
    assert.ok(diff.files.includes('new.js'));
    assert.ok(diff.diffText.includes('eval(input)'));
    assert.ok(diff.diffText.includes('new file: new.js'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('REV-2 computeStopDiff caps file count', () => {
  const dir = tempRepo();
  try {
    const base = headOf(dir);
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, 'f' + i + '.js'), 'x\n');
    const diff = review.computeStopDiff(dir, { head: base }, 3);
    assert.equal(diff.files.length, 3);
    assert.equal(diff.truncatedFiles, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('REV-3 computeCommitDiff reads the HEAD commit', () => {
  const dir = tempRepo();
  try {
    fs.appendFileSync(path.join(dir, 'app.js'), 'const y = 2;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'change']);
    const diff = review.computeCommitDiff(dir, 30);
    assert.ok(diff.files.includes('app.js'));
    assert.ok(diff.diffText.includes('const y = 2'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('REV-4 buildReviewerPrompt includes guidance additively and the schema instruction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sec-g-'));
  const gp = path.join(dir, 'guidance.md');
  fs.writeFileSync(gp, 'Never log customer_id.');
  try {
    const prompt = review.buildReviewerPrompt({
      mode: 'stop', files: ['a.js'], truncatedFiles: false, diffText: '+ eval(x)', guidancePath: gp,
    });
    assert.ok(prompt.includes('Modus B') || prompt.includes('SESSION/DIFF'));
    assert.ok(prompt.includes('Never log customer_id.'));
    assert.ok(prompt.includes('ADDITIVE'));
    assert.ok(prompt.includes('"status":"clean|risks-found"'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('REV-5 parseReviewerOutput handles claude -p envelope, fences, and junk', () => {
  const envelope = JSON.stringify({ result: '{"status":"risks-found","findings":[{"category":"injection","severity":"high","file":"a.js","line":3,"title":"SQLi","mitigation_hint":"parameterize"}]}' });
  const a = review.parseReviewerOutput(envelope);
  assert.equal(a.parse_ok, true);
  assert.equal(a.findings.length, 1);
  assert.equal(a.findings[0].severity, 'risk');

  const fenced = JSON.stringify({ result: '```json\n{"status":"clean","findings":[]}\n```' });
  const b = review.parseReviewerOutput(fenced);
  assert.equal(b.parse_ok, true);
  assert.equal(b.findings.length, 0);

  const junk = review.parseReviewerOutput('not json at all');
  assert.equal(junk.parse_ok, false);
});

test('REV-6 runReview guard blocks a concurrent review (no double spawn)', () => {
  const dir = tempRepo();
  const sid = freshSid();
  try {
    ledger.setBaseline(sid, { head: headOf(dir) });
    fs.appendFileSync(path.join(dir, 'app.js'), 'const z = eval(q);\n');
    ledger.tryBeginReview(sid, {});  // simulate an in-flight review
    let spawnCalls = 0;
    const r = review.runReview({ cwd: dir, sid, mode: 'stop', config: {}, spawnImpl: () => { spawnCalls++; return '{}'; } });
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'in-flight');
    assert.equal(spawnCalls, 0);
  } finally { ledger.endReview(sid); cleanup(sid); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('REV-7 runReview spawns, parses, and merges risk findings into the ledger', () => {
  const dir = tempRepo();
  const sid = freshSid();
  try {
    ledger.setBaseline(sid, { head: headOf(dir) });
    fs.appendFileSync(path.join(dir, 'app.js'), 'const z = eval(q);\n');
    const stub = () => JSON.stringify({ result: '{"status":"risks-found","findings":[{"category":"dynamic-exec","severity":"high","file":"app.js","line":2,"title":"eval"}]}' });
    const r = review.runReview({ cwd: dir, sid, mode: 'stop', config: {}, spawnImpl: stub });
    assert.equal(r.ran, true);
    assert.equal(r.findings_added, 1);
    const taken = ledger.takeUnsurfacedRisks(sid, {});
    assert.equal(taken.findings.length, 1);
  } finally { cleanup(sid); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('REV-8 runReview on an empty diff does not spawn', () => {
  const dir = tempRepo();
  const sid = freshSid();
  try {
    ledger.setBaseline(sid, { head: headOf(dir) });
    let spawnCalls = 0;
    const r = review.runReview({ cwd: dir, sid, mode: 'stop', config: {}, spawnImpl: () => { spawnCalls++; return '{}'; } });
    assert.equal(r.findings_added, 0);
    assert.equal(spawnCalls, 0);
  } finally { cleanup(sid); fs.rmSync(dir, { recursive: true, force: true }); }
});
