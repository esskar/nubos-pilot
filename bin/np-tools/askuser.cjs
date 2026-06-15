const { askUser } = require('../../lib/askuser.cjs');
const { emitErrorEnvelope } = require('./_args.cjs');

function _usage() {
  return 'Usage:\n  np-tools.cjs askuser --json \'{...spec...}\'';
}

async function run(argv, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];
  const idx = args.indexOf('--json');
  if (idx < 0 || idx + 1 >= args.length) {
    stderr.write(_usage() + '\n');
    return 1;
  }
  let spec;
  try {
    spec = JSON.parse(args[idx + 1]);
  } catch (err) {
    stderr.write(JSON.stringify({ code: 'askuser-invalid-json', message: err.message, details: null }) + '\n');
    return 1;
  }
  try {
    const result = await askUser(spec);
    const value = result && typeof result === 'object' && 'value' in result ? result.value : result;
    let out;
    if (value == null) out = '';
    else if (typeof value === 'string') out = value;
    else out = JSON.stringify(value);
    stdout.write(out + '\n');
    return 0;
  } catch (err) {
    emitErrorEnvelope(err, stderr, 'askuser-internal-error');
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(String((err && err.stack) || err) + '\n');
    process.exit(1);
  });
}
