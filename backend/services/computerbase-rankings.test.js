import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSelector } from 'fetchary';
import { COMPUTERBASE_RANKINGS_URL, fetchComputerBaseRankings, parseComputerBaseRankings } from './computerbase-rankings.js';

// Trimmed from the user's supplied sidebar structure, not a saved live dump.
const article = `<li><a href="/news/gaming/zelda-ohne-emulator-tears-of-the-kingdom-erhaelt-nativen-pc-port.100081/" class="charts__link charts__link--compact visited-link">
    <div class="charts__left"><div class="charts__rank charts__rank--simple charts__rank--1">1</div></div>
    <div class="charts__main"><div class="charts__context">Zelda ohne Emulator</div>
    <div class="charts__title">Tears of the Kingdom erhält nativen PC-Port</div><div class="charts__bar w-100">100%</div></div></a></li>`;
const box = (items = article, heading = 'Meistgelesene News') => `<div class="box box--sidebar box-white"><h2 class="h2">${heading}</h2>
    <ol class="charts">${items}</ol><div class="charts-info"><b>Datenbasis:</b> News der letzten 72 Stunden.</div></div>`;
const fragment = `<div class="row__aside-group">${box()}<div class="box">adbox <iframe></iframe></div></div>`;
const capturedAt = '2026-11-01T14:00:00.000Z';
const result = extra => ({ status: 200, finalUrl: COMPUTERBASE_RANKINGS_URL, capturedAt, data: { matched: true, values: [fragment] }, ...extra });

test('reads only the supplied most-read News chart with context, title and explicit rank', () => {
    const parsed = parseComputerBaseRankings([fragment, box(article, 'Top-10 Tests & Berichte')]);
    assert.deepEqual(Object.keys(parsed), ['most_read']);
    assert.deepEqual(parsed.most_read, [{
        canonicalUrl: 'https://www.computerbase.de/news/gaming/zelda-ohne-emulator-tears-of-the-kingdom-erhaelt-nativen-pc-port.100081/',
        title: 'Zelda ohne Emulator: Tears of the Kingdom erhält nativen PC-Port', rank: 1,
    }]);
    assert.doesNotMatch(parsed.most_read[0].title, /100%|Datenbasis/);
});

test('preserves ranking gaps, cleans soft hyphens/tracking and supports a missing context', () => {
    const changed = article.replace('>1</div>', '>5</div>').replace('.100081/"', '.100081/?utm_source=chart#comments"')
        .replace('Tears of the Kingdom', 'Tears of the King\u00addom');
    assert.equal(parseComputerBaseRankings([box(changed)]).most_read[0].rank, 5);
    assert.equal(parseComputerBaseRankings([box(changed)]).most_read[0].canonicalUrl.endsWith('.100081/'), true);
    assert.equal(parseComputerBaseRankings([box(changed)]).most_read[0].title.includes('Kingdom'), true);
    const noContext = article.replace('<div class="charts__context">Zelda ohne Emulator</div>', '');
    assert.equal(parseComputerBaseRankings([box(noContext)]).most_read[0].title, 'Tears of the Kingdom erhält nativen PC-Port');
});

test('ignores bars, ad rows, external sites, non-News links and malformed or missing ranks', () => {
    const ad = article.replace('<li>', '<li data-ad>');
    const external = article.replace('href="/news/', 'href="https://evil.test/news/');
    const otherHost = article.replace('href="/news/', 'href="https://forum.computerbase.de/news/');
    const testLink = article.replace('href="/news/', 'href="/tests/');
    const malformedPath = article.replace('.100081/', '.abc/');
    const badRank = article.replace('>1</div>', '>1.5</div>');
    const missingRank = article.replace('charts__rank charts__rank--simple charts__rank--1', 'unrelated');
    assert.equal(parseComputerBaseRankings([box([ad, external, otherHost, testLink, malformedPath, badRank, missingRank, article].join(''))]).most_read.length, 1);
    assert.throws(() => parseComputerBaseRankings([box(ad)]), error => error.code === 'COMPUTERBASE_RANKINGS_MISSING');
});

