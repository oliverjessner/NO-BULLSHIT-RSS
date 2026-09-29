import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sqlite3 from '@vscode/sqlite3';
import { CLI_VERSION, parseCliArgs } from './lib/arguments.js';
import { chooseArticle } from './lib/choose.js';
import { discoverDatabasePath, getElectronDatabasePath } from './lib/database-path.js';
import { formatChosenArticle, formatDigest, formatFeeds, formatLastArticles } from './lib/output.js';
import { runCli } from './main.js';
import { getDigestPeriodDefinition } from '../backend/services/digest-periods.js';

function createCaptureStream() {
    let value = '';
    return {
        write(chunk) {
            value += String(chunk);
        },
        read() {
            return value;
        },
    };
}

async function createFixtureDatabase(databasePath, { includeFeedNames = true } = {}) {
    const database = await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(databasePath, error => {
            if (error) reject(error);
            else resolve(connection);
        });
    });
    const exec = sql =>
        new Promise((resolve, reject) => {
            database.exec(sql, error => (error ? reject(error) : resolve()));
        });
    const run = (sql, params = []) =>
        new Promise((resolve, reject) => {
            database.run(sql, params, error => (error ? reject(error) : resolve()));
        });
    const close = () =>
        new Promise((resolve, reject) => {
            database.close(error => (error ? reject(error) : resolve()));
        });

    await exec(await readFile(new URL('../migrations/0001_schema.sql', import.meta.url), 'utf8'));
    if (includeFeedNames) {
        await exec(await readFile(new URL('../migrations/0002_feed_names.sql', import.meta.url), 'utf8'));
    }

    const now = new Date();
    const newestTimestamp = new Date(now.getTime() - 60_000).toISOString();
    const olderTimestamp = new Date(now.getTime() - 3_600_000).toISOString();
    const period = getDigestPeriodDefinition('day', now, 'Europe/Vienna');
    await exec(
        `
        INSERT INTO sources (id, name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
        VALUES (1, 'Test Source', 'https://example.com', 'https://example.com/', datetime('now'), datetime('now'));
        INSERT INTO feeds (id, sourceId, feedUrl, createdAt, updatedAt)
        VALUES (1, 1, 'https://example.com/feed', datetime('now'), datetime('now'));
        INSERT INTO topics (id, slug, label, configJson, ruleHash, ruleVersion, createdAt, updatedAt)
        VALUES (1, 'nvidia', 'Nvidia', '{"type":null,"minMatches":1,"exclude":[],"strong":["nvidia"],"medium":[],"weak":[]}', 'topic-hash', 2, datetime('now'), datetime('now'));
        INSERT INTO lists (id, name, description, color, createdAt, updatedAt)
        VALUES (1, 'Nvidia', 'GPU news', '#76b900', datetime('now'), datetime('now'));
        `,
    );
    await run(
        `INSERT INTO articles
            (id, feedId, externalId, title, teaser, url, canonicalUrl, contentHash, publishedAt, fetchedAt,
             createdAt, updatedAt, classificationStatus)
         VALUES
            (1, 1, 'older', 'Older', 'Older teaser', 'https://example.com/older', 'https://example.com/older', 'h1', ?, ?, datetime('now'), datetime('now'), 'ready'),
            (2, 1, 'two', 'Same time lower id', 'Digest topic alpha', 'https://example.com/two', 'https://example.com/two', 'h2', ?, ?, datetime('now'), datetime('now'), 'ready'),
            (3, 1, 'three', 'Same time higher id', 'Digest topic beta', 'https://example.com/three', 'https://example.com/three', 'h3', ?, ?, datetime('now'), datetime('now'), 'ready')`,
        [olderTimestamp, now.toISOString(), newestTimestamp, now.toISOString(), newestTimestamp, now.toISOString()],
    );
    await exec(
        `
        INSERT INTO article_state (articleId, dismissedAt, createdAt, updatedAt) VALUES
            (1, NULL, datetime('now'), datetime('now')),
            (2, NULL, datetime('now'), datetime('now')),
            (3, datetime('now'), datetime('now'), datetime('now'));
        INSERT INTO list_items (listId, articleId, createdAt) VALUES
            (1, 1, datetime('now')),
            (1, 2, datetime('now'));
        `,
    );
    await run(
        `INSERT INTO digest_periods
            (id, type, periodKey, startsAt, endsAt, timezone, status, activeGenerationId, generatedAt,
             algorithmVersion, rulesVersion, createdAt, updatedAt)
         VALUES (1, 'day', ?, ?, ?, 'Europe/Vienna', 'ready', 1,
                datetime('now'), 'test', 'test', datetime('now'), datetime('now'))`,
        [period.periodKey, period.startsAt, period.endsAt],
    );
    await exec(
        `
        INSERT INTO digest_generations
            (id, digestPeriodId, generationNumber, status, sourceArticleCount, clusterCount, algorithmVersion, rulesVersion, startedAt, generatedAt)
        VALUES (1, 1, 1, 'ready', 1, 1, 'test', 'test', datetime('now'), datetime('now'));
        `,
    );
    await run(
        `INSERT INTO digest_clusters
            (id, digestGenerationId, clusterKey, title, representativeArticleId, articleCount, firstPublishedAt,
             lastPublishedAt, fingerprint, displayPosition)
         VALUES (1, 1, 'cluster-2', 'Same time lower id', 2, 1, ?, ?, 'fp', 0)`,
        [newestTimestamp, newestTimestamp],
    );
    await exec(
        `
        INSERT INTO digest_cluster_articles
            (digestClusterId, digestGenerationId, articleId, position, similarity, isRepresentative)
        VALUES (1, 1, 2, 0, NULL, 1);
        `,
    );

    return { close };
}

