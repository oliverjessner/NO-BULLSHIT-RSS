import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSelector } from 'fetchary';
import { ARSTECHNICA_RANKINGS_URL, fetchArsTechnicaRankings, parseArsTechnicaRankings } from './arstechnica-rankings.js';

// Trimmed from the user's five supplied rows, without SVG or image payloads.
const supplied = [
    ['gadgets/2026/10/united-airlines-ceo-doubts-supersonic-airliner-from-boom-will-be-ready-by-2029', 'Supersonic airliner in doubt as company shifts to powering AI data centers'],
    ['space/2026/10/think-you-can-save-the-hubble-space-telescope-nasa-wants-to-know', 'Once again, NASA is asking for ideas to rescue Hubble from certain death'],
    ['ai/2026/10/doordash-says-outside-ai-agents-have-only-led-to-hundreds-of-orders-so-far', 'Basically no one is using AI agents for their DoorDash orders'],
    ['health/2026/10/flesh-eating-screwworms-are-feasting-on-pets-4-dogs-and-cat-attacked-this-week', 'Flesh-eating screwworms spread to third state and are attacking pets'],
    ['space/2026/10/analysts-find-looming-launch-crisis-is-more-severe-than-anticipated', 'Analysts find looming launch crisis is "more severe" than anticipated'],
];
const row = ([path, title], index = 0) => `<li>${index === 0 ? `<a href="https://arstechnica.com/${path}/"><img src="https://cdn.arstechnica.net/wp-content/uploads/2026/10/image.jpg" alt="Listing image for first story"></a>` : ''}
    <div><span><span>${index + 1}.</span><a class="most-read-title" href="https://arstechnica.com/${path}/">${title}</a></span></div></li>`;
const rows = supplied.map(row);
const module = (items = rows.join(''), heading = 'Most Read') => `<div class="component-most-read"><div><header><svg><path></path></svg><div>${heading}</div></header>
    <ol>${items}</ol></div><div class="most-read-customize"><button aria-label="Customize view settings"><svg></svg><span>Customize</span></button></div></div>`;
const capturedAt = '2026-11-01T17:00:00.000Z';
const result = extra => ({ status: 200, finalUrl: ARSTECHNICA_RANKINGS_URL, capturedAt, data: { matched: true, values: [module()] }, ...extra });
const missing = error => error.code === 'ARSTECHNICA_RANKINGS_MISSING';

test('reads the supplied five explicit ranks and article titles without duplicating the first image link', () => {
    const parsed = parseArsTechnicaRankings([module()]);
    assert.deepEqual(Object.keys(parsed), ['most_read']);
    assert.deepEqual(parsed.most_read.map(item => item.rank), [1, 2, 3, 4, 5]);
    assert.deepEqual(parsed.most_read.map(item => item.title), supplied.map(([, title]) => title));
    assert.doesNotMatch(JSON.stringify(parsed), /Customize|Listing image|cdn\.arstechnica/);
    assert.equal(Object.hasOwn(parsed, 'most_commented'), false);
});

test('preserves explicit rank gaps and sorts by rank rather than deriving positions', () => {
    const changed = rows[0].replace('>1.</span>', '>8.</span>');
    const parsed = parseArsTechnicaRankings([module(changed + rows[1])]);
    assert.deepEqual(parsed.most_read.map(item => item.rank), [2, 8]);
    const invalidFirst = rows[0].replace('class="most-read-title" href="https://arstechnica.com/', 'class="most-read-title" href="https://evil.test/');
    assert.deepEqual(parseArsTechnicaRankings([module(invalidFirst + rows[1])]).most_read.map(item => item.rank), [2]);
});

test('cleans title entities, soft hyphens and URL tracking while retaining functional parameters', () => {
    const changed = rows[1].replace('/"', '/?utm_source=sidebar&amp;id=7#comments"').replace('Once again, NASA', 'Once a\u00adgain, NASA &amp; ESA');
    const item = parseArsTechnicaRankings([module(changed)]).most_read[0];
    assert.equal(item.canonicalUrl.endsWith('/?id=7'), true);
    assert.ok(item.title.startsWith('Once again, NASA & ESA'));
});

test('accepts arbitrary article categories with valid months, but rejects CDN, author and off-site paths', () => {
    const invalid = [
        rows[1].replace('https://arstechnica.com/', 'https://evil.test/'),
        rows[1].replace('https://arstechnica.com/', 'https://arstechnica.com.evil.test/'),
        rows[1].replace('https://arstechnica.com/', 'https://cdn.arstechnica.net/'),
        row(['author/some-person', 'An author'], 1), row(['space/2026/00/story', 'Invalid month'], 1),
        row(['space/2026/13/story', 'Invalid month'], 1), row(['space/26/10/story', 'Invalid year'], 1),
        rows[1].replace('https://arstechnica.com/', 'javascript:article/'),
    ];
    assert.equal(parseArsTechnicaRankings([module(invalid.join('') + rows[2])]).most_read.length, 1);
    assert.equal(parseArsTechnicaRankings([module(row(['new-category/2026/02/story', 'New category'], 2))]).most_read.length, 1);
    assert.equal(parseArsTechnicaRankings([module(rows[1].replace('https://arstechnica.com/', 'https://www.arstechnica.com/'))]).most_read.length, 1);
});

