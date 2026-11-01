import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSelector } from 'fetchary';
import { TECHCRUNCH_RANKINGS_URL, fetchTechCrunchRankings, parseTechCrunchRankings } from './techcrunch-rankings.js';

// Trimmed from the user's five supplied Top Headlines cards, not a live dump.
const supplied = [
    ['2026/10/31/data-centers-are-now-a-midterm-issue-even-in-brooklyn', 'Data centers are now a midterm issue, even in Brooklyn'],
    ['2026/10/31/i-took-two-iphones-on-vacation-the-duo-won-me-over', 'I took two iPhones on vacation. The Duo won me over.'],
    ['2026/10/30/pile-ins-payouts-and-pacing-pressure-the-investors-behind-the-vcs-open-up', 'Pile-ins, payouts, and pacing pressure: the investors behind the VCs open up'],
    ['2026/10/31/apple-ceo-says-the-company-doesnt-want-to-ship-ai-for-ais-sake', 'Apple CEO says the company doesn’t ‘want to ship AI for AI’s sake’'],
    ['2026/10/31/openai-reportedly-lowers-funding-target-for-new-round', 'OpenAI reportedly lowers funding target for new round'],
];
const card = ([path, title], index = 0) => `<div class="wp-block-techcrunch-card"><div class="loop-card loop-card--list" data-custom-submodule="Item ${index + 4}">
    <div class="loop-card__content"><h3 class="loop-card__title"><a href="https://techcrunch.com/${path}/" class="loop-card__title-link">${title}</a></h3>
    <div class="loop-card__meta"><ul class="loop-card__author-list"><li><a class="loop-card__author" href="https://techcrunch.com/author/anthony-ha/">Anthony Ha</a></li></ul></div></div></div></div>`;
const cards = supplied.map(card);
const advert = '<div class="ad-slot-container"><div class="ad-unit"><iframe title="3rd party ad content"></iframe></div></div>';
const section = (items = cards.join('') + advert, title = 'Top Headlines') => `<div class="hero-package-2__list"><p class="hero-package-2__heading"><strong>${title}</strong></p>${items}</div>`;
const capturedAt = '2026-11-01T16:00:00.000Z';
const result = extra => ({ status: 200, finalUrl: TECHCRUNCH_RANKINGS_URL, capturedAt, data: { matched: true, values: [section()] }, ...extra });
const missing = error => error.code === 'TECHCRUNCH_RANKINGS_MISSING';

test('reads only the supplied five editorial Top Headlines, ranked by DOM order rather than Item 4–8', () => {
    const parsed = parseTechCrunchRankings([section(), section(cards[0], 'Most Popular')]);
    assert.deepEqual(Object.keys(parsed), ['top_news']);
    assert.deepEqual(parsed.top_news.map(item => item.rank), [1, 2, 3, 4, 5]);
    assert.deepEqual(parsed.top_news.map(item => item.title), supplied.map(([, title]) => title));
    assert.doesNotMatch(JSON.stringify(parsed), /Anthony Ha|author\/|iframe|Item [4-8]/);
    assert.equal(Object.hasOwn(parsed, 'most_read'), false);
});

test('requires the exact Top Headlines heading in a direct heading paragraph', () => {
    for (const fragment of [section(cards[0], 'More Top Headlines'), section(cards[0], 'Most Popular'),
        section().replace('<p class="hero-package-2__heading">', '<div><p class="hero-package-2__heading">').replace('</p>', '</p></div>'),
        section().replace('<strong>Top Headlines</strong>', 'Top Headlines')]) {
        assert.throws(() => parseTechCrunchRankings([fragment]), missing);
    }
});

test('cleans soft hyphens, entities and tracking while preserving functional query parameters', () => {
    const changed = cards[0].replace('brooklyn/"', 'brooklyn/?utm_source=homepage&amp;id=7#comments"')
        .replace('Data centers are', 'Data cen\u00adters &amp; power are');
    const item = parseTechCrunchRankings([section(changed)]).top_news[0];
    assert.equal(item.canonicalUrl.endsWith('/?id=7'), true);
    assert.equal(item.title, 'Data centers & power are now a midterm issue, even in Brooklyn');
});

test('accepts valid calendar date article paths and rejects off-site, author and malformed URLs', () => {
    const invalid = [
        cards[0].replace('https://techcrunch.com/', 'https://evil.test/'),
        cards[0].replace('https://techcrunch.com/', 'https://techcrunch.com.evil.test/'),
        cards[0].replace('https://techcrunch.com/', 'https://events.techcrunch.com/'),
        card(['author/anthony-ha', 'Not an article']),
        card(['2026/02/29/not-a-leap-year', 'Not a calendar date']),
        card(['2026/04/31/not-a-day', 'Not a calendar date']),
        card(['2026/13/01/not-a-month', 'Not a calendar date']),
        card(['2026/00/01/not-a-month', 'Not a calendar date']),
        cards[0].replace('https://techcrunch.com/', 'javascript:news/'),
    ].join('');
    const items = parseTechCrunchRankings([section(invalid + cards[1])]).top_news;
    assert.equal(items.length, 1);
    assert.equal(items[0].rank, 10);
    assert.equal(parseTechCrunchRankings([section(card(['2024/02/29/leap-day', 'Valid leap day']))]).top_news.length, 1);
    assert.equal(parseTechCrunchRankings([section(cards[0].replace('https://techcrunch.com/', 'https://www.techcrunch.com/'))]).top_news.length, 1);
});

