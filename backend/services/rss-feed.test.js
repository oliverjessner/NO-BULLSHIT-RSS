import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { fetchRssFeed, RssFeedError } from './rss-feed.js';

const rss = `<?xml version="1.0" encoding="ISO-8859-1"?><rss version="2.0"><channel>
    <title>Märkte</title><link>https://example.test</link><description>Grüße</description>
    <item><guid>one</guid><title>Neue Größe</title><link>https://example.test/one</link></item>
    </channel></rss>`;

async function fixture(t, handler) {
    const server = createServer(handler);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
    }));
    return `http://127.0.0.1:${server.address().port}`;
}

test('follows redirects, decompresses RSS and respects its declared character encoding', async t => {
    const base = await fixture(t, (req, res) => {
        assert.equal(req.headers['user-agent'], 'no-bullshit-rss');
        assert.match(req.headers.accept, /application\/atom\+xml/);
        if (req.url === '/feed') {
            res.writeHead(302, { location: '/rss' }).end();
        } else {
            res.writeHead(200, { 'content-type': 'application/rss+xml', 'content-encoding': 'gzip' });
            res.end(gzipSync(Buffer.from(rss, 'latin1')));
        }
    });
    const feed = await fetchRssFeed(`${base}/feed`);
    assert.equal(feed.title, 'Märkte');
    assert.equal(feed.items[0].title, 'Neue Größe');
    assert.equal(feed.items[0].link, 'https://example.test/one');
});

test('parses Atom even when the server uses a generic content type', async t => {
    const base = await fixture(t, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom feed</title>
            <entry><id>one</id><title>Atom item</title><link href="https://example.test/one"/></entry></feed>`);
    });
    const feed = await fetchRssFeed(base);
    assert.equal(feed.title, 'Atom feed');
    assert.equal(feed.items[0].title, 'Atom item');
});

test('reports access restrictions and permanent HTTP errors without repeating denied requests', async t => {
    const hits = new Map();
    const base = await fixture(t, (req, res) => {
        hits.set(req.url, (hits.get(req.url) || 0) + 1);
        res.writeHead(Number(req.url.slice(1)), { 'content-type': 'text/html' });
        res.end('<html><title>Access denied</title></html>');
    });
    for (const [status, detail] of [[403, 'access denied'], [429, 'automated-access protection'], [404, 'HTTP 404']]) {
        await assert.rejects(fetchRssFeed(`${base}/${status}`), error => {
            assert.ok(error instanceof RssFeedError);
            assert.equal(error.status, status);
            assert.match(error.message, new RegExp(detail));
            return true;
        });
        assert.equal(hits.get(`/${status}`), 1);
    }
});

test('rejects successful HTML/error pages and malformed XML without retries', async t => {
    const hits = new Map();
    const base = await fixture(t, (req, res) => {
        hits.set(req.url, (hits.get(req.url) || 0) + 1);
        res.end(req.url === '/html' ? '<!doctype html><html><title>Security checkpoint</title></html>' : '<rss>broken');
    });
    await assert.rejects(fetchRssFeed(`${base}/html`), /HTML page instead of RSS or Atom/);
    await assert.rejects(fetchRssFeed(`${base}/xml`), /not valid RSS or Atom/);
    assert.deepEqual([...hits.values()], [1, 1]);
});

test('retries transient server errors and request failures', async t => {
    let requests = 0;
    let attempts = 0;
    const base = await fixture(t, (_req, res) => {
        requests += 1;
        if (requests === 1) res.writeHead(503).end();
        else res.end(Buffer.from(rss, 'latin1'));
    });
    const feed = await fetchRssFeed(base, { fetchImpl: (...args) => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('temporary connection failure');
        return fetch(...args);
    } });
    assert.equal(feed.title, 'Märkte');
    assert.equal(attempts, 3);
    assert.equal(requests, 2);
});

test('times out stalled bodies after receiving response headers', async t => {
    const base = await fixture(t, (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/rss+xml' });
        res.write('<?xml version="1.0"?>');
    });
    await assert.rejects(fetchRssFeed(base, { timeoutMs: 50, retries: 0 }), /timed out after 50 ms/);
});