test('deduplicates identical responsive copies but rejects conflicting URLs, ranks or blocks', () => {
    assert.equal(parseComputerBaseRankings([box(article + article), box()]).most_read.length, 1);
    const sameRankOtherUrl = article.replace('.100081/', '.100082/');
    const sameUrlOtherRank = article.replace('>1</div>', '>2</div>');
    for (const input of [[box(article + sameRankOtherUrl)], [box(article + sameUrlOtherRank)], [box(), box(sameRankOtherUrl)]]) {
        assert.throws(() => parseComputerBaseRankings(input), error => error.code === 'COMPUTERBASE_RANKINGS_CONFLICT');
    }
});

test('requires the exact News heading and a nonempty chart, without fabricating most-commented data', () => {
    for (const fragments of [[], [box(article, 'Meistgelesene Tests')], [box('')], [box().replace('class="charts"', 'class="other"')]]) {
        assert.throws(() => parseComputerBaseRankings(fragments), error => error.code === 'COMPUTERBASE_RANKINGS_MISSING');
    }
    assert.equal(Object.hasOwn(parseComputerBaseRankings([box()]), 'most_commented'), false);
});

test('prefers bounded HTTP capture and keeps genuine capture provenance', async () => {
    const snapshot = await fetchComputerBaseRankings({ configureBrowser: () => assert.fail('Unnecessary browser'), extract: async (url, options) => {
        assert.equal(url, COMPUTERBASE_RANKINGS_URL);
        assert.equal(options.selector, '.box--sidebar');
        assert.equal(options.mode, 'http');
        assert.equal(options.consent, 'accept');
        assert.equal(options.format, 'html');
        assert.equal(options.all, true);
        assert.equal(options.timeout, 12_000);
        assert.equal(options.maxResponseBytes, 3 * 1024 * 1024);
        assert.ok(options.signal instanceof AbortSignal);
        return result();
    } });
    assert.equal(snapshot.capturedAt, capturedAt);
    assert.deepEqual(Object.keys(snapshot.rankings), ['most_read']);
});

test('retries browser rendering for semantic missing charts even when unrelated sidebar boxes matched', async () => {
    const modes = [];
    let signal;
    let configured = 0;
    const snapshot = await fetchComputerBaseRankings({ configureBrowser: () => { configured += 1; }, extract: async (_url, options) => {
        modes.push(options.mode);
        if (options.mode === 'http') {
            signal = options.signal;
            return result({ data: { matched: true, values: [box(article, 'Top-10 Tests & Berichte')] } });
        }
        assert.equal(options.mode, 'browser');
        assert.equal(options.signal, signal);
        assert.equal(options.consent, 'accept');
        assert.equal(options.waitAfterLoad, 3_000);
        return result();
    } });
    assert.equal(configured, 1);
    assert.deepEqual(modes, ['http', 'browser']);
    assert.equal(snapshot.rankings.most_read.length, 1);
});

test('rejects invalid source/status/timestamp metadata and conflicting captures without browser retries', async () => {
    for (const metadata of [{ status: 403 }, { status: 429 }, { status: undefined }, { finalUrl: 'https://evil.test/' },
        { finalUrl: 'https://www.computerbase.de.evil.test/' }, { finalUrl: null }, { capturedAt: null }, { capturedAt: '' }, { capturedAt: 'invalid' },
        { data: { values: [box(article + article.replace('.100081/', '.100082/'))] } }]) {
        let attempts = 0;
        await assert.rejects(fetchComputerBaseRankings({ configureBrowser: () => assert.fail('Do not retry invalid evidence'), extract: async () => {
            attempts += 1;
            return result(metadata);
        } }));
        assert.equal(attempts, 1);
    }
});

test('a browser configuration failure retains the original missing-chart reason', async () => {
    await assert.rejects(fetchComputerBaseRankings({
        configureBrowser: () => { throw new Error('No usable Chrome'); },
        extract: async () => result({ data: { values: [] } }),
    }), error => {
        assert.equal(error.message, 'No usable Chrome');
        assert.equal(error.cause.code, 'COMPUTERBASE_RANKINGS_MISSING');
        return true;
    });
});

test('real Fetchary HTTP extraction handles the provided sidebar structure without executing its adverts', async () => {
    const snapshot = await fetchComputerBaseRankings({ extract: (url, options) => extractSelector(url, {
        ...options, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () => new Response(`<html><body>${fragment}</body></html>`, { headers: { 'content-type': 'text/html; charset=UTF-8' } }),
    }) });
    assert.equal(snapshot.rankings.most_read.length, 1);
    assert.equal(Object.hasOwn(snapshot.rankings, 'most_commented'), false);
});