test('ignores advertisement containers and nested unrelated cards', () => {
    const nestedAd = `<div class="ad-slot-container">${cards[1]}</div>`;
    const nestedSection = `<div>${section(cards[1], 'Most Popular')}</div>`;
    assert.equal(parseTechCrunchRankings([section(cards[0] + nestedAd + nestedSection + advert)]).top_news.length, 1);
    const adCard = cards[0].replace('class="wp-block-techcrunch-card"', 'data-ad class="wp-block-techcrunch-card"');
    assert.deepEqual(parseTechCrunchRankings([section(adCard + cards[1])]).top_news.map(item => item.rank), [2]);
});

test('deduplicates identical responsive copies while rejecting conflicting titles or editorial order', () => {
    assert.equal(parseTechCrunchRankings([section(), section()]).top_news.length, 5);
    assert.deepEqual(parseTechCrunchRankings([section(cards[0] + cards[0] + cards[1])]).top_news.map(item => item.rank), [1, 3]);
    const changed = cards[0].replace(supplied[0][1], 'Different headline');
    for (const input of [[section(cards[0] + changed)], [section(), section([...cards].reverse().join(''))]]) {
        assert.throws(() => parseTechCrunchRankings(input), error => error.code === 'TECHCRUNCH_RANKINGS_CONFLICT');
    }
});

test('requires a nonempty unambiguous article selection', () => {
    for (const fragments of [[], [section('')], [section(advert)], [section().replaceAll('loop-card__title-link', 'other-link')],
        [section(cards[0].replace('</h3>', '<a class="loop-card__title-link" href="/2026/10/31/other/">Other</a></h3>'))]]) {
        assert.throws(() => parseTechCrunchRankings(fragments), missing);
    }
});

test('prefers bounded homepage HTTP capture with consent acceptance and genuine provenance', async () => {
    const snapshot = await fetchTechCrunchRankings({ configureBrowser: () => assert.fail('Unnecessary browser'), extract: async (url, options) => {
        assert.equal(url, TECHCRUNCH_RANKINGS_URL);
        assert.notEqual(url, 'https://techcrunch.com/feed/');
        assert.equal(options.mode, 'http');
        assert.equal(options.selector, '.hero-package-2__list');
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

test('semantic browser fallback is needed when HTTP matches an unrelated block or empty selection', async () => {
    for (const httpFragment of [section(cards[0], 'Most Popular'), section('')]) {
        const modes = [];
        let signal;
        let configured = 0;
        const snapshot = await fetchTechCrunchRankings({ configureBrowser: () => { configured += 1; }, extract: async (_url, options) => {
            modes.push(options.mode);
            if (options.mode === 'http') {
                signal = options.signal;
                return result({ data: { matched: true, values: [httpFragment] } });
            }
            assert.equal(options.signal, signal);
            assert.equal(options.consent, 'accept');
            assert.equal(options.waitAfterLoad, 3_000);
            return result();
        } });
        assert.equal(configured, 1);
        assert.deepEqual(modes, ['http', 'browser']);
        assert.equal(snapshot.rankings.top_news.length, 5);
    }
});

test('invalid homepage/status/timestamp and conflicting evidence never trigger a browser retry', async () => {
    for (const metadata of [{ status: 403 }, { status: 429 }, { status: undefined }, { finalUrl: 'https://evil.test/' },
        { finalUrl: 'https://techcrunch.com.evil.test/' }, { finalUrl: 'https://techcrunch.com/feed/' },
        { finalUrl: 'https://techcrunch.com/2026/10/31/article/' }, { finalUrl: null },
        { capturedAt: null }, { capturedAt: '' }, { capturedAt: 'invalid' },
        { data: { values: [section(), section(cards[1] + cards[0])] } }]) {
        let attempts = 0;
        await assert.rejects(fetchTechCrunchRankings({ configureBrowser: () => assert.fail('Do not retry invalid evidence'), extract: async () => {
            attempts += 1;
            return result(metadata);
        } }));
        assert.equal(attempts, 1);
    }
});

test('browser configuration failure retains the original missing-selection cause', async () => {
    await assert.rejects(fetchTechCrunchRankings({
        configureBrowser: () => { throw new Error('No usable Chrome'); },
        extract: async () => result({ data: { values: [] } }),
    }), error => {
        assert.equal(error.message, 'No usable Chrome');
        assert.equal(error.cause.code, 'TECHCRUNCH_RANKINGS_MISSING');
        return true;
    });
});

test('real Fetchary HTTP extraction reads the supplied Top Headlines without executing its advert iframe', async () => {
    const snapshot = await fetchTechCrunchRankings({ extract: (url, options) => extractSelector(url, {
        ...options, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () => new Response(`<html><body>${section()}</body></html>`, { headers: { 'content-type': 'text/html; charset=UTF-8' } }),
    }) });
    assert.equal(snapshot.rankings.top_news.length, 5);
    assert.deepEqual(Object.keys(snapshot.rankings), ['top_news']);
});
