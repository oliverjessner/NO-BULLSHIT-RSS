import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';

const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-watchdogs-'));
process.env.DB_PATH = path.join(directory, 'test.db');
process.env.TOPIC_RULES_FILE_PATH = path.join(directory, 'topics.json');
const db = await import('../database/datenbank.js');
const service = await import('./watchdogs.js');
const { updateAllFeeds } = await import('./fetcher.js');
const { sendDesktopNotification } = await import('./desktop-events.js');
await db.initSchema();
const rule = { name: 'AI news', enabled: true, includeAny: ['openai'], includeAll: [], exclude: [], feedIds: [] };
async function article(title = 'OpenAI update', extra = {}) {
    const result = await db.run(`INSERT INTO articles (feedId, externalId, title, teaser, content, contentHash, publishedAt, fetchedAt, createdAt, updatedAt)
        VALUES (1, ?, ?, ?, ?, 'test', datetime('now'), datetime('now'), datetime('now'), datetime('now'))`,
    [String(Math.random()), title, extra.teaser || '', extra.content || '']);
    return result.lastID;
}

test.beforeEach(async () => {
    await db.exec(`DELETE FROM digest_generations; DELETE FROM digest_period_articles; DELETE FROM watchdogs; DELETE FROM articles; DELETE FROM feeds; DELETE FROM sources;
        DELETE FROM sqlite_sequence WHERE name IN ('sources', 'feeds');
        INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt) VALUES ('Test', 'https://example.test', 'https://example.test/', datetime('now'), datetime('now'));
        INSERT INTO feeds (sourceId, name, feedUrl, watchdogInitializedAt, createdAt, updatedAt) VALUES (1, 'Test', 'https://example.test/feed', datetime('now'), datetime('now'), datetime('now'));
        UPDATE app_metadata SET value = '0' WHERE key IN ('watchdog.lastArticleId', 'watchdog.notifications');`);
});

test('combines case-insensitive any/all terms across title, teaser and content with exclusion precedence', () => {
    const article = { title: 'OPENAI report', teaser: 'European research', content: 'LLM safety', feedId: 1 };
    const matches = { ...rule, includeAny: ['missing', 'OpenAI'], includeAll: ['european', 'llm'], exclude: [] };
    assert.equal(service.matchesWatchdog(article, matches), true);
    assert.equal(service.matchesWatchdog(article, { ...matches, exclude: ['SAFETY'] }), false);
    assert.equal(service.matchesWatchdog(article, { ...matches, includeAll: ['missing'] }), false);
    assert.equal(service.matchesWatchdog(article, { ...matches, includeAny: ['missing'] }), false);
    assert.equal(service.matchesWatchdog(article, { ...matches, enabled: false }), false);
    assert.equal(service.matchesWatchdog(article, { ...matches, feedIds: [2] }), false);
    assert.equal(service.matchesWatchdog(article, { ...matches, feedIds: [1] }), true);
    assert.equal(service.matchesWatchdog({ title: null }, rule), false);
    assert.equal(service.matchesWatchdog({ title: 'ＦＯＯ', feedId: 1 }, { ...rule, includeAny: [], includeAll: ['foo'] }), true);
});

test('historical results are opt-in, persisted and always silent; rule edits never replay known articles', async () => {
    const old = await article();
    const { watchdog, historicalCount } = await service.createWatchdog({ ...rule, includeHistory: true });
    assert.equal(historicalCount, 1);
    await service.setNotificationSettings(true);
    assert.equal(await service.processWatchdogArticles(), 0);
    let matches = (await service.listMatches()).matches;
    assert.equal(matches[0].articleId, old);
    assert.equal(matches[0].historical, 1);
    assert.equal(matches[0].notificationState, 'skipped');
    await service.updateWatchdog(watchdog.id, { includeAny: ['report'] });
    await db.run("UPDATE articles SET title = 'New report' WHERE id = ?", [old]);
    assert.equal(await service.processWatchdogArticles(), 0);
    const sent = [];
    await service.dispatchWatchdogNotifications(item => sent.push(item));
    assert.deepEqual(sent, []);
    const another = await service.createWatchdog(rule);
    assert.equal((await service.listMatches({ watchdogId: another.watchdog.id })).matches.length, 0);
});

