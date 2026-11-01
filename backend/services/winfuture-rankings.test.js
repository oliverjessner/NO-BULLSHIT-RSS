import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSelector } from 'fetchary';
import { fetchWinFutureRankings, parseWinFutureRankings, parseWinFuturePopularHtml, WINFUTURE_RANKINGS_URL } from './winfuture-rankings.js';
import { fetchWinFuturePopularHtml, WINFUTURE_POPULAR_URL } from './winfuture-popular.js';
import { rankingMediumForSource, RANKING_MEDIA } from './ranking-media.js';

// Trimmed structural examples supplied in winfuture.md; no live response is
// checked in and the article titles below never become application seed data.
const read = `<div class="rightBx right_orangeBx"><div class="tab_flame"></div>
    <div class="rightBxHead head_bg2">Beliebte Nachrichten</div><div class="rightBxIn visible_part">
    <ul class="orange_teaser_tabs"><li class="active news_beliebteste_24_tab">24 Stunden</li><li class="news_beliebteste_48_tab">48 Stunden</li></ul>
    <div class="show_desc news_beliebteste_24"><ul>
    <li><div class="clearB_w"><dfn>1</dfn><a href="/news,162334.html" title="FritzOS 8.40: Kleine Halloween-Updates für 6 FritzBoxen stehen bereit">FritzOS 8.40: Kleine Halloween-Updates für 6 FritzBoxen stehen bereit</a></div></li>
    <li><div class="clearB_w"><dfn>2</dfn><a href="/news,162338.html" title="Microsoft: Fehlende Taskleistenfunktion in Windows 11 ist ein Feature">Microsoft: Fehlende Taskleistenfunktion in Windows 11 ist ein Feature</a></div></li>
    </ul></div><div class="hide_desc ajax_load news_beliebteste_48"><ul><li><dfn>1</dfn><a href="/news,48.html">Other window</a></li></ul></div>
    <div class="hide_desc ajax_load news_beliebteste_168"></div></div></div>`;
const commented = `<div class="rightBx right_greenBx"><div class="rightBxHead">Meist kommentierte Nachrichten</div>
    <div class="rightBxIn"><ul class="right_news">
    <li><div class="clearB_w"><a href="/news,162318.html"><img alt="Elektromobilität"/></a><span><a href="/news,162318.html" title="&quot;Können uns das nicht leisten&quot;: VW legt den ID. Golf auf Eis">"Können uns das nicht leisten": VW legt den ID. Golf auf Eis</a><span class="pointer" onclick="window.location='/news,162318.html#block';">(81)</span></span></div></li>
    <li><div class="clearB_w"><a href="/news,162335.html"><img alt="Server"/></a><span><a href="/news,162335.html" title="Geldregen durch Datensteuer in Frankreich: 5,5 Cent/GB Abgabe geplant">Geldregen durch Datensteuer in Frankreich: 5,5 Cent/GB Abgabe geplant</a><span class="pointer">(57)</span></span></div></li>
    </ul></div></div>`;
const capturedAt = '2026-11-01T12:00:00.000Z';
const popular = `<div><h2><a href="/news,162334.html">FritzOS 8.40: Kleine Halloween-Updates für 6 FritzBoxen stehen bereit</a></h2>
    <h2><a href="/news,162338.html">Microsoft: Fehlende Taskleistenfunktion in Windows 11 ist ein Feature</a></h2></div>`;
const result = extra => ({ status: 200, finalUrl: WINFUTURE_RANKINGS_URL, capturedAt, data: { matched: true, values: [read, commented] }, ...extra });

test('parses the supplied popular24h and commented sidebars without image duplicates or comment counts', () => {
    const parsed = parseWinFutureRankings([read, commented]);
    assert.deepEqual(parsed.most_read.map(item => [item.rank, item.canonicalUrl]), [[1, 'https://winfuture.de/news,162334.html'], [2, 'https://winfuture.de/news,162338.html']]);
    assert.deepEqual(parsed.most_commented.map(item => item.canonicalUrl), ['https://winfuture.de/news,162318.html', 'https://winfuture.de/news,162335.html']);
    assert.equal(parsed.most_commented[0].title, '"Können uns das nicht leisten": VW legt den ID. Golf auf Eis');
    assert.equal(parsed.most_read.some(item => item.canonicalUrl.endsWith('news,48.html')), false);
    assert.equal(parsed.most_commented.some(item => /\(81\)/.test(item.title)), false);
});

