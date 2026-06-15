'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { emitInitPayload } = require('../../lib/init-emit.cjs');
const archive = require('../../lib/archive.cjs');
const textMode = require('../../lib/text-mode.cjs');

function _initPayload(cwd) {
  const completion = archive.computeCompletionStatus(cwd);
  const tmDetail = textMode.resolveTextModeDetail(cwd);
  return {
    _workflow: 'close-project',
    cwd,
    project_exists: archive.projectExists(cwd),
    completion,
    summary_path: archive.projectSummaryPath(cwd),
    text_mode: tmDetail.enabled,
    text_mode_source: tmDetail.source,
  };
}

function _emitSummary(cwd) {
  return archive.writeProjectSummary(cwd);
}

function _mark(cwd) {
  return archive.setProjectStatus(cwd, 'completed');
}

function _unmark(cwd) {
  return archive.setProjectStatus(cwd, 'active');
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const verb = list[0];

  switch (verb) {
    case 'init':
    case undefined: {
      const payload = _initPayload(cwd);
      emitInitPayload(payload, stdout, cwd, 'close-project');
      return payload;
    }
    case 'check': {
      const payload = archive.computeCompletionStatus(cwd);
      stdout.write(JSON.stringify(payload, null, 2));
      return payload;
    }
    case 'write-summary': {
      const result = _emitSummary(cwd);
      stdout.write(JSON.stringify(result));
      return result;
    }
    case 'mark-completed': {
      const result = _mark(cwd);
      stdout.write(JSON.stringify(result));
      return result;
    }
    case 'unmark': {
      const result = _unmark(cwd);
      stdout.write(JSON.stringify(result));
      return result;
    }
    default:
      throw new NubosPilotError(
        'close-project-unknown-verb',
        'close-project: unknown verb: ' + String(verb),
        { verb },
      );
  }
}

module.exports = { run };
