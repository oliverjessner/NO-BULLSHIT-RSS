import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-rankings-api-'));
process.env.DB_PATH = path.join(directory, 'rankings.db');
const database = await import('../database/datenbank.js');
const { createRankingsRouter } = await import('./rankings.js');

async function fixture(t, overrides = {}) {
    const calls = [];
    const state = {
        rankingStatus: { state: 'ready', attemptedAt: '2026-11-01T00:00:00Z', errorCode: null, message: null },
    };
    const payload = medium => ({ medium, media: [{ id: 'golem', name: 'Golem' }], configured: true,
        rankings: [{ sourceId: 1, rankingKey: 'most_read', items: [{ rank: 1, title: 'Saved article', canonicalUrl: 'https://www.golem.de/news/saved.html' }] }],
        rankingStatus: state.rankingStatus });
    const app = express(); app.use(express.json());
    app.use('/api/rankings', createRankingsRouter({
        readPayload: async medium => payload(medium),
        refresh: async () => { calls.push('refresh'); },
        isRefreshing: () => false,
        ...overrides,
    }));
    const server = createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}/api/rankings`;
    const request = (route = '', body, method = 'POST') => fetch(`${base}${route}`, {
        method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { base, request, state, calls };
}

test('GET rankings is read-only and exposes only the supported Golem medium', async t => {
    const f = await fixture(t);
    const response = await fetch(`${f.base}?medium=golem`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.media, [{ id: 'golem', name: 'Golem' }]);
    assert.equal(body.medium, 'golem');
    assert.equal(body.rankings[0].items[0].title, 'Saved article');
    assert.equal(Object.hasOwn(body, 'access'), false);
    assert.deepEqual(f.calls, []);
});

test('unsupported media and injected parameters are rejected before any capture', async t => {
    const f = await fixture(t);
    assert.equal((await f.request('/refresh', { medium: 'other' })).status, 400);
    assert.equal((await f.request('/refresh', { medium: 'golem', url: 'http://127.0.0.1/private' })).status, 400);
    assert.equal((await fetch(`${f.base}?medium=other`)).status, 400);
    assert.equal((await fetch(`${f.base}?medium=golem&url=https://other.test`)).status, 400);
    assert.deepEqual(f.calls, []);
});

test('failed Golem refresh returns actionable consent status and keeps the last saved articles', async t => {
    const f = await fixture(t);
    f.state.rankingStatus = { state: 'error', errorCode: 'GOLEM_CONSENT_REQUIRED', message: 'Automatic Golem consent could not be completed. Try refreshing again.' };
    const response = await f.request('/refresh', { medium: 'golem' });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.rankingStatus.errorCode, 'GOLEM_CONSENT_REQUIRED');
    assert.match(body.error, /Automatic Golem consent could not be completed/);
    assert.equal(body.rankings[0].items.length, 1);
    assert.deepEqual(f.calls, ['refresh']);
});

test('a concurrent refresh returns409 without starting another capture', async t => {
    const f = await fixture(t, { isRefreshing: () => true });
    assert.equal((await f.request('/refresh', { medium: 'golem' })).status, 409);
    assert.deepEqual(f.calls, []);
});

test('removed manual access endpoints cannot open, save, cancel or delete sessions', async t => {
    const f = await fixture(t);
    for (const route of ['/access/start', '/access/confirm', '/access/cancel']) {
        assert.equal((await f.request(route, { medium: 'golem', jobId: '11111111-1111-4111-8111-111111111111' })).status, 404);
    }
    assert.equal((await f.request('/access?medium=golem', undefined, 'DELETE')).status, 404);
    assert.deepEqual(f.calls, []);
});

test.after(async () => { await database.closeDatabase(); await rm(directory, { recursive: true, force: true }); });
