'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');

const archive = require('./archive.cjs');
const layout = require('./layout.cjs');

const _sandboxes = [];

function _mkSandbox(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-archive-'));
  _sandboxes.push(root);
  const stateDir = path.join(root, '.nubos-pilot');
  fs.mkdirSync(stateDir, { recursive: true });

  if (o.withProjectMd !== false) {
    fs.writeFileSync(
      path.join(stateDir, 'PROJECT.md'),
      '# ' + (o.projectName || 'Test Project') + '\n\nDescription.\n',
      'utf-8',
    );
  }

  if (o.milestones) {
    const doc = { schema_version: 2, milestones: o.milestones };
    if (o.project_status) doc.project_status = o.project_status;
    fs.writeFileSync(
      path.join(stateDir, 'roadmap.yaml'),
      YAML.stringify(doc, { indent: 2 }),
      'utf-8',
    );
  }

  if (Array.isArray(o.milestoneArtifacts)) {
    for (const m of o.milestoneArtifacts) {
      const mDir = layout.milestoneDir(m.number, root);
      fs.mkdirSync(mDir, { recursive: true });
      if (m.verification) {
        fs.writeFileSync(
          path.join(mDir, layout.mId(m.number) + '-VERIFICATION.md'),
          m.verification,
          'utf-8',
        );
      }
      if (m.validation) {
        fs.writeFileSync(
          path.join(mDir, layout.mId(m.number) + '-VALIDATION.md'),
          m.validation,
          'utf-8',
        );
      }
    }
  }

  if (o.extraTopLevelDirs) {
    for (const name of o.extraTopLevelDirs) {
      fs.mkdirSync(path.join(stateDir, name), { recursive: true });
      fs.writeFileSync(path.join(stateDir, name, 'marker.txt'), 'hi', 'utf-8');
    }
  }

  return root;
}

