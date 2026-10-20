import assert from 'node:assert/strict';
import test from 'node:test';
import { createDigestExport, createFeedExport, fetchAllFeedArticles } from './export.js';

const EXPORTED_AT = new Date('2026-09-02T12:00:00.000Z');

test('Watchdog exports reuse the Feed schema and all four formats with selection metadata', () => {
    const articles = [article(42, { bullshit: true, bullshitRules: ['Sponsored'] })];
    const watchdog = { id: 3, name: 'Research', status: 'unread', archived: false, range: '7d', asOf: EXPORTED_AT.toISOString() };
    const feed = JSON.parse(createFeedExport('json', { articles, exportedAt: EXPORTED_AT }).content);
    const result = JSON.parse(createFeedExport('json', { articles, filters: { watchdog }, exportedAt: EXPORTED_AT }).content);
    assert.deepEqual(Object.keys(result), Object.keys(feed));
    assert.deepEqual(result.articles, feed.articles);
    assert.deepEqual(result.filters, { ...feed.filters, watchdog });
    for (const format of ['markdown', 'json', 'csv', 'links']) {
        const output = createFeedExport(format, { articles, filters: { watchdog }, exportedAt: EXPORTED_AT });
        assert.match(output.filename, /^no-bullshit-rss-watchdog-/);
        if (format === 'markdown') { assert.match(output.content, /^# Watchdog Export/); assert.match(output.content, /Watchdog: Research/); }
        if (format === 'csv' || format === 'links') assert.equal(output.content, createFeedExport(format, { articles, exportedAt: EXPORTED_AT }).content);
    }
});

function article(id, overrides = {}) {
    return {
        id,
        title: `Article ${id}`,
        url: `https://example.com/${id}`,
        sourceName: 'Golem',
        publishedAt: new Date(Date.UTC(2026, 8, 2, 12, 0, 0) - id * 1000).toISOString(),
        topics: [{ slug: 'ai', label: 'AI' }],
        ...overrides,
    };
}

function digestCluster(title = 'Story one') {
    const first = article(1, { title: 'First article', sourceName: 'Golem', publishedAt: '2026-09-02T09:22:00.000Z' });
    const latest = article(2, { title: 'Latest article', sourceName: 'The Verge', publishedAt: '2026-09-02T09:40:00.000Z', topics: [{ slug: 'mobile', label: 'Mobile' }] });
    return { clusterTitle: title, representative: latest, items: [latest, first] };
}

test('feed without filters exports every active result returned by the shared feed query', async () => {
    const pages = [[article(3), article(2)], [article(1)]];
    const result = await fetchAllFeedArticles(() => pages.shift(), '', { pageSize: 2 });
    assert.deepEqual(result.map(item => item.id), [3, 2, 1]);
});

test('feed search is forwarded and only search results are exported', async () => {
    const calls = [];
    const result = await fetchAllFeedArticles(params => {
        calls.push(new URLSearchParams(params));
        return [article(7, { title: 'Nvidia result' })];
    }, new URLSearchParams({ query: 'Nvidia' }));
    assert.equal(calls[0].get('query'), 'Nvidia');
    assert.deepEqual(result.map(item => item.title), ['Nvidia result']);
});

test('feed search and topic filters are combined on every export request', async () => {
    const calls = [];
    await fetchAllFeedArticles(params => { calls.push(new URLSearchParams(params)); return []; }, new URLSearchParams({ query: 'Nvidia', topic: 'ai' }));
    assert.equal(calls[0].get('query'), 'Nvidia');
    assert.equal(calls[0].get('topic'), 'ai');
});

test('feed source, list, and bullshit filters are forwarded together', async () => {
    const calls = [];
    await fetchAllFeedArticles(params => { calls.push(new URLSearchParams(params)); return []; }, new URLSearchParams({ feedId: '12', listId: '4', bullshit: 'clean' }));
    assert.equal(calls[0].get('feedId'), '12');
    assert.equal(calls[0].get('listId'), '4');
    assert.equal(calls[0].get('bullshit'), 'clean');
});

test('feed export keeps the no-topic filter on every page and in JSON and Markdown', async () => {
    const calls = [];
    const pages = [[article(2, { topics: [] })], []];
    const articles = await fetchAllFeedArticles(params => {
        calls.push(new URLSearchParams(params));
        return pages.shift();
    }, new URLSearchParams({ noTopic: 'true', query: 'news' }), { pageSize: 1 });
    assert.equal(calls.length, 2);
    for (const params of calls) {
        assert.equal(params.get('noTopic'), 'true');
        assert.equal(params.has('topic'), false);
        assert.equal(params.get('query'), 'news');
    }
    const filters = { noTopic: true, query: 'news' };
    const payload = JSON.parse(createFeedExport('json', { articles, filters, exportedAt: EXPORTED_AT }).content);
    assert.equal(payload.filters.noTopic, true);
    assert.equal(payload.filters.topic, null);
    assert.deepEqual(payload.articles[0].topics, []);
    assert.match(createFeedExport('markdown', { articles, filters, exportedAt: EXPORTED_AT }).content, /^Topic: None$/mu);
});

test('feed export traverses beyond the first 100 articles with keyset pagination', async () => {
    const all = Array.from({ length: 125 }, (_, index) => article(125 - index));
    const calls = [];
    const result = await fetchAllFeedArticles(params => {
        const request = new URLSearchParams(params);
        calls.push(request);
        const cursorId = Number(request.get('cursorId'));
        const start = cursorId ? all.findIndex(item => item.id === cursorId) + 1 : 0;
        return all.slice(start, start + 40);
    }, '', { pageSize: 40 });
    assert.equal(result.length, 125);
    assert.equal(calls.length, 4);
    assert.equal(calls[1].get('cursorId'), '86');
});

test('feed JSON contains the exact filter metadata snapshot', () => {
    const artifact = createFeedExport('json', {
        articles: [article(1)],
        filters: { query: 'Nvidia', topic: 'AI', source: 'Golem', listId: '4' },
        exportedAt: EXPORTED_AT,
    });
    const payload = JSON.parse(artifact.content);
    assert.deepEqual(payload.filters, { query: 'Nvidia', topic: 'AI', source: 'Golem', listId: 4, bullshit: null });
    assert.equal(artifact.filename, 'no-bullshit-rss-feed-nvidia-2026-09-02.json');
});

test('feed JSON includes the bullshit filter and article match reasons', () => {
    const artifact = createFeedExport('json', {
        articles: [article(1, { bullshit: true, bullshitRules: ['Black Friday', 'Deals'] })],
        filters: { bullshit: 'clean' },
        exportedAt: EXPORTED_AT,
    });
    const payload = JSON.parse(artifact.content);
    assert.equal(payload.filters.bullshit, 'clean');
    assert.equal(payload.articles[0].bullshit, true);
    assert.deepEqual(payload.articles[0].bullshitRules, ['Black Friday', 'Deals']);
});

test('feed CSV correctly escapes commas, quotes, and line breaks', () => {
    const title = 'One, "quoted"\nheadline';
    const artifact = createFeedExport('csv', { articles: [article(1, { title })], exportedAt: EXPORTED_AT });
    assert.match(artifact.content, /"One, ""quoted""\nheadline"/u);
    assert.match(artifact.content, /"AI"|,AI\r/u);
});

test('feed link list contains only one URL per line', () => {
    const artifact = createFeedExport('links', {
        articles: [article(1), article(2), article(3, { url: '' })],
        exportedAt: EXPORTED_AT,
    });
    assert.equal(artifact.content, 'https://example.com/1\nhttps://example.com/2\n');
    assert.equal(artifact.filename, 'no-bullshit-rss-feed-2026-09-02.txt');
});

test('digest Day export retains the Day variant and filename', () => {
    const artifact = createDigestExport('json', { variant: 'day', clusters: [digestCluster()], exportedAt: EXPORTED_AT });
    assert.equal(JSON.parse(artifact.content).variant, 'day');
    assert.equal(artifact.filename, 'no-bullshit-rss-digest-day-2026-09-02.json');
});

test('digest Week export retains the Week variant and filename', () => {
    const artifact = createDigestExport('markdown', { variant: 'week', clusters: [digestCluster()], exportedAt: EXPORTED_AT });
    assert.match(artifact.content, /^# Weekly Digest/u);
    assert.equal(artifact.filename, 'no-bullshit-rss-digest-week-2026-09-02.md');
});

test('digest Month export retains the Month variant and filename', () => {
    const artifact = createDigestExport('csv', { variant: 'month', clusters: [digestCluster()], exportedAt: EXPORTED_AT });
    assert.equal(artifact.filename, 'no-bullshit-rss-digest-month-2026-09-02.csv');
});

test('digest JSON preserves story clusters and their articles', () => {
    const artifact = createDigestExport('json', { variant: 'day', clusters: [digestCluster()], exportedAt: EXPORTED_AT });
    const payload = JSON.parse(artifact.content);
    assert.equal(payload.stories.length, 1);
    assert.equal(payload.stories[0].title, 'Story one');
    assert.equal(payload.stories[0].sourceCount, 2);
    assert.deepEqual(payload.stories[0].topics, ['Mobile', 'AI']);
    assert.deepEqual(payload.stories[0].articles.map(item => item.id), [2, 1]);
    assert.equal(payload.stories[0].firstReport, '2026-09-02T09:22:00.000Z');
    assert.equal(payload.stories[0].latestReport, '2026-09-02T09:40:00.000Z');
});

test('digest CSV maps every article to the correct story cluster', () => {
    const artifact = createDigestExport('csv', {
        variant: 'day',
        clusters: [digestCluster('Story one'), { ...digestCluster('Story two'), items: [article(3, { title: 'Third' })] }],
        exportedAt: EXPORTED_AT,
    });
    const lines = artifact.content.trim().split('\r\n');
    assert.equal(lines.length, 4);
    assert.match(lines[1], /^Story one,1,2,Latest article/u);
    assert.match(lines[2], /^Story one,1,2,First article/u);
    assert.match(lines[3], /^Story two,2,1,Third/u);
});

test('digest link list contains only article URLs across all clusters', () => {
    const artifact = createDigestExport('links', {
        variant: 'week',
        clusters: [digestCluster(), { ...digestCluster('Story two'), items: [article(3)] }],
        exportedAt: EXPORTED_AT,
    });
    assert.equal(artifact.content, 'https://example.com/2\nhttps://example.com/1\nhttps://example.com/3\n');
    assert.equal(artifact.filename, 'no-bullshit-rss-digest-week-2026-09-02.txt');
});
