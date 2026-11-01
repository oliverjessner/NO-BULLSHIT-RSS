import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSelector } from 'fetchary';
import { T3N_RANKINGS_URL, fetchT3nRankings, parseT3nRankings } from './t3n-rankings.js';

// Five supplied rows, trimmed to the parser's structure and title evidence.
const supplied = [
    ['anthropic-claude-motion-test-1769905', 'Claude Motion im Test: Was Anthropics Animations-KI wirklich leistet', 'faa7e0a535b6815fca8a1d176b12011a'],
    ['superhabitable-planeten-suche-nach-leben-1768470', 'Lebensfreundlicher als die Erde: Warum Astronomen bei der Suche nach Exoplaneten umdenken', 'd6ad093fc4cff83b62effb910d57c9ee'],
    ['macbook-pro-touchscreen-steve-jobs-apple-gadgets-1770763', 'Macbook Pro mit Touchscreen? Diese Apple-Gadgets hätte es unter Steve Jobs nicht gegeben', 'news-article-1770763'],
    ['nach-rekordsommer-was-deutsche-staedte-beim-hitzeschutz-tun-koennten-und-woran-es-hapert-1768345', ' Nach Rekordsommer: Was deutsche Städte beim Hitzeschutz tun könnten – und woran es hapert', 'news-article-1768345'],
    ['stromnetz-am-limit-wie-solid-state-transformatoren-jetzt-abhilfe-schaffen-koennten-1770379', ' Wie Solid-State-Transformatoren den Strombedarf von KI-Rechenzentren stemmen könnten', 'news-article-1770379'],
];
const row = ([slug, title, id]) => `<div class="most-read-item-wrapper" data-upscore-object-id="${id}"><div class="most-read-counter"></div>
    <div class="most-read-content"><a href="https://t3n.de/news/${slug}/" title="${title}" class="t-most-read__article" data-article-identifier="${id}">
    <span class="most-read-meta"><svg aria-hidden="true"><path></path></svg><span class="tr-badge" data-cf="MIT Technology Review">MIT Technology Review</span>
    <span class="tr-badge">\${custom_tr-badge}</span><span class="most-read-section">undefined</span></span><h4 class="most-read-title">${title}</h4></a></div></div>`;
const rows = supplied.map(row);
const widget = (items = rows.join('')) => `<div id="upscore-mostread-target"><div class="most-read-items">${items}</div></div>`;
const capturedAt = '2026-11-01T16:00:00.000Z';
const result = extra => ({ status: 200, finalUrl: T3N_RANKINGS_URL, capturedAt, data: { matched: true, values: [widget()] }, ...extra });
const missing = error => error.code === 'T3N_RANKINGS_MISSING';

test('reads all five supplied rows in CSS-counter DOM order, without using hash identifiers as article IDs', () => {
    const parsed = parseT3nRankings([widget()]);
    assert.deepEqual(Object.keys(parsed), ['most_read']);
    assert.deepEqual(parsed.most_read.map(item => item.rank), [1, 2, 3, 4, 5]);
    assert.deepEqual(parsed.most_read.map(item => item.title), supplied.map(([, title]) => title.trim()));
    assert.ok(parsed.most_read[0].canonicalUrl.endsWith('-1769905/'));
    assert.ok(parsed.most_read.every(item => Object.keys(item).join(',') === 'canonicalUrl,title,rank'));
    assert.doesNotMatch(JSON.stringify(parsed), /undefined|custom_tr-badge|MIT Technology Review|faa7e0a535/);
});

test('uses a clean h4 title before the title attribute, with attribute fallback and tracking removal', () => {
    const changed = rows[0].replace('test-1769905/"', 'test-1769905/?utm_source=mostread&amp;id=7#comments"')
        .replace('<h4 class="most-read-title">Claude', '<h4 class="most-read-title">Clau\u00adde');
    const item = parseT3nRankings([widget(changed)]).most_read[0];
    assert.equal(item.title, supplied[0][1]);
    assert.equal(item.canonicalUrl.endsWith('/?id=7'), true);
    const fallback = rows[1].replace(/<h4 class="most-read-title">.*?<\/h4>/, '');
    assert.equal(parseT3nRankings([widget(fallback)]).most_read[0].title, supplied[1][1]);
    const wrongAttribute = rows[0].replace('title="Claude Motion im Test:', 'title="Unrelated:');
    assert.equal(parseT3nRankings([widget(wrongAttribute)]).most_read[0].title, supplied[0][1]);
});

test('does not mistake an absent or empty injection target, template or unrelated list for rankings', () => {
    for (const fragments of [[], ['<div id="upscore-mostread-target"></div>'], [widget('')],
        [`<template id="upscore-mostread">${rows[0]}</template>`], [widget().replace('id="upscore-mostread-target"', 'id="other"')],
        [widget(row(['\${url}', '\${title}', 'placeholder']))]]) {
        assert.throws(() => parseT3nRankings(fragments), missing);
    }
});

