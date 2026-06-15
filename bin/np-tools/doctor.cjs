'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NubosPilotError, atomicWriteFileSync } = require('../../lib/core.cjs');
const { safeYamlParse } = require('../../lib/yaml.cjs');
const manifestMod = require('../../lib/install/manifest.cjs');
const codexTomlMod = require('../../lib/install/codex-toml.cjs');
const runtimeAssetsMod = require('../../lib/install/runtime-assets.cjs');
const askuserMod = require('../../lib/askuser.cjs');
const codebaseManifest = require('../../lib/codebase-manifest.cjs');
const { scan: workspaceScan } = require('../../lib/workspace-scan.cjs');
const outputLint = require('../../lib/output-lint.cjs');
const { getSchema, inferSchemaForFile } = require('../../lib/schemas/index.cjs');

const PAYLOAD_SUBPATH = path.join('.claude', 'nubos-pilot');
const STATE_SUBPATH = '.nubos-pilot';
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const OPENCODE_LOCAL_PREFIX = '.opencode/nubos-pilot/';

function _readScope(projectRoot) {
  const { readConfig, _CONFIG_PARSE_CODES } = require('../../lib/config.cjs');
  let cfg;
  try {
    cfg = readConfig(projectRoot);
  } catch (err) {
    if (err && err.code === 'not-in-project') return 'local';
    if (err && _CONFIG_PARSE_CODES.has(err.code)) return 'local';
    throw err;
  }
  return cfg && cfg.scope === 'global' ? 'global' : 'local';
}

function _payloadBaseFor(projectRoot, scope) {
  return scope === 'global' ? os.homedir() : projectRoot;
}

function _payloadDirFor(projectRoot, scope) {
  return path.join(_payloadBaseFor(projectRoot, scope), PAYLOAD_SUBPATH);
}

function _resolveManifestEntry(rel, projectRoot, scope) {
  if (rel.startsWith('~/')) {
    return path.join(os.homedir(), rel.slice(2));
  }
  const base = _payloadBaseFor(projectRoot, scope);
  if (runtimeAssetsMod.isAssetManifestKey(rel) || rel.startsWith(OPENCODE_LOCAL_PREFIX)) {
    return path.join(base, rel);
  }
  return path.join(_payloadDirFor(projectRoot, scope), rel);
}