test('parses article projections and digest ranges', () => {
    assert.deepEqual(parseCliArgs(['--version']), { command: 'version' });
    assert.deepEqual(parseCliArgs(['-v']), { command: 'version' });
    assert.deepEqual(parseCliArgs(['rss']), { command: 'rss', rssUrl: false });
    assert.deepEqual(parseCliArgs(['rss', '--rss-url']), { command: 'rss', rssUrl: true });
    assert.deepEqual(parseCliArgs(['topics']), { command: 'topics' });
    assert.deepEqual(parseCliArgs(['lists']), { command: 'lists', listName: null });
    assert.deepEqual(parseCliArgs(['lists', '--list', ' nvidia ']), { command: 'lists', listName: 'nvidia' });
    assert.deepEqual(parseCliArgs(['articles', 'search', '10', '--title', ' nvidia ']), {
        command: 'articles-search',
        count: 10,
        field: 'title',
        text: 'nvidia',
    });
    assert.deepEqual(parseCliArgs(['articles', 'search', '10', '--url', 'nvidia']), {
        command: 'articles-search',
        count: 10,
        field: 'url',
        text: 'nvidia',
    });
    assert.deepEqual(parseCliArgs(['articles', 'last', '10', '--url']), {
        command: 'articles-last',
        count: 10,
        url: true,
        title: false,
        choose: false,
    });
    assert.deepEqual(parseCliArgs(['articles', 'last', '10', '--title']), {
        command: 'articles-last',
        count: 10,
        url: false,
        title: true,
        choose: false,
    });
    assert.deepEqual(parseCliArgs(['articles', 'last', '10', '--titles']), {
        command: 'articles-last',
        count: 10,
        url: false,
        title: true,
        choose: false,
    });
    assert.deepEqual(parseCliArgs(['articles', 'last', '10', '--url', '--titles']), {
        command: 'articles-last',
        count: 10,
        url: true,
        title: true,
        choose: false,
    });
    assert.deepEqual(parseCliArgs(['articles', 'last', '10', '--choose', '--url']), {
        command: 'articles-last',
        count: 10,
        url: true,
        title: false,
        choose: true,
    });
    assert.deepEqual(parseCliArgs(['articles', 'random']), {
        command: 'articles-random',
        url: false,
        title: false,
    });
    assert.deepEqual(parseCliArgs(['articles', 'random', '--url', '--titles']), {
        command: 'articles-random',
        url: true,
        title: true,
    });
    assert.deepEqual(parseCliArgs(['articles', 'digest', '5']), {
        command: 'articles-digest',
        count: 5,
        variant: 'day',
    });
    assert.equal(parseCliArgs(['articles', 'digest', '5', '--daily']).variant, 'day');
    assert.equal(parseCliArgs(['articles', 'digest', '5', '--weekly']).variant, 'week');
    assert.equal(parseCliArgs(['articles', 'digest', '5', '--monthly']).variant, 'month');
});

