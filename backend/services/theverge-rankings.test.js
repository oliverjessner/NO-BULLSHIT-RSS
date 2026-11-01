import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSelector } from 'fetchary';
import { THEVERGE_RANKINGS_URL, fetchTheVergeRankings, parseTheVergeRankings } from './theverge-rankings.js';

// Structural fixtures mirror the live semantic hero and responsive card groups;
// article titles and paths are deliberately synthetic test data.
const stories = [
    ['/policy/101/lead-story', 'Lead editorial story'], ['/tech/102/second-story', 'Second editorial story'],
    ['/column/103/third-story', 'Third editorial story'], ['/gadgets/104/fourth-story', 'Fourth editorial story'],
    ['/entertainment/105/fifth-story', 'Fifth editorial story'],
];
const card = ([url, title], extra = '') => `<div class="duet--content-cards--content-card up4voo0 _7uluu53">
    <div><a class="_7uluu51" aria-hidden="true" href="${url}"><img alt="Image caption"></a></div><div><div><div><span>Category</span></div>
    <div><div class="_19wv7tc9"><a class="_7uluu50 _7uluu54" href="${url}">${title}</a></div></div>
    <p class="duet--article--dangerously-set-cms-markup">A teaser with an <a href="/tech/999/inline-story">inline article link</a>.</p>
    <div><a rel="author" href="/authors/example">Example Author</a><span class="duet--article--timestamp"><a href="${url}#comments">12 comments</a></span></div>${extra}</div></div></div>`;
const cards = stories.map(item => card(item));
const hero = (desktop = cards.slice(1), mobile = cards.slice(1), lead = cards[0]) => `<div class="_1e7jslxa duet--homepage--hero">${lead}
    <div><div class="desktop-variant">${desktop.map(item => `<div>${item}</div>`).join('')}</div><div class="mobile-variant">${mobile.join('')}</div></div></div>`;
const panel = (content = hero()) => `<div id="topStories-panel">${content}
    <section class="duet--homepage--most-popular"><h2>Most Popular</h2>${card(['/tech/901/popular-only', 'Not Top Stories'])}</section>
    <section class="duet--homepage-top-curated-content-section-0"><h2>Weekend reads</h2>${card(['/tech/902/curated-only', 'Not the hero'])}</section>
    <div class="duet--homepage-latest-quickposts">${card(['/tech/903/quick-post', 'Quick post'])}</div></div>`;
const page = () => `<button role="tab" id="mobile-topStories-tab" aria-controls="topStories-panel">Top Stories</button>${panel()}
    <div id="latest-panel">${card(['/tech/904/latest-only', 'Latest'])}</div><div id="following-panel">${card(['/tech/905/following-only', 'Following'])}</div>`;
const capturedAt = '2026-11-01T19:00:00.000Z';
const result = extra => ({ status: 200, finalUrl: 'https://www.theverge.com/', capturedAt, data: { matched: true, values: [page()] }, ...extra });
const missing = error => error.code === 'THEVERGE_RANKINGS_MISSING';
const conflict = error => error.code === 'THEVERGE_RANKINGS_CONFLICT';

test('reads only the five unique Top Stories hero cards, excluding curated, Most Popular, Latest and Following', () => {
    const rankings = parseTheVergeRankings([page()]);
    assert.deepEqual(Object.keys(rankings), ['top_news']);
    assert.deepEqual(rankings.top_news.map(item => item.title), stories.map(([, title]) => title));
    assert.deepEqual(rankings.top_news.map(item => item.rank), [1, 2, 3, 4, 5]);
    assert.doesNotMatch(JSON.stringify(rankings), /Not Top Stories|Not the hero|Quick post|Latest|Following|Example Author|inline-story|comments|Image caption/);
});

test('does not substitute a whole panel, latest cards, curated river or Most Popular for a missing hero', () => {
    for (const input of [[], [panel('')], [page().replaceAll('duet--homepage--hero', 'other-hero')],
        [hero()], [page().replaceAll('id="topStories-panel"', 'id="latest-panel"')]]) {
        assert.throws(() => parseTheVergeRankings(input), missing);
    }
});

test('responsive duplicates never consume ranks and the publisher may select a different story count', () => {
    assert.equal(parseTheVergeRankings([panel(hero()), panel(hero())]).top_news.length, 5);
    const shortHero = hero(cards.slice(1, 3), cards.slice(1, 3));
    assert.deepEqual(parseTheVergeRankings([panel(shortHero)]).top_news.map(item => item.rank), [1, 2, 3]);
    const noHeadlineAd = '<div data-concert="hero-ad"><a href="/tech/888/advertisement">Sponsored</a></div>';
    assert.equal(parseTheVergeRankings([panel(hero([noHeadlineAd, ...cards.slice(1)], cards.slice(1)))]).top_news.length, 5);
});

test('rejects conflicting responsive titles, order, hero variants or multiple plausible card headlines', () => {
    const changed = cards[1].replace('Second editorial story', 'Different responsive title');
    assert.throws(() => parseTheVergeRankings([panel(hero(cards.slice(1), [changed, ...cards.slice(2)]))]), conflict);
    assert.throws(() => parseTheVergeRankings([panel(hero(cards.slice(1), [...cards.slice(1)].reverse()))]), conflict);
    assert.throws(() => parseTheVergeRankings([panel(hero()), panel(hero(cards.slice(1, 3), cards.slice(1, 3)))]), conflict);
    const ambiguous = card(stories[0], '<a href="/tech/111/different-headline">Another plausible headline</a>');
    assert.throws(() => parseTheVergeRankings([panel(hero([], [], ambiguous))]), conflict);
});

