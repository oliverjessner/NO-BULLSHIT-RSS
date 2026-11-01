import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSelector } from 'fetchary';
import { HEISE_IX_RANKINGS_URL, fetchHeiseIxRankings, parseHeiseIxRankings } from './heise-ix-rankings.js';

// Trimmed from the user's supplied Top-News markup, without image or ad payloads.
const article = (path, title) => `<article data-component="TeaserContainer"><a index="0" data-component="TeaserLinkContainer" href="${path}">
    <figure><img alt="Unrelated image description"></figure><div data-component="TeaserLinkContainer"><header data-component="TeaserHeader">
    <h3><span data-component="TeaserHeadline"><span data-upscore-title="true">${title}</span></span></h3></header>
    <p data-component="TeaserSynopsis">Unrelated synopsis</p><footer>iX Magazin</footer></div></a></article>`;
const first = article('/news/Oracle-Fusion-ChatGPT-soll-Geschaeftsablaeufe-starten-statt-nur-erklaeren-11505931.html',
    'Oracle Fusion: ChatGPT soll Geschäftsabläufe starten statt nur erklären');
const second = article('/news/OpenTelemetry-Collector-Updates-zerlegen-keine-Filterregeln-mehr-11505793.html',
    'OpenTelemetry friert seine Transformationssprache ein');
const advert = '<div id="HEI_D_Incontent-1"><div>Anzeige</div><iframe src="https://ads.example/ad" title="Anzeigeninhalte von Drittanbietern"></iframe></div>';
const module = (items = first + '<hr>' + second + advert, heading = 'Top-News') => `<div data-component="TeasersModule">
    <header data-component="ModuleHeader"><div><h2>${heading}</h2><a href="https://www.heise.de/ix/newsticker">Alle News</a></div></header>
    <section data-component="TeaserList">${items}</section><footer><a href="https://www.heise.de/ix/newsticker">Alle News</a></footer></div>`;
const capturedAt = '2026-11-01T14:00:00.000Z';
const result = extra => ({ status: 200, finalUrl: 'https://www.heise.de/ix', capturedAt, data: { matched: true, values: [module()] }, ...extra });

test('reads the supplied two Top-News articles in editorial order and ignores adverts and Alle News', () => {
    const parsed = parseHeiseIxRankings([module()]);
    assert.deepEqual(Object.keys(parsed), ['top_news']);
    assert.deepEqual(parsed.top_news.map(item => ({ title: item.title, rank: item.rank })), [
        { title: 'Oracle Fusion: ChatGPT soll Geschäftsabläufe starten statt nur erklären', rank: 1 },
        { title: 'OpenTelemetry friert seine Transformationssprache ein', rank: 2 },
    ]);
    assert.ok(parsed.top_news[0].canonicalUrl.endsWith('-11505931.html'));
    assert.ok(parsed.top_news[1].canonicalUrl.endsWith('-11505793.html'));
    assert.doesNotMatch(JSON.stringify(parsed), /Alle News|Anzeige|synopsis|image description/);
    assert.equal(Object.hasOwn(parsed, 'most_read'), false);
    assert.equal(Object.hasOwn(parsed, 'most_commented'), false);
});

test('scopes the exact heading to a direct ModuleHeader and its own TeaserList', () => {
    assert.throws(() => parseHeiseIxRankings([module(first, 'Weitere Top-News')]), missing);
    const unrelated = `<div data-component="TeasersModule"><header data-component="ModuleHeader"><h2>Videos</h2></header>${module(second)}</div>`;
    assert.equal(parseHeiseIxRankings([unrelated]).top_news.length, 1);
    const nestedHeader = `<div data-component="TeasersModule"><div><header data-component="ModuleHeader"><h2>Top-News</h2></header></div><section data-component="TeaserList">${first}</section></div>`;
    assert.throws(() => parseHeiseIxRankings([nestedHeader]), missing);
    const nestedModule = module(first + module(second, 'Other News'));
    assert.equal(parseHeiseIxRankings([nestedModule]).top_news.length, 1);
});

function missing(error) { return error.code === 'HEISE_IX_TOP_NEWS_MISSING'; }

test('cleans soft hyphens and tracking while preserving functional query parameters', () => {
    const changed = first.replace('.html"', '.html?utm_source=ix&amp;id=7#comments"').replace('Geschäftsabläufe', 'Geschäfts\u00adabläufe');
    const parsed = parseHeiseIxRankings([module(changed)]).top_news[0];
    assert.equal(parsed.canonicalUrl.endsWith('.html?id=7'), true);
    assert.equal(parsed.title.includes('Geschäftsabläufe'), true);
    const fallback = second.replace('data-component="TeaserHeadline"', 'data-component="Other"');
    assert.equal(parseHeiseIxRankings([module(fallback)]).top_news[0].title, 'OpenTelemetry friert seine Transformationssprache ein');
});

