import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGolemRankings, isGolemSource, parseGolemRankings, GOLEM_RANKINGS_URL } from './golem-rankings.js';

const article = (href, title) => `<div class="go-teaser-container"><article class="go-teaser go-teaser--inline">
    <h2 class="go-heading go-teaser__heading"><a class="go-teaser__link" href="${href}">${title}</a></h2>
    <a href="https://forum.golem.de/new/redirect.php?art_id=1">37 Kommentare</a></article></div>`;
const block = (heading, items) => `<div class="go-teaser-block"><div class="go-teaser-block__header">
    <div class="go-teaser-block__heading"><h3>${heading}</h3></div></div>${items}</div>`;
const read = block('Meistgelesene Artikel', article('/news/one.html?utm_source=rss#comments', '<span>KI<span>:</span></span> <span>Neue Modelle</span>'));
const commented = block('Meistkommentierte Artikel', article('/news/two.html', 'Zweiter Artikel'));
const fragments = [read, commented];
const capturedAt = '2026-10-31T20:00:00.000Z';
const result = extra => ({ status: 200, finalUrl: GOLEM_RANKINGS_URL, capturedAt, data: { values: fragments }, ...extra });

test('parses the two exact Golem ranking headings and only their article heading links', () => {
    const rankings = parseGolemRankings([...fragments, block('Andere Artikel', article('/news/other.html', 'Ignore'))]);
    assert.deepEqual(rankings, {
        most_read: [{ canonicalUrl: 'https://www.golem.de/news/one.html', title: 'KI: Neue Modelle', rank: 1 }],
        most_commented: [{ canonicalUrl: 'https://www.golem.de/news/two.html', title: 'Zweiter Artikel', rank: 1 }],
    });
});

test('rejects off-site/non-news links and duplicate URLs while preserving original ranking positions', () => {
    const mixed = block('Meistgelesene Artikel', [
        article('https://evil.test/news/ad.html', 'Ad'),
        article('/news/one.html', 'One'),
        article('/news/one.html?utm_campaign=again', 'Duplicate'),
        article('https://forum.golem.de/news/other.html', 'Forum'),
        article('javascript:alert(1)', 'Unsafe'),
        article('/jobs/', 'Jobs'),
        article('//www.golem.de/news/final.html', 'Final'),
    ].join(''));
    assert.deepEqual(parseGolemRankings([mixed, commented]).most_read.map(item => item.rank), [2, 7]);
});

test('requires both nonempty rankings and rejects conflicting duplicate blocks', () => {
    assert.throws(() => parseGolemRankings([read]), /both article rankings/);
    assert.throws(() => parseGolemRankings([read, block('Meistkommentierte Artikel', '')]), /no usable articles/);
    assert.throws(() => parseGolemRankings([read, commented, block('Meistgelesene Artikel', article('/news/changed.html', 'Changed'))]), /conflicting/);
    assert.deepEqual(parseGolemRankings([read, commented, read]), parseGolemRankings(fragments));
});

test('selects Golem by source host rather than names or source IDs', () => {
    assert.equal(isGolemSource({ websiteUrl: 'https://www.golem.de/' }), true);
    assert.equal(isGolemSource({ websiteUrl: 'https://golem.de/news/' }), true);
    assert.equal(isGolemSource({ websiteUrl: 'https://golem.de.evil.test/', name: 'Golem' }), false);
    assert.equal(isGolemSource({ websiteUrl: 'javascript:alert(1)' }), false);
});

test('uses bounded Fetchary auto capture with consent interaction disabled and preserves capture provenance', async () => {
    const snapshot = await fetchGolemRankings({ extract: async (url, options) => {
        assert.equal(url, GOLEM_RANKINGS_URL);
        assert.equal(options.selector, '.go-teaser-block');
        assert.equal(options.all, true);
        assert.equal(options.format, 'html');
        assert.equal(options.mode, 'auto');
        assert.equal(options.consent, 'off');
        assert.equal(options.timeout, 12_000);
        assert.equal(options.cacheTtlMs, 60_000);
        assert.ok(options.signal instanceof AbortSignal);
        return result({ cache: { hit: true } });
    } });
    assert.equal(snapshot.capturedAt, capturedAt);
    assert.equal(snapshot.rankings.most_read.length, 1);
});

test('rejects error/consent pages, redirected sites and missing capture timestamps', async () => {
    for (const metadata of [{ status: 403 }, { status: 302 }, { status: undefined }, { consent: { status: 'blocked' } },
        { finalUrl: 'https://consent.example.test/' }, { capturedAt: null }, { capturedAt: '' }, { capturedAt: 'invalid' }]) {
        await assert.rejects(fetchGolemRankings({ extract: async () => result(metadata) }));
    }
});

test('accepts complete HTTP rankings when the optional browser installation is unavailable', async () => {
    let configured = 0;
    const snapshot = await fetchGolemRankings({
        configureBrowser: () => {
            configured += 1;
            throw new Error('Bundled ranking browser is incomplete');
        },
        extract: async (url, options) => {
            assert.equal(url, GOLEM_RANKINGS_URL);
            assert.equal(options.mode, 'http');
            assert.equal(options.consent, 'off');
            return result();
        },
    });
    assert.equal(configured, 1);
    assert.equal(snapshot.capturedAt, capturedAt);
    assert.equal(snapshot.rankings.most_read.length, 1);
    assert.equal(snapshot.rankings.most_commented.length, 1);
});

test('retains the browser configuration failure with the HTTP failure as its cause when HTTP cannot provide rankings', async () => {
    const captureFailure = new Error('HTTP extraction failed');
    await assert.rejects(fetchGolemRankings({
        configureBrowser: () => { throw new Error('Configured ranking browser is unavailable'); },
        extract: async (_url, options) => {
            assert.equal(options.mode, 'http');
            throw captureFailure;
        },
    }), error => {
        assert.equal(error.message, 'Configured ranking browser is unavailable');
        assert.equal(error.cause, captureFailure);
        return true;
    });
    await assert.rejects(fetchGolemRankings({
        configureBrowser: () => { throw new Error('Bundled ranking browser is incomplete'); },
        extract: async () => result({ data: { values: [read] } }),
    }), error => {
        assert.equal(error.message, 'Bundled ranking browser is incomplete');
        assert.match(error.cause.message, /both article rankings/);
        return true;
    });
});