test('accepts only genuine same-site News paths and ignores marked advertisements', () => {
    const invalid = [
        rows[0].replace('https://t3n.de/news/', 'https://evil.test/news/'),
        rows[0].replace('https://t3n.de/news/', 'https://t3n.de.evil.test/news/'),
        rows[0].replace('https://t3n.de/news/', 'https://forum.t3n.de/news/'),
        rows[0].replace('/news/', '/topics/'), rows[0].replace('-1769905/', '-hash/'),
        rows[0].replace('https://t3n.de/news/', 'javascript:news/'),
        rows[0].replace('<div class="most-read-item-wrapper"', '<div data-ad class="most-read-item-wrapper"'),
    ].join('');
    assert.equal(parseT3nRankings([widget(invalid + rows[1])]).most_read.length, 1);
    assert.equal(parseT3nRankings([widget(rows[0].replace('https://t3n.de/', 'https://www.t3n.de/'))]).most_read.length, 1);
});

test('deduplicates identical responsive rows and widgets but rejects conflicts in titles or order', () => {
    assert.equal(parseT3nRankings([widget(), widget()]).most_read.length, 5);
    assert.deepEqual(parseT3nRankings([widget(rows[0] + rows[0] + rows[1])]).most_read.map(item => item.rank), [1, 3]);
    const changed = rows[0].replaceAll(supplied[0][1], 'Different title');
    for (const input of [[widget(rows[0] + changed)], [widget(), widget([...rows].reverse().join(''))]]) {
        assert.throws(() => parseT3nRankings(input), error => error.code === 'T3N_RANKINGS_CONFLICT');
    }
    assert.throws(() => parseT3nRankings([widget().replace('</a>', '</a><a class="t-most-read__article" href="/news/other-123/">Other</a>')]), missing);
});

test('preserves the original CSS-counter position after unusable or advertising wrappers', () => {
    const wrongUrl = rows[0].replace('https://t3n.de/news/', 'https://evil.test/news/');
    const placeholder = rows[0].replaceAll(supplied[0][1], '\${title}');
    const advert = rows[0].replace('<div class="most-read-item-wrapper"', '<div data-ad class="most-read-item-wrapper"');
    for (const first of [wrongUrl, placeholder, advert]) {
        const items = parseT3nRankings([widget(first + rows[1])]).most_read;
        assert.equal(items.length, 1);
        assert.equal(items[0].rank, 2);
        assert.ok(items[0].canonicalUrl.endsWith('-1768470/'));
    }
});

test('prefers bounded HTTP capture and returns genuine source/timestamp metadata', async () => {
    const snapshot = await fetchT3nRankings({ configureBrowser: () => assert.fail('Unnecessary browser'), extract: async (url, options) => {
        assert.equal(url, T3N_RANKINGS_URL);
        assert.equal(options.selector, '#upscore-mostread-target');
        assert.equal(options.mode, 'http');
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
    assert.deepEqual(Object.keys(snapshot.rankings), ['most_read']);
});

test('an empty matched HTTP target requires semantic browser fallback within the same deadline', async () => {
    const modes = [];
    let signal;
    let configured = 0;
    const snapshot = await fetchT3nRankings({ configureBrowser: () => { configured += 1; }, extract: async (_url, options) => {
        modes.push(options.mode);
        if (options.mode === 'http') {
            signal = options.signal;
            return result({ data: { matched: true, values: ['<div id="upscore-mostread-target"></div>'] } });
        }
        assert.equal(options.signal, signal);
        assert.equal(options.consent, 'accept');
        assert.equal(options.waitAfterLoad, 3_000);
        assert.equal(options.timeout, 15_000);
        assert.equal(options.maxResponseBytes, 8 * 1024 * 1024);
        return result();
    } });
    assert.equal(configured, 1);
    assert.deepEqual(modes, ['http', 'browser']);
    assert.equal(snapshot.rankings.most_read.length, 5);
});

test('invalid source/status/timestamp and conflicting evidence never trigger a browser retry', async () => {
    for (const metadata of [{ status: 403 }, { status: 429 }, { status: undefined }, { finalUrl: 'https://evil.test/' },
        { finalUrl: 'https://t3n.de.evil.test/' }, { finalUrl: 'https://t3n.de/news/' }, { finalUrl: null },
        { capturedAt: null }, { capturedAt: '' }, { capturedAt: 'invalid' },
        { data: { values: [widget(), widget(rows[1] + rows[0])] } }]) {
        let attempts = 0;
        await assert.rejects(fetchT3nRankings({ configureBrowser: () => assert.fail('Do not retry invalid evidence'), extract: async () => {
            attempts += 1;
            return result(metadata);
        } }));
        assert.equal(attempts, 1);
    }
});

test('browser configuration failure retains the original empty-widget cause', async () => {
    await assert.rejects(fetchT3nRankings({
        configureBrowser: () => { throw new Error('No usable Chrome'); },
        extract: async () => result({ data: { values: [widget('')] } }),
    }), error => {
        assert.equal(error.message, 'No usable Chrome');
        assert.equal(error.cause.code, 'T3N_RANKINGS_MISSING');
        return true;
    });
});

test('real Fetchary HTTP extraction can parse the supplied populated structure without unrelated metadata', async () => {
    const snapshot = await fetchT3nRankings({ extract: (url, options) => extractSelector(url, {
        ...options, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () => new Response(`<html><body>${widget()}</body></html>`, { headers: { 'content-type': 'text/html; charset=UTF-8' } }),
    }) });
    assert.equal(snapshot.rankings.most_read.length, 5);
    assert.doesNotMatch(JSON.stringify(snapshot), /undefined|custom_tr-badge/);
});
