import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSelector } from 'fetchary';
import { WIRED_RANKINGS_URL, fetchWiredRankings, parseWiredRankings } from './wired-rankings.js';

// The four supplied story rows, trimmed without depending on the attachment.
const supplied = [
    ['the-dollar63-billion-binance-hack-was-pulled-off-in-just-20-minutes', 'The $6.3 Billion Binance Hack Was Pulled Off in Just 20 Minutes'],
    ['a-defense-contractor-gave-their-personal-ai-agent-access-to-a-secure-pentagon-system', 'A Defense Contractor Gave Their Personal AI Agent Access to a Secure Pentagon System'],
    ['ai-made-decades-of-computer-science-research-irrelevant', 'An AI Breakthrough Has Made Decades of Computer Science Research ‘Irrelevant’'],
    ['people-are-creating-survival-guides-to-cope-with-the-ao3-apocalypse', 'People Are Creating ‘Survival Guides’ to Cope With the ‘AO3 Apocalypse’'],
];
const row = ([slug, title], index = 0) => `<li><div class="SummaryItemWrapper-bFycXm summary-item" data-item="{&quot;dangerousHed&quot;:&quot;Do not parse this metadata title&quot;}" role="button" tabindex="0">
    <div class="summary-item__asset-container"><a class="summary-item__image-link" href="https://www.wired.com/story/${slug}/#intcid=tracking" aria-hidden="true"><picture><img src="https://media.wired.com/photos/image.jpg" alt="Unrelated image caption"></picture></a></div>
    <div class="summary-item__content"><div class="summary-item__rubric">Politics</div><a class="summary-item-tracking__hed-link summary-item__hed-link right_rail-${index + 1}" href="https://www.wired.com/story/${slug}/#intcid=tracking">
    <div data-testid="ClampWrapper"><div class="ClampContent-gsyjBh"><div class="SummaryItemHedTag-fjCYhF" data-testid="SummaryItemHed">${title}</div></div></div></a>
    <div class="summary-item__byline"><a href="https://www.wired.com/author/example/">Example Byline</a></div></div></div></li>`;
const rows = supplied.map(row);
const ad = '<li class="AsideAdListItem-lfCGib hide-aside-ad"><div class="ad ad--aside"><div class="ad__slot" data-node-id="9zzcae"></div></div></li>';
const module = (items = rows.join('') + ad, heading = 'Most Popular') => `<div class="RecircMostPopularContiner-hfeygl recirc-most-popular-sparrow-tracking" data-most-popular-id="mod-most-popular-267">
    <div class="RecircMostPopularHeading-iiIUBr"><div data-testid="SectionTitle"><div class="SectionTitleHed-iavHej">${heading}</div></div></div>
    <ul class="RecircMostPopularItems-chbXqt">${items}</ul><div class="RecircMostPopularFooter-dTjqiG"></div></div>`;
const capturedAt = '2026-11-01T18:00:00.000Z';
const result = extra => ({ status: 200, finalUrl: WIRED_RANKINGS_URL, capturedAt, data: { matched: true, values: [module()] }, ...extra });
const missing = error => error.code === 'WIRED_RANKINGS_MISSING';

test('reads the supplied four Most Popular stories without image links, metadata, bylines or the final ad', () => {
    const parsed = parseWiredRankings([module()]);
    assert.deepEqual(Object.keys(parsed), ['most_read']);
    assert.deepEqual(parsed.most_read.map(item => item.title), supplied.map(([, title]) => title));
    assert.deepEqual(parsed.most_read.map(item => item.rank), [1, 2, 3, 4]);
    assert.ok(parsed.most_read.every(item => item.canonicalUrl.endsWith('/')));
    assert.doesNotMatch(JSON.stringify(parsed), /intcid|Politics|Example Byline|metadata title|image caption|media\.wired/);
    assert.equal(Object.hasOwn(parsed, 'most_commented'), false);
});

