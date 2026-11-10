import assert from 'node:assert/strict';
import test from 'node:test';
import { createRankingsExport, fetchAllTopArticles } from './rankings-export.js';

const EXPORTED_AT = new Date('2026-11-10T12:00:00.000Z');
const CAPTURED_AT = '2026-11-09T20:00:00.000Z';
const media = [{ id: 'golem', name: 'Golem' }, { id: 'heise-ix', name: 'heise iX' }];
const ranking = (overrides = {}) => ({ medium: 'golem', mediumName: 'Golem', sourceId: 9, rankingKey: 'most_read', label: 'Most read', rank: 1, capturedAt: CAPTURED_AT, ...overrides });
const article = (id, overrides = {}) => ({
    id, title: `Article ${id}`, url: `https://example.com/${id}`, canonicalUrl: `https://example.com/${id}`,
    sourceName: 'Golem RSS', publishedAt: '2026-11-09T12:00:00.000Z', topics: [{ slug: 'tech', label: 'Tech' }],
    rankings: [ranking()], ...overrides,
});
const top = (items = [], overrides = {}) => ({ medium: 'all', media, items, hasMore: false, nextCursor: null, ...overrides });
const exportAs = (format, payload) => createRankingsExport(format, { payload, exportedAt: EXPORTED_AT });
const publisher = (overrides = {}) => ({
    medium: 'golem', media,
    rankings: [{ sourceId: 9, sourceName: 'Golem publisher', rankingKey: 'most_read', capturedAt: CAPTURED_AT,
        items: [{ id: 600, articleId: 7, rank: 1, title: 'Publisher headline', canonicalUrl: 'https://example.com/7#comments', article: article(7) }] }],
    ...overrides,
});

test('all-media export reads all pages beyond the visible 40 and keeps final response metadata', async () => {
    const all = Array.from({ length: 205 }, (_, index) => article(index + 1));
    const requests = [];
    const pages = [
        top(all.slice(0, 100), { hasMore: true, nextCursor: 'page-two' }),
        top(all.slice(100, 200), { hasMore: true, nextCursor: 'page-three' }),
        top(all.slice(200), { rankingStatus: { state: 'ready' } }),
    ];
    const originals = structuredClone(pages);
    const payload = await fetchAllTopArticles(options => {
        requests.push(options);
        return pages[requests.length - 1];
    });
    assert.deepEqual(requests, [{ limit: 100 }, { limit: 100, cursor: 'page-two' }, { limit: 100, cursor: 'page-three' }]);
    assert.deepEqual(payload.items.map(item => item.id), all.map(item => item.id));
    assert.equal(payload.hasMore, false);
    assert.equal(payload.nextCursor, null);
    assert.deepEqual(payload.rankingStatus, { state: 'ready' });
    assert.deepEqual(pages, originals);
    assert.equal(JSON.parse(exportAs('json', payload).content).articles.length, 205);
});

test('pagination merges repeated URLs and their distinct ranking memberships', async () => {
    const mostRead = article(7);
    const mostCommented = article(7, { canonicalUrl: `${mostRead.canonicalUrl}#comments`, rankings: [ranking(), ranking({ rankingKey: 'most_commented', label: 'Most commented', rank: 3 })] });
    const pages = [top([mostRead], { hasMore: true, nextCursor: 'next' }), top([mostCommented, article(8)])];
    const payload = await fetchAllTopArticles(() => pages.shift());
    assert.equal(payload.items.length, 2);
    assert.deepEqual(payload.items[0].rankings.map(item => [item.rankingKey, item.rank]), [['most_read', 1], ['most_commented', 3]]);
    assert.equal(exportAs('links', payload).content, 'https://example.com/7\nhttps://example.com/8\n');
});

test('pagination rejects malformed pages and never yields partial export results', async () => {
    const malformed = [null, {}, top([], { medium: 'golem' }), top(null), top([], { hasMore: undefined }),
        top([], { hasMore: 'true' }), ...[null, '', ' ', 42].map(nextCursor => top([], { hasMore: true, nextCursor }))];
    for (const page of malformed) {
        let calls = 0;
        await assert.rejects(fetchAllTopArticles(() => ++calls === 1 ? top([article(7)], { hasMore: true, nextCursor: 'next' }) : page), /Invalid top articles export response/);
        assert.equal(calls, 2);
    }
    await assert.rejects(fetchAllTopArticles(null), /fetchPage must be a function/);
});

test('pagination rejects both repeated and cyclic opaque cursors', async () => {
    for (const cursors of [['same', 'same'], ['first', 'second', 'first']]) {
        let calls = 0;
        await assert.rejects(fetchAllTopArticles(() => {
            const nextCursor = cursors[calls++];
            assert.ok(calls <= cursors.length, 'A cursor cycle must stop further requests');
            return top([article(calls)], { hasMore: true, nextCursor });
        }), /pagination did not advance/);
        assert.equal(calls, cursors.length);
    }
});

test('a failed later page rejects the complete export', async () => {
    let calls = 0;
    await assert.rejects(fetchAllTopArticles(() => {
        if (++calls === 2) throw new Error('Network unavailable');
        return top([article(7)], { hasMore: true, nextCursor: 'next' });
    }), /Network unavailable/);
    assert.equal(calls, 2);
});

