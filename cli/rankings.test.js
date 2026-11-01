import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sqlite3 from '@vscode/sqlite3';
import { parseCliArgs, getHelpText } from './lib/arguments.js';
import { formatTopArticles, formatChosenTopArticle } from './lib/output.js';
import { RANKING_MEDIA } from '../backend/services/ranking-media.js';
import { runCli } from './main.js';

const capture = () => {
    let text = '';
    return { write: chunk => { text += String(chunk); }, read: () => text };
};
const defaults = { command: 'articles-top', count: 40, medium: 'all', list: false, json: false, choose: false };

test('articles top defaults to 40 across all media and validates explicit options', () => {
    assert.deepEqual(parseCliArgs(['articles', 'top']), defaults);
    assert.deepEqual(parseCliArgs(['articles', 'top', '100', '--list']), { ...defaults, count: 100, list: true });
    assert.deepEqual(parseCliArgs(['articles', 'top', '1000', '--medium', ' GOLEM ', '--choose', '--json']), {
        ...defaults, count: 1000, medium: 'golem', choose: true, json: true,
    });
    assert.deepEqual(parseCliArgs(['articles', 'top', '--list', '--medium', 'ALL']), { ...defaults, list: true });
    for (const medium of RANKING_MEDIA) {
        assert.equal(parseCliArgs(['articles', 'top', '--medium', medium.id.toUpperCase()]).medium, medium.id);
    }
});

test('invalid counts, media, duplicate flags and conflicting output formats fail before database discovery', async () => {
    for (const args of [
        ...['0', '-1', '1.5', 'word', '9007199254740992'].map(count => ['articles', 'top', count]),
        ['articles', 'top', '--medium'], ['articles', 'top', '--medium', 'unknown'],
        ['articles', 'top', '--medium', 'golem', '--medium', 'winfuture'],
        ['articles', 'top', '--json', '--json'], ['articles', 'top', '--list', '--json'],
        ['articles', 'top', '--url'], ['articles', 'top', '10', '20'], ['articles', 'top', '--medium', '--choose'],
    ]) {
        let discovered = false;
        const stdout = capture(), stderr = capture();
        assert.equal(await runCli(args, { stdout, stderr, discoverDatabase: async () => { discovered = true; throw new Error('Must not discover'); } }), 1);
        assert.equal(discovered, false);
        assert.equal(stdout.read(), '');
        assert.match(stderr.read(), /^Error: /);
        assert.doesNotMatch(stderr.read(), /Must not discover/);
    }
});