function _cleanup() {
  while (_sandboxes.length) {
    const r = _sandboxes.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
}

test.afterEach(() => _cleanup());

function _verifiedMd(name) {
  return [
    '# M001 — ' + name + ' — Verification',
    '',
    '**Verified:** 2026-05-11',
    '**Milestone Status:** verified',
    '',
    '## Success Criteria',
    '',
    '### SC-1: works',
    '- **Status:** Pass',
    '- **Classified by:** np-verifier',
    '- **Evidence:** abc123',
    '',
  ].join('\n');
}

function _failedMd(name) {
  return [
    '# M001 — ' + name + ' — Verification',
    '',
    '**Verified:** 2026-05-11',
    '**Milestone Status:** failed',
    '',
    '## Success Criteria',
    '',
    '### SC-1: works',
    '- **Status:** Fail',
    '- **Classified by:** np-verifier',
    '- **Evidence:** —',
    '',
  ].join('\n');
}

function _validationMd(opts) {
  const lines = ['# M001 — Validation', ''];
  if (opts && opts.uncovered) lines.push('- REQ-01: UNCOVERED');
  else lines.push('- REQ-01: COVERED');
  return lines.join('\n');
}

test('AR-1: projectExists detects PROJECT.md presence', () => {
  const sb = _mkSandbox({ withProjectMd: true });
  assert.equal(archive.projectExists(sb), true);

  const empty = _mkSandbox({ withProjectMd: false });
  assert.equal(archive.projectExists(empty), false);
});

test('AR-2: computeCompletionStatus = no-project when PROJECT.md absent', () => {
  const sb = _mkSandbox({ withProjectMd: false });
  const result = archive.computeCompletionStatus(sb);
  assert.equal(result.status, 'no-project');
  assert.equal(result.complete, false);
});

test('AR-3: computeCompletionStatus = complete when every milestone passes', () => {
  const sb = _mkSandbox({
    projectName: 'Alpha',
    milestones: [
      { id: 'M001', number: 1, name: 'first', status: 'done', success_criteria: ['works'], slices: [] },
    ],
    milestoneArtifacts: [
      { number: 1, verification: _verifiedMd('first'), validation: _validationMd({ uncovered: false }) },
    ],
  });
  const result = archive.computeCompletionStatus(sb);
  assert.equal(result.status, 'complete');
  assert.equal(result.complete, true);
  assert.deepEqual(result.blockers, []);
});

test('AR-4: computeCompletionStatus blockers list failed SC + missing VALIDATION', () => {
  const sb = _mkSandbox({
    milestones: [
      { id: 'M001', number: 1, name: 'first', status: 'pending', success_criteria: ['works'], slices: [] },
    ],
    milestoneArtifacts: [
      { number: 1, verification: _failedMd('first') },
    ],
  });
  const result = archive.computeCompletionStatus(sb);
  assert.equal(result.complete, false);
  assert.equal(result.status, 'incomplete');
  assert.ok(result.blockers.some((b) => /1 SC failed/.test(b)), 'expected SC-failed blocker; got: ' + JSON.stringify(result.blockers));
  assert.ok(result.blockers.some((b) => /VALIDATION\.md missing/.test(b)), 'expected validation-missing blocker');
});

test('AR-5: archiveProject refuses incomplete project without force', () => {
  const sb = _mkSandbox({
    milestones: [
      { id: 'M001', number: 1, name: 'first', status: 'pending', success_criteria: ['works'], slices: [] },
    ],
  });
  assert.throws(
    () => archive.archiveProject(sb),
    (err) => err.code === 'archive-not-complete',
  );
});

test('AR-6: archiveProject moves canonical items + restores real knowledge paths into state-dir', () => {
  const sb = _mkSandbox({
    projectName: 'Beta',
    milestones: [
      { id: 'M001', number: 1, name: 'one', status: 'done', success_criteria: ['s'], slices: [] },
    ],
    milestoneArtifacts: [
      { number: 1, verification: _verifiedMd('one'), validation: _validationMd({}) },
    ],
  });
  const knowDir = path.join(sb, '.nubos-pilot', 'knowledge');
  fs.mkdirSync(path.join(knowDir, 'solutions'), { recursive: true });
  fs.mkdirSync(path.join(knowDir, 'other'), { recursive: true });
  fs.writeFileSync(
    path.join(knowDir, 'learnings.json'),
    JSON.stringify({ version: 1, learnings: [] }),
    'utf-8',
  );
  fs.writeFileSync(path.join(knowDir, 'solutions', 'sol-1.md'), 'fix note', 'utf-8');
  fs.writeFileSync(path.join(knowDir, 'other', 'y.md'), 'not carried', 'utf-8');

  const result = archive.archiveProject(sb);
  assert.ok(result.archive_dir.includes(path.join('.nubos-pilot', 'archive', 'beta-')));
  assert.ok(result.moved.includes('PROJECT.md'));
  assert.ok(result.moved.includes('roadmap.yaml'));
  assert.ok(result.moved.includes('milestones'));
  assert.ok(result.moved.includes('knowledge'));
  assert.deepEqual(
    result.carried_over.sort(),
    ['knowledge/learnings.json', 'knowledge/solutions'],
  );

  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'PROJECT.md')), false);
  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'knowledge', 'learnings.json')), true);
  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'knowledge', 'solutions', 'sol-1.md')), true);
  assert.equal(
    fs.existsSync(path.join(sb, '.nubos-pilot', 'knowledge', 'other', 'y.md')),
    false,
    'non-carry-over subpaths must not be restored into state-dir',
  );
  assert.equal(fs.existsSync(path.join(result.archive_dir, 'knowledge', 'learnings.json')), true);
  assert.equal(fs.existsSync(path.join(result.archive_dir, 'knowledge', 'solutions', 'sol-1.md')), true);
  assert.equal(fs.existsSync(path.join(result.archive_dir, 'knowledge', 'other', 'y.md')), true);
  assert.equal(fs.existsSync(path.join(result.archive_dir, 'ARCHIVE.json')), true);

  const manifest = JSON.parse(fs.readFileSync(path.join(result.archive_dir, 'ARCHIVE.json'), 'utf-8'));
  assert.equal(manifest.project_name, 'Beta');
  assert.equal(manifest.completion_status, 'complete');
  assert.equal(manifest.forced, false);
});

test('AR-CARRY-1: carry-over silently skips missing knowledge paths', () => {
  const sb = _mkSandbox({
    projectName: 'Delta',
    milestones: [
      { id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['s'], slices: [] },
    ],
    milestoneArtifacts: [
      { number: 1, verification: _verifiedMd('a'), validation: _validationMd({}) },
    ],
  });
  const result = archive.archiveProject(sb);
  assert.deepEqual(result.carried_over, []);
});