test('keeps publisher rank positions and removes tracking fragments and soft hyphens', () => {
    const changed = read.replace('<dfn>2</dfn>', '<dfn>5</dfn>').replace('/news,162338.html', '/news,162338.html?utm_source=sidebar#block')
        .replace('Microsoft: Fehlende', 'Micro\u00adsoft: Fehlende');
    const parsed = parseWinFutureRankings([changed, commented]);
    assert.deepEqual(parsed.most_read.map(item => item.rank), [1, 5]);
    assert.equal(parsed.most_read[1].canonicalUrl, 'https://winfuture.de/news,162338.html');
    assert.equal(parsed.most_read[1].title.startsWith('Microsoft:'), true);
});

test('ignores unrelated widgets, external links and non-news paths, and requires both complete lists', () => {
    const price = '<div class="rightBx right_orangeBx"><div class="rightBxHead">Beliebt im Preisvergleich</div><a href="https://other.test">Offer</a></div>';
    assert.deepEqual(parseWinFutureRankings([price, read, commented]), parseWinFutureRankings([read, commented]));
    assert.throws(() => parseWinFutureRankings([commented, price]), error => error.code === 'WINFUTURE_RANKINGS_MISSING');
    for (const href of ['https://evil.test/news,162334.html', 'https://other.winfuture.de/news,162334.html', '/download,162334.html', 'javascript:alert(1)']) {
        const invalid = read.replace('/news,162334.html', href);
        assert.deepEqual(parseWinFutureRankings([invalid, commented]).most_read.map(item => item.rank), [2]);
    }
    assert.throws(() => parseWinFutureRankings([read.replace('news_beliebteste_24"', 'missing_24"'), commented]), /list is missing/);
});

test('matches WinFuture source host independently of source IDs/names and lists supported publisher media', () => {
    assert.equal(rankingMediumForSource({ websiteUrl: 'https://www.winfuture.de/' }).id, 'winfuture');
    assert.equal(rankingMediumForSource({ websiteUrl: 'https://winfuture.de/', name: 'Other' }).id, 'winfuture');
    assert.equal(rankingMediumForSource({ websiteUrl: 'https://winfuture.de.evil.test/', name: 'WinFuture' }), null);
    assert.deepEqual(RANKING_MEDIA.map(({ id, name }) => ({ id, name })), [{ id: 'golem', name: 'Golem' }, { id: 'winfuture', name: 'WinFuture' }, { id: 'computerbase', name: 'ComputerBase' }]);
});

test('uses complete HTTP HTML without loading a browser and preserves capture metadata', async () => {
    const snapshot = await fetchWinFutureRankings({ configureBrowser: () => assert.fail('Unnecessary browser'), fetchPopular: () => assert.fail('Prefer the complete reference sidebar'), extract: async (url, options) => {
        assert.equal(url, WINFUTURE_RANKINGS_URL);
        assert.equal(options.mode, 'http');
        assert.equal(options.consent, 'accept');
        assert.equal(Object.hasOwn(options, 'session'), false);
        assert.equal(options.all, true);
        return result();
    } });
    assert.equal(snapshot.capturedAt, capturedAt);
    assert.equal(snapshot.rankings.most_read.length, 2);
});