function _pkgVersion() {
  try {
    return require('../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function _checkManifestIntegrity(projectRoot, scope) {
  const issues = [];
  const payloadDir = _payloadDirFor(projectRoot, scope);
  let manifest = null;
  try {
    manifest = manifestMod.readManifest(payloadDir);
  } catch (err) {
    issues.push({
      id: 'missing-manifest',
      severity: 'error',
      fixable: 'reinstall',
      details: { reason: 'parse-failed', cause: err && err.message },
    });
    return { manifest: null, issues };
  }
  if (!manifest) {
    issues.push({
      id: 'missing-manifest',
      severity: 'error',
      fixable: 'reinstall',
      details: { payloadDir },
    });
    return { manifest: null, issues };
  }
  const files = (manifest.files && typeof manifest.files === 'object') ? manifest.files : {};
  for (const rel of Object.keys(files)) {
    const full = _resolveManifestEntry(rel, projectRoot, scope);
    if (!fs.existsSync(full)) {
      issues.push({
        id: 'payload-missing',
        file: rel,
        severity: 'error',
        fixable: 'reinstall',
      });
      continue;
    }
    let hash;
    try { hash = manifestMod.fileHashSync(full); } catch { hash = null; }
    if (hash && hash !== files[rel]) {
      issues.push({
        id: 'payload-modified',
        file: rel,
        severity: 'warn',
        fixable: 'reinstall',
      });
    }
  }
  return { manifest, issues };
}

function _checkVersionMismatch(manifest) {
  if (!manifest) return [];
  const installed = String(manifest.version == null ? '' : manifest.version);
  const pkg = String(_pkgVersion());
  if (installed && installed !== pkg) {
    return [{
      id: 'version-mismatch',
      severity: 'warn',
      fixable: 'reinstall',
      details: { installed, expected: pkg },
    }];
  }
  return [];
}

function _checkHooksMissing(manifest, payloadDir) {
  if (!manifest) return [];
  const files = (manifest.files && typeof manifest.files === 'object') ? manifest.files : {};
  const hasHooksEntries = Object.keys(files).some((rel) => rel.startsWith('hooks/'));
  if (!hasHooksEntries) return [];
  const hooksDir = path.join(payloadDir, 'hooks');
  if (fs.existsSync(hooksDir)) return [];
  return [{
    id: 'hooks-missing',
    severity: 'error',
    fixable: 'reinstall',
    details: { hooksDir },
  }];
}

function _checkCodexTrappedFeatures() {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return { issues: [], content: null };
  let content;
  try {
    content = fs.readFileSync(CODEX_CONFIG_PATH, 'utf-8');
  } catch (err) {
    return {
      issues: [{
        id: 'codex-trapped-features',
        severity: 'warn',
        fixable: 'reinstall',
        details: { reason: 'read-failed', cause: err && err.message },
      }],
      content: null,
    };
  }
  if (codexTomlMod.hasTrappedFeatures(content)) {
    return {
      issues: [{
        id: 'codex-trapped-features',
        severity: 'warn',
        fixable: 'auto',
        details: { path: CODEX_CONFIG_PATH },
      }],
      content,
    };
  }
  return { issues: [], content };
}

function _checkAskUserBroken() {
  try {
    askuserMod.getRuntime();
    return [];
  } catch (err) {
    return [{
      id: 'askuser-broken',
      severity: 'warn',
      fixable: 'prompt',
      details: { cause: err && err.message },
    }];
  }
}

function _checkCodebaseDocs(projectRoot) {
  const issues = [];
  const stateDir = path.join(projectRoot, '.nubos-pilot');
  if (!fs.existsSync(stateDir)) return issues;
  const codebaseDir = path.join(stateDir, 'codebase');
  const indexPath = path.join(codebaseDir, 'INDEX.md');
  const modulesDir = path.join(codebaseDir, 'modules');

  if (!fs.existsSync(indexPath)) {
    issues.push({
      id: 'codebase-not-scanned',
      severity: 'warn',
      fixable: 'run-workflow',
      details: { hint: 'run `np:scan-codebase`' },
    });
    return issues;
  }

  let prevManifest;
  try {
    prevManifest = codebaseManifest.readManifest(projectRoot);
  } catch (err) {
    issues.push({
      id: 'codebase-manifest-unreadable',
      severity: 'warn',
      fixable: 'run-workflow',
      details: { cause: err && err.code, hint: 'run `np:scan-codebase`' },
    });
    return issues;
  }

  let scanResult;
  try {
    scanResult = workspaceScan({ cwd: projectRoot, batchSize: 1000 });
  } catch (err) {
    issues.push({
      id: 'codebase-scan-failed',
      severity: 'warn',
      fixable: 'run-workflow',
      details: { cause: err && err.code, hint: 'inspect workspace and re-run `np:scan-codebase`' },
    });
    return issues;
  }

  const nextManifest = codebaseManifest.manifestFromScanFiles(scanResult.files);
  const diff = codebaseManifest.diffManifest(prevManifest, nextManifest);
  const touched = diff.summary.added + diff.summary.changed + diff.summary.removed;
  if (touched > 0) {
    issues.push({
      id: 'codebase-manifest-stale',
      severity: 'warn',
      fixable: 'run-workflow',
      details: {
        added: diff.summary.added,
        changed: diff.summary.changed,
        removed: diff.summary.removed,
        hint: 'run `np:update-docs`',
      },
    });
  }

  if (fs.existsSync(modulesDir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(modulesDir).filter((f) => f.endsWith('.md'));
    } catch {}
    const tbdDocs = [];
    for (const f of entries) {
      try {
        const raw = fs.readFileSync(path.join(modulesDir, f), 'utf-8');
        const purposeIdx = raw.indexOf('## Purpose');
        if (purposeIdx >= 0) {
          const chunk = raw.slice(purposeIdx, purposeIdx + 400);
          if (chunk.includes('_TBD')) tbdDocs.push(f);
        }
      } catch {}
    }
    if (tbdDocs.length > 0) {
      issues.push({
        id: 'codebase-tbd-docs',
        severity: 'info',
        fixable: 'run-workflow',
        details: {
          count: tbdDocs.length,
          sample: tbdDocs.slice(0, 5),
          hint: 'run `np:scan-codebase` and dispatch the documenter agent for each module',
        },
      });
    }
  }

  return issues;
}

function _checkMilestoneLayout(projectRoot) {
  const stateDir = path.join(projectRoot, '.nubos-pilot');
  const roadmapPath = path.join(stateDir, 'roadmap.yaml');
  if (!fs.existsSync(roadmapPath)) return [];
  let doc;
  try {
    doc = safeYamlParse(fs.readFileSync(roadmapPath, 'utf-8'), { kind: 'doctor-roadmap' });
  } catch {
    return [{
      id: 'roadmap-unreadable',
      severity: 'error',
      fixable: 'manual',
      details: { path: roadmapPath, hint: 'check roadmap.yaml syntax' },
    }];
  }
  if (!doc || !Array.isArray(doc.milestones)) return [];

  const issues = [];
  const milestonesRoot = path.join(stateDir, 'milestones');
  for (const m of doc.milestones) {
    if (!m || m.id === 'backlog') continue;
    const id = typeof m.id === 'string' ? m.id : null;
    if (!id || !/^M\d{3,}$/.test(id)) continue;
    const mDir = path.join(milestonesRoot, id);
    if (!fs.existsSync(mDir)) {
      issues.push({
        id: 'milestone-dir-missing',
        severity: 'warn',
        fixable: 'run-workflow',
        details: { milestone: id, expected: mDir, hint: 'run `/np:plan-phase ' + (m.number || '') + '` to scaffold it' },
      });
      continue;
    }
    const slicesDir = path.join(mDir, 'slices');
    if (!Array.isArray(m.slices) || m.slices.length === 0) continue;
    if (!fs.existsSync(slicesDir)) {
      issues.push({
        id: 'milestone-slices-dir-missing',
        severity: 'warn',
        fixable: 'run-workflow',
        details: { milestone: id, expected: slicesDir },
      });
    }
  }

  const phasesDir = path.join(stateDir, 'phases');
  if (fs.existsSync(phasesDir)) {
    issues.push({
      id: 'legacy-phases-dir',
      severity: 'info',
      fixable: 'manual',
      details: {
        path: phasesDir,
        hint: 'legacy v1 layout detected; safe to remove after /np:plan-phase has scaffolded milestones/',
      },
    });
  }
  return issues;
}

const NUBOSLOOP_CRITICS = [
  'np-critic',             // spawnable (sonnet)
  'np-critic-style',       // axis module (Style)
  'np-critic-tests',       // axis module (Tests)
  'np-critic-acceptance',  // axis module (Acceptance)
];

function _checkNubosloopCritics(projectRoot) {
  const issues = [];
  const scope = _readScope(projectRoot);
  const payloadDir = _payloadDirFor(projectRoot, scope);
  const agentsDir = path.join(payloadDir, 'agents');
  if (!fs.existsSync(agentsDir)) {
    issues.push({
      id: 'nubosloop-agents-dir-missing',
      severity: 'warn',
      fixable: 'reinstall',
      details: {
        expected: agentsDir,
        hint: 'run `npx nubos-pilot update` to refresh the payload (Critic-Schwarm agents ship as part of the payload).',
      },
    });
    return issues;
  }
  for (const agent of NUBOSLOOP_CRITICS) {
    const agentPath = path.join(agentsDir, agent + '.md');
    if (!fs.existsSync(agentPath)) {
      issues.push({
        id: 'nubosloop-critic-missing',
        severity: 'warn',
        fixable: 'reinstall',
        details: {
          agent,
          expected: agentPath,
          hint: 'run `npx nubos-pilot update` to refresh the payload.',
        },
      });
    }
  }
  return issues;
}

function _checkNubosloopKnowledgeStore(projectRoot) {
  const issues = [];
  const stateDir = path.join(projectRoot, '.nubos-pilot');
  if (!fs.existsSync(stateDir)) return issues;
  const learningsPath = path.join(stateDir, 'knowledge', 'learnings.json');
  if (!fs.existsSync(learningsPath)) {
    issues.push({
      id: 'nubosloop-knowledge-store-missing',
      severity: 'info',
      fixable: 'auto',
      details: {
        expected: learningsPath,
        hint: 'auto-created on first Nubosloop commit; safe to ignore on a fresh project.',
      },
    });
    return issues;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(learningsPath, 'utf-8'));
    const { STORE_VERSION } = require('../../lib/learnings.cjs');
    const { validate } = require('../../lib/validate.cjs');
    const isObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    let errors;
    if (isObject && parsed.version === STORE_VERSION) {
      errors = validate(parsed, 'learnings.v1');
    } else if (!isObject || !Array.isArray(parsed.learnings)) {
      errors = [{ message: 'expected JSON object with `version` and `learnings[]`' }];
    } else {
      errors = [];
    }
    if (errors.length) {
      issues.push({
        id: 'nubosloop-knowledge-store-corrupt',
        severity: 'warn',
        fixable: 'manual',
        details: {
          path: learningsPath,
          violations: errors.length,
          first: errors[0].message,
          hint: 'store violates the learnings.v1 schema; remove or restore from a backup.',
        },
      });
    }
  } catch (err) {
    issues.push({
      id: 'nubosloop-knowledge-store-corrupt',
      severity: 'warn',
      fixable: 'manual',
      details: { path: learningsPath, cause: err && err.message },
    });
  }
  return issues;
}

function _checkNubosloopConfig(projectRoot) {
  const issues = [];
  const { readConfig, _CONFIG_PARSE_CODES } = require('../../lib/config.cjs');
  let cfg;
  try {
    cfg = readConfig(projectRoot);
  } catch (err) {
    if (err && err.code === 'not-in-project') return issues;
    if (err && _CONFIG_PARSE_CODES.has(err.code)) {
      issues.push({
        id: 'config-json-corrupt',
        severity: 'error',
        fixable: 'manual',
        details: {
          code: err.code,
          message: err.message,
          file: err.details && err.details.file,
          hint: 'Repair or delete .nubos-pilot/config.json — the file is unparseable or has the wrong shape.',
        },
      });
      return issues;
    }
    throw err;
  }
  const swarm = cfg && cfg.swarm;
  const adapter = swarm && swarm.knowledge_adapter;
  if (adapter && adapter !== 'local') {
    issues.push({
      id: 'nubosloop-knowledge-adapter-invalid',
      severity: 'warn',
      fixable: 'manual',
      details: {
        value: adapter,
        supported: ['local'],
        hint: 'set swarm.knowledge_adapter to "local" — falls back to "local" silently otherwise.',
      },
    });
  }
  const loop = cfg && cfg.loop;
  if (loop && loop.maxRounds != null) {
    const n = Number(loop.maxRounds);
    if (!Number.isFinite(n) || n < 1 || n > 10) {
      issues.push({
        id: 'nubosloop-maxRounds-out-of-range',
        severity: 'warn',
        fixable: 'manual',
        details: { value: loop.maxRounds, expected_range: '[1, 10]' },
      });
    }
  }
  return issues;
}

function _checkOrphanTmpFiles(projectRoot) {
  const issues = [];
  const stateDir = path.join(projectRoot, '.nubos-pilot');
  const dirs = [
    stateDir,
    path.join(stateDir, 'checkpoints'),
    path.join(stateDir, 'knowledge'),
    path.join(stateDir, 'state'),
  ];
  const { sweepStaleTmpFiles } = require('../../lib/core.cjs');
  for (const d of dirs) {
    let result;
    try { result = sweepStaleTmpFiles(d, { olderThanMs: 60 * 60 * 1000 }); }
    catch { continue; }
    if (!result || !Array.isArray(result.swept) || result.swept.length === 0) continue;
    issues.push({
      id: 'orphan-tmp-files-cleaned',
      severity: 'info',
      fixable: 'auto',
      details: {
        dir: d,
        cleaned: result.swept.length,
        hint: 'Orphaned tmp files (>1h old) from a hard-killed process were swept.',
      },
    });
  }
  return issues;
}

function _checkOrphanCheckpoints(projectRoot) {
  const issues = [];
  const stateDir = path.join(projectRoot, STATE_SUBPATH);
  const cpDir = path.join(stateDir, 'checkpoints');
  if (!fs.existsSync(cpDir)) return issues;
  let entries;
  try { entries = fs.readdirSync(cpDir); } catch { return issues; }

  let currentTask = null;
  try {
    const statePath = path.join(stateDir, 'STATE.md');
    if (fs.existsSync(statePath)) {
      const { readState } = require('../../lib/state.cjs');
      const s = readState(projectRoot);
      currentTask = (s && s.frontmatter && s.frontmatter.current_task) || null;
    }
  } catch { /* state unreadable — treat as null current_task */ }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const taskId = name.slice(0, -5);
    const cpPath = path.join(cpDir, name);
    let cp;
    try { cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8')); }
    catch { continue; }
    if (!cp || cp.status !== 'in-progress') continue;
    if (currentTask === taskId) continue;
    issues.push({
      id: 'orphan-checkpoint',
      severity: 'warn',
      fixable: 'manual',
      details: {
        task_id: taskId,
        checkpoint: path.relative(projectRoot, cpPath),
        current_task: currentTask,
        hint: 'Checkpoint marks task as in-progress but STATE.md.current_task does not match. '
          + 'Likely a crash during finishTask between STATE-clear and checkpoint-unlink. '
          + 'Run `np-tools undo-task ' + taskId + '` to clean up, or delete manually after verifying the task is genuinely done.',
      },
    });
  }
  return issues;
}

function _checkOutputSchemas(projectRoot) {
  const issues = [];
  const milestonesRoot = path.join(projectRoot, STATE_SUBPATH, 'milestones');
  if (!fs.existsSync(milestonesRoot)) return issues;
  let entries;
  try { entries = fs.readdirSync(milestonesRoot, { withFileTypes: true }); }
  catch { return issues; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!/^M\d{3,}$/.test(ent.name)) continue;
    const mDir = path.join(milestonesRoot, ent.name);
    for (const suffix of ['-VERIFICATION.md', '-VALIDATION.md']) {
      const file = path.join(mDir, ent.name + suffix);
      if (!fs.existsSync(file)) continue;
      const schemaName = inferSchemaForFile(file);
      if (!schemaName) continue;
      let result;
      try {
        result = outputLint.lintFile(file, getSchema(schemaName));
      } catch (err) {
        issues.push({
          id: 'output-schema-lint-failed',
          severity: 'error',
          fixable: 'manual',
          details: { file, schema: schemaName, cause: err && err.message },
        });
        continue;
      }
      if (!result.ok) {
        issues.push({
          id: 'output-schema-violation',
          severity: 'error',
          fixable: 'manual',
          details: {
            file,
            schema: schemaName,
            violation_count: result.violations.length,
            violations: result.violations.slice(0, 10),
          },
        });
      }
    }
  }
  return issues;
}

