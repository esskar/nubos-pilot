'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanContent, loadCustomRules, _globToRegExp, _looksCatastrophic } = require('./scan.cjs');

function cats(findings) {
  return new Set(findings.map((f) => f.category));
}

test('SCAN-1 each built-in category triggers on representative content', () => {
  const samples = {
    'dynamic-exec': 'const r = eval(userInput);',
    'unsafe-deserialization': 'data = pickle.loads(blob)',
    'dom-injection': 'el.innerHTML = userInput;',
    'hardcoded-secret': 'const key = "-----BEGIN PRIVATE KEY-----";',
  };
  for (const [category, content] of Object.entries(samples)) {
    const { findings } = scanContent({ filePath: 'src/x.js', content });
    assert.ok(cats(findings).has(category), category + ' should trigger; got ' + [...cats(findings)].join(','));
  }
});

test('SCAN-2 workflow-file is path-only and fires regardless of content', () => {
  const { findings } = scanContent({ filePath: '.github/workflows/deploy.yml', content: 'name: ci' });
  assert.ok(findings.some((f) => f.category === 'workflow-file'));
});

test('SCAN-3 clean code produces no findings (no false positives)', () => {
  const content = [
    'function add(a, b) {',
    '  return a + b;',
    '}',
    'const greeting = "hello world";',
    'el.textContent = greeting;',
  ].join('\n');
  const { findings } = scanContent({ filePath: 'src/util.js', content });
  assert.deepEqual(findings, []);
});

test('SCAN-4 finding carries the first matching line number', () => {
  const content = 'line one\nline two\nconst r = eval(x);\n';
  const { findings } = scanContent({ filePath: 'a.js', content });
  const evalFinding = findings.find((f) => f.rule_name === 'eval_call');
  assert.equal(evalFinding.line, 3);
});

test('SCAN-5 custom rules augment built-ins (both present)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-scan-'));
  const rulesFile = path.join(dir, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({
    patterns: [{
      rule_name: 'tenant_unfiltered_query',
      category: 'multi-tenant',
      severity: 'risk',
      regex: '\\.objects\\.all\\(\\)',
      reminder: 'Filter by org_id.',
    }],
  }));
  try {
    const content = 'q = Model.objects.all()\nr = eval(z)';
    const { findings } = scanContent({ filePath: 'src/tenants/x.py', content, customRulesPath: rulesFile });
    assert.ok(findings.some((f) => f.rule_name === 'tenant_unfiltered_query'), 'custom rule fires');
    assert.ok(findings.some((f) => f.rule_name === 'eval_call'), 'built-in still fires');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCAN-6 custom rule paths scope limits where it applies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-scan-'));
  const rulesFile = path.join(dir, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({
    patterns: [{
      rule_name: 'tenant_unfiltered_query',
      regex: '\\.objects\\.all\\(\\)',
      paths: ['**/src/tenants/**'],
      reminder: 'scoped',
    }],
  }));
  try {
    const content = 'q = Model.objects.all()';
    const inScope = scanContent({ filePath: 'src/tenants/a.py', content, customRulesPath: rulesFile });
    const outScope = scanContent({ filePath: 'src/public/a.py', content, customRulesPath: rulesFile });
    assert.ok(inScope.findings.some((f) => f.rule_name === 'tenant_unfiltered_query'));
    assert.ok(!outScope.findings.some((f) => f.rule_name === 'tenant_unfiltered_query'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCAN-7 catastrophic regex in custom rule is skipped, not loaded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-scan-'));
  const rulesFile = path.join(dir, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({
    patterns: [{ rule_name: 'evil', regex: '(a+)+$', reminder: 'x' }],
  }));
  try {
    const { rules, skipped } = loadCustomRules(rulesFile);
    assert.equal(rules.length, 0);
    assert.ok(skipped.some((s) => s.reason === 'catastrophic-regex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCAN-8 custom rule cap at 50 enforced with diagnostic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-scan-'));
  const rulesFile = path.join(dir, 'rules.json');
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ rule_name: 'r' + i, substrings: ['ZZZ' + i], reminder: 'x' });
  fs.writeFileSync(rulesFile, JSON.stringify({ patterns: many }));
  try {
    const { rules, skipped } = loadCustomRules(rulesFile);
    assert.equal(rules.length, 50);
    assert.ok(skipped.some((s) => s.reason === 'rule-cap-exceeded'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCAN-9 missing custom rules path is a no-op (additive, resilient)', () => {
  const { rules, skipped } = loadCustomRules(null);
  assert.deepEqual(rules, []);
  assert.deepEqual(skipped, []);
});

test('SCAN-10 glob and catastrophic helpers behave', () => {
  assert.ok(_globToRegExp('**/src/tenants/**').test('app/src/tenants/x.py'));
  assert.ok(!_globToRegExp('**/src/tenants/**').test('app/src/public/x.py'));
  assert.ok(_looksCatastrophic('(.*)*'));
  assert.ok(!_looksCatastrophic('\\beval\\s*\\('));
});
