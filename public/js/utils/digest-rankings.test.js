import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { digestRankingsFingerprint, normalizeDigestRankings, renderDigestRankings } from '../components/digest-rankings.js';

const snapshot = () => [{
    sourceId: 1, sourceName: 'Golem', rankingKey: 'most_read', capturedAt: '2026-10-31T20:00:00Z',
    items: [{ id: 901, articleId: 7, rank: 1, canonicalUrl: 'https://www.golem.de/news/article.html#comments', title: 'Article',
        article: { id: 7, url: 'https://www.golem.de/news/article.html', title: 'RSS article', content: 'Stored article' } }],
}];

test('publisher rankings use RSS article IDs for the viewer and clean HTTP links', () => {
    const input = snapshot();
    const [group] = normalizeDigestRankings(input);
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
    const [group] = normalizeDigestRankings(input);
    assert.equal(group.items[0].canonicalUrl, 'https://www.golem.de/news/functional?id=7');
    assert.equal(group.items[0].article.url, 'https://www.golem.de/news/functional?id=7');
});

test('rankings preserve publisher positions and keep unresolved or mismatched articles external', () => {
    const input = snapshot();
    input[0].rankingKey = 'most_commented';
    input[0].items.push({ id: 902, rank: 3, canonicalUrl: 'https://www.golem.de/news/third.html', title: 'Third', articleId: null, article: null });
    input[0].items.reverse();
    const [group] = normalizeDigestRankings(input);
    assert.equal(group.label, 'Most commented');
    assert.deepEqual(group.items.map(item => item.rank), [1, 3]);
    assert.equal(group.items[1].article, null);
    input[0].items[1].article.id = 8;
    assert.equal(normalizeDigestRankings(input)[0].items[0].article, null, 'Do not open a different article after stale reassociation');
});

test('unsafe links, invalid ranks, unsupported groups and empty groups produce no article items', () => {
    for (const canonicalUrl of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/article', 'https://user:secret@golem.de/story', 'invalid']) {
        const input = snapshot(); input[0].items[0].canonicalUrl = canonicalUrl;
        assert.deepEqual(normalizeDigestRankings(input), []);
    }
    for (const rank of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const input = snapshot(); input[0].items[0].rank = rank;
        assert.deepEqual(normalizeDigestRankings(input), []);
    }
    assert.deepEqual(normalizeDigestRankings([{ ...snapshot()[0], rankingKey: 'other' }]), []);
    assert.deepEqual(normalizeDigestRankings([{ ...snapshot()[0], items: [] }]), []);
    assert.deepEqual(normalizeDigestRankings(null), []);
});

test('initial Digest markup keeps Most read visible directly before its article loading state', async () => {
    const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
    const { document } = parseHTML(html);
    const container = document.querySelector('#digest-rankings');
    assert.ok(container);
    assert.equal(container.hasAttribute('hidden'), false);
    assert.equal(container.nextElementSibling.id, 'digest-state');
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
        ];
        for (const [rankings, status, message] of cases) {
            renderDigestRankings(container, rankings, new Map(), { status });
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
            renderDigestRankings(container, snapshot(), articles, { status: { state } });
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

test('ranking updates refresh even when digest clusters remain unchanged', () => {
    const base = snapshot();
    const fingerprint = digestRankingsFingerprint(base);
    assert.equal(fingerprint, digestRankingsFingerprint(structuredClone(base)));
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
        assert.notEqual(fingerprint, digestRankingsFingerprint(changed));
    }
});

test('ranking status updates refresh even when captured articles remain unchanged', () => {
    const rankings = snapshot();
    const status = { state: 'refreshing', message: null, attemptedAt: '2026-11-01T07:00:00Z' };
    const fingerprint = digestRankingsFingerprint(rankings, status);
    assert.equal(fingerprint, digestRankingsFingerprint(rankings, { ...status }));
    for (const change of [
        { state: 'ready' },
        { state: 'error', message: 'Publisher rankings could not be refreshed.' },
        { attemptedAt: '2026-11-01T07:05:00Z' },
    ]) {
        assert.notEqual(fingerprint, digestRankingsFingerprint(rankings, { ...status, ...change }));
    }
});
