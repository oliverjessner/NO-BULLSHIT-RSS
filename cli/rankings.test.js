import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sqlite3 from '@vscode/sqlite3';
import { parseCliArgs } from './lib/arguments.js';
import { formatPublisherRankings } from './lib/output.js';
import { runCli } from './main.js';

test('publisher CLI validates media and flags before opening a database', () => {
    assert.deepEqual(parseCliArgs(['--most-read', 'golem', '--json']), {
        command: 'publisher-rankings', medium: 'golem', rankingKey: 'most_read', json: true,
    });
    assert.equal(parseCliArgs(['--most-commented', 'Golem']).rankingKey, 'most_commented');
    assert.deepEqual(parseCliArgs(['--most-read', 'WinFuture']), {
        command: 'publisher-rankings', medium: 'winfuture', rankingKey: 'most_read', json: false,
    });
    assert.deepEqual(parseCliArgs(['--most-read', 'ComputerBase', '--json']), {
        command: 'publisher-rankings', medium: 'computerbase', rankingKey: 'most_read', json: true,
    });
    assert.throws(() => parseCliArgs(['--most-commented', 'computerbase']), /Most-commented rankings are not supported for ComputerBase\. Use --most-read computerbase\./);
    assert.deepEqual(parseCliArgs(['--top-news', 'Heise-IX', '--json']), {
        command: 'publisher-rankings', medium: 'heise-ix', rankingKey: 'top_news', json: true,
    });
    assert.throws(() => parseCliArgs(['--most-read', 'heise-ix']), /Most-read rankings are not supported for heise iX\. Use --top-news heise-ix\./);
    assert.throws(() => parseCliArgs(['--most-commented', 'heise-ix']), /Most-commented rankings are not supported for heise iX\. Use --top-news heise-ix\./);
    assert.throws(() => parseCliArgs(['--top-news', 'computerbase']), /Top-News rankings are not supported for ComputerBase\. Use --most-read computerbase\./);
    assert.deepEqual(parseCliArgs(['--most-read', 'T3N', '--json']), {
        command: 'publisher-rankings', medium: 't3n', rankingKey: 'most_read', json: true,
    });
    assert.throws(() => parseCliArgs(['--most-commented', 't3n']), /Most-commented rankings are not supported for t3n\. Use --most-read t3n\./);
    assert.throws(() => parseCliArgs(['--top-news', 't3n']), /Top-News rankings are not supported for t3n\. Use --most-read t3n\./);
    for (const args of [['--most-read'], ['--most-read', 'unknown'], ['--top-news'], ['--top-news', 'unknown'], ['--most-read', 'golem', '--most-commented', 'golem'], ['--top-news', 'heise-ix', '--most-read', 'heise-ix'], ['--most-read', 'golem', '--url']]) {
        assert.throws(() => parseCliArgs(args));
    }
});

test('unsupported ComputerBase most-commented rankings fail before opening a database', async () => {
    let opened = false;
    let stdout = '', stderr = '';
    const code = await runCli(['--most-commented', 'computerbase'], {
        stdout: { write: chunk => { stdout += chunk; } }, stderr: { write: chunk => { stderr += chunk; } },
        discoverDatabase: async () => { opened = true; throw new Error('Must not open a database'); },
    });
    assert.equal(code, 1);
    assert.equal(opened, false);
    assert.equal(stdout, '');
    assert.match(stderr, /Most-commented rankings are not supported for ComputerBase\. Use --most-read computerbase\./);
});

test('unsupported heise iX ranking kinds suggest editorial Top-News before opening a database', async () => {
    for (const flag of ['--most-read', '--most-commented']) {
        let stdout = '', stderr = '';
        const code = await runCli([flag, 'heise-ix'], {
            stdout: { write: chunk => { stdout += chunk; } }, stderr: { write: chunk => { stderr += chunk; } },
            discoverDatabase: async () => { throw new Error('Must not open a database'); },
        });
        assert.equal(code, 1);
        assert.equal(stdout, '');
        assert.match(stderr, /not supported for heise iX\. Use --top-news heise-ix\./);
        assert.doesNotMatch(stderr, /Must not open a database/);
    }
});

