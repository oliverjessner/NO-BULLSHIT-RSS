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

test('Golem access setup, confirmation, cancellation and forgetting use explicit dedicated actions', async () => {
    const previousFetch = globalThis.fetch;
    const requests = [];
    const jobId = '61656422-cf36-4e1a-bb3c-1dd12e90b541';
    globalThis.fetch = async (url, options) => { requests.push({ url, options }); return Response.json({ medium: 'golem', rankings: [] }); };
    try {
        await api.startRankingsAccess('golem');
        await api.confirmRankingsAccess('golem', jobId);
        await api.cancelRankingsAccess('golem', jobId);
        await api.forgetRankingsAccess('golem');
        assert.deepEqual(requests.map(request => request.url), ['/api/rankings/access/start', '/api/rankings/access/confirm', '/api/rankings/access/cancel', '/api/rankings/access?medium=golem']);
        assert.deepEqual(requests.slice(0, 3).map(request => JSON.parse(request.options.body)), [{ medium: 'golem' }, { medium: 'golem', jobId }, { medium: 'golem', jobId }]);
        assert.equal(requests[3].options.method, 'DELETE');
    } finally { globalThis.fetch = previousFetch; }
});
