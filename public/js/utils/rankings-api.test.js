import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../api/client.js';

test('Most read reads and refreshes only the selected medium through its dedicated API', async () => {
    const previousFetch = globalThis.fetch;
    const requests = [];
    const payload = { medium: 'golem', media: [{ id: 'golem', name: 'Golem' }], rankings: [], rankingStatus: { state: 'idle' } };
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        return Response.json(payload);
    };
    try {
        assert.deepEqual(await api.rankings('golem'), payload);
        assert.deepEqual(await api.refreshRankings('golem'), payload);
        assert.equal(requests[0].url, '/api/rankings?medium=golem');
        assert.equal(requests[1].url, '/api/rankings/refresh');
        assert.equal(requests[1].options.method, 'POST');
        assert.deepEqual(JSON.parse(requests[1].options.body), { medium: 'golem' });
        assert.equal(requests.some(request => request.url.startsWith('/api/fetch')), false);
    } finally { globalThis.fetch = previousFetch; }
});

test('failed or busy ranking refreshes preserve status and last-good payload for the view', async () => {
    const previousFetch = globalThis.fetch;
    try {
        for (const status of [502, 409]) {
            const payload = { error: 'Publisher refresh unavailable', medium: 'golem', rankings: [{ rankingKey: 'most_read', items: [{ rank: 1, title: 'Last saved article' }] }], rankingStatus: { state: status === 409 ? 'refreshing' : 'error' } };
            globalThis.fetch = async () => Response.json(payload, { status });
            await assert.rejects(api.refreshRankings('golem'), error => {
                assert.equal(error.status, status);
                assert.deepEqual(error.data, payload);
                assert.equal(error.message, payload.error);
                return true;
            });
        }
    } finally { globalThis.fetch = previousFetch; }
});

test('ranking API no longer exposes manual session management', () => {
    for (const method of ['startRankingsAccess', 'confirmRankingsAccess', 'cancelRankingsAccess', 'forgetRankingsAccess']) {
        assert.equal(Object.hasOwn(api, method), false);
    }
});

test('mixed top API forwards opaque pagination and cancellation without refreshing feeds', async () => {
    const previousFetch = globalThis.fetch;
    const controller = new AbortController();
    const requests = [];
    globalThis.fetch = async (url, options) => { requests.push({ url, options }); return Response.json({ medium: 'all', items: [] }); };
    try {
        await api.topArticles({ cursor: 'opaque+/=&?', signal: controller.signal });
        const url = new URL(requests[0].url, 'http://localhost');
        assert.equal(url.pathname, '/api/rankings/top');
        assert.equal(url.searchParams.get('medium'), 'all');
        assert.equal(url.searchParams.get('limit'), '40');
        assert.equal(url.searchParams.get('cursor'), 'opaque+/=&?');
        assert.equal(requests[0].options.signal, controller.signal);
    } finally { globalThis.fetch = previousFetch; }
});