test('empty editorial selections keep the Top-News label', () => {
    const text = formatPublisherRankings({ medium: 'heise-ix', configured: true, rankings: [] }, { rankingKey: 'top_news' });
    assert.equal(text, 'No saved Top-News rankings for heise-ix. Refresh rankings in the app first.');
    assert.doesNotMatch(text, /most-read|most-commented/);
});

test('unsupported t3n ranking kinds suggest most-read before opening a database', async () => {
    for (const [flag, label] of [['--most-commented', 'Most-commented'], ['--top-news', 'Top-News']]) {
        let stdout = '', stderr = '';
        let opened = false;
        const code = await runCli([flag, 't3n'], {
            stdout: { write: chunk => { stdout += chunk; } }, stderr: { write: chunk => { stderr += chunk; } },
            discoverDatabase: async () => { opened = true; throw new Error('Must not open a database'); },
        });
        assert.equal(code, 1);
        assert.equal(opened, false);
        assert.equal(stdout, '');
        assert.equal(stderr.trim(), `Error: ${label} rankings are not supported for t3n. Use --most-read t3n.`);
    }
});

test('publisher CLI help includes all supported media and Top-News without opening a database', async () => {
    let stdout = '', stderr = '';
    const code = await runCli(['--help'], {
        stdout: { write: chunk => { stdout += chunk; } }, stderr: { write: chunk => { stderr += chunk; } },
        discoverDatabase: async () => { throw new Error('Help must not open a database'); },
    });
    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Publisher media:[^\n]*computerbase/);
    assert.match(stdout, /Publisher media:[^\n]*heise-ix/);
    assert.match(stdout, /Publisher media:[^\n]*t3n/);
    assert.match(stdout, /--top-news <medium>/);
    assert.match(stdout, /--top-news heise-ix/);
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
        for (const filename of ['0001_schema.sql', '0002_feed_names.sql', '0003_bullshit_rules.sql', '0005_unified_digest_filters.sql', '0008_most_read.sql', '0009_top_news.sql']) {
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
            (2,NULL,'https://winfuture.de/news,162318.html','WinFuture comments',1,'most_commented','2026-11-01T00:00:00.000Z');
            INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt)
            VALUES (3,'ComputerBase','https://www.computerbase.de/','https://www.computerbase.de/','2026-11-01','2026-11-01');
            INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt)
            VALUES (3,3,'ComputerBase RSS','https://www.computerbase.de/rss/news.xml','2026-11-01','2026-11-01');
            INSERT INTO articles (id,feedId,externalId,title,teaser,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt)
            VALUES (3,3,'cb-one','ComputerBase RSS title','ComputerBase RSS teaser','https://www.computerbase.de/news/pc-systeme/computerbase-fixture.12345/','https://www.computerbase.de/news/pc-systeme/computerbase-fixture.12345/','three','2026-11-01','2026-11-01','2026-11-01','2026-11-01');
            INSERT INTO most_read (sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES
            (3,3,'https://www.computerbase.de/news/pc-systeme/computerbase-fixture.12345/','ComputerBase ranking title',1,'most_read','2026-11-01T00:00:00.000Z');
            INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt)
            VALUES (4,'Generic Heise','https://www.heise.de/','https://www.heise.de/','2026-11-01','2026-11-01'),
                (5,'heise iX','https://www.heise.de/ix/','https://www.heise.de/ix/','2026-11-01','2026-11-01');
            INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt)
            VALUES (4,4,'Generic Heise RSS','https://www.heise.de/rss/heise-atom.xml','2026-11-01','2026-11-01'),
                (5,5,'heise iX RSS','https://www.heise.de/ix/feed.xml','2026-11-01','2026-11-01');
            INSERT INTO articles (id,feedId,externalId,title,teaser,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt)
            VALUES (5,5,'ix-one','heise iX RSS title','heise iX RSS teaser','https://www.heise.de/ix/news/heise-ix-fixture-12345.html','https://www.heise.de/ix/news/heise-ix-fixture-12345.html','five','2026-11-01','2026-11-01','2026-11-01','2026-11-01');
            INSERT INTO most_read (sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES
            (4,NULL,'https://www.heise.de/news/generic.html','Generic Heise article',1,'most_read','2026-11-01T00:00:00.000Z'),
            (5,5,'https://www.heise.de/ix/news/heise-ix-fixture-12345.html','heise iX editorial title',1,'top_news','2026-11-01T00:00:00.000Z'),
            (5,NULL,'https://www.heise.de/ix/news/second-12346.html','heise iX editorial second story',2,'top_news','2026-11-01T00:00:00.000Z');
            INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt)
            VALUES (6,'t3n','https://t3n.de/','https://t3n.de/','2026-11-01','2026-11-01');
            INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt)
            VALUES (6,6,'t3n RSS','https://t3n.de/rss.xml','2026-11-01','2026-11-01');
            INSERT INTO articles (id,feedId,externalId,title,teaser,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt)
            VALUES (6,6,'t3n-one','t3n RSS title','t3n RSS teaser','https://t3n.de/news/t3n-fixture-1234567/','https://t3n.de/news/t3n-fixture-1234567/','six','2026-11-01','2026-11-01','2026-11-01','2026-11-01');
            INSERT INTO most_read (sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES
            (6,6,'https://t3n.de/news/t3n-fixture-1234567/','t3n publisher title',1,'most_read','2026-11-01T00:00:00.000Z');`);
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
        const computerbase = JSON.parse(await run(['--most-read', 'computerbase', '--json']));
        assert.equal(computerbase.medium, 'computerbase');
        assert.equal(computerbase.rankings.length, 1);
        assert.equal(computerbase.rankings[0].rankingKey, 'most_read');
        assert.equal(computerbase.rankings[0].sourceName, 'ComputerBase');
        assert.equal(computerbase.rankings[0].items[0].article.title, 'ComputerBase RSS title');
        assert.equal(computerbase.rankings[0].items[0].article.teaser, 'ComputerBase RSS teaser');
        assert.match(await run(['--most-read', 'computerbase']), /ComputerBase RSS title/);
        const heiseIx = JSON.parse(await run(['--top-news', 'heise-ix', '--json']));
        assert.equal(heiseIx.medium, 'heise-ix');
        assert.equal(heiseIx.rankingKey, 'top_news');
        assert.equal(heiseIx.rankings.length, 1);
        assert.equal(heiseIx.rankings[0].sourceId, 5);
        assert.equal(heiseIx.rankings[0].rankingKey, 'top_news');
        assert.equal(heiseIx.rankings[0].sourceName, 'heise iX');
        assert.equal(heiseIx.rankings[0].items[0].article.title, 'heise iX RSS title');
        assert.equal(heiseIx.rankings[0].items[0].article.teaser, 'heise iX RSS teaser');
        assert.equal(heiseIx.rankings[0].items[1].article, null);
        const heiseIxText = await run(['--top-news', 'heise-ix']);
        assert.match(heiseIxText, /heise iX · Top-News · 2026-11-01T00:00:00\.000Z/);
        assert.match(heiseIxText, /1\theise iX RSS title\thttps:\/\/www.heise.de\/ix\/news\/heise-ix-fixture-12345.html/);
        assert.doesNotMatch(heiseIxText, /Most read|Most commented|Generic Heise/);
        const t3n = JSON.parse(await run(['--most-read', 't3n', '--json']));
        assert.equal(t3n.medium, 't3n');
        assert.equal(t3n.rankingKey, 'most_read');
        assert.equal(t3n.rankings.length, 1);
        assert.equal(t3n.rankings[0].sourceId, 6);
        assert.equal(t3n.rankings[0].rankingKey, 'most_read');
        assert.equal(t3n.rankings[0].sourceName, 't3n');
        assert.equal(t3n.rankings[0].items[0].article.title, 't3n RSS title');
        assert.equal(t3n.rankings[0].items[0].article.teaser, 't3n RSS teaser');
        const t3nText = await run(['--most-read', 't3n']);
        assert.match(t3nText, /t3n · Most read · 2026-11-01T00:00:00\.000Z/);
        assert.match(t3nText, /1\tt3n RSS title\thttps:\/\/t3n.de\/news\/t3n-fixture-1234567\//);
        assert.doesNotMatch(t3nText, /Most commented|Top-News|heise iX|ComputerBase|WinFuture|Golem/);
        assert.deepEqual(await readFile(databasePath), before);
        assert.deepEqual(await readdir(directory), filesBefore);
    } finally {
        if (connection) await new Promise(resolve => connection.close(resolve));
        await rm(directory, { recursive: true, force: true });
    }
});