test('matches are idempotent under concurrent processing and preserve read/archive state across restart', async () => {
    const { watchdog } = await service.createWatchdog(rule);
    await service.setNotificationSettings(true);
    const id = await article();
    await Promise.all([service.processWatchdogArticles(), service.processWatchdogArticles()]);
    let matches = (await service.listMatches()).matches;
    assert.equal(matches.length, 1);
    assert.equal(matches[0].articleId, id);
    assert.equal((await service.listWatchdogs())[0].unreadCount, 1);
    const matchId = matches[0].id;
    await service.updateMatch(matchId, { read: true, archived: true });
    assert.equal((await service.listMatches()).matches.length, 0);
    assert.equal((await service.listMatches({ archived: true, status: 'read' })).matches.length, 1);
    assert.equal((await service.listWatchdogs())[0].unreadCount, 0);
    const script = `const db = await import('./backend/database/datenbank.js');
        const s = await import('./backend/services/watchdogs.js');
        await s.processWatchdogArticles();
        const rows = (await s.listMatches({archived:true,status:'read'})).matches;
        if(rows.length!==1 || rows[0].id!==${matchId}) throw new Error('State not persisted');
        await db.closeDatabase();`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: process.env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(await service.deleteWatchdog(watchdog.id), true);
    assert.equal((await service.listMatches({ archived: true })).matches.length, 0);
});

test('batches a fetch per watchdog, caps native notices, and never retries a failed or claimed delivery', async () => {
    for (let i = 0; i < 5; i++) await service.createWatchdog({ ...rule, name: `Rule ${i}` });
    await service.setNotificationSettings(true);
    await article(); await article();
    assert.equal(await service.processWatchdogArticles(), 10);
    const sent = [];
    await service.dispatchWatchdogNotifications(item => { sent.push(item); if (sent.length === 1) throw new Error('Native OS failure'); });
    assert.equal(sent.length, 3);
    assert.equal(sent[0].count, 2);
    assert.equal((await db.get("SELECT COUNT(*) AS count FROM watchdog_matches WHERE notificationState = 'pending'")).count, 0);
    assert.equal(await service.dispatchWatchdogNotifications(() => assert.fail('Duplicate delivery')), 0);
    assert.equal(await service.processWatchdogArticles(), 0);
});

test('notification opt-in never backfills old banners and disabled watchdogs only resume for future articles', async () => {
    const { watchdog } = await service.createWatchdog(rule);
    await article();
    await service.processWatchdogArticles();
    await service.setNotificationSettings(true);
    assert.equal(await service.dispatchWatchdogNotifications(() => assert.fail('Old banner')), 0);
    await service.updateWatchdog(watchdog.id, { enabled: false });
    await article();
    await service.processWatchdogArticles();
    await service.updateWatchdog(watchdog.id, { enabled: true });
    assert.equal(await service.processWatchdogArticles(), 0);
    await article();
    assert.equal(await service.processWatchdogArticles(), 1);
    assert.equal((await service.listMatches()).matches.length, 2);
});

test('pausing a watchdog suppresses an already pending banner permanently', async () => {
    const { watchdog } = await service.createWatchdog(rule);
    await service.setNotificationSettings(true); await article();
    await service.processWatchdogArticles();
    await service.updateWatchdog(watchdog.id, { enabled: false });
    assert.equal(await service.dispatchWatchdogNotifications(() => assert.fail('Paused banner')), 0);
    await service.updateWatchdog(watchdog.id, { enabled: true });
    assert.equal(await service.dispatchWatchdogNotifications(() => assert.fail('Replayed banner')), 0);
});

