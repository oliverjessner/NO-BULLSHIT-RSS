import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseHTML } from 'linkedom';

const payload = (title = 'Saved Golem story') => ({
    medium: 'golem', media: [{ id: 'golem', name: 'Golem' }, { id: 'winfuture', name: 'WinFuture' }, { id: 'computerbase', name: 'ComputerBase' }, { id: 'heise-ix', name: 'heise iX' }], configured: true,
    rankingStatus: { state: 'ready', message: null, attemptedAt: '2026-11-01T07:00:00Z' },
    rankings: [{ sourceId: 1, sourceName: 'Golem', rankingKey: 'most_read', capturedAt: '2026-11-01T07:00:00Z', items: [
        { id: 901, articleId: 7, rank: 1, canonicalUrl: 'https://www.golem.de/news/saved.html', title,
            article: { id: 7, title, url: 'https://www.golem.de/news/saved.html' } },
        { id: 902, articleId: null, rank: 2, canonicalUrl: 'https://www.golem.de/news/external.html', title: 'External story', article: null },
    ] }],
});

function winFuturePayload(title = 'Saved WinFuture story') {
    const base = payload(title);
    return { ...base, medium: 'winfuture', rankings: base.rankings.map(group => ({
        ...group, sourceId: 2, sourceName: 'WinFuture', items: group.items.map(item => ({
            ...item, canonicalUrl: 'https://winfuture.de/news,162334.html', articleId: item.articleId ? 17 : null,
            article: item.article ? { ...item.article, id: 17, url: 'https://winfuture.de/news,162334.html' } : null,
        })),
    })) };
}

function computerBasePayload(title = 'Saved ComputerBase story') {
    const base = payload(title);
    const url = 'https://www.computerbase.de/news/pc-systeme/computerbase-fixture.12345/';
    return { ...base, medium: 'computerbase', rankings: [{
        ...base.rankings[0], sourceId: 3, sourceName: 'ComputerBase', items: [{
            ...base.rankings[0].items[0], canonicalUrl: url, articleId: 27,
            article: { ...base.rankings[0].items[0].article, id: 27, url, teaser: 'ComputerBase RSS teaser.' },
        }],
    }] };
}

function heiseIxPayload(title = 'Saved heise iX editorial story') {
    const base = payload(title);
    const url = 'https://www.heise.de/ix/news/heise-ix-fixture-12345.html';
    return { ...base, medium: 'heise-ix', rankings: [{
        ...base.rankings[0], sourceId: 5, sourceName: 'heise iX', rankingKey: 'top_news', items: [{
            ...base.rankings[0].items[0], canonicalUrl: url, articleId: 37,
            article: { ...base.rankings[0].items[0].article, id: 37, url, teaser: 'heise iX RSS teaser.' },
        }],
    }] };
}