test('prints the package version for version and help commands', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const versionStdout = createCaptureStream();
    const versionStderr = createCaptureStream();

    assert.equal(await runCli(['--version'], { stdout: versionStdout, stderr: versionStderr }), 0);
    assert.equal(versionStdout.read(), `${packageJson.version}\n`);
    assert.equal(versionStderr.read(), '');
    assert.equal(CLI_VERSION, packageJson.version);

    const helpStdout = createCaptureStream();
    assert.equal(await runCli(['--help'], { stdout: helpStdout, stderr: createCaptureStream() }), 0);
    assert.equal(helpStdout.read().startsWith(`NO BULLSHIT RSS CLI v${packageJson.version}\n`), true);
    assert.match(helpStdout.read(), /-v, --version\s+Show version/u);
});

test('rejects invalid counts, flags and multiple digest ranges', () => {
    assert.throws(() => parseCliArgs(['articles', 'last', '0']), /greater than 0/u);
    assert.throws(() => parseCliArgs(['articles', 'last', '-1']), /greater than 0/u);
    assert.throws(() => parseCliArgs(['articles', 'last', 'foo']), /greater than 0/u);
    assert.throws(() => parseCliArgs(['articles', 'last', '1.5']), /greater than 0/u);
    assert.throws(() => parseCliArgs(['articles', 'last', '2', '--weekly']), /Unknown option/u);
    assert.throws(() => parseCliArgs(['articles', 'random', '2']), /Unknown option/u);
    assert.throws(() => parseCliArgs(['articles', 'random', '--choose']), /Unknown option/u);
    assert.throws(() => parseCliArgs(['articles', 'digest', '2', '--choose']), /Unknown option/u);
    assert.throws(() => parseCliArgs(['rss', '--url']), /Unknown option/u);
    assert.throws(() => parseCliArgs(['topics', '--list']), /Unknown option/u);
    assert.throws(() => parseCliArgs(['lists', '--list']), /Missing required list name/u);
    assert.throws(() => parseCliArgs(['lists', '--list', '--url']), /Missing required list name/u);
    assert.throws(() => parseCliArgs(['lists', '--unknown']), /Unknown option/u);
    assert.throws(() => parseCliArgs(['articles', 'search', '10']), /exactly one of --title or --url/u);
    assert.throws(() => parseCliArgs(['articles', 'search', '10', '--title']), /Missing search text/u);
    assert.throws(() => parseCliArgs(['articles', 'search', '10', '--title', 'nvidia', '--url', 'gpu']), /Unknown option/u);
    assert.throws(() => parseCliArgs(['unknown', 'last', '2']), /Unknown resource/u);
    assert.throws(() => parseCliArgs(['articles', 'unknown', '2']), /Unknown articles command/u);
    assert.throws(
        () => parseCliArgs(['articles', 'digest', '2', '--daily', '--monthly']),
        /Only one of --daily, --weekly or --monthly/u,
    );
});

test('writes validation errors only to stderr and exits non-zero', async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exitCode = await runCli(['articles', 'last', '0'], { stdout, stderr });

    assert.equal(exitCode, 1);
    assert.equal(stdout.read(), '');
    assert.match(stderr.read(), /^Error: .+greater than 0/u);
});