test('initial feed import creates silent matches, including an initially empty feed', async () => {
    await db.run('UPDATE feeds SET watchdogInitializedAt = NULL');
    await service.createWatchdog(rule);
    await service.setNotificationSettings(true);
    await article();
    assert.equal(await service.processWatchdogArticles({ fetchedFeedIds: [1] }), 1);
    assert.equal(await service.dispatchWatchdogNotifications(() => assert.fail('Initial import banner')), 0);
    await article();
    await service.processWatchdogArticles({ fetchedFeedIds: [1] });
    let sent = 0;
    await service.dispatchWatchdogNotifications(() => sent++);
    assert.equal(sent, 1);
    await db.run('UPDATE feeds SET watchdogInitializedAt = NULL');
    await service.processWatchdogArticles({ fetchedFeedIds: [1] });
    await article();
    await service.processWatchdogArticles();
    assert.equal(await service.dispatchWatchdogNotifications(() => {}), 1);
});

test('validates bounded terms/feed IDs and keeps deleted feed restrictions from broadening', async () => {
    await assert.rejects(service.createWatchdog({ ...rule, name: ' ' }));
    await assert.rejects(service.createWatchdog({ ...rule, includeAny: [] }));
    await assert.rejects(service.createWatchdog({ ...rule, feedIds: [99] }));
    await assert.rejects(service.createWatchdog({ ...rule, includeAny: ['x'.repeat(201)] }));
    const { watchdog } = await service.createWatchdog({ ...rule, feedIds: [1] });
    await db.run('DELETE FROM feeds WHERE id = 1');
    const persisted = await service.getWatchdog(watchdog.id);
    assert.deepEqual(persisted.feedIds, [1]);
    assert.equal(service.matchesWatchdog({ title: 'openai', feedId: 2 }, persisted), false);
});

test('paginates matches without duplicate rows and filters independently by read state and watchdog', async () => {
    const { watchdog } = await service.createWatchdog(rule);
    for (let i = 0; i < 55; i++) await article();
    await service.processWatchdogArticles();
    const first = await service.listMatches({ watchdogId: watchdog.id });
    assert.equal(first.matches.length, 50); assert.equal(first.hasMore, true);
    const last = await service.listMatches({ before: first.matches.at(-1).id });
    assert.equal(last.matches.length, 5); assert.equal(last.hasMore, false);
    assert.equal(new Set([...first.matches, ...last.matches].map(row => row.id)).size, 55);
    await service.updateMatch(first.matches[0].id, { read: true });
    assert.equal((await service.listMatches({ status: 'read' })).matches.length, 1);
});

test('the existing RSS fetch evaluates new articles and native failures cannot interrupt it', async t => {
    const server = createServer((_req, res) => res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title><link>https://example.test</link><description>Test</description><item><guid>rss-watchdog-test</guid><title>OpenAI RSS report</title><link>https://example.test/story</link></item></channel></rss>`));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    await db.run('UPDATE feeds SET feedUrl = ?', [`http://127.0.0.1:${server.address().port}/rss`]);
    await service.createWatchdog(rule); await service.setNotificationSettings(true);
    let sent = 0;
    const options = { refreshLogos: async () => {}, notify: () => { sent++; throw new Error('Native unavailable'); } };
    await Promise.all([updateAllFeeds(options), updateAllFeeds(options)]);
    assert.equal((await service.listMatches()).matches.length, 1);
    assert.equal(sent, 1);
    await updateAllFeeds(options);
    assert.equal(sent, 1);
});

test('native frames are opt-in, valid JSON and errors are propagated to the isolated dispatcher', async () => {
    let output = '';
    const stream = { write: (value, callback) => { output += value; callback(); } };
    await sendDesktopNotification({ id: 1 }, { desktop: false, output: stream });
    assert.equal(output, '');
    await sendDesktopNotification({ id: 1 }, { desktop: true, output: stream });
    assert.deepEqual(JSON.parse(output.slice('NBS_DESKTOP_EVENT '.length)), { type: 'watchdog.notification', id: 1 });
    await assert.rejects(sendDesktopNotification({}, { desktop: true, output: { write: (_value, callback) => callback(new Error('Closed pipe')) } }));
    const broken = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('Closed IPC pipe')); } });
    await assert.rejects(sendDesktopNotification({}, { desktop: true, output: broken }), /Closed IPC pipe/);
});

test.after(async () => { await db.closeDatabase(); await rm(directory, { recursive: true, force: true }); });
