import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sqlite3 from '@vscode/sqlite3';
import { getDigestPeriodDefinition, getDigestTimezone } from '../backend/services/digest-periods.js';
import { parseCliArgs } from './lib/arguments.js';
import { runCli } from './main.js';

const timestamp = '2026-11-01T00:00:00.000Z';
const articleUrl = id => `https://www.golem.de/news/random-${id}.html`;
const capture = () => {
    let text = '';
    return { write: value => { text += String(value); }, read: () => text };
};

async function fixtureDatabase(t, setup, { includeFeedNames = true } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nbs-random-cli-'));
    const databasePath = path.join(directory, 'data-v2.db');
    let before, filesBefore;
    t.after(async () => {
        try {
            if (before) {
                assert.deepEqual(await readFile(databasePath), before, 'Random selection must not modify database bytes');
                assert.deepEqual((await readdir(directory)).sort(), filesBefore, 'Random selection must not create sidecars');
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    const database = await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(databasePath, error => error ? reject(error) : resolve(connection));
    });
    const exec = sql => new Promise((resolve, reject) => database.exec(sql, error => error ? reject(error) : resolve()));
    const run = (sql, params = []) => new Promise((resolve, reject) => database.run(sql, params, error => error ? reject(error) : resolve()));
    const addArticle = (id, { feedId = 1, publishedAt = timestamp } = {}) => run(
        `INSERT INTO articles (id, feedId, externalId, title, teaser, url, canonicalUrl, contentHash,
            publishedAt, fetchedAt, createdAt, updatedAt, classificationStatus)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')`,
        [id, feedId, `random-${id}`, `Article ${id}`, `Teaser ${id}`, articleUrl(id), articleUrl(id),
            `hash-${id}`, publishedAt, timestamp, timestamp, timestamp],
    );
    const addArticles = async (count, options) => {
        for (let id = 1; id <= count; id += 1) await addArticle(id, options);
    };
    const addDigest = async () => {
        const period = getDigestPeriodDefinition('day', new Date(), getDigestTimezone());
        await run(`INSERT INTO digest_periods (id, type, periodKey, startsAt, endsAt, timezone, status,
            activeGenerationId, generatedAt, algorithmVersion, rulesVersion, createdAt, updatedAt)
            VALUES (1, 'day', ?, ?, ?, ?, 'ready', 1, ?, 'test', 'test', ?, ?)`,
        [period.periodKey, period.startsAt, period.endsAt, getDigestTimezone(), timestamp, timestamp, timestamp]);
        await run(`INSERT INTO digest_generations (id, digestPeriodId, generationNumber, status,
            sourceArticleCount, clusterCount, algorithmVersion, rulesVersion, startedAt, generatedAt)
            VALUES (1, 1, 1, 'ready', 0, 0, 'test', 'test', ?, ?)`, [timestamp, timestamp]);
    };
    const addCluster = async (id, articleIds, { generationId = 1, displayPosition = id - 1 } = {}) => {
        await run(`INSERT INTO digest_clusters (id, digestGenerationId, clusterKey, title,
            representativeArticleId, articleCount, firstPublishedAt, lastPublishedAt, fingerprint, displayPosition)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, generationId, `cluster-${id}`, `Cluster ${id}`, articleIds[0], articleIds.length,
            timestamp, timestamp, `fingerprint-${id}`, displayPosition]);
        for (const [position, articleId] of articleIds.entries()) {
            await run(`INSERT INTO digest_cluster_articles (digestClusterId, digestGenerationId, articleId,
                position, similarity, isRepresentative) VALUES (?, ?, ?, ?, NULL, ?)`,
            [id, generationId, articleId, position, Number(position === 0)]);
        }
    };
    const addRanking = (articleId, { rankingKey = 'most_read', capturedAt = timestamp, rank = articleId,
        url = articleUrl(articleId), title = `Publisher ${articleId}` } = {}) => run(
        `INSERT INTO most_read (sourceId, articleId, canonicalUrl, title, rank, rankingKey, capturedAt)
            VALUES (1, ?, ?, ?, ?, ?, ?)`, [articleId, url, title, rank, rankingKey, capturedAt],
    );
    try {
        for (const migration of ['0001_schema.sql', '0002_feed_names.sql', '0003_bullshit_rules.sql',
            '0005_unified_digest_filters.sql', '0008_most_read.sql', '0009_top_news.sql']) {
            if (!includeFeedNames && migration === '0002_feed_names.sql') continue;
            await exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
        }
        await exec(`INSERT INTO sources (id, name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
            VALUES (1, 'Golem', 'https://www.golem.de/', 'https://www.golem.de/', '${timestamp}', '${timestamp}'),
                   (2, 'Other', 'https://example.test/', 'https://example.test/', '${timestamp}', '${timestamp}');`);
        for (const [id, name, url] of [[1, 'Primary Feed', 'https://rss.golem.de/rss.php'], [2, 'Other Feed', 'https://example.test/feed.xml']]) {
            await run(`INSERT INTO feeds (id, sourceId, ${includeFeedNames ? 'name,' : ''} feedUrl, createdAt, updatedAt)
                VALUES (?, ?, ${includeFeedNames ? '?,' : ''} ?, ?, ?)`,
            [id, id, ...(includeFeedNames ? [name] : []), url, timestamp, timestamp]);
        }
        await setup({ exec, run, addArticle, addArticles, addDigest, addCluster, addRanking });
    } finally {
        await new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
    }
    before = await readFile(databasePath);
    filesBefore = (await readdir(directory)).sort();
    return {
        async run(args, { index = 0, expectedPoolSize } = {}) {
            const stdout = capture(), stderr = capture();
            const poolSizes = [];
            const code = await runCli(['articles', 'random', ...args], {
                stdout, stderr, cwd: directory, env: { DB_PATH: databasePath },
                fetchApi: () => assert.fail('Random selection must not fetch'),
                randomIndex: size => {
                    poolSizes.push(size);
                    if (expectedPoolSize !== undefined) assert.equal(size, expectedPoolSize);
                    return index === -1 ? size - 1 : index;
                },
            });
            return { code, stdout: stdout.read(), stderr: stderr.read(), poolSizes };
        },
    };
}

test('random accepts one source in any projection position and rejects conflicting sources before discovery', async () => {
    assert.equal(parseCliArgs(['articles', 'random']).source, 'feed');
    for (const source of ['feed', 'digest', 'top']) {
        for (const flags of [[`--${source}`, '--url', '--title'], ['--url', `--${source}`, '--titles']]) {
            const options = parseCliArgs(['articles', 'random', ...flags]);
            assert.equal(options.source, source);
            assert.equal(options.url, true);
            assert.equal(options.title, true);
        }
    }
    for (const flags of [
        ['--feed', '--digest'], ['--digest', '--feed'], ['--feed', '--top'], ['--top', '--digest'],
        ['--feed', '--digest', '--top'], ['--feed', '--feed'], ['--digest', '--digest'], ['--top', '--top'],
        ['--feed', '1'], ['--digest', '--weekly'], ['--unknown'],
    ]) {
        const stdout = capture(), stderr = capture();
        let discovered = false;
        const code = await runCli(['articles', 'random', ...flags], {
            stdout, stderr,
            discoverDatabase: async () => { discovered = true; throw new Error('Must not discover'); },
        });
        assert.equal(code, 1);
        assert.equal(discovered, false);
        assert.equal(stdout.read(), '');
        assert.match(stderr.read(), /^Error: /u);
        assert.doesNotMatch(stderr.read(), /Must not discover/u);
    }
});

test('default and feed random sample only the newest 50 stored articles with stable timestamp ties', async t => {
    const fixture = await fixtureDatabase(t, async ({ addArticles, exec }) => {
        await addArticles(60);
        await exec(`INSERT INTO article_state (articleId, dismissedAt, createdAt, updatedAt)
            VALUES (60, '${timestamp}', '${timestamp}', '${timestamp}');
            INSERT INTO bullshit_rules (id, name, field, operator, value, createdAt, updatedAt)
            VALUES (1, 'Flagged', 'title', 'contains', 'Article', '${timestamp}', '${timestamp}');
            INSERT INTO article_bullshit_matches (articleId, ruleId, matchedAt) VALUES (59, 1, '${timestamp}');`);
    });
    for (const flags of [[], ['--feed']]) {
        const newest = await fixture.run(flags, { expectedPoolSize: 50 });
        assert.equal(newest.code, 0, newest.stderr);
        assert.deepEqual(newest.poolSizes, [50]);
        assert.deepEqual(JSON.parse(newest.stdout), {
            id: 60, title: 'Article 60', url: articleUrl(60), publishedAt: timestamp, sourceName: 'Primary Feed',
        });
        const oldestEligible = await fixture.run(flags, { index: -1, expectedPoolSize: 50 });
        assert.equal(oldestEligible.code, 0, oldestEligible.stderr);
        assert.equal(JSON.parse(oldestEligible.stdout).id, 11);
    }
    assert.equal((await fixture.run(['--feed', '--url'], { expectedPoolSize: 50 })).stdout, `${articleUrl(60)}\n`);
    assert.equal((await fixture.run(['--title', '--feed'], { index: 1, expectedPoolSize: 50 })).stdout, 'Article 59\n');
    assert.equal((await fixture.run(['--url', '--feed', '--titles'], { index: -1, expectedPoolSize: 50 })).stdout,
        `${articleUrl(11)}\tArticle 11\n`);
});

test('digest random limits distinct member articles after stored digest visibility filters', async t => {
    const fixture = await fixtureDatabase(t, async ({ addArticles, addArticle, addDigest, addCluster, run, exec }) => {
        await addArticles(60);
        await addDigest();
        // Display order and representatives deliberately differ from newest article order.
        await addCluster(1, Array.from({ length: 20 }, (_, index) => index + 1));
        await addCluster(2, Array.from({ length: 20 }, (_, index) => index + 41));
        await addCluster(3, Array.from({ length: 20 }, (_, index) => index + 21));
        for (let id = 61; id <= 66; id += 1) await addArticle(id, { feedId: id === 61 ? 2 : 1 });
        await addCluster(4, [61]);
        await addCluster(5, [62]);
        await addCluster(6, [63]);
        await addCluster(7, [64]);
        // Article 65 is only in the Feed; article 66 belongs to an inactive generation.
        await run(`INSERT INTO digest_generations (id, digestPeriodId, generationNumber, status,
            sourceArticleCount, clusterCount, algorithmVersion, rulesVersion, startedAt, generatedAt)
            VALUES (2, 1, 2, 'superseded', 1, 1, 'test', 'test', ?, ?)`, [timestamp, timestamp]);
        await addCluster(8, [66], { generationId: 2, displayPosition: 0 });
        await exec(`INSERT INTO digest_excluded_feeds (feedId, createdAt) VALUES (2, '${timestamp}');
            INSERT INTO bullshit_rules (id, name, field, operator, value, createdAt, updatedAt)
            VALUES (1, 'Flagged', 'title', 'contains', '62', '${timestamp}', '${timestamp}');
            INSERT INTO article_bullshit_matches (articleId, ruleId, matchedAt) VALUES (62, 1, '${timestamp}');
            INSERT INTO digest_cluster_state (digestPeriodId, clusterKey, completedAt, dismissedAt, createdAt, updatedAt)
            VALUES (1, 'cluster-6', '${timestamp}', NULL, '${timestamp}', '${timestamp}'),
                   (1, 'cluster-7', NULL, '${timestamp}', '${timestamp}', '${timestamp}');`);
    });
    const newest = await fixture.run(['--digest'], { expectedPoolSize: 50 });
    assert.equal(newest.code, 0, newest.stderr);
    assert.equal(JSON.parse(newest.stdout).id, 60);
    const oldest = await fixture.run(['--digest', '--url', '--title'], { index: -1, expectedPoolSize: 50 });
    assert.equal(oldest.code, 0, oldest.stderr);
    assert.equal(oldest.stdout, `${articleUrl(11)}\tArticle 11\n`);
});

test('feed and digest choose their newest 50 by publication time before article ID', async t => {
    const fixture = await fixtureDatabase(t, async ({ addArticles, addDigest, addCluster, run }) => {
        await addArticles(60);
        await run('UPDATE articles SET publishedAt = ? WHERE id = 1', ['2026-11-04T00:00:00.000Z']);
        await run('UPDATE articles SET publishedAt = ? WHERE id = 2', ['2026-11-05T00:00:00.000Z']);
        await addDigest();
        await addCluster(1, Array.from({ length: 60 }, (_, index) => index + 1));
    });
    for (const source of ['feed', 'digest']) {
        const newest = await fixture.run([`--${source}`], { expectedPoolSize: 50 });
        assert.equal(newest.code, 0, newest.stderr);
        assert.deepEqual(newest.poolSizes, [50]);
        assert.equal(JSON.parse(newest.stdout).id, 2);
        assert.equal(JSON.parse(newest.stdout).publishedAt, '2026-11-05T00:00:00.000Z');
        const next = await fixture.run([`--${source}`, '--url'], { index: 1, expectedPoolSize: 50 });
        assert.equal(next.code, 0, next.stderr);
        assert.equal(next.stdout, `${articleUrl(1)}\n`);
        const oldest = await fixture.run([`--${source}`, '--url', '--title'], { index: -1, expectedPoolSize: 50 });
        assert.equal(oldest.code, 0, oldest.stderr);
        assert.equal(oldest.stdout, `${articleUrl(13)}\tArticle 13\n`);
    }
});

test('top random uses 50 unique newest publisher articles including unmatched links', async t => {
    const unmatchedUrl = 'https://www.golem.de/news/unmatched-random.html';
    const fixture = await fixtureDatabase(t, async ({ addArticle, addRanking }) => {
        for (let id = 1; id <= 60; id += 1) {
            await addArticle(id, { publishedAt: new Date(Date.UTC(2026, 10, 1, 0, id)).toISOString() });
            await addRanking(id);
        }
        await addRanking(60, { capturedAt: '2026-11-02T00:00:00.000Z', rank: 1 });
        await addRanking(60, { rankingKey: 'most_commented', capturedAt: '2026-11-02T00:00:00.000Z', rank: 1 });
        await addRanking(null, { capturedAt: '2026-11-03T00:00:00.000Z', rank: 1, url: unmatchedUrl, title: 'Unmatched publisher article' });
    });
    const first = await fixture.run(['--top'], { expectedPoolSize: 50 });
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {
        id: null, title: 'Unmatched publisher article', url: unmatchedUrl, publishedAt: null, sourceName: 'Golem',
    });
    const second = await fixture.run(['--top', '--title'], { index: 1, expectedPoolSize: 50 });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, 'Article 60\n');
    const oldest = await fixture.run(['--url', '--top'], { index: -1, expectedPoolSize: 50 });
    assert.equal(oldest.code, 0, oldest.stderr);
    assert.equal(oldest.stdout, `${articleUrl(12)}\n`);
});

test('all random sources use the available pool when fewer than 50 articles exist', async t => {
    const fixture = await fixtureDatabase(t, async ({ addArticles, addDigest, addCluster, addRanking }) => {
        await addArticles(3);
        await addDigest();
        await addCluster(1, [1, 2, 3]);
        for (let id = 1; id <= 3; id += 1) await addRanking(id);
    });
    for (const source of ['feed', 'digest', 'top']) {
        const result = await fixture.run([`--${source}`], { index: -1, expectedPoolSize: 3 });
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(result.poolSizes, [3]);
        assert.equal(JSON.parse(result.stdout).id, 1);
    }
});

test('random feed reads source names from a legacy database without feed names', async t => {
    const fixture = await fixtureDatabase(t, async ({ addArticles }) => addArticles(3), { includeFeedNames: false });
    const result = await fixture.run(['--feed'], { expectedPoolSize: 3 });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).id, 3);
    assert.equal(JSON.parse(result.stdout).sourceName, 'Golem');
});

test('empty digest and top sources report an error without falling back to stored feed articles', async t => {
    const fixture = await fixtureDatabase(t, async ({ addArticles }) => addArticles(3));
    for (const source of ['digest', 'top']) {
        const result = await fixture.run([`--${source}`, '--url']);
        assert.equal(result.code, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^Error: No .*articles/iu);
        assert.deepEqual(result.poolSizes, []);
    }
});

test('random fails cleanly for every source when no articles are stored', async t => {
    const fixture = await fixtureDatabase(t, async () => {});
    for (const flags of [[], ['--feed'], ['--digest'], ['--top']]) {
        const result = await fixture.run(flags);
        assert.equal(result.code, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^Error: No .*articles/iu);
        assert.deepEqual(result.poolSizes, []);
    }
});