test('formats URL, title, combined and compact JSON output', () => {
    const articles = [
        {
            id: 7,
            title: 'A title',
            url: 'https://example.com/a',
            publishedAt: '2026-01-01T00:00:00.000Z',
            sourceName: 'Example',
            teaser: 'not part of compact output',
        },
        {
            id: 6,
            title: 'Second title',
            url: 'https://example.com/b',
            publishedAt: '2025-12-31T00:00:00.000Z',
            sourceName: 'Example',
        },
    ];
    assert.equal(formatLastArticles(articles, { url: true }), 'https://example.com/a\nhttps://example.com/b');
    assert.equal(formatLastArticles(articles, { title: true }), 'A title\nSecond title');
    assert.equal(
        formatLastArticles(articles, { url: true, title: true }),
        'https://example.com/a\tA title\nhttps://example.com/b\tSecond title',
    );
    assert.deepEqual(JSON.parse(formatLastArticles([articles[0]])), [
        {
            id: 7,
            title: 'A title',
            url: 'https://example.com/a',
            publishedAt: '2026-01-01T00:00:00.000Z',
            sourceName: 'Example',
        },
    ]);
    assert.equal(formatChosenArticle(articles[0], { url: true }), 'https://example.com/a');
    assert.equal(formatChosenArticle(articles[0], { title: true }), 'A title');
    assert.deepEqual(JSON.parse(formatChosenArticle(articles[0])), {
        id: 7,
        title: 'A title',
        url: 'https://example.com/a',
        publishedAt: '2026-01-01T00:00:00.000Z',
        sourceName: 'Example',
    });
    assert.deepEqual(
        JSON.parse(
            formatDigest(
                {
                    clusters: [
                        {
                            clusterTitle: 'Cluster',
                            clusterCount: 1,
                            items: [articles[0]],
                        },
                    ],
                },
                1,
            ),
        ),
        [
            {
                title: 'Cluster',
                count: 1,
                articles: [
                    {
                        title: 'A title',
                        url: 'https://example.com/a',
                        sourceName: 'Example',
                        publishedAt: '2026-01-01T00:00:00.000Z',
                    },
                ],
            },
        ],
    );
    const feeds = [
        { name: 'Example Tech', feedUrl: 'https://example.com/tech.xml', websiteUrl: 'https://example.com/tech' },
        { name: 'Example Startups', feedUrl: 'https://example.com/startups.xml', websiteUrl: 'https://example.com/startups' },
    ];
    assert.deepEqual(JSON.parse(formatFeeds(feeds)), feeds);
    assert.equal(formatFeeds(feeds, { rssUrl: true }), 'https://example.com/tech.xml\nhttps://example.com/startups.xml');
});

test('chooses an article with keyboard navigation and restores terminal state', async () => {
    const input = new EventEmitter();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = value => {
        input.isRaw = value;
    };
    input.resume = () => {};
    input.pause = () => {};

    const output = createCaptureStream();
    output.isTTY = true;
    output.rows = 24;
    output.columns = 100;

    const articles = [
        { id: 1, title: 'First', sourceName: 'One' },
        { id: 2, title: 'Second', sourceName: 'Two' },
    ];
    const selection = chooseArticle(articles, { input, output });
    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'return' });

    assert.equal((await selection).id, 2);
    assert.equal(input.isRaw, false);
    assert.match(output.read(), /Choose an article/u);
});

test('rejects interactive selection without a TTY', async () => {
    await assert.rejects(chooseArticle([{ id: 1 }], { input: {}, output: {} }), /interactive terminal/u);
});

test('discovers DB_PATH, repository and Electron databases in priority order', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'no-bullshit-rss-cli-path-'));
    t.after(() => rm(directory, { recursive: true, force: true }));

    const explicitPath = path.join(directory, 'explicit.db');
    await writeFile(explicitPath, 'fixture');
    assert.equal(await discoverDatabasePath({ cwd: directory, env: { DB_PATH: explicitPath } }), explicitPath);

    const repository = path.join(directory, 'repo');
    const nested = path.join(repository, 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(repository, 'package.json'), JSON.stringify({ name: 'no-bullshit-rss' }));
    await writeFile(path.join(repository, 'data-v2.db'), 'v2 fixture');
    assert.equal(await discoverDatabasePath({ cwd: nested, env: {} }), path.join(repository, 'data-v2.db'));

    const homeDir = path.join(directory, 'home');
    const electronPath = getElectronDatabasePath({ platform: 'linux', env: {}, homeDir });
    await mkdir(path.dirname(electronPath), { recursive: true });
    await writeFile(electronPath, 'fixture');
    assert.equal(await discoverDatabasePath({ cwd: directory, env: {}, platform: 'linux', homeDir }), electronPath);

    await assert.rejects(
        discoverDatabasePath({ cwd: directory, env: { DB_PATH: path.join(directory, 'missing.db') } }),
        /Database not found at DB_PATH/u,
    );
});

