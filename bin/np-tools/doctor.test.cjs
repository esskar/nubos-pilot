const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const doctor = require('./doctor.cjs');
const scanCodebase = require('./scan-codebase.cjs');

const _sandboxes = [];

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-doc-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(dir);
  return dir;
}

function captureStdout() {
  const chunks = [];
  return {
    stub: { write: (s) => chunks.push(String(s)), end: () => {} },
    json: () => JSON.parse(chunks.join('')),
  };
}

afterEach(() => {
  while (_sandboxes.length) {
    const dir = _sandboxes.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('DOC-1: flags codebase-not-scanned when INDEX.md missing', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export {};');
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(ids.includes('codebase-not-scanned'));
});

test('DOC-2: no codebase issue when scanned and source unchanged', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(!ids.includes('codebase-not-scanned'));
  assert.ok(!ids.includes('codebase-manifest-stale'));
});

test('DOC-3: flags codebase-manifest-stale after source changes', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });

  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){ /* v2 */ }');
  fs.writeFileSync(path.join(root, 'new.js'), 'export function b(){}');

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const stale = out.issues.find((i) => i.id === 'codebase-manifest-stale');
  assert.ok(stale, 'expected codebase-manifest-stale');
  assert.ok(stale.details.changed >= 1);
  assert.ok(stale.details.added >= 1);
});

test('DOC-4: flags codebase-tbd-docs for modules with _TBD Purpose', async () => {
  const root = makeSandbox();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const tbd = out.issues.find((i) => i.id === 'codebase-tbd-docs');
  assert.ok(tbd, 'expected codebase-tbd-docs');
  assert.ok(tbd.details.count >= 1);
});

test('DOC-6: asset manifest keys resolve to project root, not payloadDir', async () => {
  const root = makeSandbox();

  const payloadDir = path.join(root, '.claude', 'nubos-pilot');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(path.join(payloadDir, '.manifest.json'), JSON.stringify({
    version: '0.0.0',
    timestamp: new Date().toISOString(),
    files: {
      '.claude/commands/np/foo.md': 'deadbeef',
      '.claude/agents/np-bar.md': 'deadbeef',
    },
  }));
  const cmdDir = path.join(root, '.claude', 'commands', 'np');
  const agentsDir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(cmdDir, 'foo.md'), 'x');
  fs.writeFileSync(path.join(agentsDir, 'np-bar.md'), 'y');

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const missing = out.issues.filter((i) => i.id === 'payload-missing');
  assert.equal(missing.length, 0,
    'asset keys must resolve to project-root paths (found ' +
    missing.map((m) => m.file).join(', ') + ')');
});

test('DOC-5: no tbd flag after prose applied', async () => {
  const root = makeSandbox();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });

  const proseFile = path.join(root, 'p.json');
  fs.writeFileSync(proseFile, JSON.stringify({
    description: 'A module',
    purpose: 'Provides function a.',
    key_concepts: ['just one thing'],
    public_api: '`a()`',
    invariants: [],
    gotchas: [],
  }));
  scanCodebase.run(['--apply-prose', '--module', 'src', '--prose-file', proseFile], {
    cwd: root, stdout: captureStdout().stub,
  });

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const tbd = out.issues.find((i) => i.id === 'codebase-tbd-docs');
  assert.ok(!tbd, 'expected no codebase-tbd-docs');
});

test('DOC-7: flags nubosloop-knowledge-store-corrupt when JSON is malformed', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'knowledge', 'learnings.json'), 'NOT JSON');

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(ids.includes('nubosloop-knowledge-store-corrupt'));
});

test('DOC-8: flags nubosloop-knowledge-adapter-invalid for unsupported adapter', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'config.json'),
    JSON.stringify({ swarm: { knowledge_adapter: 'pinecone' } }),
  );
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(ids.includes('nubosloop-knowledge-adapter-invalid'));
});

test('DOC-9b: flags config-json-corrupt when config.json is unparseable', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'config.json'), '{ not json');
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const issue = out.issues.find((i) => i.id === 'config-json-corrupt');
  assert.ok(issue, 'expected config-json-corrupt issue');
  assert.equal(issue.severity, 'error');
  assert.match(issue.details.hint, /Repair or delete/);
});

test('DOC-9: flags nubosloop-maxRounds-out-of-range when value > 10', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'config.json'),
    JSON.stringify({ loop: { maxRounds: 99 } }),
  );
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(ids.includes('nubosloop-maxRounds-out-of-range'));
});

test('DOC-10: clean config produces no nubosloop issues', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'knowledge'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'knowledge', 'learnings.json'),
    JSON.stringify({ version: 1, learnings: [] }),
  );
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'config.json'),
    JSON.stringify({ loop: { maxRounds: 3 }, swarm: { knowledge_adapter: 'local' } }),
  );
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(!ids.some((id) => id.startsWith('nubosloop-knowledge-store-corrupt')));
  assert.ok(!ids.some((id) => id.startsWith('nubosloop-knowledge-adapter-invalid')));
  assert.ok(!ids.some((id) => id.startsWith('nubosloop-maxRounds')));
});
