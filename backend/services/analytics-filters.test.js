import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsBucket, articleScope, normalizeAnalyticsFilters } from './analytics-filters.js';

const now = new Date('2026-11-10T12:00:00.000Z');

test('analytics defaults to equal rolling UTC periods and retains shared dimensions', () => {
    const filters = normalizeAnalyticsFilters({ publisher: '2', topic: 'ai', topics: 'ai,security,ai', compare: '1,2', group: 'week', basis: 'fetchedAt' }, { now });
    assert.equal(filters.period, '30d');
    assert.equal(filters.startAt, '2026-10-11T12:00:00.000Z');
    assert.equal(filters.previousStartAt, '2026-09-11T12:00:00.000Z');
    assert.equal(filters.endAt, now.toISOString());
    assert.equal(filters.publisherId, 2);
    assert.deepEqual(filters.topicSlugs, ['ai', 'security']);
    assert.deepEqual(filters.compareIds, [1, 2]);
    assert.equal(filters.timeBasis, 'fetchedAt');
    assert.equal(normalizeAnalyticsFilters({ period: 'all' }, { now }).previousStartAt, null);
});

test('analytics validates dimensions, bounded pagination and safe history URLs', () => {
    for (const input of [
        { period: '1year' }, { group: 'hour' }, { basis: 'title' }, { rankingKey: 'pageviews' },
        { publisher: '1 OR 1=1' }, { publisher: '9007199254740993' }, { topic: "ai'" },
        { topics: Array.from({ length: 9 }, (_, i) => `t${i}`).join(',') }, { compare: '1,2,3' },
        { limit: '201' }, { offset: '-1' }, { historyLimit: '1001' }, { sort: 'content' },
        { direction: 'desc;DELETE' }, { url: 'javascript:alert(1)' }, { url: 'https://user:password@example.com/' },
    ]) assert.throws(() => normalizeAnalyticsFilters(input, { now }), { status: 400 });
    assert.equal(normalizeAnalyticsFilters({ url: 'https://example.com/article#comments' }, { now }).url, 'https://example.com/article');
});

test('article scopes bind every user value and compare mixed UTC formats with half-open dates', () => {
    const filters = normalizeAnalyticsFilters({ publisher: '3', topic: 'ai' }, { now });
    const scope = articleScope(filters);
    assert.match(scope.where, /julianday\(a.publishedAt\) >= julianday\(\?\)/u);
    assert.match(scope.where, /julianday\(a.publishedAt\) < julianday\(\?\)/u);
    assert.match(scope.where, /analytics_topic.slug = \?/u);
    assert.deepEqual(scope.params, [filters.startAt, filters.endAt, 3, 'ai']);
    assert.deepEqual(articleScope(filters, { period: false, publisher: false, topic: false }), { where: '1', params: [] });
    assert.throws(() => articleScope(filters, { alias: 'a;DROP TABLE articles' }), /Invalid article alias/u);
    assert.match(analyticsBucket('a.publishedAt', 'week'), /%w/u);
    assert.throws(() => analyticsBucket('a.title'), /Invalid analytics date column/u);
});