test('AR-CARRY-2: custom carry_over restores an archived item back into state-dir', () => {
  const sb = _mkSandbox({
    projectName: 'Epsilon',
    milestones: [
      { id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['s'], slices: [] },
    ],
    milestoneArtifacts: [
      { number: 1, verification: _verifiedMd('a'), validation: _validationMd({}) },
    ],
  });
  const msgDir = path.join(sb, '.nubos-pilot', 'messages');
  fs.mkdirSync(msgDir, { recursive: true });
  fs.writeFileSync(path.join(msgDir, 'msg-1.md'), 'hello', 'utf-8');
  const result = archive.archiveProject(sb, { carry_over: ['messages'] });
  assert.deepEqual(result.carried_over, ['messages']);
  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'messages', 'msg-1.md')), true);
  assert.equal(fs.existsSync(path.join(result.archive_dir, 'messages', 'msg-1.md')), true);
});

test('AR-CARRY-3: carry_over manifest entries are POSIX-normalized', () => {
  const sb = _mkSandbox({
    projectName: 'Zeta',
    milestones: [
      { id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['s'], slices: [] },
    ],
    milestoneArtifacts: [
      { number: 1, verification: _verifiedMd('a'), validation: _validationMd({}) },
    ],
  });
  const knowDir = path.join(sb, '.nubos-pilot', 'knowledge');
  fs.mkdirSync(knowDir, { recursive: true });
  fs.writeFileSync(path.join(knowDir, 'learnings.json'), '{}', 'utf-8');
  const platformPath = path.join('knowledge', 'learnings.json');
  const result = archive.archiveProject(sb, { carry_over: [platformPath] });
  assert.deepEqual(result.carried_over, ['knowledge/learnings.json']);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.archive_dir, 'ARCHIVE.json'), 'utf-8'));
  assert.deepEqual(manifest.carried_over, ['knowledge/learnings.json']);
});

test('AR-7: archiveProject collision suffixes a counter', () => {
  const sb = _mkSandbox({
    projectName: 'Gamma',
    milestones: [
      { id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['s'], slices: [] },
    ],
    milestoneArtifacts: [
      { number: 1, verification: _verifiedMd('a'), validation: _validationMd({}) },
    ],
  });
  const first = archive.archiveProject(sb);

  fs.writeFileSync(path.join(sb, '.nubos-pilot', 'PROJECT.md'), '# Gamma\n', 'utf-8');
  fs.writeFileSync(
    path.join(sb, '.nubos-pilot', 'roadmap.yaml'),
    YAML.stringify({
      schema_version: 2,
      milestones: [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['s'], slices: [] }],
    }),
    'utf-8',
  );
  fs.mkdirSync(layout.milestoneDir(1, sb), { recursive: true });
  fs.writeFileSync(path.join(layout.milestoneDir(1, sb), 'M001-VERIFICATION.md'), _verifiedMd('a'), 'utf-8');
  fs.writeFileSync(path.join(layout.milestoneDir(1, sb), 'M001-VALIDATION.md'), _validationMd({}), 'utf-8');

  const second = archive.archiveProject(sb);
  assert.notEqual(first.archive_dir, second.archive_dir);
  assert.match(path.basename(second.archive_dir), /-2$/);
});

test('AR-8: listArchives returns most-recent-first manifests', () => {
  const sb = _mkSandbox({
    projectName: 'Delta',
    milestones: [
      { id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['s'], slices: [] },
    ],
    milestoneArtifacts: [
      { number: 1, verification: _verifiedMd('a'), validation: _validationMd({}) },
    ],
  });
  archive.archiveProject(sb);
  const list = archive.listArchives(sb);
  assert.equal(list.length, 1);
  assert.equal(list[0].project_name, 'Delta');
  assert.equal(list[0].completion_status, 'complete');
});

