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
    const topCalls = [];
    const state = {
        rankingStatus: { state: 'ready', attemptedAt: '2026-11-01T00:00:00Z', errorCode: null, message: null },
    };
    const payload = medium => ({ medium, media: [{ id: 'golem', name: 'Golem' }, { id: 'winfuture', name: 'WinFuture' }, { id: 'computerbase', name: 'ComputerBase' }, { id: 'heise-ix', name: 'heise iX' }, { id: 't3n', name: 't3n' }, { id: 'techcrunch', name: 'TechCrunch' }, { id: 'arstechnica', name: 'Ars Technica' }, { id: 'wired', name: 'WIRED' }, { id: 'theverge', name: 'The Verge' }], configured: true,
        rankings: [{ sourceId: 1, rankingKey: 'most_read', items: [{ rank: 1, title: 'Saved article', canonicalUrl: 'https://www.golem.de/news/saved.html' }] }],
        rankingStatus: state.rankingStatus });
    const app = express(); app.use(express.json());
    app.use('/api/rankings', createRankingsRouter({
        readPayload: async medium => payload(medium),
        readTop: async options => {
            topCalls.push(options);
            return { medium: options.medium || 'all', media: payload('golem').media, configured: true,
                items: [{ canonicalUrl: 'https://www.golem.de/news/saved.html', title: 'Saved top article' }],
                hasMore: false, nextCursor: null, rankingStatus: state.rankingStatus };
        },
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
    return { base, request, state, calls, topCalls };
}

test('GET rankings is read-only and exposes the supported publisher media', async t => {
    const f = await fixture(t);
    const response = await fetch(`${f.base}?medium=golem`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.media, [{ id: 'golem', name: 'Golem' }, { id: 'winfuture', name: 'WinFuture' }, { id: 'computerbase', name: 'ComputerBase' }, { id: 'heise-ix', name: 'heise iX' }, { id: 't3n', name: 't3n' }, { id: 'techcrunch', name: 'TechCrunch' }, { id: 'arstechnica', name: 'Ars Technica' }, { id: 'wired', name: 'WIRED' }, { id: 'theverge', name: 'The Verge' }]);
    assert.equal(body.medium, 'golem');
    assert.equal(body.rankings[0].items[0].title, 'Saved article');
    assert.equal(Object.hasOwn(body, 'access'), false);
    assert.deepEqual(f.calls, []);
});

test('WinFuture can be selected and refreshed independently', async t => {
    let captured;
    const f = await fixture(t, { refresh: async options => { captured = options; } });
    assert.equal((await (await fetch(`${f.base}?medium=winfuture`)).json()).medium, 'winfuture');
    const refreshed = await f.request('/refresh', { medium: 'winfuture' });
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).medium, 'winfuture');
    assert.deepEqual(captured, { medium: 'winfuture' });
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

test('ComputerBase can be selected and refreshed without capturing another medium', async t => {
    let captured;
    const f = await fixture(t, { refresh: async options => { captured = options; } });
    const response = await fetch(`${f.base}?medium=computerbase`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).medium, 'computerbase');
    const refreshed = await f.request('/refresh', { medium: 'computerbase' });
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).medium, 'computerbase');
    assert.deepEqual(captured, { medium: 'computerbase' });
});

test('heise iX Top-News can be selected and refreshed independently', async t => {
    let captured;
    const f = await fixture(t, { refresh: async options => { captured = options; } });
    assert.equal((await fetch(`${f.base}?medium=heise-ix`)).status, 200);
    const response = await f.request('/refresh', { medium: 'heise-ix' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).medium, 'heise-ix');
    assert.deepEqual(captured, { medium: 'heise-ix' });
});

test('t3n most-read rankings can be selected and refreshed independently', async t => {
    let captured;
    const f = await fixture(t, { refresh: async options => { captured = options; } });
    assert.equal((await fetch(`${f.base}?medium=t3n`)).status, 200);
    const response = await f.request('/refresh', { medium: 't3n' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).medium, 't3n');
    assert.deepEqual(captured, { medium: 't3n' });
});

