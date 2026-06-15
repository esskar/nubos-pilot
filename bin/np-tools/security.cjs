'use strict';

const fs = require('node:fs');
const path = require('node:path');
const child_process = require('node:child_process');

const { tryReadConfigPath } = require('../../lib/config.cjs');
const scan = require('../../lib/security/scan.cjs');
const ledger = require('../../lib/security/ledger.cjs');
const review = require('../../lib/security/review.cjs');
const headlessGuard = require('../../lib/headless-guard.cjs');
const args = require('./_args.cjs');

const COMMIT_RE = /\bgit\b[\s\S]*\b(commit|push)\b/;

function _readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    process.stdin.setEncoding('utf-8');
    const timer = setTimeout(() => { try { process.stdin.removeAllListeners(); } catch {} resolve(buf); }, 800);
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(buf); });
  });
}

function _safeParse(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; }}

async function _payload(argv) {
  const inline = args.getFlag(argv, '--payload', { allowDashValues: true });
  if (inline !== undefined) return _safeParse(inline);
  if (argv.includes('--stdin')) return _safeParse(await _readStdin());
  return {};
}

function _cfg(cwd) {
  return {
    enabled: tryReadConfigPath(cwd, 'security.enabled', true) !== false,
    scan_on_write: tryReadConfigPath(cwd, 'security.scan_on_write', true) !== false,
    review_on_stop: tryReadConfigPath(cwd, 'security.review_on_stop', true) !== false,
    review_on_commit: tryReadConfigPath(cwd, 'security.review_on_commit', true) !== false,
    custom_rules_path: tryReadConfigPath(cwd, 'security.custom_rules_path', null),
    guidance_path: tryReadConfigPath(cwd, 'security.guidance_path', null),
    review_timeout_ms: Number(tryReadConfigPath(cwd, 'security.review_timeout_ms', 180000)) || 180000,
    max_stop_reviews_in_a_row: Number(tryReadConfigPath(cwd, 'security.max_stop_reviews_in_a_row', 3)) || 3,
    max_commit_reviews_per_hour: Number(tryReadConfigPath(cwd, 'security.max_commit_reviews_per_hour', 20)) || 20,
    max_files_per_review: Number(tryReadConfigPath(cwd, 'security.max_files_per_review', 30)) || 30,
  };
}

function _resolveRel(cwd, p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

function _editedContent(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (typeof toolInput.content === 'string') return toolInput.content;
  if (typeof toolInput.new_string === 'string') return toolInput.new_string;
  if (typeof toolInput.new_source === 'string') return toolInput.new_source;
  if (Array.isArray(toolInput.edits)) {
    return toolInput.edits.map((e) => (e && typeof e.new_string === 'string' ? e.new_string : '')).join('\n');
  }
  return '';
}

function _editedPath(cwd, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const raw = toolInput.file_path || toolInput.notebook_path || '';
  if (!raw) return '';
  return path.isAbsolute(raw) ? path.relative(cwd, raw) : raw;
}

function _spawnWorker(cwd, sid, mode) {
  const npTools = path.join(__dirname, '..', '..', 'np-tools.cjs');
  try {
    const child = child_process.spawn(
      process.execPath,
      [npTools, 'security', 'run-review', '--session', sid, '--mode', mode],
      { cwd, detached: true, stdio: 'ignore' },
    );
    child.unref();
    return true;
  } catch { return false; }
}

function _emit(stdout, obj) { stdout.write(JSON.stringify(obj)); }

async function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];
  const verb = list[0];

  if (headlessGuard.isHeadless(process.env)) return 0;

  const cfg = _cfg(cwd);
  if (!cfg.enabled && verb !== 'run-review') return 0;

  const payload = await _payload(list);
  const sid = payload.session_id || args.getFlag(list, '--session') || '';

  if (verb === 'session-start') {
    if (sid) { try { ledger.initSession(sid); } catch {} }
    return 0;
  }

  if (verb === 'baseline') {
    if (sid) {
      try { ledger.setBaseline(sid, { head: review.headSha(cwd) }); } catch {}
    }
    return 0;
  }

  if (verb === 'scan') {
    if (!cfg.scan_on_write || !sid) return 0;
    const filePath = _editedPath(cwd, payload.tool_input);
    const content = _editedContent(payload.tool_input);
    if (!filePath || !content) return 0;
    let result;
    try {
      result = scan.scanContent({ filePath, content, customRulesPath: _resolveRel(cwd, cfg.custom_rules_path) });
    } catch { return 0; }
    let fresh;
    try { fresh = ledger.markScanReported(sid, result.findings); } catch { fresh = result.findings; }
    if (!fresh.length) return 0;
    const lines = fresh.map((f) => '- [' + f.category + '] ' + path.basename(f.file) + ':' + f.line + ' — ' + f.reminder);
    _emit(stdout, {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: '[nubos-pilot security] potential issue(s) in just-written code:\n' + lines.join('\n')
          + '\nConsider addressing before proceeding (non-blocking).',
      },
    });
    return 0;
  }

  if (verb === 'review') {
    if (!cfg.review_on_stop || !sid) return 0;
    let harvest = { findings: [] };
    try { harvest = ledger.takeUnsurfacedRisks(sid, { maxStreak: cfg.max_stop_reviews_in_a_row }); } catch {}
    if (harvest.findings && harvest.findings.length) {
      const lines = harvest.findings.map((f) => '- [' + (f.category || 'security') + '] '
        + (f.file ? path.basename(String(f.file)) + (f.line ? ':' + f.line : '') + ' — ' : '')
        + (f.title || 'security finding') + (f.mitigation_hint ? ' (' + f.mitigation_hint + ')' : ''));
      _emit(stdout, {
        decision: 'block',
        reason: '[nubos-pilot security] An independent review of this turn\'s changes found '
          + harvest.findings.length + ' security issue(s). Address them now as a follow-up, then continue:\n'
          + lines.join('\n'),
      });
      return 0;
    }
    _spawnWorker(cwd, sid, 'stop');
    return 0;
  }

  if (verb === 'commit') {
    if (!cfg.review_on_commit || !sid) return 0;
    const cmd = payload.tool_input && typeof payload.tool_input.command === 'string' ? payload.tool_input.command : '';
    if (!cmd || !COMMIT_RE.test(cmd)) return 0;
    let allowed = { allowed: false };
    try { allowed = ledger.tryRecordCommitReview(sid, { maxPerHour: cfg.max_commit_reviews_per_hour }); } catch {}
    if (allowed.allowed) _spawnWorker(cwd, sid, 'commit');
    return 0;
  }

  if (verb === 'run-review') {
    if (!cfg.enabled || !sid) return 0;
    const mode = args.getFlag(list, '--mode') === 'commit' ? 'commit' : 'stop';
    try { review.runReview({ cwd, sid, mode, config: { ...cfg, guidance_path: _resolveRel(cwd, cfg.guidance_path) } }); } catch {}
    return 0;
  }

  return 0;
}

module.exports = { run, COMMIT_RE, _editedContent, _editedPath };