test('requires a safe explicit integer rank sibling and the dedicated article anchor', () => {
    for (const first of [rows[1].replace('>2.</span>', '>0.</span>'), rows[1].replace('>2.</span>', '>2.5.</span>'),
        rows[1].replace('>2.</span>', '>9007199254740992.</span>'), rows[1].replace('>2.</span>', '>Two.</span>'),
        rows[1].replace('class="most-read-title"', 'class="author-link"')]) {
        assert.deepEqual(parseArsTechnicaRankings([module(first + rows[2])]).most_read.map(item => item.rank), [3]);
    }
    assert.deepEqual(parseArsTechnicaRankings([module(rows[1].replace('<li>', '<li data-ad>') + rows[2])]).most_read.map(item => item.rank), [3]);
});

test('deduplicates identical responsive rows or modules and rejects conflicting ranks or URLs', () => {
    assert.equal(parseArsTechnicaRankings([module(rows[0] + rows[0] + rows[1]), module(rows[0] + rows[1])]).most_read.length, 2);
    const sameRankOtherUrl = rows[1].replace('>2.</span>', '>1.</span>');
    const sameUrlOtherRank = rows[0].replace('>1.</span>', '>2.</span>');
    for (const input of [[module(rows[0] + sameRankOtherUrl)], [module(rows[0] + sameUrlOtherRank)], [module(), module(rows[1])]]) {
        assert.throws(() => parseArsTechnicaRankings(input), error => error.code === 'ARSTECHNICA_RANKINGS_CONFLICT');
    }
});

test('requires the exact component header and a populated, unambiguous ordered list', () => {
    for (const fragments of [[], [module('', 'Most Read')], [module(rows[0], 'Most Read Today')],
        [module().replace('class="component-most-read"', 'class="other"')], [module().replace('<ol>', '<ul>').replace('</ol>', '</ul>')],
        [module().replace('</ol>', '</ol><ol></ol>')]]) {
        assert.throws(() => parseArsTechnicaRankings(fragments), missing);
    }
});

test('prefers bounded homepage HTTP capture with consent acceptance and real provenance', async () => {
    const snapshot = await fetchArsTechnicaRankings({ configureBrowser: () => assert.fail('Unnecessary browser'), extract: async (url, options) => {
        assert.equal(url, ARSTECHNICA_RANKINGS_URL);
        assert.equal(options.mode, 'http');
        assert.equal(options.selector, '.component-most-read');
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

test('missing semantic lists retry with a bounded browser even when the component matched', async () => {
    const modes = [];
    let signal;
    let configured = 0;
    const snapshot = await fetchArsTechnicaRankings({ configureBrowser: () => { configured += 1; }, extract: async (_url, options) => {
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
    assert.equal(snapshot.rankings.most_read.length, 5);
});

test('invalid homepage/status/timestamp and conflicting evidence never trigger browser retries', async () => {
    for (const metadata of [{ status: 403 }, { status: 429 }, { status: undefined }, { finalUrl: 'https://evil.test/' },
        { finalUrl: 'https://arstechnica.com.evil.test/' }, { finalUrl: 'https://feeds.arstechnica.com/arstechnica/index' },
        { finalUrl: 'https://arstechnica.com/space/2026/10/story/' }, { finalUrl: null },
        { capturedAt: null }, { capturedAt: '' }, { capturedAt: 'invalid' }, { data: { values: [module(), module(rows[1])] } }]) {
        let attempts = 0;
        await assert.rejects(fetchArsTechnicaRankings({ configureBrowser: () => assert.fail('Do not retry invalid evidence'), extract: async () => {
            attempts += 1;
            return result(metadata);
        } }));
        assert.equal(attempts, 1);
    }
});

test('browser configuration failure retains the missing-list cause', async () => {
    await assert.rejects(fetchArsTechnicaRankings({
        configureBrowser: () => { throw new Error('No usable Chrome'); },
        extract: async () => result({ data: { values: [] } }),
    }), error => {
        assert.equal(error.message, 'No usable Chrome');
        assert.equal(error.cause.code, 'ARSTECHNICA_RANKINGS_MISSING');
        return true;
    });
});

test('real Fetchary HTTP extraction reads the supplied structure and excludes Customize and image anchors', async () => {
    const snapshot = await fetchArsTechnicaRankings({ extract: (url, options) => extractSelector(url, {
        ...options, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () => new Response(`<html><body>${module()}</body></html>`, { headers: { 'content-type': 'text/html; charset=UTF-8' } }),
    }) });
    assert.equal(snapshot.rankings.most_read.length, 5);
    assert.doesNotMatch(JSON.stringify(snapshot), /Customize|cdn\.arstechnica/);
});
