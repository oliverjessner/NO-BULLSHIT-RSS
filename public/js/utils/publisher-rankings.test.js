import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { publisherRankingsFingerprint, normalizePublisherRankings, renderPublisherRankings } from '../components/publisher-rankings.js';

const snapshot = () => [{
    sourceId: 1, sourceName: 'Golem', rankingKey: 'most_read', capturedAt: '2026-10-31T20:00:00Z',
    items: [{ id: 901, articleId: 7, rank: 1, canonicalUrl: 'https://www.golem.de/news/article.html#comments', title: 'Article',
        article: { id: 7, url: 'https://www.golem.de/news/article.html', title: 'RSS article', content: 'Stored article' } }],
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

test('Most read has its own main menu, Golem-only medium selector and viewer outside Digest', async () => {
    const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
    const { document } = parseHTML(html);
    const container = document.querySelector('#view-rankings #publisher-rankings');
    assert.ok(container);
    assert.equal(container.hasAttribute('hidden'), false);
    assert.equal(document.querySelector('#view-digest #publisher-rankings'), null);
    assert.equal(document.querySelectorAll('.nav-link[data-view="rankings"]').length, 1);
    assert.deepEqual([...document.querySelectorAll('#rankings-medium option')].map(option => [option.value, option.textContent]), [['golem', 'Golem']]);
    assert.equal(document.querySelector('#rankings-medium').hasAttribute('data-oj-select-dropdown'), true);
    assert.ok(document.querySelector('#view-rankings #rankings-refresh'));
    assert.ok(document.querySelector('#view-rankings #rankings-article-viewer-frame'));
    assert.ok(document.querySelector('#rankings-access-start'));
    assert.equal(document.querySelector('#rankings-access-confirm').hasAttribute('hidden'), true);
    assert.equal(document.querySelector('#rankings-access-forget').hasAttribute('hidden'), true);
    assert.match(container.querySelector('h2').textContent, /Most read & most commented/);
    assert.match(container.querySelector('[role="status"]').textContent, /Loading publisher rankings/);
    assert.equal(container.querySelectorAll('li').length, 0);
});

test('rankings heading stays visible through idle, loading, refreshing, filtered and error states', () => {
    const previousDocument = globalThis.document;
    const { document } = parseHTML('<html><body><section id="rankings" hidden></section></body></html>');
    globalThis.document = document;
    try {
        const container = document.querySelector('#rankings');
        const cases = [
            [[], undefined, /No publisher rankings yet/],
            [[], { state: 'loading' }, /Loading publisher rankings/],
            [[], { state: 'refreshing' }, /Refreshing publisher rankings/],
            [[{ ...snapshot()[0], items: [] }], { state: 'ready' }, /No publisher rankings are available/],
            [[], { state: 'error', message: 'chrome --no-sandbox\nError: failed at browser.js:12' }, /Publisher rankings could not be refreshed/],
            [[], { state: 'error', errorCode: 'GOLEM_CONSENT_REQUIRED' }, /Golem requires a consent or PUR choice.*Set up Golem access/],
        ];
        for (const [rankings, status, message] of cases) {
            renderPublisherRankings(container, rankings, new Map(), { status });
            assert.equal(container.hidden, false);
            assert.equal(container.querySelector('h2').textContent, 'Most read & most commented');
            assert.match(container.querySelector('[role="status"]').textContent, message);
            assert.equal(container.querySelectorAll('li').length, 0, 'Status displays must never invent articles');
            assert.doesNotMatch(container.textContent, /--no-sandbox|browser\.js|Error:/);
        }
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});

test('refreshing or failed rankings keep the actual captured snapshot and its viewer article IDs', () => {
    const previousDocument = globalThis.document;
    const { document } = parseHTML('<html><body><section id="rankings"></section></body></html>');
    globalThis.document = document;
    try {
        const container = document.querySelector('#rankings');
        const articles = new Map();
        for (const state of ['refreshing', 'error']) {
            renderPublisherRankings(container, snapshot(), articles, { status: { state } });
            assert.equal(container.hidden, false);
            assert.match(container.querySelector('[role="status"]').textContent, /Showing the latest saved rankings/);
            assert.equal(container.querySelectorAll('li').length, 1);
            assert.equal(container.querySelector('li a').dataset.articleId, '7');
            assert.equal(container.querySelector('time').dateTime, '2026-10-31T20:00:00.000Z');
            assert.equal(articles.get(7).id, 7);
        }
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
