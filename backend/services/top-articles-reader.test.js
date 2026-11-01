import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-top-reader-'));
process.env.DB_PATH = path.join(directory, 'fixture.db');
const db = await import('../database/datenbank.js');
const { readTopArticles } = await import('./top-articles-reader.js');
const { openReadOnlyDatabase } = await import('../../cli/lib/read-only-database.js');
await db.initSchema();
const capturedAt = '2026-11-02T00:00:00.000Z';
const url = index => `https://www.golem.de/news/top-${index}.html`;

test.beforeEach(async () => {
    await db.exec(`DELETE FROM sources; DELETE FROM app_metadata; DELETE FROM bullshit_rules;
        INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt) VALUES
        (1,'Golem','https://www.golem.de/','https://www.golem.de/','2026-11-01','2026-11-01'),
        (2,'t3n','https://t3n.de/','https://t3n.de/','2026-11-01','2026-11-01'),
        (3,'heise iX','https://www.heise.de/ix','https://www.heise.de/ix','2026-11-01','2026-11-01'),
        (4,'Other','https://other.test/','https://other.test/','2026-11-01','2026-11-01');
        INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt) VALUES
        (11,1,'Golem RSS','https://rss.golem.de/rss.php','2026-11-01','2026-11-01'),
        (12,1,'Golem imports','nbs-import:https://www.golem.de','2026-11-01','2026-11-01'),
        (21,2,'t3n RSS','https://t3n.de/rss.xml','2026-11-01','2026-11-01'),
        (31,3,'iX RSS','https://www.heise.de/ix/feed.xml','2026-11-01','2026-11-01'),
        (41,4,'Other RSS','https://other.test/rss','2026-11-01','2026-11-01');`);
});

async function article(index, { feedId = 11, articleUrl = url(index), publishedAt = new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString() } = {}) {
    const result = await db.run(`INSERT INTO articles
        (feedId,externalId,title,teaser,content,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt)
        VALUES (?, ?, ?, 'RSS teaser', 'RSS body', ?, ?, ?, ?, ?, ?, ?)`,
    [feedId, `entry-${index}-${feedId}`, `RSS title ${index}`, articleUrl, articleUrl, String(index), publishedAt, capturedAt, capturedAt, capturedAt]);
    return Number(result.lastID);
}
async function ranking(index, { sourceId = 1, rankingKey = 'most_read', articleUrl = url(index), capture = capturedAt, rank = index + 1 } = {}) {
    return db.run(`INSERT INTO most_read (sourceId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES (?,?,?,?,?,?)`,
        [sourceId, articleUrl, `Chart title ${index}`, rank, rankingKey, capture]);
}

test('history pages contain distinct URLs, keep every selection provenance and pin new captures behind their watermark', async () => {
    for (let index = 0; index < 120; index += 1) {
        await article(index);
        await ranking(index, { capture: new Date(Date.parse(capturedAt) + Math.floor(index / 40) * 60_000).toISOString(), rank: index % 40 + 1 });
    }
    await ranking(119, { rankingKey: 'most_commented', rank: 1 });
    const first = await readTopArticles(db);
    assert.equal(first.items.length, 40);
    assert.equal(first.items[0].title, 'RSS title 119');
    assert.deepEqual(new Set(first.items[0].rankings.map(item => item.rankingKey)), new Set(['most_read', 'most_commented']));
    assert.equal(first.hasMore, true);
    // Both a genuinely new URL and a recapture of an old URL arrive mid-scroll.
    await article(500, { publishedAt: '2026-10-01T00:00:00Z' });
    await ranking(500, { capture: '2026-11-03T00:00:00Z', rank: 1 });
    await ranking(0, { capture: '2026-11-03T00:00:00Z', rank: 2 });
    const second = await readTopArticles(db, { cursor: first.nextCursor });
    const third = await readTopArticles(db, { cursor: second.nextCursor });
    const all = [...first.items, ...second.items, ...third.items];
    assert.equal(all.length, 120);
    assert.equal(new Set(all.map(item => item.canonicalUrl)).size, 120);
    assert.equal(all.some(item => item.canonicalUrl === url(500)), false);
    assert.equal(third.hasMore, false);
    assert.equal(third.nextCursor, null);
    const fresh = await readTopArticles(db, { limit: 1000, maxLimit: null });
    assert.equal(fresh.items.length, 121);
    assert.equal(fresh.items.find(item => item.canonicalUrl === url(0)).capturedAt, '2026-11-03T00:00:00Z');
});

