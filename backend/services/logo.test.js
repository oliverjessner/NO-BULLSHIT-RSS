import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import sharp from 'sharp';

const directory = await mkdtemp(path.join(os.tmpdir(), 'no-bullshit-rss-logos-'));
process.env.DB_PATH = path.join(directory, 'logos.db');
const database = await import('../database/datenbank.js');
const { fetchSiteLogo, refreshAllFeedLogos } = await import('./logo.js');
const { createFeedsRouter, createFeedRecord } = await import('../routes/feeds.js');
const { updateAllFeeds } = await import('./fetcher.js');
const { subscribe } = await import('./events.js');
await database.initSchema();

const fetchLocalLogo = url => fetchSiteLogo(url, { allowPrivateNetwork: true });
const refreshLocalLogos = options => refreshAllFeedLogos({ ...options, fetchLogo: fetchLocalLogo });

const small = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff0000' } }).png().toBuffer();
const large = await sharp({ create: { width: 192, height: 192, channels: 4, background: '#00ff00' } }).png().toBuffer();
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const rss = '<?xml version="1.0"?><rss version="2.0"><channel><title>Test feed</title><link>https://example.com/</link><description>Test</description></channel></rss>';
const routes = new Map();
const hits = new Map();
const app = express();
app.use(express.json());
app.use('/api/feeds', createFeedsRouter({ fetchLogo: fetchLocalLogo }));
app.use((req, res) => {
    hits.set(req.path, (hits.get(req.path) || 0) + 1);
    const route = routes.get(req.path);
    if (route) route(req, res);
    else res.status(404).end();
});
const server = createServer(app);
await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;
const page = (url, html) => routes.set(url, (_req, res) => res.type('html').send(html));
const image = (url, buffer, type = 'image/png') => routes.set(url, (_req, res) => res.type(type).send(buffer));

test.beforeEach(async () => {
    routes.clear();
    hits.clear();
    await database.run('DELETE FROM sources');
});

test('blocks private network targets by default and allows an explicit trusted test call', async () => {
    page('/private', '<link rel="icon" href="/small.png">');
    image('/small.png', small);

    assert.equal(await fetchSiteLogo(`${base}/private`), null);
    assert.equal(hits.size, 0);
    assert.deepEqual(await fetchLocalLogo(`${base}/private`), { buffer: small, mime: 'image/png' });
});

test('uses final page, base and manifest URLs and chooses measured resolution over advertised sizes', async () => {
    routes.set('/start', (_req, res) => res.redirect('/news/'));
    page('/news/', `<html><head><base href="/assets/">
        <link href="small.png" sizes="1024x1024" rel="icon">
        <link rel="apple-touch-icon" href="touch.png">
        <link rel="manifest" href="manifest"></head></html>`);
    image('/assets/small.png', small);
    image('/assets/touch.png', small);
    routes.set('/assets/manifest', (_req, res) => res.redirect('/app/site.webmanifest'));
    routes.set('/app/site.webmanifest', (_req, res) => res.json({ icons: [{ src: 'large.png', sizes: '1x1' }] }));
    routes.set('/app/large.png', (_req, res) => res.redirect('/cdn/icon'));
    image('/cdn/icon', large, 'application/octet-stream');

    const logo = await fetchLocalLogo(`${base}/start`);
    assert.deepEqual(logo, { buffer: large, mime: 'image/png' });
    assert.equal(hits.get('/cdn/icon'), 1, 'the selected image is stored without a second download');
});

test('follows all redirect statuses without reading redirect bodies or reducing the page limit', async () => {
    const statuses = [301, 302, 303, 307, 308];
    const closed = statuses.map((status, index) => new Promise(resolve => {
        routes.set(`/redirect-${index}`, (_req, res) => {
            res.once('close', resolve);
            res.status(status).set('Location', index + 1 < statuses.length ? `/redirect-${index + 1}` : '/redirected-page');
            res.set('Content-Length', String(3 * 1024 * 1024));
            // A redirect's irrelevant, unfinished body must not delay discovery.
            res.write('unused redirect body');
        });
    }));
    page('/redirected-page', `<link rel="icon" href="/small.png">${' '.repeat(256 * 1024)}`);
    image('/small.png', small);

    assert.deepEqual(await fetchLocalLogo(`${base}/redirect-0`), { buffer: small, mime: 'image/png' });
    await Promise.all(closed);
    for (let index = 0; index < statuses.length; index += 1) assert.equal(hits.get(`/redirect-${index}`), 1);
    assert.equal(hits.get('/redirected-page'), 1);
    assert.equal(hits.get('/small.png'), 1);
});

