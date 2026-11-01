import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGolemRankings, GolemConsentRequiredError, isGolemSource, parseGolemRankings, GOLEM_RANKINGS_URL } from './golem-rankings.js';

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

test('uses bounded Fetchary HTTP capture with the accept consent policy and preserves capture provenance', async () => {
    const snapshot = await fetchGolemRankings({ extract: async (url, options) => {
        assert.equal(url, GOLEM_RANKINGS_URL);
        assert.equal(options.selector, '.go-teaser-block');
        assert.equal(options.all, true);
        assert.equal(options.format, 'html');
        assert.equal(options.mode, 'http');
        assert.equal(options.consent, 'accept');
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

test('does not configure an optional browser when complete public HTTP rankings are sufficient', async () => {
    let configured = 0;
    const snapshot = await fetchGolemRankings({
        configureBrowser: () => {
            configured += 1;
            throw new Error('Bundled ranking browser is incomplete');
        },
        extract: async (url, options) => {
            assert.equal(url, GOLEM_RANKINGS_URL);
            assert.equal(options.mode, 'http');
            assert.equal(options.consent, 'accept');
            return result();
        },
    });
    assert.equal(configured, 0);
    assert.equal(snapshot.capturedAt, capturedAt);
    assert.equal(snapshot.rankings.most_read.length, 1);
    assert.equal(snapshot.rankings.most_commented.length, 1);
});

test('does not attempt browser rendering for failed HTTP requests', async () => {
    const captureFailure = new Error('HTTP extraction failed');
    let configured = 0;
    await assert.rejects(fetchGolemRankings({
        configureBrowser: () => { configured += 1; },
        extract: async (_url, options) => {
            assert.equal(options.mode, 'http');
            throw captureFailure;
        },
    }), error => {
        assert.equal(error, captureFailure);
        return true;
    });
    assert.equal(configured, 0);
});

test('reports a required browser configuration failure with the incomplete HTTP capture as its cause', async () => {
    await assert.rejects(fetchGolemRankings({
        configureBrowser: () => { throw new Error('Bundled ranking browser is incomplete'); },
        extract: async () => result({ data: { values: [read] } }),
    }), error => {
        assert.equal(error.message, 'Bundled ranking browser is incomplete');
        assert.match(error.cause.message, /both article rankings/);
        return true;
    });
});

test('renders explicitly when unrelated HTTP teaser blocks match but both required sections are missing', async () => {
    const modes = [];
    let signal;
    let configured = 0;
    const snapshot = await fetchGolemRankings({
        configureBrowser: () => { configured += 1; return { source: 'system' }; },
        extract: async (_url, options) => {
            modes.push(options.mode);
            assert.equal(options.consent, 'accept');
            assert.equal(options.timeout, 12_000);
            assert.equal(options.maxResponseBytes, 3 * 1024 * 1024);
            if (options.mode === 'http') {
                signal = options.signal;
                assert.equal(options.waitAfterLoad, 0);
                return result({ data: { matched: true, values: [block('Neueste Meldungen', article('/news/other.html', 'Other'))] } });
            }
            assert.equal(options.mode, 'browser');
            assert.equal(options.waitAfterLoad, 3_000);
            assert.equal(options.signal, signal);
            return result();
        },
    });
    assert.deepEqual(modes, ['http', 'browser']);
    assert.equal(configured, 1);
    assert.equal(snapshot.capturedAt, capturedAt);
    assert.equal(snapshot.rankings.most_read.length, 1);
    assert.equal(snapshot.rankings.most_commented.length, 1);
});

test('accepts Golem consent in the browser when HTTP redirects to its cookie choice page', async () => {
    const modes = [];
    let configured = 0;
    const snapshot = await fetchGolemRankings({
        configureBrowser: () => { configured += 1; },
        extract: async (_url, options) => {
            modes.push(options.mode);
            assert.equal(options.consent, 'accept');
            if (options.mode === 'http') return result({
                finalUrl: 'https://www.golem.de/sonstiges/zustimmung/auswahl.html?from=https%3A%2F%2Fwww.golem.de%2F',
                data: { matched: false, values: [] },
                consent: { detected: true, provider: 'sourcepoint', action: 'accept', status: 'unsupported' },
            });
            assert.equal(options.waitAfterLoad, 3_000);
            return result({ consent: { detected: true, action: 'accept', status: 'handled' } });
        },
    });
    assert.deepEqual(modes, ['http', 'browser']);
    assert.equal(configured, 1);
    assert.equal(snapshot.rankings.most_read.length, 1);
    assert.equal(snapshot.rankings.most_commented.length, 1);
});

test('retains an actionable consent error if automatic acceptance cannot release the Golem page', async () => {
    const modes = [];
    await assert.rejects(fetchGolemRankings({ extract: async (_url, options) => {
        modes.push(options.mode);
        assert.equal(options.consent, 'accept');
        return result({
            finalUrl: 'https://www.golem.de/sonstiges/zustimmung/auswahl.html',
            data: { matched: false, values: [] },
            consent: { detected: true, action: 'accept', status: 'blocked' },
        });
    } }), error => {
        assert.ok(error instanceof GolemConsentRequiredError);
        assert.equal(error.code, 'GOLEM_CONSENT_REQUIRED');
        assert.equal(error.phase, 'consent');
        assert.equal(error.retryable, false);
        assert.match(error.message, /Automatic Golem consent could not be completed/);
        return true;
    });
    assert.deepEqual(modes, ['http', 'browser']);
});

test('accepts inline consent dialogs through a rendered retry', async () => {
    const modes = [];
    await fetchGolemRankings({ extract: async (_url, options) => {
        modes.push(options.mode);
        return options.mode === 'http' ? result({
            data: { matched: false, values: [] },
            consent: { detected: true, action: 'accept', status: 'unsupported' },
        }) : result({ consent: { detected: true, action: 'accept', status: 'handled' } });
    } });
    assert.deepEqual(modes, ['http', 'browser']);
});

test('reports missing rankings separately from a completed consent decision', async () => {
    await assert.rejects(fetchGolemRankings({ extract: async () => result({
        data: { values: [read] },
        consent: { detected: true, action: 'accept', status: 'handled' },
    }) }), error => error.code === 'GOLEM_RANKINGS_MISSING');
});

test('HTTP and browser capture use automatic consent acceptance without saved sessions or browser profiles', async () => {
    const modes = [];
    const snapshot = await fetchGolemRankings({
        configureBrowser: () => ({ source: 'system' }),
        extract: async (_url, options) => {
            modes.push(options.mode);
            assert.equal(Object.hasOwn(options, 'session'), false);
            assert.equal(Object.hasOwn(options, 'sessionDir'), false);
            assert.equal(options.consent, 'accept');
            assert.equal(Object.hasOwn(options, 'cookiesFromBrowser'), false);
            assert.equal(Object.hasOwn(options, 'browserProfile'), false);
            assert.equal(Object.hasOwn(options, 'cookieFile'), false);
            return options.mode === 'http' ? result({ data: { values: [read] } }) : result();
        },
    });
    assert.deepEqual(modes, ['http', 'browser']);
    assert.equal(snapshot.rankings.most_read.length, 1);
    assert.equal(snapshot.rankings.most_commented.length, 1);
});