test('removed ranking flags have no aliases and point to articles top before opening a database', async () => {
    for (const flag of ['--most-read', '--most-commented', '--top-news']) {
        for (const args of [[flag, 'golem'], ['articles', 'top', flag, 'golem'], [`${flag}=golem`]]) {
            const stdout = capture(), stderr = capture();
            assert.equal(await runCli(args, { stdout, stderr, discoverDatabase: async () => { throw new Error('Must not discover'); } }), 1);
            assert.equal(stdout.read(), '');
            assert.match(stderr.read(), /is no longer supported\. Use "articles top/);
            assert.doesNotMatch(stderr.read(), /Must not discover/);
        }
    }
});

test('help describes the unified top command and all supported media without legacy flags', () => {
    const text = getHelpText();
    assert.match(text, /articles top \[count\]/);
    assert.match(text, /default: 40/);
    for (const medium of RANKING_MEDIA) assert.ok(text.includes(medium.id));
    assert.doesNotMatch(text, /--most-read|--most-commented|--top-news/);
});

test('text output keeps article details and publisher labels, with terminal controls cleaned', () => {
    const article = { id: null, title: 'Title\nwith\x1bcontrols', url: 'https://example.test/a', sourceName: 'Publisher',
        teaser: 'A\t teaser', publishedAt: null, capturedAt: '2026-11-01T00:00:00.000Z', medium: 'techcrunch',
        rankings: [{ rankingKey: 'top_news', label: 'Top\nHeadlines\t', rank: 2, capturedAt: '2026-11-01T00:00:00.000Z' }] };
    const text = formatTopArticles([article]);
    assert.match(text, /1\. Title with controls/);
    assert.match(text, /Publisher · Captured 2026-11-01/);
    assert.match(text, /Top Headlines #2/);
    assert.match(text, /https:\/\/example.test\/a/);
    assert.match(text, /A teaser/);
    assert.doesNotMatch(text, /\x1b/);
    assert.deepEqual(JSON.parse(formatTopArticles([article], { json: true })), [article]);
    assert.deepEqual(JSON.parse(formatChosenTopArticle(article, { json: true })), article);
    assert.equal(formatChosenTopArticle(article, { list: true }), text);
    assert.match(formatTopArticles([], { medium: 'golem' }), /No saved top articles for golem/);
    assert.deepEqual(JSON.parse(formatTopArticles([], { json: true })), []);
});

const fixtureMedia = [
    ['golem', 'Golem', 'https://www.golem.de/', 'https://rss.golem.de/rss.php', i => `https://www.golem.de/news/fixture-${i}.html`],
    ['winfuture', 'WinFuture', 'https://winfuture.de/', 'https://static.winfuture.de/feed', i => `https://winfuture.de/news,${100000 + i}.html`],
    ['computerbase', 'ComputerBase', 'https://www.computerbase.de/', 'https://www.computerbase.de/rss/news.xml', i => `https://www.computerbase.de/news/fixture.${100000 + i}/`],
    ['heise-ix', 'heise iX', 'https://www.heise.de/ix/', 'https://www.heise.de/ix/feed.xml', i => `https://www.heise.de/news/fixture-${100000 + i}.html`],
    ['t3n', 't3n', 'https://t3n.de/', 'https://t3n.de/rss.xml', i => `https://t3n.de/news/fixture-${100000 + i}/`],
    ['techcrunch', 'TechCrunch', 'https://techcrunch.com/', 'https://techcrunch.com/feed/', i => `https://techcrunch.com/2026/10/01/fixture-${i}/`],
    ['arstechnica', 'Ars Technica', 'https://arstechnica.com/', 'https://feeds.arstechnica.com/arstechnica/index', i => `https://arstechnica.com/space/2026/10/ars-fixture-${i}/`],
];
const fixtureArticleCount = 135;

async function fixtureDatabase(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nbs-top-cli-'));
    const databasePath = path.join(directory, 'data-v2.db');
    let before, filesBefore;
    t.after(async () => {
        try {
            if (before) {
                assert.deepEqual(await readFile(databasePath), before, 'CLI must not modify database bytes');
                assert.deepEqual((await readdir(directory)).sort(), filesBefore, 'CLI must not create SQLite sidecars or other files');
            }
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
    const database = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(databasePath, error => error ? reject(error) : resolve(db));
    });
    const exec = sql => new Promise((resolve, reject) => database.exec(sql, error => error ? reject(error) : resolve()));
    const run = (sql, params) => new Promise((resolve, reject) => database.run(sql, params, error => error ? reject(error) : resolve()));
    try {
        for (const filename of ['0001_schema.sql', '0002_feed_names.sql', '0003_bullshit_rules.sql', '0005_unified_digest_filters.sql', '0008_most_read.sql', '0009_top_news.sql']) {
            await exec(await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8'));
        }
        for (const [index, [, name, website, feed]] of fixtureMedia.entries()) {
            await run('INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
                [index + 1, name, website, website, '2026-10-01', '2026-10-01']);
            await run('INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
                [index + 1, index + 1, name, feed, '2026-10-01', '2026-10-01']);
        }
        for (let i = 1; i <= fixtureArticleCount; i += 1) {
            const sourceId = (i - 1) % fixtureMedia.length + 1;
            const medium = fixtureMedia[sourceId - 1];
            const publisher = RANKING_MEDIA.find(item => item.id === medium[0]);
            const url = medium[4](i);
            const publishedAt = new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
            await run(`INSERT INTO articles (id,feedId,externalId,title,teaser,content,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [i, sourceId, `fixture-${i}`, `RSS title ${i}`, `RSS teaser ${i}`, `Body fixture ${i}`,
                url, url, `hash-${i}`, publishedAt, '2026-10-02', '2026-10-02', '2026-10-02']);
            await run('INSERT INTO most_read (sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES (?,?,?,?,?,?,?)',
                [sourceId, i, url, `Publisher title ${i}`, i, publisher.rankingKeys[0], '2026-10-02T00:00:00.000Z']);
            // A newer snapshot contains only a few old URLs: history must remain visible.
            if (i > 125) await run('INSERT INTO most_read (sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES (?,?,?,?,?,?,?)',
                [sourceId, i, `${url}?utm_source=new-snapshot`, `New publisher title ${i}`, i, publisher.rankingKeys[0], '2026-10-03T00:00:00.000Z']);
            if (publisher.rankingKeys.includes('most_commented')) await run('INSERT INTO most_read (sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES (?,?,?,?,?,?,?)',
                [sourceId, i, url, `Commented title ${i}`, i, 'most_commented', '2026-10-03T00:00:00.000Z']);
        }
        await exec(`INSERT INTO most_read (sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES
            (6,NULL,'https://techcrunch.com/2026/10/04/unmatched/','Unmatched publisher headline',1,'top_news','2026-10-04T00:00:00.000Z');
            INSERT INTO topics (id,slug,label,configJson,ruleHash,ruleVersion,createdAt,updatedAt)
            VALUES (1,'fixture','Fixture topic','{}','fixture',1,'2026-10-01','2026-10-01');
            INSERT INTO article_topics (articleId,topicId,score,matchedTermsJson,classificationVersion,createdAt)
            VALUES (135,1,1,'{}','fixture','2026-10-01');
            INSERT INTO lists (id,name,createdAt,updatedAt) VALUES (1,'Saved','2026-10-01','2026-10-01');
            INSERT INTO list_items (listId,articleId,createdAt) VALUES (1,135,'2026-10-01');`);
    } finally {
        await new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
    }
    before = await readFile(databasePath);
    filesBefore = (await readdir(directory)).sort();
    return { databasePath, run: async (args, options = {}) => {
        const stdout = capture(), stderr = capture();
        const code = await runCli(args, { stdout, stderr, env: { DB_PATH: databasePath }, cwd: directory,
            fetchApi: () => assert.fail('Top articles must not fetch'), ...options });
        return { code, stdout: stdout.read(), stderr: stderr.read() };
    } };
}

test('top 100 returns 100 unique newest articles from all media and stored history without writes', async t => {
    const fixture = await fixtureDatabase(t);
    const defaultResult = await fixture.run(['articles', 'top', '--json']);
    assert.equal(defaultResult.code, 0, defaultResult.stderr);
    assert.equal(JSON.parse(defaultResult.stdout).length, 40);
    const result = await fixture.run(['articles', 'top', '100', '--json']);
    assert.equal(result.code, 0, result.stderr);
    const items = JSON.parse(result.stdout);
    assert.equal(items.length, 100);
    assert.equal(new Set(items.map(item => item.canonicalUrl)).size, 100);
    assert.deepEqual(items.map(item => item.id), [null, ...Array.from({ length: 99 }, (_, index) => fixtureArticleCount - index)]);
    assert.deepEqual(new Set(items.map(item => item.medium)), new Set(fixtureMedia.map(item => item[0])));
    assert.equal(items[0].title, 'Unmatched publisher headline');
    assert.equal(items[0].rankings[0].label, 'Top Headlines');
    assert.equal(items[1].title, 'RSS title 135');
    assert.equal(items[1].teaser, 'RSS teaser 135');
    assert.equal(items[1].saved, true);
    assert.equal(items[1].topics[0].slug, 'fixture');
    assert.doesNotMatch(result.stdout, /Body fixture/);
    const allResult = await fixture.run(['articles', 'top', '1000', '--json']);
    assert.equal(allResult.code, 0, allResult.stderr);
    assert.equal(JSON.parse(allResult.stdout).length, fixtureArticleCount + 1);
});

test('medium filters include all supported ranking kinds and text/list output agree', async t => {
    const fixture = await fixtureDatabase(t);
    const result = await fixture.run(['articles', 'top', '100', '--medium', 'golem', '--json']);
    assert.equal(result.code, 0, result.stderr);
    const items = JSON.parse(result.stdout);
    const golemIds = Array.from({ length: fixtureArticleCount }, (_, index) => index + 1).filter(id => (id - 1) % fixtureMedia.length === 0).reverse();
    assert.equal(items.length, golemIds.length);
    assert.ok(items.every(item => item.medium === 'golem'));
    assert.deepEqual(items.map(item => item.id), golemIds);
    assert.ok(items[0].rankings.some(item => item.rankingKey === 'most_read'));
    assert.ok(items[0].rankings.some(item => item.rankingKey === 'most_commented'));
    const text = await fixture.run(['articles', 'top', '--medium', 'techcrunch']);
    const list = await fixture.run(['articles', 'top', '--medium', 'techcrunch', '--list']);
    assert.equal(text.code, 0, text.stderr);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(text.stdout, list.stdout);
    assert.match(text.stdout, /Top Headlines/);
    assert.match(text.stdout, /Unmatched publisher headline/);
    assert.doesNotMatch(text.stdout, /RSS title 135|Body fixture/);
});

test('Ars Technica medium filtering, JSON, readable list and chooser use saved RSS data without writes', async t => {
    const fixture = await fixtureDatabase(t);
    const args = ['articles', 'top', '100', '--medium', 'arstechnica'];
    const result = await fixture.run([...args, '--json']);
    assert.equal(result.code, 0, result.stderr);
    const items = JSON.parse(result.stdout);
    const arsIndex = fixtureMedia.findIndex(item => item[0] === 'arstechnica');
    const expectedIds = Array.from({ length: fixtureArticleCount }, (_, index) => index + 1).filter(id => (id - 1) % fixtureMedia.length === arsIndex).reverse();
    assert.deepEqual(items.map(item => item.id), expectedIds);
    assert.ok(items.every(item => item.medium === 'arstechnica' && item.sourceName === 'Ars Technica'));
    assert.ok(items.every(item => item.rankings.length === 1 && item.rankings[0].rankingKey === 'most_read' && item.rankings[0].rank === item.id));
    assert.equal(items[0].title, `RSS title ${expectedIds[0]}`);
    assert.equal(items[0].teaser, `RSS teaser ${expectedIds[0]}`);
    assert.match(items[0].canonicalUrl, /^https:\/\/arstechnica\.com\/space\/2026\/10\/ars-fixture-/);
    const text = await fixture.run([...args, '--list']);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Ars Technica/);
    assert.match(text.stdout, new RegExp(`Most read #${expectedIds[0]}`));
    assert.doesNotMatch(text.stdout, /Most commented|Top-News|Top Headlines|Body fixture/);
    const chosen = await fixture.run([...args, '--choose', '--json'], { chooseArticle: async candidates => {
        assert.deepEqual(candidates.map(item => item.id), expectedIds);
        return candidates[0];
    } });
    assert.equal(chosen.code, 0, chosen.stderr);
    assert.deepEqual(JSON.parse(chosen.stdout), items[0]);
});

test('top chooser receives the unified list and terminal streams, then emits only the chosen full record', async t => {
    const fixture = await fixtureDatabase(t);
    const stdin = {}, stdout = capture(), stderr = capture();
    let selected;
    const result = await fixture.run(['articles', 'top', '100', '--choose', '--json'], {
        stdin, stdout, stderr, chooseArticle: async (articles, streams) => {
            assert.equal(articles.length, 100);
            assert.equal(streams.input, stdin);
            assert.equal(streams.output, stderr);
            selected = articles[1];
            return selected;
        },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(stdout.read()), selected);
    assert.equal(stderr.read(), '');
    const text = await fixture.run(['articles', 'top', '--choose', '--list'], { chooseArticle: async articles => articles[0] });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /^1\. Unmatched publisher headline/);
});

test('top chooser requires a terminal and closes its read-only database on cancellation or errors', async t => {
    const fixture = await fixtureDatabase(t);
    const noTerminal = await fixture.run(['articles', 'top', '--choose'], { stdin: {} });
    assert.equal(noTerminal.code, 1);
    assert.equal(noTerminal.stdout, '');
    assert.match(noTerminal.stderr, /requires an interactive terminal/);
    const cancelled = await fixture.run(['articles', 'top', '--choose'], { chooseArticle: async () => { throw new Error('Selection cancelled.'); } });
    assert.equal(cancelled.code, 1);
    assert.equal(cancelled.stdout, '');
    assert.match(cancelled.stderr, /Selection cancelled/);
});