test('collected top pages validate and forward medium, bounded size and cursor without starting a capture', async t => {
    const f = await fixture(t);
    const response = await fetch(`${f.base}/top?medium=t3n&limit=40&cursor=opaque-cursor`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).items[0].title, 'Saved top article');
    assert.deepEqual(f.topCalls, [{ medium: 't3n', limit: 40, cursor: 'opaque-cursor' }]);
    assert.deepEqual(f.calls, []);
    for (const query of ['medium=unknown', 'limit=0', 'limit=101', 'limit=1.5', 'url=https://evil.test', 'cursor=']) {
        assert.equal((await fetch(`${f.base}/top?${query}`)).status, 400, query);
    }
    assert.equal(f.topCalls.length, 1);
});

test('malformed collected-page cursors return a safe client error', async t => {
    const f = await fixture(t, { readTop: async () => { throw Object.assign(new Error('Invalid top-article cursor.'), { status: 400 }); } });
    const response = await fetch(`${f.base}/top?cursor=bad`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid top-article cursor.' });
});

test('All media refresh captures all publishers and returns a collected page including saved data on failure', async t => {
    const refreshOptions = [];
    const f = await fixture(t, { refresh: async options => { refreshOptions.push(options); } });
    let response = await f.request('/refresh', { medium: 'all' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).items[0].title, 'Saved top article');
    assert.deepEqual(refreshOptions, [{}]);
    f.state.rankingStatus = { state: 'error', message: 'Publisher rankings could not be refreshed.' };
    response = await f.request('/refresh', { medium: 'all' });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).items[0].title, 'Saved top article');
});

test('TechCrunch Top Headlines can be selected and refreshed independently', async t => {
    let captured;
    const f = await fixture(t, { refresh: async options => { captured = options; } });
    assert.equal((await fetch(`${f.base}?medium=techcrunch`)).status, 200);
    const response = await f.request('/refresh', { medium: 'techcrunch' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).medium, 'techcrunch');
    assert.deepEqual(captured, { medium: 'techcrunch' });
});

test('Ars Technica can be selected for grouped and collected reads and refreshed independently', async t => {
    let captured;
    const f = await fixture(t, { refresh: async options => { captured = options; } });
    assert.equal((await fetch(`${f.base}?medium=arstechnica`)).status, 200);
    assert.equal((await fetch(`${f.base}/top?medium=arstechnica&limit=40`)).status, 200);
    const response = await f.request('/refresh', { medium: 'arstechnica' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).medium, 'arstechnica');
    assert.deepEqual(captured, { medium: 'arstechnica' });
});

test('WIRED can be selected for grouped and collected reads and refreshed independently', async t => {
    let captured;
    const f = await fixture(t, { refresh: async options => { captured = options; } });
    assert.equal((await fetch(`${f.base}?medium=wired`)).status, 200);
    assert.equal((await fetch(`${f.base}/top?medium=wired&limit=40`)).status, 200);
    assert.deepEqual(f.topCalls, [{ medium: 'wired', limit: 40, cursor: null }]);
    const response = await f.request('/refresh', { medium: 'wired' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).medium, 'wired');
    assert.deepEqual(captured, { medium: 'wired' });
});

test('The Verge supports grouped and collected reads plus an independent Top Stories refresh', async t => {
    let captured;
    const f = await fixture(t, { refresh: async options => { captured = options; } });
    assert.equal((await fetch(`${f.base}?medium=theverge`)).status, 200);
    assert.equal((await fetch(`${f.base}/top?medium=theverge&limit=40`)).status, 200);
    assert.deepEqual(f.topCalls, [{ medium: 'theverge', limit: 40, cursor: null }]);
    const response = await f.request('/refresh', { medium: 'theverge' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).medium, 'theverge');
    assert.deepEqual(captured, { medium: 'theverge' });
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
