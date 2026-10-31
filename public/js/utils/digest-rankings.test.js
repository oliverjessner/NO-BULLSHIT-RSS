import assert from 'node:assert/strict';
import test from 'node:test';
import { digestRankingsFingerprint, normalizeDigestRankings } from '../components/digest-rankings.js';

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

test('unsafe links, invalid ranks, unsupported groups and empty groups stay hidden', () => {
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