test('accepts modern single/multiple category routes and legacy calendar dates with numeric story IDs', () => {
    for (const url of ['/tech/123/new-article', '/cs/features/124/feature-article/', '/2024/2/29/125/legacy-story',
        '/circuitbreaker/2023/12/31/126/legacy-prefixed', 'https://theverge.com/policy/127/bare-host']) {
        assert.equal(parseTheVergeRankings([panel(hero([], [], card([url, 'Article title'])))]).top_news.length, 1);
    }
    for (const url of ['https://evil.test/tech/123/article', 'https://theverge.com.evil.test/tech/123/article',
        'https://cdn.theverge.com/tech/123/article', 'https://name:password@www.theverge.com/tech/123/article',
        '/authors/123/name', '/about/123/page', '/tech/hash/article', '/tech/0/article', '/tech/123/article/extra',
        '/2023/2/29/125/invalid-leap-day', '/2024/13/1/125/invalid-month', 'javascript:alert(1)']) {
        assert.throws(() => parseTheVergeRankings([panel(hero([], [], card([url, 'Invalid article'])))]), missing);
    }
});

test('cleans headline entities, soft hyphens and tracking while retaining functional URL parameters', () => {
    const lead = card(['/tech/123/clean-story?utm_source=home&amp;id=7#tracking', 'A soft\u00adhyphen &amp; headline']);
    const item = parseTheVergeRankings([panel(hero([], [], lead))]).top_news[0];
    assert.equal(item.title, 'A softhyphen & headline');
    assert.equal(item.canonicalUrl, 'https://www.theverge.com/tech/123/clean-story?id=7');
});

test('excludes image, teaser, author/meta and advertisement links even when their routes are valid article URLs', () => {
    const extra = '<div class="article-metadata"><a href="/tech/201/meta-story">Metadata link</a></div><div class="byline"><a href="/tech/202/author-story">Author link</a></div>';
    const ad = `<div data-ad>${card(['/tech/203/ad-story', 'Advertisement'])}</div>`;
    assert.deepEqual(parseTheVergeRankings([panel(hero([], [], card(stories[0], extra) + ad))]).top_news.map(item => item.title), ['Lead editorial story']);
});

test('prefers bounded homepage HTTP capture with consent acceptance and genuine metadata', async () => {
    const snapshot = await fetchTheVergeRankings({ configureBrowser: () => assert.fail('Unnecessary browser'), extract: async (url, options) => {
        assert.equal(url, THEVERGE_RANKINGS_URL);
        assert.equal(options.mode, 'http');
        assert.equal(options.selector, '#topStories-panel');
        assert.equal(options.consent, 'accept');
        assert.equal(options.format, 'html');
        assert.equal(options.all, true);
        assert.equal(options.timeout, 12_000);
        assert.equal(options.maxResponseBytes, 3 * 1024 * 1024);
        assert.equal(options.cacheTtlMs, 60_000);
        assert.ok(options.signal instanceof AbortSignal);
        return result();
    } });
    assert.equal(snapshot.capturedAt, capturedAt);
    assert.deepEqual(Object.keys(snapshot.rankings), ['top_news']);
});

test('an empty or missing semantic hero triggers bounded browser fallback, not a matched-panel success', async () => {
    const modes = [];
    let signal;
    let configured = 0;
    const snapshot = await fetchTheVergeRankings({ configureBrowser: () => { configured += 1; }, extract: async (_url, options) => {
        modes.push(options.mode);
        if (options.mode === 'http') {
            signal = options.signal;
            return result({ data: { matched: true, values: [panel(hero([], [], ''))] } });
        }
        assert.equal(options.signal, signal);
        assert.equal(options.consent, 'accept');
        assert.equal(options.waitAfterLoad, 3_000);
        return result();
    } });
    assert.equal(configured, 1);
    assert.deepEqual(modes, ['http', 'browser']);
    assert.equal(snapshot.rankings.top_news.length, 5);
});

test('invalid homepage/status/timestamp and conflicting captures do not trigger browser retries', async () => {
    for (const metadata of [{ status: 403 }, { status: 429 }, { status: undefined }, { finalUrl: 'https://evil.test/' },
        { finalUrl: 'https://www.theverge.com.evil.test/' }, { finalUrl: 'https://www.theverge.com/rss/index.xml' },
        { finalUrl: 'https://www.theverge.com/tech/123/article' }, { finalUrl: null },
        { capturedAt: null }, { capturedAt: '' }, { capturedAt: 'invalid' },
        { data: { values: [panel(hero()), panel(hero(cards.slice(1, 3), cards.slice(1, 3)))] } }]) {
        let attempts = 0;
        await assert.rejects(fetchTheVergeRankings({ configureBrowser: () => assert.fail('Do not retry invalid evidence'), extract: async () => {
            attempts += 1;
            return result(metadata);
        } }));
        assert.equal(attempts, 1);
    }
});

test('browser configuration failure retains the original missing-hero cause', async () => {
    await assert.rejects(fetchTheVergeRankings({
        configureBrowser: () => { throw new Error('No usable Chrome'); },
        extract: async () => result({ data: { values: [] } }),
    }), error => {
        assert.equal(error.message, 'No usable Chrome');
        assert.equal(error.cause.code, 'THEVERGE_RANKINGS_MISSING');
        return true;
    });
});

test('real Fetchary HTTP extraction reads the standalone structural fixture without network access', async () => {
    const snapshot = await fetchTheVergeRankings({ extract: (url, options) => extractSelector(url, {
        ...options, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () => new Response(`<html><body>${page()}</body></html>`, { headers: { 'content-type': 'text/html; charset=UTF-8' } }),
    }) });
    assert.equal(snapshot.rankings.top_news.length, 5);
    assert.deepEqual(snapshot.rankings.top_news.map(item => item.rank), [1, 2, 3, 4, 5]);
});
