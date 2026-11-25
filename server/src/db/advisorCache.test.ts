import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-cache-'));
const file = path.join(dir, 'cache.db');
process.env.ADVISOR_CACHE_DB_PATH = file;
import { sqliteAdvisorCache, closeAdvisorCache } from './advisorCache';

describe('advisor cache store', () => {
  after(() => { closeAdvisorCache(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('reads null, writes, reads back, and upserts on (map, queue_mode)', () => {
    assert.equal(sqliteAdvisorCache.read('Lijiang', 'comp'), null);
    sqliteAdvisorCache.write('Lijiang', 'comp', 'Ana', null, '{"a":1}');
    assert.equal(sqliteAdvisorCache.read('Lijiang', 'comp')?.focus_json, '{"a":1}');
    sqliteAdvisorCache.write('Lijiang', 'comp', 'Mercy', 'Ana', '{"a":2}');
    assert.equal(sqliteAdvisorCache.read('Lijiang', 'comp')?.focus_json, '{"a":2}');
    assert.equal(sqliteAdvisorCache.read('Lijiang', 'qp'), null);
  });

  test('the file holds only the advisor_cache table', () => {
    closeAdvisorCache();
    const d = new DatabaseSync(file);
    const names = (d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map(r => r.name);
    d.close();
    assert.deepEqual(names, ['advisor_cache']);
  });
});
