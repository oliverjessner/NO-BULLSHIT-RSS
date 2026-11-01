import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseHTML } from 'linkedom';

const payload = (title = 'Saved Golem story') => ({
    medium: 'golem', media: [{ id: 'golem', name: 'Golem' }], configured: true,
    access: { state: 'idle', jobId: null, saved: false, savedAt: null, message: null },
    rankingStatus: { state: 'ready', message: null, attemptedAt: '2026-11-01T07:00:00Z' },
    rankings: [{ sourceId: 1, sourceName: 'Golem', rankingKey: 'most_read', capturedAt: '2026-11-01T07:00:00Z', items: [
        { id: 901, articleId: 7, rank: 1, canonicalUrl: 'https://www.golem.de/news/saved.html', title,
            article: { id: 7, title, url: 'https://www.golem.de/news/saved.html' } },
        { id: 902, articleId: null, rank: 2, canonicalUrl: 'https://www.golem.de/news/external.html', title: 'External story', article: null },
    ] }],
});

test('standalone Most read keeps its own viewer, stale snapshots and refresh request ordering', async () => {
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const { document, window } = parseHTML(await readFile(new URL('../../index.html', import.meta.url), 'utf8'));
    globalThis.document = document;
    globalThis.window = window;
    window.scrollTo = () => {};
    const opened = [];
    window.open = url => { opened.push(url); return null; };
    const requests = [];
    let mode = 'ready';
    let configured = true;
    const polls = new Map();
    globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay !== 1500) return previous.setTimeout(callback, delay, ...args);
        const id = Symbol('rankings status poll'); polls.set(id, callback); return id;
    };
    globalThis.clearTimeout = id => { if (!polls.delete(id)) previous.clearTimeout(id); };
    async function runStatusPoll() {
        assert.equal(polls.size, 1, 'Active setup must keep exactly one status poll');
        const [id, callback] = polls.entries().next().value;
        polls.delete(id); callback();
        await new Promise(setImmediate);
    }
    const jobId = '61656422-cf36-4e1a-bb3c-1dd12e90b541';
    let access = { ...payload().access };
    let completeOldRead;
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        if (url === '/api/rankings/access/start') {
            access = { ...access, state: 'opening', jobId };
            return Response.json({ ...payload(), access }, { status: 202 });
        }
        if (url === '/api/rankings/access/confirm') {
            assert.deepEqual(JSON.parse(options.body), { medium: 'golem', jobId });
            if (mode === 'consent-required') return Response.json({ ...payload(), access, error: 'Automatic consent could not be completed', rankingStatus: { state: 'error', errorCode: 'GOLEM_CONSENT_REQUIRED' } }, { status: 502 });
            access = { ...access, state: 'saved', jobId: null, saved: true, savedAt: '2026-11-01T07:05:00Z' };
            return Response.json({ ...payload(), access });
        }
        if (url === '/api/rankings/access/cancel') {
            assert.deepEqual(JSON.parse(options.body), { medium: 'golem', jobId });
            access = { ...payload().access };
            return Response.json({ ...payload(), access });
        }
        if (url === '/api/rankings/access?medium=golem') {
            assert.equal(options.method, 'DELETE');
            access = { ...payload().access };
            return Response.json({ ...payload(), access });
        }
        if (url === '/api/rankings/refresh') {
            if (mode === 'failed') return Response.json({ ...payload(), error: 'Could not refresh', rankingStatus: { state: 'error' } }, { status: 502 });
            if (mode === 'automatic-consent-required') return Response.json({ ...payload(), access, error: 'Automatic consent could not be completed', rankingStatus: { state: 'error', errorCode: 'GOLEM_CONSENT_REQUIRED' } }, { status: 502 });
            if (mode === 'busy') return Response.json({ error: 'Refresh already running' }, { status: 409 });
            return Response.json(payload('Refreshed Golem story'));
        }
        assert.equal(url, '/api/rankings?medium=golem');
        if (mode === 'delayed-read') return new Promise(resolve => { completeOldRead = resolve; });
        return Response.json({ ...payload(), access, configured, rankings: configured ? payload().rankings : [], rankingStatus: configured ? payload().rankingStatus : { state: 'idle' } });
    };
    let rankings;
    try {
        rankings = await import('../views/rankings.js');
        const { store } = await import('../state/store.js');
        const { initNavigation, navigate } = await import('../ui/navigation.js');
        initNavigation(name => name === 'rankings' ? rankings.activateRankings() : undefined);
        await navigate('rankings');
        assert.equal(store.ui.activeView, 'rankings');
        assert.equal(document.querySelector('#view-rankings').hidden, false);
        assert.equal(document.querySelector('#view-digest').hidden, true);
        assert.equal(document.querySelector('.nav-link[data-view="rankings"]').getAttribute('aria-current'), 'page');
        assert.equal(store.rankings.articlesById.get(7).title, 'Saved Golem story');
        assert.equal(store.digest.articlesById.has(7), false);
        assert.equal(requests.some(request => request.url.startsWith('/api/rankings/access')), false, 'Opening Most read must never open a browser or save access');
        assert.equal(document.querySelector('#rankings-refresh').disabled, false, 'Optional access setup must not be required before Refresh');
        assert.match(document.querySelector('#rankings-access-status').textContent, /Optional access has not been set up.*Refresh can accept/);

        function click(link) {
            const event = new window.Event('click', { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'button', { value: 0 });
            link.dispatchEvent(event);
        }
        click(document.querySelector('.publisher-ranking-link[data-article-id="7"]'));
        assert.equal(document.querySelector('#rankings-article-viewer').classList.contains('hide'), false);
        assert.equal(document.querySelector('#rankings-article-viewer-frame').dataset.loadedUrl, 'https://www.golem.de/news/saved.html');
        click(document.querySelector('.publisher-ranking-link:not([data-article-id])'));
        assert.deepEqual(opened, ['https://www.golem.de/news/external.html']);

        mode = 'failed';
        await rankings.refreshRankings();
        assert.equal(document.querySelectorAll('#publisher-rankings li').length, 2);
        assert.match(document.querySelector('#publisher-rankings [role="status"]').textContent, /Showing the latest saved rankings/);
        assert.match(document.querySelector('#rankings-refresh').textContent, /Retry refresh/);
        assert.equal(document.querySelector('#rankings-refresh').disabled, false);

        mode = 'delayed-read';
        const oldRead = rankings.loadRankings({ force: true });
        mode = 'ready';
        const refresh = rankings.refreshRankings();
        assert.equal(rankings.refreshRankings(), refresh, 'Two clicks must share one refresh');
        await refresh;
        completeOldRead(Response.json(payload('Old response')));
        await oldRead;
        assert.match(document.querySelector('#publisher-rankings').textContent, /Refreshed Golem story/);
        assert.doesNotMatch(document.querySelector('#publisher-rankings').textContent, /Old response/);
        assert.equal(document.querySelector('#rankings-refresh').disabled, false);

        mode = 'automatic-consent-required';
        await rankings.refreshRankings();
        assert.match(document.querySelector('#publisher-rankings [role="status"]').textContent, /could not be completed automatically.*Try Refresh again.*Set up Golem access/);
        assert.equal(document.querySelector('#rankings-refresh').disabled, false);
        assert.equal(document.querySelector('#rankings-access-start').disabled, false);
        assert.equal(requests.some(request => request.url === '/api/rankings/access/start'), false, 'A failed automatic consent attempt must not open optional setup without a click');
        mode = 'ready';
        await rankings.startRankingsAccess();
        assert.equal(requests.filter(request => request.url === '/api/rankings/access/start').length, 1);
        assert.equal(document.querySelector('#rankings-access-confirm').hidden, true);
        assert.equal(requests.filter(request => request.url === '/api/rankings/access/confirm').length, 0);
        access = { ...access, state: 'awaiting_confirmation' };
        await rankings.loadRankings({ force: true });
        assert.equal(document.querySelector('#rankings-access-confirm').hidden, false);
        assert.equal(document.querySelector('#rankings-access-confirm').disabled, false);
        assert.match(document.querySelector('#rankings-access-status').textContent, /Choose your consent or PUR option/);
        assert.equal(requests.filter(request => request.url === '/api/rankings/access/confirm').length, 0, 'Reading setup status must never save access');
        assert.equal(polls.size, 1, 'Awaiting confirmation must observe browser closure and setup expiry');
        access = { ...access, state: 'error', jobId: null, saved: false };
        await runStatusPoll();
        assert.equal(document.querySelector('#rankings-access-confirm').hidden, true);
        assert.equal(document.querySelector('#rankings-access-forget').hidden, false);
        assert.equal(document.querySelector('#rankings-access-forget').disabled, false);
        await rankings.forgetRankingsAccess();
        assert.equal(document.querySelector('#rankings-access-forget').hidden, true);
        await rankings.startRankingsAccess();
        access = { ...access, state: 'awaiting_confirmation' };
        await rankings.loadRankings({ force: true });
        mode = 'consent-required';
        await rankings.confirmRankingsAccess();
        assert.match(document.querySelector('#publisher-rankings [role="status"]').textContent, /cookie consent could not be completed automatically.*Try Refresh again/);
        assert.equal(document.querySelector('#rankings-access-confirm').hidden, false);
        assert.equal(document.querySelector('#rankings-access-confirm').disabled, false);
        assert.equal(document.querySelectorAll('#publisher-rankings li').length, 2);
        mode = 'ready';
        await rankings.confirmRankingsAccess();
        assert.equal(document.querySelector('#rankings-access-forget').hidden, false);
        assert.equal(document.querySelector('#rankings-access-confirm').hidden, true);
        await rankings.forgetRankingsAccess();
        assert.equal(document.querySelector('#rankings-access-forget').hidden, true);
        await rankings.startRankingsAccess();
        access = { ...access, state: 'awaiting_confirmation' };
        await rankings.loadRankings({ force: true });
        await rankings.cancelRankingsAccess();
        assert.equal(document.querySelector('#rankings-access-confirm').hidden, true);
        assert.equal(document.querySelector('#rankings-access-cancel').hidden, true);

        configured = false;
        await rankings.loadRankings({ force: true });
        assert.match(document.querySelector('#publisher-rankings [role="status"]').textContent, /Add a Golem RSS feed in Settings/);
        assert.equal(document.querySelector('#rankings-refresh').disabled, true);
        const refreshCount = requests.filter(request => request.url === '/api/rankings/refresh').length;
        await rankings.refreshRankings();
        assert.equal(requests.filter(request => request.url === '/api/rankings/refresh').length, refreshCount);
        configured = true;
        access = { ...access, state: 'error', jobId: null, saved: false };
        await rankings.loadRankings({ force: true });
        assert.equal(document.querySelector('#rankings-access-forget').hidden, false, 'Malformed saved access must remain resettable even when saved=false');
        await rankings.forgetRankingsAccess();
        access = { ...access, state: 'error', jobId, saved: false };
        await rankings.loadRankings({ force: true });
        assert.equal(document.querySelector('#rankings-access-start').disabled, true);
        assert.equal(document.querySelector('#rankings-access-forget').disabled, true);
        assert.equal(polls.size, 1, 'A cleanup job remains active even if its state is error');
        const starts = requests.filter(request => request.url === '/api/rankings/access/start').length;
        const forgets = requests.filter(request => request.url.startsWith('/api/rankings/access?')).length;
        await rankings.startRankingsAccess();
        await rankings.forgetRankingsAccess();
        assert.equal(requests.filter(request => request.url === '/api/rankings/access/start').length, starts);
        assert.equal(requests.filter(request => request.url.startsWith('/api/rankings/access?')).length, forgets);
        access = { ...access, state: 'cancelling' };
        await runStatusPoll();
        assert.equal(document.querySelector('#rankings-access-cancel').hidden, true);
        assert.equal(document.querySelector('#rankings-access-start').disabled, true);
        access = { ...payload().access };
        await runStatusPoll();
        assert.equal(document.querySelector('#rankings-access-start').disabled, false);
        assert.equal(polls.size, 0);

        mode = 'busy';
        await rankings.refreshRankings();
        assert.equal(document.querySelector('#rankings-refresh').disabled, true);
        assert.match(document.querySelector('#publisher-rankings [role="status"]').textContent, /Refreshing publisher rankings/);
        assert.equal(requests.some(request => request.url.startsWith('/api/fetch')), false);
        assert.ok(requests.filter(request => request.url.endsWith('/refresh')).every(request => JSON.parse(request.options.body).medium === 'golem'));
    } finally {
        rankings?.deactivateRankings();
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    }
});