test('retains header and streamed page and icon limits after redirects', async () => {
    const hugePage = `<link rel="icon" href="/small.png">${' '.repeat(2 * 1024 * 1024)}`;
    routes.set('/large-page-start', (_req, res) => res.redirect('/large-page'));
    page('/large-page', hugePage);
    routes.set('/streamed-page-start', (_req, res) => res.redirect('/streamed-page'));
    routes.set('/streamed-page', (_req, res) => {
        res.type('html');
        res.write(hugePage);
        res.end();
    });
    image('/small.png', small);
    assert.equal(await fetchLocalLogo(`${base}/large-page-start`), null);
    assert.equal(await fetchLocalLogo(`${base}/streamed-page-start`), null);
    assert.equal(hits.has('/small.png'), false);

    const oversized = Buffer.concat([large, Buffer.alloc(200 * 1024)]);
    page('/icon-limits', '<link rel="icon" href="/sized-start"><link rel="icon" href="/streamed-start"><link rel="icon" href="/small.png">');
    routes.set('/sized-start', (_req, res) => res.redirect('/oversized.png'));
    image('/oversized.png', oversized);
    routes.set('/streamed-start', (_req, res) => res.redirect('/oversized-stream.png'));
    routes.set('/oversized-stream.png', (_req, res) => {
        res.type('image/png');
        res.write(oversized);
        res.end();
    });
    assert.deepEqual(await fetchLocalLogo(`${base}/icon-limits`), { buffer: small, mime: 'image/png' });
    assert.equal(hits.get('/oversized.png'), 1);
    assert.equal(hits.get('/oversized-stream.png'), 1);
});

test('rejects redirects without a destination and bounds redirect loops', async () => {
    routes.set('/no-location', (_req, res) => res.status(302).end());
    routes.set('/loop', (_req, res) => res.redirect('/loop'));

    assert.equal(await fetchLocalLogo(`${base}/no-location`), null);
    assert.equal(await fetchLocalLogo(`${base}/loop`), null);
    assert.equal(hits.get('/loop'), 11);
});

test('prefers scalable SVG and handles a missing page icon with the favicon.ico fallback', async () => {
    page('/svg', '<link rel="icon" href="/large.png"><link rel="icon" href="/icon.svg">');
    image('/large.png', large);
    image('/icon.svg', svg, 'image/svg+xml');
    assert.deepEqual(await fetchLocalLogo(`${base}/svg`), { buffer: Buffer.from(svg), mime: 'image/svg+xml' });

    page('/fallback', '<link rel="icon" href="/broken.png">');
    image('/broken.png', '<html>Not an image</html>', 'image/png');
    image('/favicon.ico', small, 'application/octet-stream');
    assert.deepEqual(await fetchLocalLogo(`${base}/fallback`), { buffer: small, mime: 'image/png' });
});

test('skips oversized icons from headers and streamed bytes while retaining a smaller candidate', async () => {
    const oversized = Buffer.concat([large, Buffer.alloc(200 * 1024)]);
    page('/limits', '<link rel="icon" href="/sized.png"><link rel="icon" href="/stream.png"><link rel="icon" href="/small.png">');
    image('/sized.png', oversized);
    routes.set('/stream.png', (_req, res) => {
        res.type('image/png');
        res.write(oversized);
        res.end();
    });
    image('/small.png', small);
    assert.deepEqual(await fetchLocalLogo(`${base}/limits`), { buffer: small, mime: 'image/png' });
    assert.equal(hits.get('/sized.png'), 1);
    assert.equal(hits.get('/stream.png'), 1);

    page('/huge', 'x'.repeat(2 * 1024 * 1024 + 1));
    assert.equal(await fetchLocalLogo(`${base}/huge`), null);
});