test('AR-9: setProjectStatus writes project_status + completed_at', () => {
  const sb = _mkSandbox({
    milestones: [
      { id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['s'], slices: [] },
    ],
  });
  archive.setProjectStatus(sb, 'completed');
  const doc = YAML.parse(fs.readFileSync(path.join(sb, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.project_status, 'completed');
  assert.ok(typeof doc.completed_at === 'string' && /^\d{4}-/.test(doc.completed_at));
});

test('AR-10: setProjectStatus rejects unknown value', () => {
  const sb = _mkSandbox({
    milestones: [
      { id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['s'], slices: [] },
    ],
  });
  assert.throws(
    () => archive.setProjectStatus(sb, 'bogus'),
    (err) => err.code === 'archive-invalid-project-status',
  );
});

test('AR-9b: setProjectStatus throws roadmap-unsupported-schema on schema_version=99', () => {
  const sb = _mkSandbox({
    milestones: [
      { id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['s'], slices: [] },
    ],
  });
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  const doc = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'));
  doc.schema_version = 99;
  fs.writeFileSync(yamlPath, YAML.stringify(doc, { indent: 2 }));
  assert.throws(
    () => archive.setProjectStatus(sb, 'completed'),
    (err) =>
      err.name === 'NubosPilotError'
      && err.code === 'roadmap-unsupported-schema'
      && err.details.file === 'roadmap.yaml',
  );
});

test('AR-9c: setProjectStatus stamps schema_version forward on legacy v1 input', () => {
  const sb = _mkSandbox({
    milestones: [
      { id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['s'], slices: [] },
    ],
  });
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  const doc = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'));
  doc.schema_version = 1;
  fs.writeFileSync(yamlPath, YAML.stringify(doc, { indent: 2 }));
  archive.setProjectStatus(sb, 'completed');
  const after = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'));
  assert.equal(after.schema_version, 2);
  assert.equal(after.project_status, 'completed');
});

test('AR-11: writeProjectSummary renders milestone block per milestone', () => {
  const sb = _mkSandbox({
    projectName: 'Echo',
    milestones: [
      { id: 'M001', number: 1, name: 'one', status: 'done', success_criteria: ['s'], slices: [] },
    ],
    milestoneArtifacts: [
      { number: 1, verification: _verifiedMd('one'), validation: _validationMd({}) },
    ],
  });
  const result = archive.writeProjectSummary(sb);
  const md = fs.readFileSync(result.path, 'utf-8');
  assert.match(md, /^# Echo — Project Summary$/m);
  assert.match(md, /^### M001 — one$/m);
  assert.match(md, /^- \*\*Verification:\*\* verified/m);
});

test('AR-12: readArchiveFile refuses path traversal', () => {
  const sb = _mkSandbox({
    projectName: 'Foxtrot',
    milestones: [
      { id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['s'], slices: [] },
    ],
    milestoneArtifacts: [
      { number: 1, verification: _verifiedMd('a'), validation: _validationMd({}) },
    ],
  });
  const result = archive.archiveProject(sb);
  const archiveName = path.basename(result.archive_dir);
  assert.throws(
    () => archive.readArchiveFile(sb, archiveName, '../../etc/passwd'),
    (err) => err.code === 'archive-path-escape',
  );
});

test('AR-13: archiveProject with force=true succeeds on incomplete project + marks forced', () => {
  const sb = _mkSandbox({
    projectName: 'Golf',
    milestones: [
      { id: 'M001', number: 1, name: 'a', status: 'pending', success_criteria: ['s'], slices: [] },
    ],
  });
  const result = archive.archiveProject(sb, { force: true });
  assert.equal(result.forced, true);
  assert.equal(result.completion_status, 'incomplete');
  const manifest = JSON.parse(fs.readFileSync(path.join(result.archive_dir, 'ARCHIVE.json'), 'utf-8'));
  assert.equal(manifest.forced, true);
  assert.ok(manifest.blockers_at_archive.length > 0);
});

test('AR-14: computeCompletionStatus counts H3 reqs in a trailing ## Uncovered section (body source)', () => {
  const validationBody = [
    '# M001 — Validation',
    '',
    '## Covered',
    '',
    '### REQ-03',
    '',
    '## Uncovered',
    '',
    '### REQ-01',
    '',
    '### REQ-02',
    '',
  ].join('\n');
  const sb = _mkSandbox({
    projectName: 'Beta',
    milestones: [
      { id: 'M001', number: 1, name: 'first', status: 'done', success_criteria: ['works'], slices: [] },
    ],
    milestoneArtifacts: [
      { number: 1, verification: _verifiedMd('first'), validation: validationBody },
    ],
  });
  const result = archive.computeCompletionStatus(sb);
  assert.equal(result.complete, false);
  assert.ok(
    result.blockers.some((b) => /M001: 2 requirement\(s\) UNCOVERED/.test(b)),
    'expected uncovered blocker from the trailing ## Uncovered section; got: ' + JSON.stringify(result.blockers),
  );
});