function _audit(projectRoot) {
  const scope = _readScope(projectRoot);
  const payloadDir = _payloadDirFor(projectRoot, scope);
  const issues = [];
  const { manifest, issues: manifestIssues } = _checkManifestIntegrity(projectRoot, scope);
  issues.push(...manifestIssues);
  issues.push(..._checkVersionMismatch(manifest));
  issues.push(..._checkHooksMissing(manifest, payloadDir));
  const codex = _checkCodexTrappedFeatures();
  issues.push(...codex.issues);
  issues.push(..._checkAskUserBroken());
  issues.push(..._checkCodebaseDocs(projectRoot));
  issues.push(..._checkMilestoneLayout(projectRoot));
  issues.push(..._checkNubosloopCritics(projectRoot));
  issues.push(..._checkNubosloopKnowledgeStore(projectRoot));
  issues.push(..._checkNubosloopConfig(projectRoot));
  issues.push(..._checkOrphanTmpFiles(projectRoot));
  issues.push(..._checkOrphanCheckpoints(projectRoot));
  issues.push(..._checkOutputSchemas(projectRoot));
  return { issues, _codexContent: codex.content };
}

function _fixCodexTrappedFeatures(content) {
  const repaired = codexTomlMod.repairTrappedFeatures(content);
  if (repaired === content) return false;
  atomicWriteFileSync(CODEX_CONFIG_PATH, repaired);
  return true;
}