test('Most read uses automatic consent refresh with its own viewer, saved snapshots and request ordering', async () => {
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const { document, window } = parseHTML(await readFile(new URL('../../index.html', import.meta.url), 'utf8'));
    globalThis.document = document;
    globalThis.window = window;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
    // Linkedom exposes a getter-only select value; provide the writable browser
    // boundary used by the controller while retaining the actual page markup.
    Object.defineProperty(document.querySelector('#rankings-medium'), 'value', { configurable: true, writable: true, value: 'golem' });
    window.scrollTo = () => {};
    const opened = [];
    window.open = url => { opened.push(url); return null; };
    const requests = [];
    let mode = 'ready';
    let configured = true;
    let completeOldRead;
    const polls = new Map();
    globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay !== 1500) return previous.setTimeout(callback, delay, ...args);
        const id = Symbol('rankings status poll'); polls.set(id, callback); return id;
    };
    globalThis.clearTimeout = id => { if (!polls.delete(id)) previous.clearTimeout(id); };
    async function runStatusPoll() {
        assert.equal(polls.size, 1);
        const [id, callback] = polls.entries().next().value;
        polls.delete(id); callback();
        await new Promise(setImmediate);
    }
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        if (url === '/api/rankings/refresh') {
            if (JSON.parse(options.body).medium === 'heise-ix') return Response.json(heiseIxPayload('Refreshed heise iX editorial story'));
            if (JSON.parse(options.body).medium === 'computerbase') return Response.json(computerBasePayload('Refreshed ComputerBase story'));
            if (JSON.parse(options.body).medium === 'winfuture') return Response.json(winFuturePayload('Refreshed WinFuture story'));
            if (mode === 'failed') return Response.json({ ...payload(), error: 'Could not refresh', rankingStatus: { state: 'error' } }, { status: 502 });
            if (mode === 'consent-required') return Response.json({ ...payload(), error: 'Automatic consent could not be completed', rankingStatus: { state: 'error', errorCode: 'GOLEM_CONSENT_REQUIRED' } }, { status: 502 });
            if (mode === 'busy') return Response.json({ error: 'Refresh already running' }, { status: 409 });
            return Response.json(payload('Refreshed Golem story'));
        }
        if (url === '/api/rankings?medium=winfuture') {
            const current = winFuturePayload();
            return Response.json({ ...current, configured, rankings: configured ? current.rankings : [], rankingStatus: configured ? current.rankingStatus : { state: 'idle' } });
        }
        if (url === '/api/rankings?medium=computerbase') return Response.json(computerBasePayload());
        if (url === '/api/rankings?medium=heise-ix') return Response.json(heiseIxPayload());
        assert.equal(url, '/api/rankings?medium=golem');
        if (mode === 'delayed-read') return new Promise(resolve => { completeOldRead = resolve; });
        return Response.json({ ...payload(), configured, rankings: configured ? payload().rankings : [], rankingStatus: configured ? payload().rankingStatus : { state: 'idle' } });
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
        assert.equal(document.querySelector('#rankings-refresh').disabled, false);
        assert.equal(document.querySelector('[id^="rankings-access-"]'), null);

        function click(link) {
            const event = new window.Event('click', { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'button', { value: 0 });
            link.dispatchEvent(event);
        }
        click(document.querySelector('.publisher-ranking-card[data-article-id="7"] .article-title-button'));
        assert.equal(document.querySelector('#rankings-article-viewer').classList.contains('hide'), false);
        assert.equal(document.querySelector('#rankings-article-viewer-frame').dataset.loadedUrl, 'https://www.golem.de/news/saved.html');
        click(document.querySelector('.publisher-ranking-card:not([data-article-id]) .article-title-button'));
        assert.deepEqual(opened, ['https://www.golem.de/news/external.html']);

        mode = 'failed';
        await rankings.refreshRankings();
        assert.equal(document.querySelectorAll('#publisher-rankings li').length, 2);
        assert.equal(document.querySelector('#publisher-rankings [role="status"]').hidden, true);
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

        mode = 'consent-required';
        await rankings.refreshRankings();
        assert.equal(document.querySelector('#publisher-rankings [role="status"]').hidden, true);
        assert.match(document.querySelector('#publisher-rankings [role="status"]').title, /could not be completed automatically/);
        assert.doesNotMatch(document.querySelector('#publisher-rankings').textContent, /Set up|Save access|PUR/);
        assert.equal(document.querySelector('#rankings-refresh').disabled, false);

        mode = 'ready';
        configured = false;
        await rankings.loadRankings({ force: true });
        assert.match(document.querySelector('#publisher-rankings [role="status"]').textContent, /Add a Golem RSS feed in Settings/);
        assert.equal(document.querySelector('#rankings-refresh').disabled, true);
        const refreshCount = requests.filter(request => request.url === '/api/rankings/refresh').length;
        await rankings.refreshRankings();
        assert.equal(requests.filter(request => request.url === '/api/rankings/refresh').length, refreshCount);
        configured = true;
        await rankings.loadRankings({ force: true });

        mode = 'busy';
        await rankings.refreshRankings();
        assert.equal(document.querySelector('#rankings-refresh').disabled, true);
        assert.equal(polls.size, 1);
        mode = 'ready';
        await runStatusPoll();
        assert.equal(document.querySelector('#rankings-refresh').disabled, false);
        assert.equal(polls.size, 0);
        assert.equal(requests.some(request => request.url.startsWith('/api/fetch') || request.url.includes('/access')), false);

        // A provider switch invalidates a pending response from the old medium
        // and closes its article viewer before rendering the newly selected one.
        mode = 'delayed-read';
        const oldGolemRead = rankings.loadRankings({ force: true });
        mode = 'ready';
        const select = document.querySelector('#rankings-medium');
        select.value = 'winfuture';
        select.dispatchEvent(new window.Event('change'));
        await new Promise(setImmediate);
        assert.equal(store.ui.rankingsMedium, 'winfuture');
        assert.match(document.querySelector('#publisher-rankings').textContent, /Saved WinFuture story/);
        assert.equal(store.rankings.articlesById.has(7), false);
        assert.equal(store.rankings.articlesById.get(17).title, 'Saved WinFuture story');
        assert.equal(document.querySelector('#rankings-article-viewer').classList.contains('hide'), true);
        completeOldRead(Response.json(payload('Late Golem response')));
        await oldGolemRead;
        assert.doesNotMatch(document.querySelector('#publisher-rankings').textContent, /Late Golem response/);
        assert.equal(select.value, 'winfuture');
        await rankings.refreshRankings();
        assert.deepEqual(JSON.parse(requests.filter(request => request.url.endsWith('/refresh')).at(-1).options.body), { medium: 'winfuture' });
        assert.match(document.querySelector('#publisher-rankings').textContent, /Refreshed WinFuture story/);
        configured = false;
        await rankings.loadRankings({ force: true });
        assert.match(document.querySelector('#publisher-rankings').textContent, /Add a WinFuture RSS feed/);
        assert.doesNotMatch(document.querySelector('#publisher-rankings').textContent, /Golem/);
        configured = true;
        select.value = 'computerbase';
        select.dispatchEvent(new window.Event('change'));
        await new Promise(setImmediate);
        assert.equal(store.ui.rankingsMedium, 'computerbase');
        assert.deepEqual([...document.querySelectorAll('.publisher-ranking-title')].map(title => title.textContent), ['Most read']);
        assert.equal(document.querySelectorAll('#publisher-rankings .feed-card').length, 1);
        assert.equal(document.querySelector('#publisher-rankings .teaser').textContent, 'ComputerBase RSS teaser.');
        assert.equal(store.rankings.articlesById.has(17), false);
        click(document.querySelector('.publisher-ranking-card[data-article-id="27"] .article-title-button'));
        assert.equal(document.querySelector('#rankings-article-viewer-frame').dataset.loadedUrl, 'https://www.computerbase.de/news/pc-systeme/computerbase-fixture.12345/');
        await rankings.refreshRankings();
        assert.deepEqual(JSON.parse(requests.filter(request => request.url.endsWith('/refresh')).at(-1).options.body), { medium: 'computerbase' });
        assert.match(document.querySelector('#publisher-rankings').textContent, /Refreshed ComputerBase story/);
        select.value = 'heise-ix';
        select.dispatchEvent(new window.Event('change'));
        await new Promise(setImmediate);
        assert.equal(store.ui.rankingsMedium, 'heise-ix');
        assert.deepEqual([...document.querySelectorAll('.publisher-ranking-title')].map(title => title.textContent), ['Top-News']);
        assert.equal(document.querySelectorAll('#publisher-rankings .feed-card').length, 1);
        assert.equal(document.querySelector('#publisher-rankings .teaser').textContent, 'heise iX RSS teaser.');
        assert.equal(store.rankings.articlesById.has(27), false);
        assert.doesNotMatch(document.querySelector('#publisher-rankings').textContent, /Most read|Most commented/);
        click(document.querySelector('.publisher-ranking-card[data-article-id="37"] .article-title-button'));
        assert.equal(document.querySelector('#rankings-article-viewer-frame').dataset.loadedUrl, 'https://www.heise.de/ix/news/heise-ix-fixture-12345.html');
        await rankings.refreshRankings();
        assert.deepEqual(JSON.parse(requests.filter(request => request.url.endsWith('/refresh')).at(-1).options.body), { medium: 'heise-ix' });
        assert.match(document.querySelector('#publisher-rankings').textContent, /Refreshed heise iX editorial story/);
        select.value = 'golem';
        select.dispatchEvent(new window.Event('change'));
        await new Promise(setImmediate);
        assert.equal(store.ui.rankingsMedium, 'golem');
        assert.match(document.querySelector('#publisher-rankings').textContent, /Saved Golem story/);
    } finally {
        rankings?.deactivateRankings();
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
        if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
        else delete globalThis.localStorage;
    }
});