test('accepts only genuine same-site News article links and skips ad articles', () => {
    const variants = [
        first.replace('href="/news/', 'href="https://evil.test/news/'),
        first.replace('href="/news/', 'href="https://heise.de.evil.test/news/'),
        first.replace('href="/news/', 'href="https://forum.heise.de/news/'),
        first.replace('href="/news/', 'href="/ix/'),
        first.replace('-11505931.html', '-not-a-number.html'),
        first.replace('<article ', '<article data-ad '),
        first.replace('data-upscore-title="true"', '').replace('data-component="TeaserHeadline"', 'data-component="Other"'),
    ];
    assert.equal(parseHeiseIxRankings([module(variants.join('') + second)]).top_news.length, 1);
    assert.equal(parseHeiseIxRankings([module(first.replace('href="/news/', 'href="https://heise.de/news/'))]).top_news.length, 1);
});

test('deduplicates identical copies but rejects conflicting titles or editorial orders', () => {
    assert.equal(parseHeiseIxRankings([module(first + first + second), module()]).top_news.length, 2);
    for (const input of [[module(first + first.replace('Oracle Fusion:', 'Changed:'))], [module(), module(second + first)]]) {
        assert.throws(() => parseHeiseIxRankings(input), error => error.code === 'HEISE_IX_TOP_NEWS_CONFLICT');
    }
});

test('requires a nonempty unambiguous Top-News list', () => {
    for (const fragments of [[], [module('')], [module(advert)], [module().replace('data-component="TeaserList"', 'data-component="Other"')],
        [module().replace('</section>', '</section><section data-component="TeaserList"></section>')]]) {
        assert.throws(() => parseHeiseIxRankings(fragments), missing);
    }
});

test('prefers bounded HTTP capture with consent acceptance and genuine provenance', async () => {
    const snapshot = await fetchHeiseIxRankings({ configureBrowser: () => assert.fail('Unnecessary browser'), extract: async (url, options) => {
        assert.equal(url, HEISE_IX_RANKINGS_URL);
        assert.equal(options.mode, 'http');
        assert.equal(options.selector, '[data-component="TeasersModule"]');
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

test('browser fallback is semantic when HTTP matched a different teaser module', async () => {
    const modes = [];
    let signal;
    let configured = 0;
    const snapshot = await fetchHeiseIxRankings({ configureBrowser: () => { configured += 1; }, extract: async (_url, options) => {
        modes.push(options.mode);
        if (options.mode === 'http') {
            signal = options.signal;
            return result({ data: { matched: true, values: [module(first, 'Weitere News')] } });
        }
        assert.equal(options.signal, signal);
        assert.equal(options.consent, 'accept');
        assert.equal(options.waitAfterLoad, 3_000);
        return result();
    } });
    assert.equal(configured, 1);
    assert.deepEqual(modes, ['http', 'browser']);
    assert.equal(snapshot.rankings.top_news.length, 2);
});

test('rejects invalid source scope/status/timestamp and conflicts without browser retries', async () => {
    for (const metadata of [{ status: 403 }, { status: 429 }, { status: undefined }, { finalUrl: 'https://evil.test/ix' },
        { finalUrl: 'https://www.heise.de/' }, { finalUrl: 'https://www.heise.de/ix/newsticker' }, { finalUrl: 'https://www.heise.de/ixx' },
        { finalUrl: null }, { capturedAt: null }, { capturedAt: '' }, { capturedAt: 'invalid' },
        { data: { values: [module(), module(second + first)] } }]) {
        let attempts = 0;
        await assert.rejects(fetchHeiseIxRankings({ configureBrowser: () => assert.fail('Do not retry invalid evidence'), extract: async () => {
            attempts += 1;
            return result(metadata);
        } }));
        assert.equal(attempts, 1);
    }
    assert.equal((await fetchHeiseIxRankings({ extract: async () => result({ finalUrl: HEISE_IX_RANKINGS_URL }) })).rankings.top_news.length, 2);
});

test('browser configuration failure retains the missing-module cause', async () => {
    await assert.rejects(fetchHeiseIxRankings({
        configureBrowser: () => { throw new Error('No usable Chrome'); },
        extract: async () => result({ data: { values: [] } }),
    }), error => {
        assert.equal(error.message, 'No usable Chrome');
        assert.equal(error.cause.code, 'HEISE_IX_TOP_NEWS_MISSING');
        return true;
    });
});

test('real Fetchary HTTP extraction reads the supplied structure without executing its iframe', async () => {
    const snapshot = await fetchHeiseIxRankings({ extract: (url, options) => extractSelector(url, {
        ...options, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () => new Response(`<html><body>${module()}</body></html>`, { headers: { 'content-type': 'text/html; charset=UTF-8' } }),
    }) });
    assert.equal(snapshot.rankings.top_news.length, 2);
    assert.deepEqual(Object.keys(snapshot.rankings), ['top_news']);
});