test('all media includes editorial selections, uses capture fallback and scopes requested medium and article source', async () => {
    await article(1, { feedId: 41 }); // Wrong source must not supply Golem metadata.
    await ranking(1, { rank: 1 });
    const ixUrl = 'https://www.heise.de/news/example-11505931.html';
    await article(2, { feedId: 31, articleUrl: ixUrl, publishedAt: '2026-11-01 12:00:00' });
    await ranking(2, { sourceId: 3, articleUrl: ixUrl, rankingKey: 'top_news', rank: 1 });
    await ranking(3, { sourceId: 4, articleUrl: 'https://other.test/news/entry', rank: 1 });
    await ranking(4, { articleUrl: 'https://evil.test/news/wrong-origin', rank: 2 });
    const all = await readTopArticles(db);
    assert.equal(all.items.length, 2);
    assert.equal(all.items[0].id, null);
    assert.equal(all.items[0].publishedAt, null);
    assert.equal(all.items[0].title, 'Chart title 1');
    assert.equal(all.items[1].rankings[0].label, 'Top-News');
    const ix = await readTopArticles(db, { medium: 'heise-ix' });
    assert.equal(ix.items.length, 1);
    assert.equal(ix.items[0].sourceName, 'iX RSS');
    assert.equal((await readTopArticles(db, { medium: 't3n' })).items.length, 0);
});

test('RSS preferences, legacy URLs and current dismissal/bullshit state remain consistent without manual fallback bypasses', async () => {
    const rssId = await article(1, { articleUrl: `${url(1)}?utm_source=legacy` });
    await article(1, { feedId: 12, publishedAt: '2026-11-03T00:00:00Z' });
    const filteredId = await article(2);
    await ranking(1, { rank: 1 }); await ranking(2, { rank: 2 });
    await db.exec(`INSERT INTO bullshit_rules (id,name,enabled,field,operator,value,createdAt,updatedAt)
        VALUES (1,'Filter',1,'title','contains','title','2026-11-01','2026-11-01');`);
    await db.run("INSERT INTO article_bullshit_matches (articleId,ruleId,matchedAt) VALUES (?,1,datetime('now'))", [filteredId]);
    let result = await readTopArticles(db, { includeContent: false });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, rssId);
    assert.equal(result.items[0].teaser, 'RSS teaser');
    assert.equal(result.items[0].content, null);
    await db.run("INSERT INTO article_state (articleId,dismissedAt,createdAt,updatedAt) VALUES (?,datetime('now'),datetime('now'),datetime('now'))", [rssId]);
    result = await readTopArticles(db);
    assert.equal(result.items.length, 0);
});

test('only the requested page hydrates full RSS bodies and all read queries remain read-only', async () => {
    for (let index = 0; index < 50; index += 1) { await article(index); await ranking(index); }
    const readonly = await openReadOnlyDatabase(process.env.DB_PATH);
    const queries = [];
    try {
        const result = await readTopArticles({ all: (sql, params) => { queries.push({ sql, params }); return readonly.all(sql, params); } }, { limit: 10 });
        assert.equal(result.items.length, 10);
        assert.equal(result.items[0].content, 'RSS body');
        const bodies = queries.filter(query => query.sql.includes('articles.content'));
        assert.equal(bodies.length, 1);
        assert.equal(JSON.parse(bodies[0].params[1]).length, 10);
        assert.ok(queries.every(query => query.sql.trimStart().startsWith('SELECT')));
        assert.equal((await readonly.get('SELECT total_changes() AS count')).count, 0);
    } finally { await readonly.close(); }
});

test('invalid limits, media and foreign or malformed cursors fail before database access', async () => {
    const database = { all: () => assert.fail('Invalid input must not query the database') };
    for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { medium: 'unknown' }, { cursor: 'bad!' },
        { cursor: Buffer.from(JSON.stringify({ v: 1, medium: 'golem', watermark: 1, time: 1, id: 1 })).toString('base64url') }]) {
        await assert.rejects(readTopArticles(database, options), error => error.status === 400);
    }
});

test.after(async () => { await db.closeDatabase(); await rm(directory, { recursive: true, force: true }); });
