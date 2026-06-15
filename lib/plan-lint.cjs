'use strict';


const fs = require('node:fs');
const path = require('node:path');
const { extractFrontmatter } = require('./frontmatter.cjs');


const POSIX_BASELINE = Object.freeze(new Set([
  'true', 'false', 'echo', 'printf', 'test', '[', '[[',
  'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk',
  'grep', 'egrep', 'fgrep', 'find', 'xargs',
  'ls', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln', 'touch', 'chmod', 'chown',
  'pwd', 'cd', 'set', 'unset', 'export', 'source', '.', 'eval', 'exit',
  'diff', 'patch', 'tar', 'gzip', 'gunzip', 'zip', 'unzip',
  'env', 'sleep', 'date', 'time', 'which', 'type',
]));

const INTERPRETER_PREFIXES = Object.freeze(new Set([
  'node', 'npx', 'pnpm', 'yarn', 'npm', 'bun', 'bunx',
  'php', 'composer', 'python', 'python3', 'pipx', 'uv', 'poetry',
  'ruby', 'bundle', 'go',
]));

const WORKING_TREE_READERS = Object.freeze([
  /\bupdate-docs\b/i,
  /\bgit\s+(diff|status|ls-files|log)/i,
  /\bfind\s+\S+\s+-newer\b/i,
  /\bpre-commit\s+run\b/i,
  /\bphpstan\s+analyse\b/i,        // reads source files across the project
  /\bpint\b/i,                       // reads + may rewrite source files
  /\beslint\b/i,
  /\btsc\b/i,                        // reads tsconfig + project files
]);