test('publisher export includes unmatched articles with null IDs and canonical title/link fallbacks', () => {
    const payload = publisher();
    payload.rankings[0].items.push(
        { id: 601, articleId: null, rank: 2, title: 'External only', canonicalUrl: 'https://example.com/external#comments', article: article(999) },
        { id: 602, articleId: null, rank: 4, canonicalUrl: 'https://example.com/title-fallback', article: null },
    );
    const before = structuredClone(payload);
    const output = JSON.parse(exportAs('json', payload).content);
    assert.deepEqual(output.articles.map(item => item.id), [7, null, null]);
    assert.equal(output.articles[0].sourceName, 'Golem RSS');
    assert.deepEqual(output.articles[0].topics, ['Tech']);
    assert.equal(output.articles[0].rankings[0].sourceName, 'Golem publisher');
    assert.equal(output.articles[1].title, 'External only');
    assert.equal(output.articles[1].url, 'https://example.com/external');
    assert.equal(output.articles[1].sourceName, 'Golem publisher');
    assert.equal(output.articles[2].title, 'https://example.com/title-fallback');
    assert.deepEqual(payload, before);
});

test('publisher duplicate memberships retain rank, provider label, source and capture time', () => {
    const payload = publisher();
    payload.rankings.push({ ...payload.rankings[0], rankingKey: 'top_news', label: 'Top stories', items: [payload.rankings[0].items[0]] });
    const output = JSON.parse(exportAs('json', payload).content);
    assert.equal(output.articles.length, 1);
    assert.deepEqual(output.articles[0].rankings, [
        { medium: 'golem', mediumName: 'Golem', sourceId: 9, sourceName: 'Golem publisher', rankingKey: 'most_read', label: 'Most read', rank: 1, capturedAt: CAPTURED_AT },
        { medium: 'golem', mediumName: 'Golem', sourceId: 9, sourceName: 'Golem publisher', rankingKey: 'top_news', label: 'Top stories', rank: 1, capturedAt: CAPTURED_AT },
    ]);
    assert.equal(exportAs('links', payload).content, 'https://example.com/7\n');
    const markdown = exportAs('markdown', payload).content;
    assert.match(markdown, /Most read #1 \(most_read\)/);
    assert.match(markdown, /Top stories #1 \(top_news\)/);
    assert.match(markdown, /Source: Golem publisher \(ID 9\).*Captured: 2026-11-09T20:00:00.000Z/);
    assert.equal(exportAs('csv', payload).content.trim().split('\r\n').length, 3);
});

test('all-media JSON preserves null IDs, RSS metadata, topic labels and ranking provenance', () => {
    const payload = top([article(null, { url: 'https://example.com/external', canonicalUrl: 'https://example.com/external',
        topics: ['Tech', { label: 'tech' }, { slug: 'ai' }], bullshit: true, bullshitRules: [' Sponsored\ncontent '] })]);
    const before = structuredClone(payload);
    const output = JSON.parse(exportAs('json', payload).content);
    assert.equal(output.medium, 'all');
    assert.equal(output.mediumName, 'All media');
    assert.equal(output.exportedAt, EXPORTED_AT.toISOString());
    assert.equal(output.articles[0].id, null);
    assert.deepEqual(output.articles[0].topics, ['Tech', 'ai']);
    assert.equal(output.articles[0].bullshit, true);
    assert.deepEqual(output.articles[0].bullshitRules, ['Sponsored content']);
    assert.deepEqual(output.articles[0].rankings[0], { ...ranking(), sourceName: 'Golem RSS' });
    assert.deepEqual(payload, before);
});

test('selected medium is recorded in JSON, Markdown and every filename', () => {
    const payload = publisher({ medium: 'heise-ix' });
    const json = exportAs('json', payload);
    assert.equal(JSON.parse(json.content).medium, 'heise-ix');
    assert.equal(JSON.parse(json.content).mediumName, 'heise iX');
    assert.match(exportAs('markdown', payload).content, /^Medium: heise iX \(heise-ix\)$/mu);
    const formats = { markdown: ['md', 'text/markdown'], json: ['json', 'application/json'], csv: ['csv', 'text/csv'], links: ['txt', 'text/plain'] };
    for (const [format, [extension, mimeType]] of Object.entries(formats)) {
        const result = exportAs(format, payload);
        assert.equal(result.filename, `no-bullshit-rss-most-read-heise-ix-2026-11-10.${extension}`);
        assert.equal(result.mimeType, `${mimeType};charset=utf-8`);
    }
});

test('CSV escapes article and ranking text while Markdown keeps one headline line', () => {
    const payload = top([article(7, { title: 'One, "quoted"\nheadline', sourceName: 'RSS, "source"',
        rankings: [ranking({ label: 'Top, "news"', rankingKey: 'top_news' })] })]);
    const csv = exportAs('csv', payload).content;
    assert.match(csv, /"One, ""quoted""\nheadline"/);
    assert.match(csv, /"RSS, ""source"""/);
    assert.match(csv, /"Top, ""news"""/);
    assert.match(exportAs('markdown', payload).content, /^## One, "quoted" headline$/mu);
});

test('exports use the same safe article and ranking normalization as the cards', () => {
    const payload = top([article(7, { url: 'javascript:alert(1)', canonicalUrl: 'https://example.com/7#comments' }),
        article(8, { canonicalUrl: 'file:///tmp/unsafe', url: 'file:///tmp/unsafe' }),
        article(9, { rankings: [ranking({ rank: 0 }), ranking({ rankingKey: 'unsupported' })] })]);
    const output = JSON.parse(exportAs('json', payload).content);
    assert.deepEqual(output.articles.map(item => item.id), [7, 9]);
    assert.equal(output.articles[0].url, 'https://example.com/7');
    assert.deepEqual(output.articles[1].rankings, []);
    assert.equal(exportAs('links', payload).content, 'https://example.com/7\nhttps://example.com/9\n');
    assert.throws(() => exportAs('pdf', payload), /Unsupported export format/);
    assert.throws(() => exportAs('json', {}), /Invalid rankings export response/);
});
