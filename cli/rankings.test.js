import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sqlite3 from '@vscode/sqlite3';
import { parseCliArgs } from './lib/arguments.js';
import { runCli } from './main.js';

test('publisher CLI validates media and flags before opening a database', () => {
    assert.deepEqual(parseCliArgs(['--most-read', 'golem', '--json']), {
        command: 'publisher-rankings', medium: 'golem', rankingKey: 'most_read', json: true,
    });
    assert.equal(parseCliArgs(['--most-commented', 'Golem']).rankingKey, 'most_commented');
    assert.deepEqual(parseCliArgs(['--most-read', 'WinFuture']), {
        command: 'publisher-rankings', medium: 'winfuture', rankingKey: 'most_read', json: false,
    });
    for (const args of [['--most-read'], ['--most-read', 'unknown'], ['--most-read', 'golem', '--most-commented', 'golem'], ['--most-read', 'golem', '--url']]) {
        assert.throws(() => parseCliArgs(args));
    }
});

test('publisher CLI reads latest ranked RSS data without writes or refreshes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-rankings-cli-'));
    const databasePath = path.join(directory, 'rankings.db');
    let connection;
    try {
        connection = await new Promise((resolve, reject) => {
            const db = new sqlite3.Database(databasePath, error => error ? reject(error) : resolve(db));
        });
        const exec = sql => new Promise((resolve, reject) => connection.exec(sql, error => error ? reject(error) : resolve()));
        for (const filename of ['0001_schema.sql', '0002_feed_names.sql', '0003_bullshit_rules.sql', '0005_unified_digest_filters.sql', '0008_most_read.sql']) {
            await exec(await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8'));
        }
        await exec(`INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt)
            VALUES (1,'Golem','https://www.golem.de/','https://www.golem.de/','2026-11-01','2026-11-01');
            INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt)
            VALUES (1,1,'Golem RSS','https://rss.golem.de/rss.php','2026-11-01','2026-11-01');
            INSERT INTO articles (id,feedId,externalId,title,teaser,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt)
            VALUES (1,1,'one','RSS title','RSS teaser','https://www.golem.de/news/one.html','https://www.golem.de/news/one.html','one','2026-11-01','2026-11-01','2026-11-01','2026-11-01');
            INSERT INTO most_read (sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES
            (1,NULL,'https://www.golem.de/news/old.html','Old',1,'most_read','2026-10-31T00:00:00.000Z'),
            (1,1,'https://www.golem.de/news/one.html','Ranking title',1,'most_read','2026-11-01T00:00:00.000Z'),
            (1,NULL,'https://www.golem.de/news/two.html','Unmatched',2,'most_read','2026-11-01T00:00:00.000Z'),
            (1,NULL,'https://www.golem.de/news/three.html','Comments',1,'most_commented','2026-11-01T00:00:00.000Z');
            INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt)
            VALUES (2,'WinFuture','https://winfuture.de/','https://winfuture.de/','2026-11-01','2026-11-01');
            INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt)
            VALUES (2,2,'WinFuture RSS','https://static.winfuture.de/feed','2026-11-01','2026-11-01');
            INSERT INTO articles (id,feedId,externalId,title,teaser,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt)
            VALUES (2,2,'wf-one','WinFuture RSS title','WinFuture teaser','https://winfuture.de/news,162334.html','https://winfuture.de/news,162334.html','two','2026-11-01','2026-11-01','2026-11-01','2026-11-01');
            INSERT INTO most_read (sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES
            (2,2,'https://winfuture.de/news,162334.html','WinFuture ranking title',1,'most_read','2026-11-01T00:00:00.000Z'),
            (2,NULL,'https://winfuture.de/news,162318.html','WinFuture comments',1,'most_commented','2026-11-01T00:00:00.000Z');`);
        await new Promise((resolve, reject) => connection.close(error => error ? reject(error) : resolve()));
        connection = null;
        const before = await readFile(databasePath);
        const filesBefore = await readdir(directory);
        const run = async args => {
            let stdout = '', stderr = '';
            const code = await runCli(args, {
                stdout: { write: chunk => { stdout += chunk; } }, stderr: { write: chunk => { stderr += chunk; } },
                discoverDatabase: async () => databasePath,
                fetchApi: () => { throw new Error('CLI must not fetch'); },
            });
            assert.equal(code, 0, stderr);
            assert.equal(stderr, '');
            return stdout;
        };
        const result = JSON.parse(await run(['--most-read', 'golem', '--json']));
        assert.equal(result.rankings.length, 1);
        assert.deepEqual(result.rankings[0].items.map(item => item.rank), [1, 2]);
        assert.equal(result.rankings[0].items[0].article.teaser, 'RSS teaser');
        assert.equal(result.rankings[0].items[1].article, null);
        const text = await run(['--most-read', 'golem']);
        assert.match(text, /1\tRSS title\thttps:\/\/www.golem.de\/news\/one.html/);
        assert.doesNotMatch(text, /Old|Comments/);
        assert.match(await run(['--most-commented', 'golem']), /Comments/);
        const winfuture = JSON.parse(await run(['--most-read', 'winfuture', '--json']));
        assert.equal(winfuture.medium, 'winfuture');
        assert.equal(winfuture.rankings.length, 1);
        assert.equal(winfuture.rankings[0].sourceName, 'WinFuture');
        assert.equal(winfuture.rankings[0].items[0].article.teaser, 'WinFuture teaser');
        assert.match(await run(['--most-commented', 'winfuture']), /WinFuture comments/);
        assert.deepEqual(await readFile(databasePath), before);
        assert.deepEqual(await readdir(directory), filesBefore);
    } finally {
        if (connection) await new Promise(resolve => connection.close(resolve));
        await rm(directory, { recursive: true, force: true });
    }
});
