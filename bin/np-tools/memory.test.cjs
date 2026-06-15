'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

const memoryIndex = require('./memory-index.cjs');
const memoryQuery = require('./memory-query.cjs');
const memoryAdd = require('./memory-add.cjs');
const memoryRebuild = require('./memory-rebuild.cjs');
const memoryStats = require('./memory-stats.cjs');

function _sandbox(enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-memory-cli-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  if (enabled) {
    fs.writeFileSync(
      path.join(root, '.nubos-pilot', 'config.json'),
      JSON.stringify({ memory: { enabled: true, model: 'mock-v1', alpha: 0.6 } }),
      'utf-8',
    );
  } else {
    fs.writeFileSync(
      path.join(root, '.nubos-pilot', 'config.json'),
      JSON.stringify({ memory: { enabled: false } }),
      'utf-8',
    );
  }
  return root;
}

function _capture() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  stream.text = () => Buffer.concat(chunks).toString('utf-8');
  return stream;
}

function _hashEmbed(text, dim) {
  const v = new Float32Array(dim);
  let s = 1;
  for (let i = 0; i < text.length; i++) s = (s * 31 + text.charCodeAt(i)) & 0x7fffffff;
  for (let i = 0; i < dim; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    v[i] = (s % 1000) / 1000;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

function _mockProvider() {
  return {
    modelId: 'mock-v1',
    dim: 8,
    async embed(texts) { return texts.map((t) => _hashEmbed(t, 8)); },
  };
}

function _mockIndex() {
  let entries = new Map();
  return {
    add(id, vec) { entries.set(id, vec); },
    remove(id) { entries.delete(id); },
    size() { return entries.size; },
    isEmpty() { return entries.size === 0; },
    clear() { entries = new Map(); },
    search(vec, k) {
      const hits = [];
      for (const [id, v] of entries.entries()) {
        let dot = 0;
        for (let i = 0; i < vec.length; i++) dot += vec[i] * v[i];
        hits.push({ id, score: dot });
      }
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, k);
    },
  };
}

function _mocks(root) {
  return { cwd: root, provider: _mockProvider(), indexEngine: _mockIndex(), alpha: 0.6 };
}

test('MEMC-1: memory-index --records JSON array writes records and prints {added, skipped}', async () => {
  const root = _sandbox();
  try {
    const out = _capture();
    const records = JSON.stringify([
      { type: 'learning', title: 'A', body: 'b1' },
      { type: 'learning', title: 'B', body: 'b2' },
    ]);
    const exit = await memoryIndex.run(['--records', records], { ..._mocks(root), stdout: out });
    assert.equal(exit, 0);
    const parsed = JSON.parse(out.text());
    assert.equal(parsed.added, 2);
    assert.equal(parsed.skipped, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEMC-2: memory-index --records-file reads JSONL', async () => {
  const root = _sandbox();
  try {
    const filePath = path.join(root, 'records.jsonl');
    const lines = [
      JSON.stringify({ type: 'critic', title: 'finding-1', body: 'b' }),
      JSON.stringify({ type: 'research', title: 'decision-1', body: 'b' }),
    ];
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

    const out = _capture();
    await memoryIndex.run(['--records-file', filePath], { ..._mocks(root), stdout: out });
    const parsed = JSON.parse(out.text());
    assert.equal(parsed.added, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEMC-3: memory-query prints top-k JSON array', async () => {
  const root = _sandbox();
  try {
    const ctx = _mocks(root);
    await memoryIndex.run(
      ['--records', JSON.stringify([
        { type: 'learning', title: 'A', body: 'a' },
        { type: 'learning', title: 'B', body: 'b' },
      ])],
      { ...ctx, stdout: _capture() },
    );

    const queryOut = _capture();
    await memoryQuery.run(['--text', 'a', '--k', '5'], { ...ctx, stdout: queryOut });
    const hits = JSON.parse(queryOut.text());
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length >= 1);
    assert.ok('id' in hits[0] && 'score' in hits[0] && 'record' in hits[0]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEMC-4: memory-add inserts a single record and prints {added, id}', async () => {
  const root = _sandbox();
  try {
    const out = _capture();
    const exit = await memoryAdd.run(
      ['--type', 'learning', '--title', 'A', '--body', 'b', '--tags', 'feature-flags,filament'],
      { ..._mocks(root), stdout: out },
    );
    assert.equal(exit, 0);
    const parsed = JSON.parse(out.text());
    assert.equal(parsed.added, true);
    assert.match(parsed.id, /^[0-9a-f]{8}-/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEMC-5: memory-stats returns count + dim + model', async () => {
  const root = _sandbox();
  try {
    const ctx = _mocks(root);
    await memoryAdd.run(['--type', 'learning', '--title', 'A', '--body', 'b'], { ...ctx, stdout: _capture() });

    const statsOut = _capture();
    memoryStats.run([], { ...ctx, stdout: statsOut });
    const stats = JSON.parse(statsOut.text());
    assert.equal(stats.count, 1);
    assert.equal(stats.dim, 8);
    assert.equal(stats.model, 'mock-v1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEMC-6: memory-rebuild re-embeds existing records', async () => {
  const root = _sandbox();
  try {
    const ctx = _mocks(root);
    await memoryIndex.run(
      ['--records', JSON.stringify([
        { type: 'learning', title: 'A', body: 'a' },
        { type: 'learning', title: 'B', body: 'b' },
      ])],
      { ...ctx, stdout: _capture() },
    );

    const rebuildOut = _capture();
    await memoryRebuild.run([], { ...ctx, stdout: rebuildOut });
    const result = JSON.parse(rebuildOut.text());
    assert.equal(result.reembedded, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEMC-7: production path with memory.enabled=false errors with memory-disabled', () => {
  const root = _sandbox(false);
  try {
    assert.throws(
      () => memoryStats.run([], { cwd: root, stdout: _capture() }),
      (err) => err.name === 'NubosPilotError' && err.code === 'memory-disabled',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEMC-8: memory-query without text errors with memory-query-missing-text', async () => {
  const root = _sandbox();
  try {
    await assert.rejects(
      memoryQuery.run([], { ..._mocks(root), stdout: _capture() }),
      (err) => err.code === 'memory-query-missing-text',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEMC-9: memory-index without records errors with memory-index-missing-records', async () => {
  const root = _sandbox();
  try {
    await assert.rejects(
      memoryIndex.run([], { ..._mocks(root), stdout: _capture() }),
      (err) => err.code === 'memory-index-missing-records',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
