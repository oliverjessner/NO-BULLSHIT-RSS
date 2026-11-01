import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRankingStatus, readRankingRefreshStatus, RANKING_STATUS_KEY } from '../backend/services/ranking-status.js';

test('ranking status rejects malformed storage and never exposes raw diagnostic messages', () => {
    for (const input of [undefined, 'invalid', '{', { state: 'unexpected' }]) {
        assert.deepEqual(normalizeRankingStatus(input), { state: 'idle', attemptedAt: null, message: null });
    }
    const status = normalizeRankingStatus(JSON.stringify({ state: 'error', attemptedAt: '2026-11-01T00:00:00Z', message: 'chrome --no-sandbox secret' }));
    assert.equal(status.state, 'error');
    assert.equal(status.attemptedAt, '2026-11-01T00:00:00.000Z');
    assert.doesNotMatch(status.message, /chrome|sandbox|secret/);
});

test('interrupted ranking updates stop displaying refreshing after two minutes', () => {
    const now = Date.parse('2026-11-01T00:03:00Z');
    assert.equal(normalizeRankingStatus({ state: 'refreshing', attemptedAt: '2026-11-01T00:02:00Z' }, { now }).state, 'refreshing');
    assert.equal(normalizeRankingStatus({ state: 'refreshing', attemptedAt: '2026-11-01T00:00:00Z' }, { now }).state, 'error');
    assert.equal(normalizeRankingStatus({ state: 'refreshing' }, { now }).state, 'error');
    assert.equal(normalizeRankingStatus({ state: 'ready', attemptedAt: '2026-11-01T00:00:00Z' }, { now }).state, 'ready');
});

test('read-only ranking status reads metadata and supports old databases without that table', async () => {
    assert.deepEqual(await readRankingRefreshStatus({ all: async () => [] }), normalizeRankingStatus(null));
    const queries = [];
    const status = await readRankingRefreshStatus({ all: async (sql, params) => {
        queries.push({ sql, params });
        return sql.includes('sqlite_master') ? [{ name: 'app_metadata' }] : [{ value: JSON.stringify({ state: 'error' }) }];
    } });
    assert.equal(status.state, 'error');
    assert.deepEqual(queries[1].params, [RANKING_STATUS_KEY]);
    assert.ok(queries.every(query => query.sql.startsWith('SELECT')));
});