test('preserves original direct-LI positions across ad, invalid and duplicate rows', () => {
    const invalid = rows[0].replace('class="summary-item-tracking__hed-link summary-item__hed-link right_rail-1" href="https://www.wired.com/', 'class="summary-item__hed-link" href="https://evil.test/');
    for (const first of [ad, invalid]) {
        assert.deepEqual(parseWiredRankings([module(first + rows[1])]).most_read.map(item => item.rank), [2]);
    }
    assert.deepEqual(parseWiredRankings([module(rows[0] + rows[0] + rows[1])]).most_read.map(item => item.rank), [1, 3]);
    const nestedAd = `<li><div class="ad">${rows[0].replace(/^<li>|<\/li>$/g, '')}</div></li>`;
    assert.deepEqual(parseWiredRankings([module(nestedAd + rows[1])]).most_read.map(item => item.rank), [2]);
});

test('requires the exact semantic module, its Most Popular SectionTitle and one direct list', () => {
    for (const fragment of [module(rows[0], 'Most Read'), module(rows[0], 'More Most Popular'),
        module().replace('data-most-popular-id=', 'data-other-id='), module().replaceAll('data-testid="SectionTitle"', 'data-testid="Other"'),
        module().replace('<ul ', '<div><ul ').replace('</ul>', '</ul></div>'), module().replace('</ul>', '</ul><ul></ul>')]) {
        assert.throws(() => parseWiredRankings([fragment]), missing);
    }
    assert.equal(parseWiredRankings([module().replace('mod-most-popular-267', 'mod-most-popular-999')]).most_read.length, 4);
});

test('uses only the headline test ID and cleans entities, soft hyphens, fragments and known tracking', () => {
    const changed = rows[0].replaceAll('/#intcid=tracking', '/?utm_source=popular&amp;id=7#intcid=tracking')
        .replace('>The $6.3 Billion', '>The $6.3 Bil\u00adlion &amp; More');
    const item = parseWiredRankings([module(changed)]).most_read[0];
    assert.equal(item.canonicalUrl.endsWith('/?id=7'), true);
    assert.ok(item.title.startsWith('The $6.3 Billion & More'));
    const noHeadline = rows[0].replace('data-testid="SummaryItemHed"', 'data-testid="Other"');
    assert.deepEqual(parseWiredRankings([module(noHeadline + rows[1])]).most_read.map(item => item.rank), [2]);
});

test('accepts same-site story, gallery and review article paths while rejecting unrelated or hostile URLs', () => {
    const invalid = [
        row(['https-not-a-path', 'placeholder']).replaceAll('https://www.wired.com/story/', 'https://evil.test/story/'),
        rows[0].replaceAll('https://www.wired.com/', 'https://wired.com.evil.test/'),
        rows[0].replaceAll('https://www.wired.com/', 'https://media.wired.com/'),
        rows[0].replaceAll('/story/', '/author/'), rows[0].replaceAll('/story/', '/category/'),
        rows[0].replaceAll('https://www.wired.com/', 'https://user:password@www.wired.com/'),
        rows[0].replaceAll('https://www.wired.com/', 'javascript:story/'),
    ].join('');
    assert.deepEqual(parseWiredRankings([module(invalid + rows[1])]).most_read.map(item => item.rank), [8]);
    assert.equal(parseWiredRankings([module(rows[0].replaceAll('https://www.wired.com/', 'https://wired.com/'))]).most_read.length, 1);
    for (const articleType of ['gallery', 'review']) {
        assert.equal(parseWiredRankings([module(rows[0].replaceAll('/story/', `/${articleType}/`))]).most_read.length, 1);
    }
});

test('deduplicates identical responsive modules but rejects conflicting article titles or list order', () => {
    assert.equal(parseWiredRankings([module(), module()]).most_read.length, 4);
    const changed = rows[0].replace(supplied[0][1], 'Different headline');
    for (const input of [[module(rows[0] + changed)], [module(), module([...rows].reverse().join(''))]]) {
        assert.throws(() => parseWiredRankings(input), error => error.code === 'WIRED_RANKINGS_CONFLICT');
    }
});

