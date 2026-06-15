'use strict';


const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, findProjectRoot } = require('../../lib/core.cjs');
const { extractFrontmatter } = require('../../lib/frontmatter.cjs');
const planLint = require('../../lib/plan-lint.cjs');
const args = require('./_args.cjs');

const MILESTONE_RE = /^M\d{3,}$/;

function _walkMilestonePlans(milestoneDir) {
  const out = [];
  if (!fs.existsSync(milestoneDir)) return out;
  const mPlan = fs.readdirSync(milestoneDir)
    .filter((f) => /^M\d{3,}-PLAN\.md$/.test(f))
    .map((f) => path.join(milestoneDir, f));
  out.push(...mPlan);
  const slicesDir = path.join(milestoneDir, 'slices');
  if (fs.existsSync(slicesDir)) {
    const slices = fs.readdirSync(slicesDir).filter((d) => /^S\d{3,}$/.test(d)).sort();
    for (const sId of slices) {
      const sDir = path.join(slicesDir, sId);
      for (const f of fs.readdirSync(sDir)) {
        if (/^S\d{3,}-PLAN\.md$/.test(f)) out.push(path.join(sDir, f));
      }
      const tasksDir = path.join(sDir, 'tasks');
      if (!fs.existsSync(tasksDir)) continue;
      const tasks = fs.readdirSync(tasksDir).filter((d) => /^T\d{4,}$/.test(d)).sort();
      for (const tId of tasks) {
        const tDir = path.join(tasksDir, tId);
        for (const f of fs.readdirSync(tDir)) {
          if (/^T\d{4,}-PLAN\.md$/.test(f)) out.push(path.join(tDir, f));
        }
      }
    }
  }
  return out;
}

function _sliceTaskCollect(milestoneDir) {
  const out = []; // [{ slice, tasks: [{id, files_modified, depends_on, verifyText}] }]
  const slicesDir = path.join(milestoneDir, 'slices');
  if (!fs.existsSync(slicesDir)) return out;
  const slices = fs.readdirSync(slicesDir).filter((d) => /^S\d{3,}$/.test(d)).sort();
  for (const sId of slices) {
    const tasksDir = path.join(slicesDir, sId, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;
    const tasks = fs.readdirSync(tasksDir).filter((d) => /^T\d{4,}$/.test(d)).sort();
    const collected = [];
    for (const tId of tasks) {
      const taskDir = path.join(tasksDir, tId);
      const planFile = fs.readdirSync(taskDir).find((f) => /^T\d{4,}-PLAN\.md$/.test(f));
      if (!planFile) continue;
      const raw = fs.readFileSync(path.join(taskDir, planFile), 'utf-8');
      const { frontmatter, body } = extractFrontmatter(raw);
      const verifyMatch = String(body || '').match(/<verify>([\s\S]*?)<\/verify>/);
      collected.push({
        id: (frontmatter && frontmatter.id) || tId,
        files_modified: (frontmatter && Array.isArray(frontmatter.files_modified))
          ? frontmatter.files_modified : [],
        depends_on: (frontmatter && Array.isArray(frontmatter.depends_on))
          ? frontmatter.depends_on : [],
        verifyText: verifyMatch ? verifyMatch[1] : '',
        slice: sId,
      });
    }
    if (collected.length) out.push({ slice: sId, tasks: collected });
  }
  return out;
}

function _summarize(filesResult, raceFindings) {
  const counts = { critical: 0, major: 0, minor: 0, total: 0 };
  for (const f of filesResult) {
    for (const finding of f.findings) {
      counts.total += 1;
      counts[finding.severity || 'minor'] = (counts[finding.severity || 'minor'] || 0) + 1;
    }
  }
  for (const finding of raceFindings) {
    counts.total += 1;
    counts[finding.severity || 'minor'] = (counts[finding.severity || 'minor'] || 0) + 1;
  }
  return counts;
}

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];

  const milestoneFlag = args.getFlag(list, '--milestone');
  const positional = list.filter((a) => !String(a).startsWith('--'));
  const targetPath = positional[0];

  let filePaths = [];
  let raceInputs = [];

  if (milestoneFlag) {
    if (!MILESTONE_RE.test(milestoneFlag)) {
      throw new NubosPilotError(
        'plan-lint-invalid-milestone',
        '--milestone expects M<NNN> form (e.g. M004)',
        { got: milestoneFlag },
      );
    }
    const root = findProjectRoot(cwd);
    const mDir = path.join(root, '.nubos-pilot', 'milestones', milestoneFlag);
    if (!fs.existsSync(mDir)) {
      throw new NubosPilotError(
        'plan-lint-milestone-not-found',
        'milestone directory does not exist: ' + mDir,
        { milestone: milestoneFlag, path: mDir },
      );
    }
    filePaths = _walkMilestonePlans(mDir);
    raceInputs = _sliceTaskCollect(mDir);
  } else if (targetPath) {
    const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
    if (!fs.existsSync(abs)) {
      throw new NubosPilotError(
        'plan-lint-file-not-found',
        'plan file not found: ' + targetPath,
        { path: abs },
      );
    }
    filePaths = [abs];
  } else {
    throw new NubosPilotError(
      'plan-lint-missing-target',
      'plan-lint requires a path argument OR --milestone <M<NNN>>',
      { hint: 'examples: `plan-lint M004-S001-PLAN.md` or `plan-lint --milestone M004`' },
    );
  }

  const filesResult = filePaths.map((p) => {
    const raw = fs.readFileSync(p, 'utf-8');
    const { body } = extractFrontmatter(raw);
    return {
      path: path.relative(cwd, p),
      findings: planLint.lintPlan(body, { cwd, raw }),
    };
  });

  let raceFindings = [];
  for (const group of raceInputs) {
    raceFindings.push(...planLint.lintParallelTaskRaces(group.tasks));
  }

  const summary = _summarize(filesResult, raceFindings);
  const payload = {
    target: milestoneFlag || (positional[0] || null),
    summary,
    files: filesResult,
    parallel_race_findings: raceFindings,
  };
  stdout.write(JSON.stringify(payload, null, 2) + '\n');
  return summary.critical > 0 ? 2 : 0;
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
