import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { publisherRankingsFingerprint, normalizePublisherRankings, renderPublisherRankings } from '../components/publisher-rankings.js';

const markup = await readFile(new URL('../../index.html', import.meta.url), 'utf8');

const snapshot = () => [{
    sourceId: 1, sourceName: 'Golem', rankingKey: 'most_read', capturedAt: '2026-10-31T20:00:00Z',
    items: [{ id: 901, articleId: 7, rank: 1, canonicalUrl: 'https://www.golem.de/news/article.html#comments', title: 'Article',
        article: { id: 7, feedId: 201, url: 'https://www.golem.de/news/article.html', title: 'RSS article', teaser: 'RSS summary', content: 'Stored article', publishedAt: '2026-10-31T19:00:00Z', sourceName: 'Golem RSS', saved: true, topics: [{ slug: 'tech', label: 'Tech' }] } }],
}];

test('publisher rankings use RSS article IDs for the viewer and clean HTTP links', () => {
    const input = snapshot();
    const [group] = normalizePublisherRankings(input);
    assert.equal(group.label, 'Most read');
    assert.equal(group.capturedAt, '2026-10-31T20:00:00.000Z');
    assert.equal(group.items[0].id, 901);
    assert.equal(group.items[0].articleId, 7, 'Snapshot row IDs must never be used as article IDs');
    assert.equal(group.items[0].article.id, 7);
    assert.equal(group.items[0].canonicalUrl, 'https://www.golem.de/news/article.html');
    assert.equal(group.items[0].article.url, group.items[0].canonicalUrl);
    assert.match(input[0].items[0].canonicalUrl, /#comments/, 'Normalization must not mutate the stored payload');
});

test('functional query parameters survive ranking links and viewer article URLs', () => {
    const input = snapshot();
    input[0].items[0].canonicalUrl = 'https://www.golem.de/news/functional?id=7#comments';
    input[0].items[0].article.url = 'https://www.golem.de/news/functional?id=7#article';
    const [group] = normalizePublisherRankings(input);
    assert.equal(group.items[0].canonicalUrl, 'https://www.golem.de/news/functional?id=7');
    assert.equal(group.items[0].article.url, 'https://www.golem.de/news/functional?id=7');
});

test('rankings preserve publisher positions and keep unresolved or mismatched articles external', () => {
    const input = snapshot();
    input[0].rankingKey = 'most_commented';
    input[0].items.push({ id: 902, rank: 3, canonicalUrl: 'https://www.golem.de/news/third.html', title: 'Third', articleId: null, article: null });
    input[0].items.reverse();
    const [group] = normalizePublisherRankings(input);
    assert.equal(group.label, 'Most commented');
    assert.deepEqual(group.items.map(item => item.rank), [1, 3]);
    assert.equal(group.items[1].article, null);
    input[0].items[1].article.id = 8;
    assert.equal(normalizePublisherRankings(input)[0].items[0].article, null, 'Do not open a different article after stale reassociation');
});

test('unsafe links, invalid ranks, unsupported groups and empty groups produce no article items', () => {
    for (const canonicalUrl of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/article', 'https://user:secret@golem.de/story', 'invalid']) {
        const input = snapshot(); input[0].items[0].canonicalUrl = canonicalUrl;
        assert.deepEqual(normalizePublisherRankings(input), []);
    }
    for (const rank of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const input = snapshot(); input[0].items[0].rank = rank;
        assert.deepEqual(normalizePublisherRankings(input), []);
    }
    assert.deepEqual(normalizePublisherRankings([{ ...snapshot()[0], rankingKey: 'other' }]), []);
    assert.deepEqual(normalizePublisherRankings([{ ...snapshot()[0], items: [] }]), []);
    assert.deepEqual(normalizePublisherRankings(null), []);
});

test('Most read has its own main menu, publisher selector and viewer outside Digest', async () => {
    const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
    const { document } = parseHTML(html);
    const container = document.querySelector('#view-rankings #publisher-rankings');
    assert.ok(container);
    assert.equal(container.hasAttribute('hidden'), false);
    assert.equal(document.querySelector('#view-digest #publisher-rankings'), null);
    assert.equal(document.querySelectorAll('.nav-link[data-view="rankings"]').length, 1);
    assert.deepEqual([...document.querySelectorAll('#rankings-medium option')].map(option => [option.value, option.textContent]), [['golem', 'Golem'], ['winfuture', 'WinFuture'], ['computerbase', 'ComputerBase'], ['heise-ix', 'heise iX']]);
    assert.equal(document.querySelector('#rankings-medium').hasAttribute('data-oj-select-dropdown'), true);
    assert.ok(document.querySelector('#view-rankings #rankings-refresh'));
    assert.ok(document.querySelector('#view-rankings #rankings-article-viewer-frame'));
    assert.equal(container.querySelector('.publisher-rankings-note'), null);
    assert.match(document.querySelector('#rankings-refresh').title, /Refresh Golem rankings/);
    assert.equal(document.querySelector('[id^="rankings-access-"]'), null);
    assert.equal(container.querySelector('h2'), null);
    assert.match(container.querySelector('[role="status"]').textContent, /Loading/);
    assert.equal(container.querySelectorAll('li').length, 0);
});

test('rankings show one compact empty or error state without repeated introductory prose', () => {
    const previousDocument = globalThis.document;
    const { document } = parseHTML('<html><body><section id="rankings" hidden></section></body></html>');
    globalThis.document = document;
    try {
        const container = document.querySelector('#rankings');
        const cases = [
            [[], undefined, /No rankings yet/],
            [[], { state: 'loading' }, /Loading/],
            [[], { state: 'refreshing' }, /Refreshing/],
            [[{ ...snapshot()[0], items: [] }], { state: 'ready' }, /No articles available/],
            [[], { state: 'error', message: 'chrome --no-sandbox\nError: failed at browser.js:12' }, /Could not load rankings/],
            [[], { state: 'error', errorCode: 'GOLEM_CONSENT_REQUIRED' }, /Consent could not be completed.*Retry refresh/],
        ];
        for (const [rankings, status, message] of cases) {
            renderPublisherRankings(container, rankings, new Map(), { status });
            assert.equal(container.hidden, false);
            assert.equal(container.querySelector('h2'), null);
            assert.match(container.querySelector('[role="status"]').textContent, message);
            assert.equal(container.querySelectorAll('li').length, 0, 'Status displays must never invent articles');
            assert.doesNotMatch(container.textContent, /--no-sandbox|browser\.js|Error:/);
        }
        renderPublisherRankings(container, [], new Map(), { configured: false, publisherName: 'WinFuture' });
        assert.match(container.textContent, /Add a WinFuture RSS feed/);
        assert.doesNotMatch(container.textContent, /Golem/);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});

test('refreshing or failed rankings keep the actual captured snapshot and its viewer article IDs', () => {
    const previousDocument = globalThis.document;
    const { document } = parseHTML(markup);
    globalThis.document = document;
    try {
        const container = document.querySelector('#publisher-rankings');
        const articles = new Map();
        for (const state of ['refreshing', 'error']) {
            renderPublisherRankings(container, snapshot(), articles, { status: { state } });
            assert.equal(container.hidden, false);
            assert.equal(container.querySelector('[role="status"]').hidden, true);
            assert.equal(container.querySelectorAll('li').length, 1);
            assert.equal(container.querySelector('.feed-card').dataset.articleId, '7');
            assert.equal(container.querySelector('time').dateTime, '2026-10-31T20:00:00.000Z');
            assert.equal(articles.get(7).id, 7);
        }
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});

test('rankings reuse Feed cards with actual RSS details and a title-only unmatched fallback', () => {
    const previousDocument = globalThis.document;
    const { document } = parseHTML(markup);
    globalThis.document = document;
    try {
        const input = snapshot();
        input[0].items.push({ id: 902, articleId: null, rank: 3, canonicalUrl: 'https://www.golem.de/news/unmatched.html', title: 'Actual publisher title', article: null });
        const container = document.querySelector('#publisher-rankings');
        renderPublisherRankings(container, input, new Map(), { status: { state: 'ready' } });
        const cards = container.querySelectorAll('.feed-card');
        assert.equal(cards.length, 2);
        assert.deepEqual([...container.querySelectorAll('.publisher-ranking-rank')].map(rank => rank.textContent), ['#1', '#3']);
        assert.equal(container.querySelector('.publisher-ranking-title').textContent, 'Most read');
        assert.equal(cards[0].querySelector('.article-title-button').textContent, 'RSS article');
        assert.equal(cards[0].querySelector('.teaser').textContent, 'RSS summary');
        assert.equal(cards[0].querySelector('.article-save-btn').classList.contains('is-saved'), true);
        assert.equal(cards[0].querySelector('.meta-source').dataset.feedId, '201');
        assert.equal(cards[0].querySelector('[data-action="filter-topic"]').dataset.topicSlug, 'tech');
        assert.equal(cards[1].hasAttribute('data-article-id'), false);
        assert.equal(cards[1].querySelector('.article-title-button').textContent, 'Actual publisher title');
        assert.equal(cards[1].querySelector('.teaser').textContent, '');
        assert.equal(cards[1].querySelector('.teaser').hidden, true);
        assert.equal(cards[1].querySelector('.article-save-btn').disabled, true);
        assert.equal(cards[1].querySelector('.article-dismiss-btn').disabled, true);
        assert.equal(cards[1].querySelector('.btn-open-external').disabled, false);
        assert.equal(container.querySelector('.publisher-rankings-note'), null);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});

test('ranking changes update the standalone view fingerprint', () => {
    const base = snapshot();
    const fingerprint = publisherRankingsFingerprint(base);
    assert.equal(fingerprint, publisherRankingsFingerprint(structuredClone(base)));
    for (const change of [
        groups => { groups[0].sourceId = 2; },
        groups => { groups[0].sourceName = 'New source name'; },
        groups => { groups[0].rankingKey = 'most_commented'; },
        groups => { groups[0].capturedAt = '2026-10-31T20:05:00Z'; },
        groups => { groups[0].items[0].id = 903; },
        groups => { groups[0].items[0].rank = 2; },
        groups => { groups[0].items[0].title = 'New title'; },
        groups => { groups[0].items[0].canonicalUrl = 'https://www.golem.de/news/new.html'; },
        groups => { groups[0].items[0].articleId = 8; },
        groups => { groups[0].items[0].article.content = 'Updated article'; },
    ]) {
        const changed = structuredClone(base); change(changed);
        assert.notEqual(fingerprint, publisherRankingsFingerprint(changed));
    }
});

test('ComputerBase renders only its available most-read group with the matched RSS Feed card', () => {
    const previousDocument = globalThis.document;
    const { document } = parseHTML(markup);
    globalThis.document = document;
    try {
        const rankings = snapshot();
        Object.assign(rankings[0], { sourceId: 3, sourceName: 'ComputerBase' });
        Object.assign(rankings[0].items[0], {
            canonicalUrl: 'https://www.computerbase.de/news/pc-systeme/computerbase-fixture.12345/',
            article: { ...rankings[0].items[0].article, sourceName: 'ComputerBase RSS', title: 'ComputerBase RSS headline', teaser: 'ComputerBase RSS teaser.', url: 'https://www.computerbase.de/news/pc-systeme/computerbase-fixture.12345/' },
        });
        const container = document.querySelector('#publisher-rankings');
        const articles = new Map();
        renderPublisherRankings(container, rankings, articles, { status: { state: 'ready' }, publisherName: 'ComputerBase' });
        assert.equal(container.querySelectorAll('.publisher-ranking-panel').length, 1);
        assert.equal(container.querySelector('.publisher-ranking-title').textContent, 'Most read');
        assert.equal(container.querySelector('[data-ranking-key="most_commented"]'), null);
        assert.equal(container.querySelector('.feed-card .article-title-button').textContent, 'ComputerBase RSS headline');
        assert.equal(container.querySelector('.feed-card .teaser').textContent, 'ComputerBase RSS teaser.');
        assert.equal(articles.get(7).sourceName, 'ComputerBase RSS');
        assert.doesNotMatch(container.textContent, /Most commented|Golem|WinFuture/);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});

test('heise iX editorial Top-News keeps its distinct label and matched RSS Feed card', () => {
    const previousDocument = globalThis.document;
    const { document } = parseHTML(markup);
    globalThis.document = document;
    try {
        const rankings = snapshot();
        Object.assign(rankings[0], { sourceId: 5, sourceName: 'heise iX', rankingKey: 'top_news' });
        Object.assign(rankings[0].items[0], {
            canonicalUrl: 'https://www.heise.de/ix/news/heise-ix-fixture-12345.html',
            article: { ...rankings[0].items[0].article, sourceName: 'heise iX RSS', title: 'heise iX RSS headline', teaser: 'heise iX RSS teaser.', url: 'https://www.heise.de/ix/news/heise-ix-fixture-12345.html' },
        });
        const container = document.querySelector('#publisher-rankings');
        const articles = new Map();
        renderPublisherRankings(container, rankings, articles, { status: { state: 'ready' }, publisherName: 'heise iX' });
        assert.equal(container.querySelectorAll('.publisher-ranking-panel').length, 1);
        assert.equal(container.querySelector('.publisher-ranking-title').textContent, 'Top-News');
        assert.equal(container.querySelector('[data-ranking-key="top_news"]')?.tagName, 'SECTION');
        assert.equal(container.querySelector('[data-ranking-key="most_read"], [data-ranking-key="most_commented"]'), null);
        assert.equal(container.querySelector('.feed-card .article-title-button').textContent, 'heise iX RSS headline');
        assert.equal(container.querySelector('.feed-card .teaser').textContent, 'heise iX RSS teaser.');
        assert.equal(articles.get(7).sourceName, 'heise iX RSS');
        assert.doesNotMatch(container.textContent, /Most read|Most commented|Golem|WinFuture/);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});

test('ranking status updates refresh even when captured articles remain unchanged', () => {
    const rankings = snapshot();
    const status = { state: 'refreshing', message: null, attemptedAt: '2026-11-01T07:00:00Z' };
    const fingerprint = publisherRankingsFingerprint(rankings, status);
    assert.equal(fingerprint, publisherRankingsFingerprint(rankings, { ...status }));
    for (const change of [
        { state: 'ready' },
        { state: 'error', message: 'Publisher rankings could not be refreshed.' },
        { attemptedAt: '2026-11-01T07:05:00Z' },
    ]) {
        assert.notEqual(fingerprint, publisherRankingsFingerprint(rankings, { ...status, ...change }));
    }
});