test('requires populated headline rows and rejects ambiguous headline anchors', () => {
    for (const fragments of [[], [module('')], [module(ad)],
        [module(rows[0].replace('<div class="summary-item__byline">', '<a class="summary-item__hed-link" href="/story/other/">Other</a><div class="summary-item__byline">'))]]) {
        assert.throws(() => parseWiredRankings(fragments), missing);
    }
});

test('prefers bounded sitemap HTTP capture with consent acceptance and genuine metadata', async () => {
    const snapshot = await fetchWiredRankings({ configureBrowser: () => assert.fail('Unnecessary browser'), extract: async (url, options) => {
        assert.equal(url, WIRED_RANKINGS_URL);
        assert.equal(options.mode, 'http');
        assert.equal(options.selector, '.recirc-most-popular-sparrow-tracking[data-most-popular-id]');
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

test('missing semantic lists require bounded browser fallback even when the module matched', async () => {
    const modes = [];
    let signal;
    let configured = 0;
    const snapshot = await fetchWiredRankings({ configureBrowser: () => { configured += 1; }, extract: async (_url, options) => {
        modes.push(options.mode);
        if (options.mode === 'http') {
            signal = options.signal;
            return result({ data: { matched: true, values: [module('')] } });
        }
        assert.equal(options.signal, signal);
        assert.equal(options.consent, 'accept');
        assert.equal(options.waitAfterLoad, 3_000);
        return result();
    } });
    assert.equal(configured, 1);
    assert.deepEqual(modes, ['http', 'browser']);
    assert.equal(snapshot.rankings.most_read.length, 4);
});

test('invalid sitemap/status/timestamp and conflicting evidence never trigger browser retries', async () => {
    for (const metadata of [{ status: 403 }, { status: 429 }, { status: undefined }, { finalUrl: 'https://evil.test/about/sitemap/' },
        { finalUrl: 'https://www.wired.com.evil.test/about/sitemap/' }, { finalUrl: 'https://www.wired.com/' },
        { finalUrl: 'https://www.wired.com/story/article/' }, { finalUrl: null },
        { capturedAt: null }, { capturedAt: '' }, { capturedAt: 'invalid' }, { data: { values: [module(), module(rows[1])] } }]) {
        let attempts = 0;
        await assert.rejects(fetchWiredRankings({ configureBrowser: () => assert.fail('Do not retry invalid evidence'), extract: async () => {
            attempts += 1;
            return result(metadata);
        } }));
        assert.equal(attempts, 1);
    }
    const noTrailingSlash = await fetchWiredRankings({ extract: async () => result({ finalUrl: 'https://wired.com/about/sitemap' }) });
    assert.equal(noTrailingSlash.rankings.most_read.length, 4);
});

test('browser configuration failure retains the original missing-selection cause', async () => {
    await assert.rejects(fetchWiredRankings({
        configureBrowser: () => { throw new Error('No usable Chrome'); },
        extract: async () => result({ data: { values: [] } }),
    }), error => {
        assert.equal(error.message, 'No usable Chrome');
        assert.equal(error.cause.code, 'WIRED_RANKINGS_MISSING');
        return true;
    });
});

test('real Fetchary HTTP extraction reads the realistic supplied module without image or ad duplication', async () => {
    const snapshot = await fetchWiredRankings({ extract: (url, options) => extractSelector(url, {
        ...options, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () => new Response(`<html><body>${module()}</body></html>`, { headers: { 'content-type': 'text/html; charset=UTF-8' } }),
    }) });
    assert.equal(snapshot.rankings.most_read.length, 4);
    assert.deepEqual(snapshot.rankings.most_read.map(item => item.rank), [1, 2, 3, 4]);
});