test('runs article and digest commands against only a temporary DB without writes', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'no-bullshit-rss-cli-db-'));
    const databasePath = path.join(directory, 'fixture.db');
    const fixture = await createFixtureDatabase(databasePath);
    await fixture.close();
    t.after(() => rm(directory, { recursive: true, force: true }));

    const articleStdout = createCaptureStream();
    const articleStderr = createCaptureStream();
    const articleExitCode = await runCli(['articles', 'last', '3'], {
        stdout: articleStdout,
        stderr: articleStderr,
        cwd: directory,
        env: { DB_PATH: databasePath },
    });
    assert.equal(articleExitCode, 0);
    assert.equal(articleStderr.read(), '');
    assert.deepEqual(
        JSON.parse(articleStdout.read()).map(article => article.id),
        [3, 2, 1],
    );

    const chosenStdout = createCaptureStream();
    const chosenStderr = createCaptureStream();
    const chosenExitCode = await runCli(['articles', 'last', '3', '--choose', '--url'], {
        stdout: chosenStdout,
        stderr: chosenStderr,
        cwd: directory,
        env: { DB_PATH: databasePath },
        chooseArticle: async articles => articles[1],
    });
    assert.equal(chosenExitCode, 0);
    assert.equal(chosenStderr.read(), '');
    assert.equal(chosenStdout.read(), 'https://example.com/two\n');

    const titleSearchStdout = createCaptureStream();
    const titleSearchExitCode = await runCli(['articles', 'search', '1', '--title', 'SAME TIME'], {
        stdout: titleSearchStdout,
        stderr: createCaptureStream(),
        cwd: directory,
        env: { DB_PATH: databasePath },
    });
    assert.equal(titleSearchExitCode, 0);
    assert.deepEqual(JSON.parse(titleSearchStdout.read()).map(article => article.id), [3]);

    const urlSearchStdout = createCaptureStream();
    const urlSearchExitCode = await runCli(['articles', 'search', '10', '--url', 'EXAMPLE.COM/TWO'], {
        stdout: urlSearchStdout,
        stderr: createCaptureStream(),
        cwd: directory,
        env: { DB_PATH: databasePath },
    });
    assert.equal(urlSearchExitCode, 0);
    assert.deepEqual(JSON.parse(urlSearchStdout.read()).map(article => article.id), [2]);

    const randomStdout = createCaptureStream();
    const randomStderr = createCaptureStream();
    const randomExitCode = await runCli(['articles', 'random'], {
        stdout: randomStdout,
        stderr: randomStderr,
        cwd: directory,
        env: { DB_PATH: databasePath },
    });
    assert.equal(randomExitCode, 0);
    assert.equal(randomStderr.read(), '');
    const randomArticle = JSON.parse(randomStdout.read());
    assert.equal([1, 2, 3].includes(randomArticle.id), true);
    assert.equal(typeof randomArticle.title, 'string');
    assert.match(randomArticle.url, /^https:\/\/example\.com\//u);

    const randomUrlStdout = createCaptureStream();
    const randomUrlExitCode = await runCli(['articles', 'random', '--url'], {
        stdout: randomUrlStdout,
        stderr: createCaptureStream(),
        cwd: directory,
        env: { DB_PATH: databasePath },
    });
    assert.equal(randomUrlExitCode, 0);
    assert.match(randomUrlStdout.read(), /^https:\/\/example\.com\/(?:older|two|three)\n$/u);

    const digestStdout = createCaptureStream();
    const digestStderr = createCaptureStream();
    const digestExitCode = await runCli(['articles', 'digest', '10', '--daily'], {
        stdout: digestStdout,
        stderr: digestStderr,
        cwd: directory,
        env: { DB_PATH: databasePath },
    });
    assert.equal(digestExitCode, 0);
    assert.equal(digestStderr.read(), '');
    const clusters = JSON.parse(digestStdout.read());
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].articles[0].title, 'Same time lower id');

    const feedsStdout = createCaptureStream();
    const feedsStderr = createCaptureStream();
    const feedsExitCode = await runCli(['rss'], {
        stdout: feedsStdout,
        stderr: feedsStderr,
        cwd: directory,
        env: { DB_PATH: databasePath },
    });
    assert.equal(feedsExitCode, 0);
    assert.equal(feedsStderr.read(), '');
    assert.deepEqual(JSON.parse(feedsStdout.read()), [
        { name: 'Test Source', feedUrl: 'https://example.com/feed', websiteUrl: 'https://example.com' },
    ]);

    const feedUrlsStdout = createCaptureStream();
    const feedUrlsExitCode = await runCli(['rss', '--rss-url'], {
        stdout: feedUrlsStdout,
        stderr: createCaptureStream(),
        cwd: directory,
        env: { DB_PATH: databasePath },
    });
    assert.equal(feedUrlsExitCode, 0);
    assert.equal(feedUrlsStdout.read(), 'https://example.com/feed\n');

    const topicsStdout = createCaptureStream();
    const topicsExitCode = await runCli(['topics'], {
        stdout: topicsStdout,
        stderr: createCaptureStream(),
        cwd: directory,
        env: { DB_PATH: databasePath },
    });
    assert.equal(topicsExitCode, 0);
    assert.deepEqual(JSON.parse(topicsStdout.read()), [
        {
            id: 1,
            slug: 'nvidia',
            label: 'Nvidia',
            type: null,
            minMatches: 1,
            exclude: [],
            strong: ['nvidia'],
            medium: [],
            weak: [],
            ruleVersion: 2,
        },
    ]);

    const listsStdout = createCaptureStream();
    const listsExitCode = await runCli(['lists'], {
        stdout: listsStdout,
        stderr: createCaptureStream(),
        cwd: directory,
        env: { DB_PATH: databasePath },
    });
    assert.equal(listsExitCode, 0);
    assert.deepEqual(JSON.parse(listsStdout.read()), [
        { id: 1, name: 'Nvidia', description: 'GPU news', color: '#76b900', articleCount: 2 },
    ]);

    const listArticlesStdout = createCaptureStream();
    const listArticlesStderr = createCaptureStream();
    const listArticlesExitCode = await runCli(['lists', '--list', 'nViDiA'], {
        stdout: listArticlesStdout,
        stderr: listArticlesStderr,
        cwd: directory,
        env: { DB_PATH: databasePath },
    });
    assert.equal(listArticlesExitCode, 0);
    assert.equal(listArticlesStderr.read(), '');
    assert.deepEqual(JSON.parse(listArticlesStdout.read()).map(article => article.id), [2, 1]);

    const verification = await createFixtureReader(databasePath);
    const persisted = await verification.all(
        'SELECT articles.id, article_state.dismissedAt FROM articles JOIN article_state ON article_state.articleId = articles.id ORDER BY articles.id',
    );
    assert.deepEqual(
        persisted.map(row => [row.id, Boolean(row.dismissedAt)]),
        [
            [1, false],
            [2, false],
            [3, true],
        ],
    );
    await verification.close();
});