async function _applyFixes(issues, codexContent, askUser, stderr) {
  const applied = [];
  const skipped = [];
  for (const issue of issues) {
    if (issue.fixable === 'auto') {
      if (issue.id === 'codex-trapped-features' && codexContent != null) {
        try {
          const ok = _fixCodexTrappedFeatures(codexContent);
          if (ok) applied.push({ id: issue.id, fix: 'codex-trapped-features-repaired' });
          else skipped.push({ id: issue.id, reason: 'no-change' });
        } catch (err) {
          skipped.push({ id: issue.id, reason: 'fix-failed', cause: err && err.message });
        }
      } else {
        skipped.push({ id: issue.id, reason: 'no-auto-handler' });
      }
      continue;
    }
    if (issue.fixable === 'prompt') {
      const answer = await askUser({
        type: 'confirm',
        question: `Issue ${issue.id} gefunden — reparieren?`,
        default: true,
      });
      if (answer && answer.value) {
        applied.push({ id: issue.id, fix: 'user-confirmed' });
      } else {
        skipped.push({ id: issue.id, reason: 'user-declined' });
      }
      continue;
    }
    if (issue.fixable === 'reinstall') {
      try { stderr.write(`[doctor] ${issue.id}: Run \`npx nubos-pilot\` to reinstall.\n`); } catch {}
      skipped.push({ id: issue.id, reason: 'requires-reinstall' });
      continue;
    }
    if (issue.fixable === 'run-workflow') {
      const hint = (issue.details && issue.details.hint) || 'run the suggested np workflow';
      try { stderr.write(`[doctor] ${issue.id}: ${hint}.\n`); } catch {}
      skipped.push({ id: issue.id, reason: 'requires-workflow' });
      continue;
    }
    skipped.push({ id: issue.id, reason: 'not-fixable' });
  }
  return { applied, skipped };
}

async function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const askUser = typeof context.askUser === 'function'
    ? context.askUser
    : askuserMod.askUser;
  const list = Array.isArray(args) ? args : [];
  const doFix = list.includes('--fix');

  const audit = _audit(cwd);
  const payload = { issues: audit.issues };

  if (doFix && audit.issues.length > 0) {
    const { applied, skipped } = await _applyFixes(
      audit.issues,
      audit._codexContent,
      askUser,
      stderr,
    );
    payload.applied = applied;
    payload.skipped = skipped;
  }

  try { stdout.write(JSON.stringify(payload)); } catch (err) {
    throw new NubosPilotError('doctor-emit-failed', err && err.message, {});
  }
  return payload;
}

module.exports = { run };