test('uses the current public popular tab when the legacy sidebar is absent, without losing the commented list', async () => {
    let popularReads = 0;
    const snapshot = await fetchWinFutureRankings({
        configureBrowser: () => assert.fail('Public HTTP data does not need a browser'),
        extract: async (_url, options) => {
            assert.equal(options.mode, 'http');
            return result({ data: { values: [commented] } });
        },
        fetchPopular: async ({ signal }) => {
            popularReads += 1;
            assert.ok(signal instanceof AbortSignal);
            return { html: popular, capturedAt: '2026-11-01T12:01:00.000Z' };
        },
    });
    assert.equal(popularReads, 1);
    assert.equal(snapshot.capturedAt, '2026-11-01T12:01:00.000Z');
    assert.equal(snapshot.rankings.most_read.length, 2);
    assert.equal(snapshot.rankings.most_commented.length, 2);
    assert.deepEqual(parseWinFuturePopularHtml(popular).map(item => item.rank), [1, 2]);
    assert.throws(() => parseWinFuturePopularHtml('<h2><a href="https://evil.test/news,1.html">Ad</a></h2>'), /no usable articles/);
});

test('reads the public tab using its fixed origin, POST contract and bounded validated JSON response', async () => {
    const response = await fetchWinFuturePopularHtml({ fetchImpl: async (url, options) => {
        assert.equal(url, WINFUTURE_POPULAR_URL);
        assert.equal(options.method, 'POST');
        assert.equal(options.body, 'pager=1');
        assert.equal(options.redirect, 'manual');
        assert.ok(options.signal instanceof AbortSignal);
        return Response.json({ html: popular });
    } });
    assert.equal(response.html, popular);
    assert.ok(Number.isFinite(Date.parse(response.capturedAt)));
    const invalid = [
        () => new Response('{}', { status: 302, headers: { location: 'https://evil.test/' } }),
        () => Response.json({ html: popular, error: 'Unavailable' }),
        () => Response.json({ html: '' }),
        () => new Response('<html>Consent</html>', { headers: { 'content-type': 'text/html' } }),
        () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }),
        () => new Response('x'.repeat(1048577), { headers: { 'content-type': 'application/json' } }),
        () => {
            const response = Response.json({ html: popular });
            Object.defineProperty(response, 'url', { value: 'https://evil.test/ajax/homepage/hp_top' });
            return response;
        },
    ];
    for (const makeResponse of invalid) {
        await assert.rejects(fetchWinFuturePopularHtml({ fetchImpl: async () => makeResponse() }), error => error.code === 'WINFUTURE_POPULAR_UNAVAILABLE');
    }
});

test('retries explicit browser rendering when unrelated static widgets or a partial capture omit a required list', async () => {
    const modes = [];
    let signal;
    const snapshot = await fetchWinFutureRankings({ extract: async (_url, options) => {
        modes.push(options.mode);
        assert.equal(options.consent, 'accept');
        if (options.mode === 'http') { signal = options.signal; return result({ data: { matched: true, values: [commented] } }); }
        assert.equal(options.signal, signal);
        assert.equal(options.waitAfterLoad, 3_000);
        return result();
    } });
    assert.deepEqual(modes, ['http', 'browser']);
    assert.equal(snapshot.rankings.most_read.length, 2);
});

test('rejects HTTP failures, redirected sites and invalid timestamps without a fabricated capture', async () => {
    for (const metadata of [{ status: 403 }, { status: 429 }, { finalUrl: 'https://other.test/' }, { capturedAt: null }, { capturedAt: 'invalid' }]) {
        let requests = 0;
        await assert.rejects(fetchWinFutureRankings({ extract: async () => { requests += 1; return result(metadata); } }));
        assert.equal(requests, 1);
    }
});

test('real Fetchary HTTP extraction decodes the publisher ISO-8859-1 content before parsing', async () => {
    const snapshot = await fetchWinFutureRankings({ extract: (url, options) => extractSelector(url, {
        ...options,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () => new Response(Buffer.from(`<html><body>${read}${commented}</body></html>`, 'latin1'), {
            headers: { 'content-type': 'text/html; charset=iso-8859-1' },
        }),
    }) });
    assert.equal(snapshot.rankings.most_read[0].title.includes('für 6 FritzBoxen'), true);
    assert.equal(snapshot.rankings.most_commented[0].title.includes('Können'), true);
});