test('returns null for invalid URLs, failed pages and sites without a usable image', async () => {
    for (const value of [null, '', 'invalid', 'file:///etc/hosts', 'https://user:pass@example.com/']) {
        assert.equal(await fetchLocalLogo(value), null);
    }
    assert.equal(hits.size, 0);
    assert.equal(await fetchLocalLogo(`${base}/unavailable`), null);
    page('/empty', '<html></html>');
    assert.equal(await fetchLocalLogo(`${base}/empty`), null);
});

test('aborts a stalled response body after headers arrive', { timeout: 12_000 }, async () => {
    let closed;
    const connectionClosed = new Promise(resolve => { closed = resolve; });
    routes.set('/stalled', (_req, res) => {
        res.type('html');
        res.write('<html>');
        res.once('close', closed);
    });
    assert.equal(await fetchLocalLogo(`${base}/stalled`), null);
    await connectionClosed;
});

test('creates and updates feeds with locally served icon bytes', async () => {
    page('/website', '<link rel="icon" href="/small.png">');
    page('/new-website', '<link rel="icon" href="/large.png">');
    image('/small.png', small);
    image('/large.png', large);
    routes.set('/rss', (_req, res) => res.type('application/rss+xml').send(rss));
    const body = { name: 'Test', websiteUrl: `${base}/website`, feedUrl: `${base}/rss` };
    const created = await fetch(`${base}/api/feeds`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(created.status, 201);
    const feed = await created.json();
    const stored = await fetch(`${base}${feed.logoDataUrl}`);
    assert.equal(stored.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await stored.arrayBuffer()), small);

    const updated = await fetch(`${base}/api/feeds/${feed.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, websiteUrl: `${base}/new-website` }),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(Buffer.from(await (await fetch(`${base}${(await updated.json()).logoDataUrl}`)).arrayBuffer()), large);
});

test('feed fetching fills missing source icons once, preserves existing logos and notifies the UI', async () => {
    page('/shared', '<link rel="icon" href="/large.png">');
    image('/large.png', large);
    for (const route of ['/one.rss', '/two.rss', '/existing.rss']) {
        routes.set(route, (_req, res) => res.type('application/rss+xml').send(rss));
    }
    const firstId = await createFeedRecord({ name: 'One', websiteUrl: `${base}/shared`, feedUrl: `${base}/one.rss` });
    const secondId = await createFeedRecord({ name: 'Two', websiteUrl: `${base}/shared`, feedUrl: `${base}/two.rss` });
    await createFeedRecord({ name: 'Existing', websiteUrl: `${base}/existing`, feedUrl: `${base}/existing.rss`, logoBuffer: small, logoMime: 'image/png' });
    const events = [];
    const unsubscribe = subscribe(event => events.push(event));
    try {
        await updateAllFeeds({ refreshLogos: refreshLocalLogos });
        assert.equal(hits.get('/shared'), 1);
        assert.equal(hits.has('/existing'), false);
        assert.deepEqual(await database.all('SELECT logo, logoMime FROM sources ORDER BY id'), [
            { logo: large, logoMime: 'image/png' }, { logo: small, logoMime: 'image/png' },
        ]);
        assert.ok(events.some(event => event.event === 'feeds.updated' && event.data.logosUpdated === 1));
        for (const id of [firstId, secondId]) {
            assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/feeds/${id}/logo`)).arrayBuffer()), large);
        }
        assert.deepEqual(await refreshLocalLogos({ missingOnly: true }), { updated: 0, total: 0 });
    } finally { unsubscribe(); }

    routes.clear();
    assert.deepEqual(await refreshLocalLogos(), { updated: 0, total: 2 });
    assert.deepEqual((await database.all('SELECT logo FROM sources ORDER BY id')).map(row => row.logo), [large, small]);
});

test.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await database.closeDatabase();
    await rm(directory, { recursive: true, force: true });
});
