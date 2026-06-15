'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const learnings = require('./learnings.cjs');

function _mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-learn-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  return root;
}

test('LRN-1: empty store match returns null/empty', () => {
  const r = _mkRoot();
  try {
    const res = learnings.matchExistingLearning('anything', r);
    assert.deepEqual(res.hits, []);
    assert.equal(res.best, null);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('LRN-2: logLearning persists with occurrence=1, fingerprint, timestamps', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning(
      { pattern: 'use jose@6.0.10 for JWT verification', outcome: 'verified working in M001' },
      r,
    );
    const list = learnings.listLearnings(r);
    assert.equal(list.length, 1);
    assert.equal(list[0].occurrence, 1);
    assert.match(list[0].fingerprint, /^[a-f0-9]{16}$/);
    assert.ok(list[0].first_seen);
    assert.equal(list[0].first_seen, list[0].last_seen);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('LRN-3: same pattern logged twice → occurrence=2, last_seen updated, task_ids merged', async () => {
  const r = _mkRoot();
  try {
    learnings.logLearning(
      { pattern: 'use jose@6.0.10 for JWT verification', outcome: 'verified', task_id: 'M001-S001-T0001' },
      r,
    );
    await new Promise((res) => setTimeout(res, 5));
    learnings.logLearning(
      { pattern: 'use jose@6.0.10 for JWT verification', outcome: 'still works', task_id: 'M002-S003-T0007' },
      r,
    );
    const list = learnings.listLearnings(r);
    assert.equal(list.length, 1);
    assert.equal(list[0].occurrence, 2);
    assert.equal(list[0].outcome, 'still works');
    assert.deepEqual(list[0].task_ids.slice().sort(), ['M001-S001-T0001', 'M002-S003-T0007']);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('LRN-4: different patterns produce different fingerprints', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'use jose for jwt', outcome: 'ok' }, r);
    learnings.logLearning({ pattern: 'use argon2id for password hashing', outcome: 'ok' }, r);
    const list = learnings.listLearnings(r);
    assert.equal(list.length, 2);
    assert.notEqual(list[0].fingerprint, list[1].fingerprint);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('LRN-5: matchExistingLearning returns hit when similarity ≥ threshold AND occurrence ≥ min', () => {
  const r = _mkRoot();
  try {
    for (let i = 0; i < 3; i += 1) {
      learnings.logLearning({ pattern: 'use jose@6.0.10 for JWT verification', outcome: 'ok' }, r);
    }
    const res = learnings.matchExistingLearning('jose JWT verification', r, { threshold: 0.4, minOccurrence: 3 });
    assert.ok(res.best, 'expected a hit');
    assert.ok(res.best.similarity >= 0.4);
    assert.equal(res.best.occurrence, 3);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('LRN-6: high threshold blocks matches that fail Jaccard', () => {
  const r = _mkRoot();
  try {
    for (let i = 0; i < 3; i += 1) {
      learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'ok' }, r);
    }
    const res = learnings.matchExistingLearning('argon password hashing', r, { threshold: 0.9, minOccurrence: 3 });
    assert.equal(res.best, null);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('LRN-7: minOccurrence blocks rare patterns', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'use jose for jwt', outcome: 'ok' }, r);
    const res = learnings.matchExistingLearning('use jose for jwt', r, { threshold: 0.5, minOccurrence: 3 });
    assert.equal(res.best, null);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('LRN-8: clearLearnings empties the store', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'foo bar baz quux', outcome: 'ok' }, r);
    assert.equal(learnings.listLearnings(r).length, 1);
    learnings.clearLearnings(r);
    assert.equal(learnings.listLearnings(r).length, 0);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('LRN-9: malformed pattern → TypeError', () => {
  const r = _mkRoot();
  try {
    assert.throws(() => learnings.logLearning({ outcome: 'ok' }, r), TypeError);
    assert.throws(() => learnings.logLearning({ pattern: 'x' }, r), TypeError);
    assert.throws(() => learnings.logLearning(null, r), TypeError);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('LRN-10: fingerprint is stable across stop-word reorderings', () => {
  const a = learnings._fingerprint('use jose for the JWT verification');
  const b = learnings._fingerprint('JWT verification: use jose');
  assert.equal(a, b);
});

test('LRN-11: jaccard symmetry + edge cases', () => {
  assert.equal(learnings._jaccard([], []), 0);
  assert.equal(learnings._jaccard(['a'], []), 0);
  assert.equal(learnings._jaccard(['a', 'b'], ['b', 'a']), 1);
  const j1 = learnings._jaccard(['a', 'b', 'c'], ['b', 'c', 'd']);
  assert.ok(Math.abs(j1 - (2 / 4)) < 1e-9);
});

test('LRN-12: store with future version raises learnings-store-version-mismatch (no silent wipe)', () => {
  const r = _mkRoot();
  try {
    const learningsPath = learnings._storePath(r);
    fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
    fs.writeFileSync(learningsPath, JSON.stringify({ version: 99, learnings: [{ pattern: 'precious', outcome: 'verified' }] }), 'utf-8');
    assert.throws(
      () => learnings.matchExistingLearning('anything', r),
      (err) => err && err.code === 'learnings-store-version-mismatch'
        && err.details && err.details.expected === learnings.STORE_VERSION
        && err.details.got === 99,
    );
    // Original data must still be on disk — we did NOT silently clear it
    const onDisk = JSON.parse(fs.readFileSync(learningsPath, 'utf-8'));
    assert.equal(onDisk.version, 99);
    assert.equal(onDisk.learnings[0].pattern, 'precious');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-13: malformed JSON raises learnings-store-corrupt', () => {
  const r = _mkRoot();
  try {
    const learningsPath = learnings._storePath(r);
    fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
    fs.writeFileSync(learningsPath, 'NOT JSON', 'utf-8');
    assert.throws(
      () => learnings.matchExistingLearning('x', r),
      (err) => err && err.code === 'learnings-store-corrupt',
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-VAL-1: invalid task_id raises TypeError (R7/R8 from second review)', () => {
  const r = _mkRoot();
  try {
    assert.throws(
      () => learnings.logLearning({ pattern: 'x y z', outcome: 'ok', task_id: '../STATE' }, r),
      TypeError,
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-VAL-2: invalid milestone_id raises TypeError', () => {
  const r = _mkRoot();
  try {
    assert.throws(
      () => learnings.logLearning({ pattern: 'x y z', outcome: 'ok', milestone_id: 'not-a-milestone' }, r),
      TypeError,
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-VAL-3: pattern over MAX_PATTERN_BYTES raises TypeError (R10)', () => {
  const r = _mkRoot();
  try {
    const big = 'x '.repeat(learnings.MAX_PATTERN_BYTES);
    assert.throws(
      () => learnings.logLearning({ pattern: big, outcome: 'ok' }, r),
      TypeError,
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-VAL-4: outcome over MAX_OUTCOME_BYTES raises TypeError', () => {
  const r = _mkRoot();
  try {
    const big = 'x '.repeat(learnings.MAX_OUTCOME_BYTES);
    assert.throws(
      () => learnings.logLearning({ pattern: 'p y z', outcome: big }, r),
      TypeError,
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// Direct unit tests against _evictIfOverCap — running 1000 logLearning roundtrips
// in a sandbox is unnecessarily slow. The integration is exercised by the
// "logLearning calls eviction" smoke test below.
test('LRN-OVERSIZED: read-side cap rejects > 2*MAX_STORE_BYTES files', () => {
  const r = _mkRoot();
  try {
    const learningsPath = learnings._storePath(r);
    fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
    // Write a large but non-JSON file just to exceed the size cap; we never
    // get to JSON.parse because the size check fires first.
    const filler = Buffer.alloc(2 * learnings.MAX_STORE_BYTES + 100, 0x20);
    fs.writeFileSync(learningsPath, filler);
    assert.throws(
      () => learnings.matchExistingLearning('x', r),
      (err) => err && err.code === 'learnings-store-oversized',
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-VAL-8: per-record validation rejects non-string pattern', () => {
  const r = _mkRoot();
  try {
    const learningsPath = learnings._storePath(r);
    fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
    fs.writeFileSync(learningsPath, JSON.stringify({
      version: learnings.STORE_VERSION,
      learnings: [{
        fingerprint: 'aaaaaaaaaaaaaaaa',
        pattern: { not: 'a string' },
        outcome: 'ok',
        occurrence: 1,
        first_seen: '2026-01-01T00:00:00Z',
        last_seen: '2026-01-01T00:00:00Z',
      }],
    }), 'utf-8');
    assert.throws(
      () => learnings.matchExistingLearning('x', r),
      (err) => err && err.code === 'learnings-store-corrupt' && /pattern/.test(err.message),
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-VAL-9: per-record validation rejects non-array tokens', () => {
  const r = _mkRoot();
  try {
    const learningsPath = learnings._storePath(r);
    fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
    fs.writeFileSync(learningsPath, JSON.stringify({
      version: learnings.STORE_VERSION,
      learnings: [{
        fingerprint: 'aaaaaaaaaaaaaaaa',
        pattern: 'x y z', outcome: 'ok', occurrence: 1,
        tokens: 'not an array',
        first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-01T00:00:00Z',
      }],
    }), 'utf-8');
    assert.throws(
      () => learnings.matchExistingLearning('x', r),
      (err) => err && err.code === 'learnings-store-corrupt' && /tokens/.test(err.message),
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-FIX-1: frozen v1-without-tokens fixture matches identical to v1-with-tokens', () => {
  // ADR-0013 claims tokens is additive — a v1 record without tokens must
  // still be matchable. Smoke this with a hand-crafted fixture.
  const r = _mkRoot();
  try {
    const learningsPath = learnings._storePath(r);
    fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
    fs.writeFileSync(learningsPath, JSON.stringify({
      version: learnings.STORE_VERSION,
      learnings: [
        {
          fingerprint: 'aaaaaaaaaaaaaaaa',
          pattern: 'use jose for jwt verification',
          // tokens INTENTIONALLY MISSING — pre-additive-field record
          outcome: 'verified',
          occurrence: 5,
          first_seen: '2026-01-01T00:00:00Z',
          last_seen: '2026-01-01T00:00:00Z',
          task_ids: ['M001-S001-T0001'],
          milestone_ids: ['M001'],
        },
      ],
    }), 'utf-8');
    const m = learnings.matchExistingLearning('use jose for jwt verification', r, { threshold: 0.5, minOccurrence: 3 });
    assert.ok(m.best, 'pre-tokens-era record must still be matchable via read-side fallback');
    assert.equal(m.best.fingerprint, 'aaaaaaaaaaaaaaaa');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-VAL-6: per-record validation rejects missing required fields', () => {
  const r = _mkRoot();
  try {
    const learningsPath = learnings._storePath(r);
    fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
    // Missing 'occurrence'
    fs.writeFileSync(learningsPath, JSON.stringify({
      version: learnings.STORE_VERSION,
      learnings: [{
        fingerprint: 'aaaaaaaaaaaaaaaa',
        pattern: 'x', outcome: 'ok',
        first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-01T00:00:00Z',
        task_ids: [], milestone_ids: [],
      }],
    }), 'utf-8');
    assert.throws(
      () => learnings.matchExistingLearning('x', r),
      (err) => err && err.code === 'learnings-store-corrupt'
        && err.details && err.details.field === 'occurrence',
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-VAL-7: per-record validation rejects malformed fingerprint', () => {
  const r = _mkRoot();
  try {
    const learningsPath = learnings._storePath(r);
    fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
    fs.writeFileSync(learningsPath, JSON.stringify({
      version: learnings.STORE_VERSION,
      learnings: [{
        fingerprint: 'NOTHEX',
        pattern: 'x', outcome: 'ok', occurrence: 1,
        first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-01T00:00:00Z',
      }],
    }), 'utf-8');
    assert.throws(
      () => learnings.matchExistingLearning('x', r),
      (err) => err && err.code === 'learnings-store-corrupt' && /fingerprint/.test(err.message),
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-OUTCOME-1: outcome flip records outcome_history (max 5 entries)', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'use jose for jwt', outcome: 'tested-ok' }, r);
    learnings.logLearning({ pattern: 'use jose for jwt', outcome: 'edge-case-found' }, r);
    learnings.logLearning({ pattern: 'use jose for jwt', outcome: 'patched' }, r);
    const list = learnings.listLearnings(r);
    assert.equal(list[0].outcome, 'patched');
    assert.equal(list[0].outcome_history.length, 2);
    assert.equal(list[0].outcome_history[0].outcome, 'tested-ok');
    assert.equal(list[0].outcome_history[1].outcome, 'edge-case-found');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-OUTCOME-2: identical outcome re-log does NOT inflate the journal', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'use jose for jwt', outcome: 'tested-ok' }, r);
    learnings.logLearning({ pattern: 'use jose for jwt', outcome: 'tested-ok' }, r);
    learnings.logLearning({ pattern: 'use jose for jwt', outcome: 'tested-ok' }, r);
    const list = learnings.listLearnings(r);
    assert.equal(list[0].occurrence, 3);
    // No flips → no journal entries
    assert.ok(!list[0].outcome_history || list[0].outcome_history.length === 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-BAK-1: logLearning creates .bak before destructive write', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'first entry alpha', outcome: 'ok' }, r);
    const p = learnings._storePath(r);
    const beforeContent = fs.readFileSync(p, 'utf-8');
    // Second log should rotate beforeContent → .bak
    learnings.logLearning({ pattern: 'second entry beta', outcome: 'ok' }, r);
    assert.ok(fs.existsSync(p + '.bak'), '.bak must exist after second write');
    const bakContent = fs.readFileSync(p + '.bak', 'utf-8');
    assert.equal(bakContent, beforeContent, '.bak must hold the prior file content');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-EVICT-3: _evictIfOverCap returns evicted entries + emits stderr by default', () => {
  const store = { version: learnings.STORE_VERSION, learnings: [] };
  for (let i = 0; i < learnings.MAX_LEARNINGS + 2; i += 1) {
    store.learnings.push({
      fingerprint: i.toString(16).padStart(16, 'c'),
      pattern: 'p ' + i, outcome: 'ok', occurrence: 1,
      first_seen: '2026-02-01T00:00:00Z',
      last_seen: '2026-02-01T00:00:00Z',
      task_ids: [], milestone_ids: [],
    });
  }
  let captured = '';
  const stderr = { write: (s) => { captured += String(s); return true; } };
  const evicted = learnings._evictIfOverCap(store, { stderr });
  assert.equal(evicted.length, 2);
  assert.equal(store.learnings.length, learnings.MAX_LEARNINGS);
  assert.match(captured, /learnings-eviction: dropped 2 entries/);
});

test('LRN-EVICT-4: _evictIfOverCap is silent when opts.silent=true', () => {
  const store = { version: learnings.STORE_VERSION, learnings: [] };
  for (let i = 0; i < learnings.MAX_LEARNINGS + 1; i += 1) {
    store.learnings.push({
      fingerprint: i.toString(16).padStart(16, 'd'),
      pattern: 'p ' + i, outcome: 'ok', occurrence: 1,
      first_seen: '2026-02-01T00:00:00Z',
      last_seen: '2026-02-01T00:00:00Z',
      task_ids: [], milestone_ids: [],
    });
  }
  let captured = '';
  const stderr = { write: (s) => { captured += String(s); return true; } };
  learnings._evictIfOverCap(store, { stderr, silent: true });
  assert.equal(captured, '');
});

test('LRN-EVICT-1: _evictIfOverCap trims to MAX_LEARNINGS, evicts lowest-occurrence-oldest first', () => {
  // Build a store of MAX_LEARNINGS+1 entries — one "precious" with occurrence=10,
  // rest occurrence=1 with staggered last_seen. After eviction the list must be
  // exactly MAX_LEARNINGS and precious must survive.
  const store = { version: learnings.STORE_VERSION, learnings: [] };
  // _evictIfOverCap operates on in-memory shapes only; per-record validation
  // happens in _readStore. Use any plausible fingerprint here.
  store.learnings.push({
    fingerprint: 'precfp00deadbeef', pattern: 'precious high occurrence pattern',
    outcome: 'ok', occurrence: 10, first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-01T00:00:00Z',
    task_ids: [], milestone_ids: [],
  });
  for (let i = 0; i < learnings.MAX_LEARNINGS; i += 1) {
    store.learnings.push({
      fingerprint: i.toString(16).padStart(16, 'b'),
      pattern: 'filler pattern slot ' + i + ' here',
      outcome: 'ok', occurrence: 1,
      first_seen: '2026-02-01T00:00:00Z',
      last_seen: '2026-02-01T00:00:' + String(i % 60).padStart(2, '0') + 'Z',
      task_ids: [], milestone_ids: [],
    });
  }
  assert.equal(store.learnings.length, learnings.MAX_LEARNINGS + 1);
  learnings._evictIfOverCap(store);
  assert.equal(store.learnings.length, learnings.MAX_LEARNINGS);
  const precious = store.learnings.find((l) => l.fingerprint === 'precfp00deadbeef');
  assert.ok(precious, 'high-occurrence entry must survive eviction');
});

test('LRN-EVICT-2: logLearning enforces the cap end-to-end at MAX_LEARNINGS+1', () => {
  // Smoke test: just verify that pushing one over the cap triggers the eviction
  // path. We test with a small store seeded directly to avoid 1000 IO roundtrips.
  const r = _mkRoot();
  try {
    // Seed exactly MAX_LEARNINGS entries via _setStoreForTests, then logLearning one more
    const seeded = { version: learnings.STORE_VERSION, learnings: [] };
    for (let i = 0; i < learnings.MAX_LEARNINGS; i += 1) {
      // Hex fingerprints — required by per-record validation
      seeded.learnings.push({
        fingerprint: i.toString(16).padStart(16, 'a'),
        pattern: 'seeded slot ' + i + ' here',
        tokens: ['seeded', 'slot', String(i), 'here'],
        outcome: 'ok', occurrence: 1,
        first_seen: '2026-02-01T00:00:00Z', last_seen: '2026-02-01T00:00:00Z',
        task_ids: [], milestone_ids: [],
      });
    }
    learnings._setStoreForTests(seeded, r);
    assert.equal(learnings.listLearnings(r).length, learnings.MAX_LEARNINGS);
    learnings.logLearning({ pattern: 'late arrival pattern here', outcome: 'ok' }, r);
    const after = learnings.listLearnings(r);
    assert.equal(after.length, learnings.MAX_LEARNINGS, 'must not exceed cap after over-cap log');
    assert.ok(after.some((l) => /late arrival/.test(l.pattern)), 'newest entry must survive');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-VAL-5: valid task_id + milestone_id are accepted', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning(
      { pattern: 'x y z', outcome: 'ok', task_id: 'M001-S001-T0001', milestone_id: 'M001' },
      r,
    );
    const list = learnings.listLearnings(r);
    assert.equal(list[0].task_ids[0], 'M001-S001-T0001');
    assert.equal(list[0].milestone_ids[0], 'M001');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-DI-1: task_ids / milestone_ids cap at MAX_PROVENANCE_IDS (50 newest, no unbounded growth)', () => {
  const r = _mkRoot();
  try {
    // Re-log the same pattern with 60 distinct task_ids
    for (let i = 0; i < 60; i += 1) {
      const taskId = 'M001-S001-T' + String(i).padStart(4, '0');
      learnings.logLearning({ pattern: 'use jose for jwt', outcome: 'verified', task_id: taskId }, r);
    }
    const all = learnings.listLearnings(r);
    const entry = all.find((l) => /jose/.test(l.pattern));
    assert.equal(entry.task_ids.length, 50, 'task_ids must be capped at MAX_PROVENANCE_IDS');
    // The cap keeps the newest IDs — the 60th log (index 59) must be present
    assert.ok(entry.task_ids.includes('M001-S001-T0059'));
    // The very first ID (index 0) must have been trimmed
    assert.ok(!entry.task_ids.includes('M001-S001-T0000'));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-DI-2: _writeStore validates records before persisting (no silent corrupt write)', () => {
  const r = _mkRoot();
  try {
    // _writeStore is exposed via _setStoreForTests for the destructive path —
    // a malformed record must reject at write time, not at the next read.
    assert.throws(
      () => learnings._setStoreForTests({
        version: learnings.STORE_VERSION,
        learnings: [{
          fingerprint: 'a'.repeat(16),
          // pattern: missing
          outcome: 'verified',
          occurrence: 1,
          first_seen: '2024-01-01T00:00:00Z',
          last_seen: '2024-01-01T00:00:00Z',
        }],
      }, r),
      (err) => err && err.code === 'learnings-store-corrupt' && /pattern/.test(err.message),
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-DI-3: .bak is atomic (rename-into-place, no torn copy on partial write)', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'first version', outcome: 'verified' }, r);
    learnings.logLearning({ pattern: 'second version', outcome: 'verified' }, r);
    const storePath = learnings._storePath(r);
    const bak = storePath + '.bak';
    assert.ok(fs.existsSync(bak), '.bak should exist after second write');
    // No leftover .bak.tmp from the rename path
    assert.ok(!fs.existsSync(storePath + '.bak.tmp'), '.bak.tmp must be cleaned up after atomic rename');
    // .bak must be a complete, parseable JSON document — never a partial file
    const parsed = JSON.parse(fs.readFileSync(bak, 'utf-8'));
    assert.ok(Array.isArray(parsed.learnings));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-PERF-1: matchExistingLearning hits project away the tokens[] field', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
    learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
    learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
    const res = learnings.matchExistingLearning('use jose for jwt', r, { threshold: 0.5, minOccurrence: 3 });
    assert.ok(res.best, 'expected hit');
    // The projected hit must NOT carry the bulky tokens[] (perf contract).
    assert.equal(res.best.tokens, undefined);
    assert.equal(typeof res.best.fingerprint, 'string');
    assert.equal(typeof res.best.pattern, 'string');
    assert.equal(typeof res.best.similarity, 'number');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-PERF-2: length-bucket pre-filter excludes obvious non-matches without invoking Jaccard', () => {
  const r = _mkRoot();
  try {
    // Two very-different-length patterns. With threshold=0.9 the short query
    // can never reach 90% similarity to a much-longer entry by the
    // min/max ratio bound — so the pre-filter must prune it.
    learnings.logLearning({
      pattern: 'this is a very long descriptive pattern about persistence concurrency observability and idempotency in distributed systems',
      outcome: 'verified',
    }, r);
    learnings.logLearning({
      pattern: 'this is a very long descriptive pattern about persistence concurrency observability and idempotency in distributed systems',
      outcome: 'verified',
    }, r);
    learnings.logLearning({
      pattern: 'this is a very long descriptive pattern about persistence concurrency observability and idempotency in distributed systems',
      outcome: 'verified',
    }, r);
    const res = learnings.matchExistingLearning('jose', r, { threshold: 0.9, minOccurrence: 3 });
    assert.equal(res.hits.length, 0);
    assert.equal(res.best, null);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LRN-MIG-1: _migrate validates the migrated shape (R5/F-D from fifth review)', () => {
  // A buggy migrator that produces records missing the required `pattern`
  // field must throw — same contract as on-disk data.
  const buggyMigrators = {
    0: () => ({
      version: learnings.STORE_VERSION,
      learnings: [{
        fingerprint: 'a'.repeat(16),
        // pattern: missing
        outcome: 'verified',
        occurrence: 1,
        first_seen: '2024-01-01T00:00:00Z',
        last_seen: '2024-01-01T00:00:00Z',
      }],
    }),
  };
  assert.throws(
    () => learnings._migrate({ version: 0, learnings: [] }, '<test>', buggyMigrators),
    (err) => err && err.code === 'learnings-store-corrupt' && /pattern/.test(err.message),
  );
});

test('LRN-MIG-2: _migrate accepts a valid migrated shape (round-trip control case)', () => {
  const goodMigrators = {
    0: (v0) => ({
      version: learnings.STORE_VERSION,
      learnings: (v0.learnings || []).map((r) => Object.assign({}, r, { migrated: true })),
    }),
  };
  const out = learnings._migrate(
    {
      version: 0,
      learnings: [{
        fingerprint: 'b'.repeat(16),
        pattern: 'x',
        outcome: 'verified',
        occurrence: 1,
        first_seen: '2024-01-01T00:00:00Z',
        last_seen: '2024-01-01T00:00:00Z',
      }],
    },
    '<test>',
    goodMigrators,
  );
  assert.equal(out.version, learnings.STORE_VERSION);
  assert.equal(out.learnings[0].migrated, true);
});

test('LRN-14: missing learnings[] array raises learnings-store-corrupt', () => {
  const r = _mkRoot();
  try {
    const learningsPath = learnings._storePath(r);
    fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
    fs.writeFileSync(learningsPath, JSON.stringify({ version: learnings.STORE_VERSION }), 'utf-8');
    assert.throws(
      () => learnings.matchExistingLearning('x', r),
      (err) => err && err.code === 'learnings-store-corrupt',
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