test('reads digest data from a pre-feed-name database without migrating it', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'no-bullshit-rss-cli-legacy-feed-name-'));
    const databasePath = path.join(directory, 'fixture.db');
    const fixture = await createFixtureDatabase(databasePath, { includeFeedNames: false });
    await fixture.close();
    t.after(() => rm(directory, { recursive: true, force: true }));

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exitCode = await runCli(['articles', 'digest', '10', '--daily'], {
        stdout,
        stderr,
        cwd: directory,
        env: { DB_PATH: databasePath },
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), '');
    assert.equal(JSON.parse(stdout.read())[0].articles[0].sourceName, 'Test Source');

    const listStdout = createCaptureStream();
    const listStderr = createCaptureStream();
    const listExitCode = await runCli(['lists', '--list', 'nvidia'], {
        stdout: listStdout,
        stderr: listStderr,
        cwd: directory,
        env: { DB_PATH: databasePath },
    });
    assert.equal(listExitCode, 0);
    assert.equal(listStderr.read(), '');
    assert.equal(JSON.parse(listStdout.read())[0].sourceName, 'Test Source');

    const verification = await createFixtureReader(databasePath);
    const columns = await verification.all('PRAGMA table_info(feeds)');
    assert.equal(columns.some(column => column.name === 'name'), false);
    await verification.close();
});

async function createFixtureReader(databasePath) {
    const database = await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, error => {
            if (error) reject(error);
            else resolve(connection);
        });
    });
    return {
        all(sql, params = []) {
            return new Promise((resolve, reject) => {
                database.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
            });
        },
        close() {
            return new Promise((resolve, reject) => {
                database.close(error => (error ? reject(error) : resolve()));
            });
        },
    };
}