function _readJsonSafe(filepath) {
  try {
    if (!fs.existsSync(filepath)) return null;
    const raw = fs.readFileSync(filepath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function _resolveKnownVerbs(opts) {
  if (Array.isArray(opts && opts.knownVerbs)) return new Set(opts.knownVerbs);
  try {
    const cmds = require('../bin/np-tools/_commands.cjs');
    if (Array.isArray(cmds.COMMANDS)) {
      return new Set(cmds.COMMANDS.map((c) => c.name));
    }
  } catch {}
  return new Set();
}

function _resolveScripts(cwd) {
  const composer = _readJsonSafe(path.join(cwd, 'composer.json'));
  const npm      = _readJsonSafe(path.join(cwd, 'package.json'));
  return {
    composer: composer && composer.scripts && typeof composer.scripts === 'object'
      ? new Set(Object.keys(composer.scripts)) : new Set(),
    npm: npm && npm.scripts && typeof npm.scripts === 'object'
      ? new Set(Object.keys(npm.scripts)) : new Set(),
  };
}

function _binaryExists(cwd, relPath) {
  try { return fs.existsSync(path.join(cwd, relPath)); }
  catch { return false; }
}

function _firstCommand(line) {
  const stripped = String(line || '').trim();
  if (!stripped) return null;
  if (stripped.startsWith('#')) return null;
  const head = stripped.split(/[;|&]+/)[0].trim();
  if (!head) return null;
  const tokens = head.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return null;
  return { command: tokens[i], rest: tokens.slice(i + 1), full: head };
}

function _extractVerifyBlocks(body) {
  const out = [];
  const matches = String(body || '').matchAll(/<verify>([\s\S]*?)<\/verify>/g);
  for (const m of matches) {
    out.push({ start: m.index, body: m[1] });
  }
  return out;
}


function _validateCommand(cmd, ctx) {
  const { command, rest, full } = cmd;
  if (POSIX_BASELINE.has(command)) return { ok: true };
  if (INTERPRETER_PREFIXES.has(command)) {
    return _validateInterpreterCall(command, rest, full, ctx);
  }
  if (command.includes('/') || command.startsWith('./') || command.startsWith('../')) {
    if (_binaryExists(ctx.cwd, command)) return { ok: true };
    if (/^(\.\/)?(vendor\/bin|node_modules\/\.bin|bin|scripts)\//.test(command)) {
      return { ok: true, hint: 'binary not present at lint-time but path is conventional' };
    }
    return { ok: false, reason: 'path-not-found',
      hint: 'verify path "' + command + '" does not exist; check the project layout' };
  }
  return { ok: true, hint: 'bareword command "' + command + '" assumed PATH-resolved' };
}

function _validateInterpreterCall(interp, rest, full, ctx) {
  if (interp === 'node' && rest.length >= 1) {
    const target = rest[0];
    if (/np-tools\.cjs$/.test(target)) {
      const verb = rest[1];
      if (!verb || verb.startsWith('-')) {
        return { ok: false, reason: 'np-tools-missing-verb',
          hint: 'np-tools.cjs requires a verb as second argument' };
      }
      if (!ctx.knownVerbs.has(verb)) {
        return { ok: false, reason: 'np-tools-unknown-verb',
          hint: 'verb "' + verb + '" is not a registered np-tools command (see _commands.cjs)' };
      }
      return { ok: true };
    }
    if (/\.(c?js|mjs)$/.test(target)) {
      if (_binaryExists(ctx.cwd, target)) return { ok: true };
      return { ok: false, reason: 'node-script-not-found',
        hint: 'node script "' + target + '" not found at lint-time' };
    }
    return { ok: true }; // node -e "..." or other forms
  }
  if (interp === 'npm' || interp === 'pnpm' || interp === 'yarn') {
    let i = 0;
    if (rest[i] === 'run' || rest[i] === 'run-script' || rest[i] === 'exec') i++;
    const script = rest[i];
    if (!script || script.startsWith('-')) return { ok: true }; // npm install etc.
    if (ctx.scripts.npm.has(script)) return { ok: true };
    if (['install', 'ci', 'test', 'audit', 'update', 'outdated'].includes(script)) {
      return { ok: true };
    }
    return { ok: false, reason: 'npm-script-not-declared',
      hint: '"' + script + '" is not declared in package.json scripts' };
  }
  if (interp === 'composer') {
    const script = rest[0];
    if (!script || script.startsWith('-')) return { ok: true };
    if (ctx.scripts.composer.has(script)) return { ok: true };
    const builtin = new Set([
      'install', 'update', 'require', 'remove', 'dump-autoload', 'dumpautoload',
      'show', 'why', 'depends', 'why-not', 'audit', 'check-platform-reqs',
      'create-project', 'init', 'self-update', 'about', 'archive', 'browse',
      'clear-cache', 'clearcache', 'config', 'diagnose', 'exec', 'fund',
      'global', 'home', 'licenses', 'list', 'outdated', 'prohibits', 'reinstall',
      'run-script', 'run', 'search', 'status', 'suggests', 'validate',
    ]);
    if (builtin.has(script)) return { ok: true };
    return { ok: false, reason: 'composer-script-not-declared',
      hint: '"' + script + '" is neither a composer builtin nor declared in composer.json scripts' };
  }
  if (interp === 'npx' || interp === 'bunx' || interp === 'pnpx') return { ok: true };
  if (interp === 'php') return { ok: true };
  if (['ruby', 'python', 'python3', 'go', 'bun'].includes(interp)) return { ok: true };
  if (interp === 'bundle') return { ok: true };
  return { ok: true };
}

function lintVerifyCommands(planBody, opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const ctx = {
    cwd,
    knownVerbs: _resolveKnownVerbs(opts),
    scripts: _resolveScripts(cwd),
  };
  const findings = [];
  const blocks = _extractVerifyBlocks(planBody || '');
  for (const block of blocks) {
    const lines = block.body.split(/\r?\n/);
    for (const line of lines) {
      const cmd = _firstCommand(line);
      if (!cmd) continue;
      const verdict = _validateCommand(cmd, ctx);
      if (!verdict.ok) {
        findings.push({
          category: 'verify-command-unknown',
          severity: 'critical',
          target: '<verify> block',
          message: '`' + cmd.full + '` — ' + (verdict.hint || verdict.reason || 'unknown command'),
          hint: verdict.hint || null,
          raw: { reason: verdict.reason, command: cmd.command, line },
        });
      }
    }
  }
  return findings;
}


function _verifyReadsWorkingTree(verifyText) {
  const t = String(verifyText || '');
  for (const re of WORKING_TREE_READERS) {
    if (re.test(t)) return true;
  }
  return false;
}

function lintParallelTaskRaces(tasks) {
  const findings = [];
  const groups = new Map();
  for (const t of tasks || []) {
    const key = t.slice || '__default__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const parallel = group.filter((t) => {
      const d = t.depends_on;
      return !Array.isArray(d) || d.length === 0;
    });
    if (parallel.length < 2) continue;
    for (const a of parallel) {
      if (!_verifyReadsWorkingTree(a.verifyText)) continue;
      const conflicts = parallel.filter(
        (b) => b.id !== a.id
          && Array.isArray(b.files_modified)
          && b.files_modified.length > 0,
      );
      if (conflicts.length === 0) continue;
      findings.push({
        category: 'parallel-task-implicit-dependency',
        severity: 'critical',
        target: a.id,
        message: 'task ' + a.id + ' is marked parallel (depends_on:[]) but its <verify> reads the working tree, ' +
          'creating an implicit ordering against sibling task(s) that modify files: ' +
          conflicts.map((c) => c.id).join(', '),
        hint: 'set depends_on to [' + conflicts.map((c) => '"' + c.id + '"').join(', ') + '] OR ' +
          'replace the working-tree-reading verify with a stateless check',
        raw: { task: a.id, conflicts: conflicts.map((c) => c.id) },
      });
    }
  }
  return findings;
}


const OVER_SPECIFICATION_SIGNALS = [
  {
    name: 'schema-ddl',
    re: /^(\s*)?(CREATE\s+TABLE|ALTER\s+(TABLE|COLUMN)|Schema::(create|table)|->\s*(string|integer|bigInteger|foreignId|timestamp)\s*\()/im,
    hint: 'schema DDL belongs to the executor — the plan describes intent (e.g. "subscriptions table with columns the framework dictates"), not exact column shape',
  },
  {
    name: 'framework-timestamped-filename',
    re: /\b\d{4}_\d{2}_\d{2}_\d{6}_[a-z_]+\.php\b/,
    hint: 'framework-controlled migration filenames are publish-time output, not plan input — use a glob pattern in files_modified',
  },
  {
    name: 'inline-code-snippet',
    re: /```(?:[a-z]+)?\n[\s\S]{200,}\n```/,
    hint: 'large code blocks in PLAN.md push implementation into the planner — describe what the code must achieve, let the executor write it',
  },
];

function lintOverSpecification(planBody) {
  const findings = [];
  const body = String(planBody || '');
  for (const sig of OVER_SPECIFICATION_SIGNALS) {
    const m = body.match(sig.re);
    if (m) {
      findings.push({
        category: 'plan-over-specifies-implementation',
        severity: 'major',
        target: 'PLAN.md body',
        message: 'over-specification signal: ' + sig.name + ' (matched: ' +
          String(m[0]).replace(/\s+/g, ' ').slice(0, 80) + ')',
        hint: sig.hint,
        raw: { signal: sig.name, snippet: String(m[0]).slice(0, 200) },
      });
    }
  }
  return findings;
}


function lintPlan(planBody, opts) {
  const raw = (opts && typeof opts.raw === 'string') ? opts.raw : planBody;
  return [
    ...lintVerifyCommands(planBody, opts),
    ...lintOverSpecification(raw),
  ];
}

function lintTaskFile(planMdPath, opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const raw = fs.readFileSync(planMdPath, 'utf-8');
  const { frontmatter, body } = extractFrontmatter(raw);
  return {
    path: planMdPath,
    frontmatter: frontmatter || {},
    findings: lintPlan(body, { ...opts, cwd, raw }),
  };
}

module.exports = {
  lintVerifyCommands,
  lintParallelTaskRaces,
  lintOverSpecification,
  lintPlan,
  lintTaskFile,
  POSIX_BASELINE,
  INTERPRETER_PREFIXES,
  WORKING_TREE_READERS,
};
