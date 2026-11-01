import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseHTML } from 'linkedom';

test('All media paginates, preserves loaded depth and ignores stale source/deactivation responses', async t => {
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const { document, window } = parseHTML(await readFile(new URL('../../index.html', import.meta.url), 'utf8'));
    globalThis.document = document;
    globalThis.window = window;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
    const select = document.querySelector('#rankings-medium');
    Object.defineProperty(select, 'value', { configurable: true, writable: true, value: 'all' });
    window.scrollTo = () => {};
    let observer;
    window.IntersectionObserver = class {
        constructor(callback, options) { observer = { callback, options, target: null }; }
        observe(target) { observer.target = target; }
        disconnect() { observer.target = null; }
    };
    const media = ['golem', 'winfuture', 'computerbase', 'heise-ix', 't3n', 'techcrunch', 'arstechnica'].map(id => ({ id, name: id }));
    let items = Array.from({ length: 96 }, (_, index) => ({
        id: index + 1, feedId: 1, title: `RSS story ${index + 1}`, teaser: 'Stored RSS teaser.', sourceName: `${media[index % media.length].name} RSS`,
        url: `https://example.test/story/${index + 1}`, canonicalUrl: `https://example.test/story/${index + 1}`, saved: false,
        medium: media[index % media.length].id, rankings: [{ medium: media[index % media.length].id, rankingKey: [3, 5].includes(index % media.length) ? 'top_news' : 'most_read',
            ...(index % media.length === 5 ? { label: 'Top Headlines' } : {}), rank: 1, capturedAt: '2026-11-01T00:00:00Z' }],
    }));
    const page = (cursor = '') => {
        const offset = cursor === 'page2' ? 40 : cursor === 'page3' ? 80 : 0;
        return { medium: 'all', media, configured: true, rankingStatus: { state: 'ready' },
            items: [...(offset === 80 ? [items[0]] : []), ...items.slice(offset, offset + 40)],
            hasMore: offset < 80, nextCursor: offset === 0 ? 'page2' : offset === 40 ? 'page3' : null };
    };
    const grouped = { medium: 'golem', media, configured: true, rankingStatus: { state: 'ready' }, rankings: [{ sourceId: 1, sourceName: 'Golem', rankingKey: 'most_read', capturedAt: '2026-11-01',
        items: [{ id: 900, articleId: 1001, rank: 1, title: 'Grouped story', canonicalUrl: 'https://www.golem.de/news/grouped.html', article: { id: 1001, title: 'Grouped RSS story', url: 'https://www.golem.de/news/grouped.html' } }] }] };
    const requests = [];
    let pageFailure = false, holdPage = false, heldPage, holdRefresh = false, heldRefresh, refreshFailure = null;
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        if (url === '/api/rankings/refresh') {
            assert.deepEqual(JSON.parse(options.body), { medium: 'all' });
            if (refreshFailure) return Response.json(refreshFailure === 'partial'
                ? { ...page(), error: 'One publisher failed', rankingStatus: { state: 'error' } }
                : { error: 'No usable publisher response' }, { status: 502 });
            if (holdRefresh) {
                const captured = page();
                return new Promise(resolve => { heldRefresh = () => resolve(Response.json(captured)); });
            }
            return Response.json(page());
        }
        if (url === '/api/rankings?medium=golem') return Response.json(grouped);
        const parsed = new URL(url, 'http://localhost');
        assert.equal(parsed.pathname, '/api/rankings/top');
        assert.equal(parsed.searchParams.get('medium'), 'all');
        assert.equal(parsed.searchParams.get('limit'), '40');
        const cursor = parsed.searchParams.get('cursor');
        if (cursor && holdPage) return new Promise(resolve => { heldPage = () => resolve(Response.json(page(cursor))); });
        if (cursor && pageFailure) return Response.json({ error: 'Unavailable' }, { status: 503 });
        return Response.json(page(cursor));
    };
    const settle = () => new Promise(setImmediate);
    const cards = () => document.querySelectorAll('#publisher-rankings .feed-card');
    let rankings;
    try {
        rankings = await import('../views/rankings.js');
        const { store } = await import('../state/store.js');
        const { initNavigation, navigate } = await import('../ui/navigation.js');
        initNavigation(name => name === 'rankings' ? rankings.activateRankings() : undefined);
        await navigate('rankings');
        assert.equal(store.ui.rankingsMedium, 'all');
        assert.equal(cards().length, 40);
        assert.match(document.querySelector('#publisher-rankings').textContent, /Top-News/);
        assert.match(document.querySelector('#publisher-rankings').textContent, /Top Headlines/);
        assert.match(document.querySelector('#publisher-rankings').textContent, /arstechnica RSS/);
        assert.equal(document.querySelector('.publisher-ranking-panel'), null);
        assert.equal(observer.target.id, 'rankings-load-more');
        assert.equal(observer.options.rootMargin, '320px 0px');
        const firstRow = document.querySelector('.publisher-top-list > li');
        await rankings.loadMoreRankings();
        assert.equal(cards().length, 80);
        assert.equal(document.querySelector('.publisher-top-list > li'), firstRow);
        observer.callback([{ isIntersecting: true }]);
        await settle();
        assert.equal(cards().length, 96, 'Overlap between pages must not create a duplicate card');
        assert.equal(document.querySelector('#rankings-load-more').hidden, true);
        assert.equal(store.rankings.loadedPages, 3);

        const click = target => {
            const event = new window.Event('click', { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'button', { value: 0 }); target.dispatchEvent(event);
        };
        click(document.querySelector('[data-article-id="51"] .article-title-button'));
        assert.equal(document.querySelector('#rankings-article-viewer-frame').dataset.loadedUrl, 'https://example.test/story/51');
        items = items.map(item => item.id === 51 ? { ...item, saved: true } : item);
        await rankings.loadRankings({ force: true, silent: true });
        assert.equal(cards().length, 96);
        assert.equal(document.querySelector('[data-article-id="51"] .article-save-btn').classList.contains('is-saved'), true);
        assert.equal(document.querySelector('#rankings-article-viewer-frame').dataset.loadedUrl, 'https://example.test/story/51');
        await rankings.refreshRankings();
        assert.equal(cards().length, 96, 'Manual refresh must retain all loaded pages');

        await t.test('a partial 502 refresh updates all loaded pages without SSE and retains its error status', async () => {
            items = items.map(item => item.id === 2 ? { ...item, title: 'New first-page result after partial refresh' }
                : item.id === 61 ? { ...item, teaser: 'New later-page RSS details.' } : item);
            refreshFailure = 'partial';
            const beforePartial = requests.length;
            await rankings.refreshRankings();
            assert.equal(cards().length, 96, 'A 502 with a valid updated page retains the loaded collection');
            assert.equal(store.rankings.loadedPages, 3);
            assert.equal(document.querySelector('[data-article-id="2"] .article-title-button').textContent, 'New first-page result after partial refresh');
            assert.equal(document.querySelector('[data-article-id="61"] .teaser').textContent, 'New later-page RSS details.');
            assert.equal(requests.slice(beforePartial).filter(request => request.url.includes('cursor=')).length, 2, 'Partial refresh hydrates every previously loaded page without SSE');
            assert.equal(store.rankings.payload.rankingStatus.state, 'error');
            assert.match(document.querySelector('#rankings-refresh').textContent, /Retry refresh/);
            assert.equal(document.querySelector('#rankings-refresh').disabled, false);
            assert.equal(document.querySelector('#publisher-rankings [role="status"]').hidden, true);

            refreshFailure = 'empty';
            items = items.map(item => item.id === 2 ? { ...item, title: 'Not returned in the failed response' } : item);
            await rankings.refreshRankings();
            assert.equal(cards().length, 96);
            assert.equal(document.querySelector('[data-article-id="2"] .article-title-button').textContent, 'New first-page result after partial refresh', 'An unusable failure response retains the last good collection');
            refreshFailure = null;
        });

        holdRefresh = true;
        const refresh = rankings.refreshRankings();
        const staleFirstPage = page();
        items = items.map(item => item.id === 1 ? { ...item, saved: true } : item);
        rankings.markRankingsDirty();
        await rankings.loadRankings({ force: true, silent: true });
        // Return a snapshot captured before the list event; the deferred read
        // must replace its first-page saved state after Refresh settles.
        heldRefresh();
        await refresh; await settle();
        assert.equal(cards().length, 96);
        assert.equal(document.querySelector('[data-article-id="1"] .article-save-btn').classList.contains('is-saved'), true);
        assert.equal(staleFirstPage.items[0].saved, false);
        holdRefresh = false;

        async function switchTo(medium) { select.value = medium; select.dispatchEvent(new window.Event('change')); await settle(); }
        await switchTo('golem');
        assert.equal(cards().length, 1);
        assert.equal(document.querySelector('#rankings-load-more').hidden, true);
        await switchTo('all');
        assert.equal(cards().length, 40);
        pageFailure = true;
        await rankings.loadMoreRankings();
        assert.equal(cards().length, 40);
        assert.equal(document.querySelector('#rankings-load-more').textContent, 'Retry load more');
        assert.equal(document.querySelector('#rankings-load-more').disabled, false);
        pageFailure = false;
        await rankings.loadMoreRankings();
        assert.equal(cards().length, 80);

        holdPage = true;
        const append = rankings.loadMoreRankings();
        const appendRequest = requests.at(-1);
        await switchTo('golem');
        assert.equal(appendRequest.options.signal.aborted, true);
        heldPage(); await append;
        assert.equal(cards().length, 1);
        assert.match(document.querySelector('#publisher-rankings').textContent, /Grouped RSS story/);
        holdPage = false;
        await switchTo('all');
        holdPage = true;
        const leaving = rankings.loadMoreRankings();
        const leavingRequest = requests.at(-1);
        rankings.deactivateRankings();
        assert.equal(leavingRequest.options.signal.aborted, true);
        heldPage(); await leaving;
        assert.equal(cards().length, 40);
        assert.equal(observer.target, null);
    } finally {
        rankings?.deactivateRankings();
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
        if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage;
    }
});
