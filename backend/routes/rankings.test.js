import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-rankings-api-'));
process.env.DB_PATH = path.join(directory, 'rankings.db');
process.env.NBS_RANKING_SESSION_DIR = path.join(directory, 'sessions');
const database = await import('../database/datenbank.js');
const { createRankingsRouter } = await import('./rankings.js');
const jobId = '11111111-1111-4111-8111-111111111111';

async function fixture(t, overrides = {}) {
    const calls = [];
    const state = {
        rankingStatus: { state: 'ready', attemptedAt: '2026-11-01T00:00:00Z', errorCode: null, message: null },
        access: { state: 'idle', jobId: null, saved: false, savedAt: null, message: null },
    };
    const payload = medium => ({ medium, media: [{ id: 'golem', name: 'Golem' }], configured: true,
        rankings: [{ sourceId: 1, rankingKey: 'most_read', items: [{ rank: 1, title: 'Saved article', canonicalUrl: 'https://www.golem.de/news/saved.html' }] }],
        rankingStatus: state.rankingStatus });
    const access = {
        status: async () => state.access,
        start: async () => { calls.push('start'); state.access = { ...state.access, state: 'opening', jobId }; },
        confirm: async id => { assert.equal(id, jobId); calls.push('confirm'); state.access = { ...state.access, state: 'saved', saved: true }; },
        cancel: async id => { assert.equal(id, jobId); calls.push('cancel'); state.access = { ...state.access, state: 'idle', jobId: null }; },
        forget: async () => { calls.push('forget'); state.access = { ...state.access, state: 'idle', saved: false }; },
        ...overrides.access,
    };
    const app = express(); app.use(express.json());
    app.use('/api/rankings', createRankingsRouter({
        readPayload: async medium => payload(medium),
        refresh: async () => { calls.push('refresh'); },
        isRefreshing: () => false,
        waitForRefresh: async () => { calls.push('wait'); },
        ...overrides, access,
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
    assert.deepEqual(f.calls, []);
});

test('unsupported media and injected parameters are rejected before any capture or access setup', async t => {
    const f = await fixture(t);
    for (const route of ['/refresh', '/access/start']) {
        assert.equal((await f.request(route, { medium: 'other' })).status, 400);
        assert.equal((await f.request(route, { medium: 'golem', url: 'http://127.0.0.1/private' })).status, 400);
    }
    assert.equal((await fetch(`${f.base}?medium=other`)).status, 400);
    assert.equal((await fetch(`${f.base}?medium=golem&url=https://other.test`)).status, 400);
    assert.deepEqual(f.calls, []);
});

test('failed Golem refresh returns actionable consent status and keeps the last saved articles', async t => {
    const f = await fixture(t);
    f.state.rankingStatus = { state: 'error', errorCode: 'GOLEM_CONSENT_REQUIRED', message: 'Golem requires a cookie choice or Golem pur access before rankings can be loaded.' };
    const response = await f.request('/refresh', { medium: 'golem' });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.rankingStatus.errorCode, 'GOLEM_CONSENT_REQUIRED');
    assert.match(body.error, /cookie choice or Golem pur/);
    assert.equal(body.rankings[0].items.length, 1);
    assert.deepEqual(f.calls, ['refresh']);
});

test('a concurrent refresh returns409 without starting another capture', async t => {
    const f = await fixture(t, { isRefreshing: () => true });
    assert.equal((await f.request('/refresh', { medium: 'golem' })).status, 409);
    assert.deepEqual(f.calls, []);
});

test('access requires explicit start and current-job save, then verifies the saved session through refresh', async t => {
    const f = await fixture(t);
    const started = await f.request('/access/start', { medium: 'golem' });
    assert.equal(started.status, 202);
    assert.equal((await started.json()).access.jobId, jobId);
    assert.deepEqual(f.calls, ['start']);
    const saved = await f.request('/access/confirm', { medium: 'golem', jobId });
    assert.equal(saved.status, 200);
    assert.deepEqual(f.calls, ['start', 'confirm', 'wait', 'refresh']);
    assert.equal((await saved.json()).access.saved, true);
});

test('stale setup saves and invalid job identifiers never verify or refresh access', async t => {
    const f = await fixture(t, { access: { confirm: async () => {
        const error = new Error('Internal detail'); error.code = 'ACCESS_STALE'; throw error;
    } } });
    assert.equal((await f.request('/access/confirm', { medium: 'golem', jobId: '../session' })).status, 400);
    const stale = await f.request('/access/confirm', { medium: 'golem', jobId });
    assert.equal(stale.status, 409);
    assert.doesNotMatch((await stale.json()).error, /Internal detail/);
    assert.deepEqual(f.calls, []);
});

test('cancel and forget affect access only and do not run a publisher refresh', async t => {
    const f = await fixture(t);
    assert.equal((await f.request('/access/cancel', { medium: 'golem', jobId })).status, 200);
    assert.equal((await f.request('/access?medium=golem', undefined, 'DELETE')).status, 200);
    assert.deepEqual(f.calls, ['cancel', 'forget']);
});

test('cancelled saves return409 and never verify an older saved session', async t => {
    const f = await fixture(t, { access: { confirm: async () => {
        const error = new Error('Setup cancelled'); error.code = 'ACCESS_CANCELLED'; throw error;
    } } });
    const response = await f.request('/access/confirm', { medium: 'golem', jobId });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /cancelled/);
    assert.deepEqual(f.calls, []);
});

test.after(async () => { await database.closeDatabase(); await rm(directory, { recursive: true, force: true }); });
