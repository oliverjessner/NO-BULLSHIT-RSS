import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-watchdog-ui-'));
const env = { ...process.env, DB_PATH: path.join(directory, 'ui.db'), TOPIC_RULES_FILE_PATH: path.join(directory, 'topics.json'), SERVER_LOG_PATH: path.join(directory, 'server.log'), DISABLE_SCHEDULER: '1', HOST: '127.0.0.1', DESKTOP_PARENT_WATCHDOG: '1' };
let backend, browser, fixture;
function database(code) {
    const script = `const db = await import('./backend/database/datenbank.js');\n${code}\nawait db.closeDatabase();`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
}
async function waitFor(condition, label) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}`);
}
try {
    fixture = httpServer((_req, res) => {
        res.setHeader('Content-Type', 'application/rss+xml');
        res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>Research feed</title><link>https://example.test</link><description>Test</description><item><guid>live-rss</guid><title>OpenAI live research</title><link>https://example.test/live</link><description>Local RSS integration fixture.</description></item></channel></rss>');
    });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    database(`await db.initSchema();
        const { DEFAULT_FEEDS_MARKER } = await import('./scripts/default-feeds.js');
        await db.run("INSERT INTO app_metadata (key,value,updatedAt) VALUES (?, '1', datetime('now'))", [DEFAULT_FEEDS_MARKER]);
        await db.exec("INSERT INTO sources (name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt) VALUES ('Research feed','https://example.test','https://example.test/',datetime('now'),datetime('now')); INSERT INTO feeds (sourceId,name,feedUrl,watchdogInitializedAt,createdAt,updatedAt) VALUES (1,'Research feed','https://example.test/rss',datetime('now'),datetime('now'),datetime('now'));");
        for (const [index, title] of ['OpenAI research in Europe','Anthropic research report','Sponsored OpenAI research'].entries()) {
            await db.run("INSERT INTO articles (feedId,externalId,title,teaser,content,url,contentHash,publishedAt,fetchedAt,createdAt,updatedAt) VALUES (1,?,?,?,?,'https://example.test/article','fixture',datetime('now'),datetime('now'),datetime('now'),datetime('now'))", [String(index),title,'A local research summary.','Stored research article content.']);
        }
        await db.run("UPDATE articles SET publishedAt = datetime('now','-2 days') WHERE externalId = '0'");`);
    database(`await db.run('UPDATE feeds SET feedUrl = ?', ['http://127.0.0.1:${fixture.address().port}/rss']);`);
    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    env.PORT = String(socket.address().port); await new Promise(resolve => socket.close(resolve));
    backend = spawn(process.execPath, ['backend/server.js'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; backend.stdout.on('data', data => { output += data; }); backend.stderr.on('data', data => { output += data; });
    await waitFor(() => output.includes('NBS_DESKTOP_READY'), 'backend readiness');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const origin = `http://127.0.0.1:${env.PORT}`;
    const readingList = await (await page.request.post(`${origin}/api/lists`, { data: { name: 'Watchdog reading list' } })).json();
    await page.goto(origin);
    await page.locator('#view-main').waitFor({ state: 'visible' });
    await page.locator('[data-view="watchdog"]').click();
    await page.locator('#watchdog-new').click();
    const dialog = page.locator('#watchdog-dialog'); await dialog.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.id === 'watchdog-name');
    await page.locator('#watchdog-name').fill('AI research');
    await page.locator('#watchdog-any').fill('OpenAI\nAnthropic');
    await page.locator('#watchdog-all').fill('research');
    await page.locator('#watchdog-exclude').fill('sponsored');
    await page.locator('#watchdog-feeds input').check();
    await page.locator('#watchdog-history').check();
    await page.locator('#watchdog-save').click();
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('.watchdog-match').length === 2);
    assert.equal(await page.locator('#watchdog-nav-badge').textContent(), '2');
    assert.equal(await page.locator('.watchdog-match .oj-tag').first().textContent(), 'AI research');
    assert.equal(await page.locator('#watchdog-notifications').isDisabled(), true);
    assert.equal(await page.locator('#view-watchdog #watchdog-notifications').count(), 0);
    for (const [range, count] of [['24h', 1], ['7d', 2], ['month', 2], ['year', 2], ['all', 2]]) {
        await page.locator('#watchdog-range-filter').selectOption(range, { force: true });
        await page.waitForFunction(count => document.querySelector('#watchdog-results').getAttribute('aria-busy') === 'false' && document.querySelectorAll('.watchdog-match').length === count, count);
    }
    const expectedArticleIds = (await (await page.request.get(`${origin}/api/watchdogs/export`)).json()).map(article => article.id);
    for (const format of ['markdown', 'json', 'csv', 'links']) {
        await page.locator('#watchdog-export-trigger').click();
        const downloaded = page.waitForEvent('download');
        await page.locator(`#watchdog-export-popover [data-export-format="${format}"]`).click();
        const file = await downloaded;
        const content = await readFile(await file.path(), 'utf8');
        assert.match(file.suggestedFilename(), /^no-bullshit-rss-watchdog-/);
        if (format === 'json') {
            const payload = JSON.parse(content);
            assert.deepEqual(payload.articles.map(article => article.id), expectedArticleIds);
            assert.deepEqual(Object.keys(payload), ['exportedAt', 'filters', 'articles']);
            assert.deepEqual(Object.keys(payload.articles[0]), ['id', 'title', 'url', 'sourceName', 'publishedAt', 'topics', 'bullshit', 'bullshitRules']);
            assert.equal(payload.filters.watchdog.range, 'all');
        } else if (format === 'csv') assert.ok(content.startsWith('title,url,source,published_at,topics\r\n'));
        else if (format === 'markdown') assert.ok(content.startsWith('# Watchdog Export'));
        else assert.equal(content.trim().split('\n').length, 2);
    }
    await page.locator('[data-view="settings"]').click();
    assert.equal(await page.getByRole('tab', { name: 'RSS Feeds', exact: true }).count(), 1);
    await page.locator('#settings-notifications-tab').click();
    await page.waitForFunction(() => document.querySelector('#watchdog-notification-status').textContent.startsWith('Native notifications are available'));
    assert.equal(await page.locator('#watchdog-notifications').isDisabled(), true);
    await page.locator('[data-view="watchdog"]').click();
    await page.locator('.watchdog-all').click();
    await page.locator('.watchdog-rule .watchdog-rule-meta').click();
    await page.waitForFunction(() => document.querySelector('#watchdog-filter').value !== '');
    await page.locator('.watchdog-all').click();
    await page.locator('.watchdog-rule').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#watchdog-filter').value !== '');
    await page.locator('.watchdog-match .watchdog-match-meta').first().click();
    await page.locator('#watchdog-article-dialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#watchdog-article-content').textContent(), /Stored research/);
    await page.keyboard.press('Escape');
    await page.locator('#watchdog-article-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#watchdog-nav-badge').textContent === '1');
    await page.locator('.watchdog-match').first().focus();
    await page.keyboard.press('Space');
    await page.locator('#watchdog-article-dialog').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('#watchdog-article-dialog').waitFor({ state: 'hidden' });
    // Exercise the OJ dropdown with the keyboard, including its focus handling.
    await page.locator('#watchdog-status-filter-trigger').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitemradio');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.activeElement?.dataset.ojValue === 'unread');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#watchdog-status-filter').value === 'unread');
    await page.waitForFunction(() => document.querySelectorAll('.watchdog-match').length === 1);
    await page.locator('.watchdog-match [data-action="archive"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.watchdog-match').length === 0);
    await page.locator('#watchdog-archived').check();
    await page.waitForFunction(() => document.querySelectorAll('.watchdog-match').length === 1);
    await page.locator('.watchdog-match [data-action="archive"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.watchdog-match').length === 0);
    await page.locator('#watchdog-archived').uncheck();
    await page.waitForFunction(() => document.querySelectorAll('.watchdog-match').length === 1);
    await page.locator('#watchdog-rules [data-action="edit"]').click();
    await dialog.waitFor({ state: 'visible' });
    await page.locator('#watchdog-name').fill('AI research radar');
    assert.equal(await page.locator('#watchdog-history-row').isVisible(), false);
    await page.locator('#watchdog-save').click(); await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('.watchdog-rule-name')?.textContent === 'AI research radar');
    await page.locator('#watchdog-rules [data-action="toggle"]').click();
    await page.waitForFunction(() => document.querySelector('.watchdog-rule-meta')?.textContent.includes('Paused'));
    await page.locator('#watchdog-rules [data-action="toggle"]').click();
    await page.waitForFunction(() => document.querySelector('.watchdog-rule-meta')?.textContent.includes('Active'));
    // The existing RSS fetch delivers a new article and the real SSE update.
    await page.evaluate(async () => { await fetch('/api/fetch/run', { method: 'POST' }); });
    await page.waitForFunction(() => [...document.querySelectorAll('.watchdog-match-title')].some(node => node.textContent === 'OpenAI live research'), { timeout: 45_000 });
    const rows = await (await page.request.get(`${origin}/api/watchdogs/matches`)).json();
    const target = rows.matches.find(row => row.title === 'OpenAI live research');
    assert.ok(target);
    await page.goto(`${origin}/#watchdog/${target.id}`);
    await page.waitForFunction(() => document.querySelector('#watchdog-article-dialog')?.open);
    assert.equal(await page.locator('#watchdog-article-title').textContent(), 'OpenAI live research');
    await page.keyboard.press('Escape');
    await page.locator('#watchdog-article-dialog').waitFor({ state: 'hidden' });
    await page.locator('#watchdog-status-filter').selectOption('all', { force: true });
    await page.waitForFunction(() => document.querySelector('#watchdog-results').getAttribute('aria-busy') === 'false' && document.querySelectorAll('.watchdog-match').length === 3);
    const outputDirectory = path.join(root, '.desktop-cache/watchdog-qa'); await mkdir(outputDirectory, { recursive: true });
    await page.locator('.oj-toast-dismiss').evaluateAll(nodes => nodes.forEach(node => node.click()));
    // Fill the article pane with layout fixtures cloned from a real match. Only
    // that pane should move when paging through a long list with the keyboard.
    for (const viewport of [{ width: 1440, height: 1050 }, { width: 800, height: 600 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await page.evaluate(() => {
            const list = document.querySelector('#watchdog-matches');
            for (let index = 0; index < 20; index++) {
                const fixture = list.firstElementChild.cloneNode(true);
                fixture.dataset.scrollFixture = 'true'; list.append(fixture);
            }
        });
        const positions = () => page.evaluate(() => {
            const inbox = document.querySelector('#watchdog-inbox');
            return {
                page: window.scrollY,
                filters: document.querySelector('.watchdog-filters').getBoundingClientRect().top,
                sidebar: document.querySelector('.watchdog-sidebar').getBoundingClientRect().top,
                inboxHeight: inbox.clientHeight,
                inboxBottom: inbox.getBoundingClientRect().bottom,
                scrollTop: inbox.scrollTop,
            };
        });
        const before = await positions();
        assert.ok(before.inboxHeight > 100, `Article pane too short at ${viewport.width}x${viewport.height}: ${before.inboxHeight}px`);
        assert.ok(before.inboxBottom <= viewport.height, 'Article pane extends beyond the window');
        await page.locator('#watchdog-inbox').focus();
        await page.keyboard.press('PageDown');
        await page.waitForFunction(() => document.querySelector('#watchdog-inbox').scrollTop > 0, null, { timeout: 3000 }).catch(async error => {
            const metrics = await page.evaluate(() => {
                const inbox = document.querySelector('#watchdog-inbox');
                return { focused: document.activeElement?.id, scrollHeight: inbox.scrollHeight, clientHeight: inbox.clientHeight, matches: document.querySelectorAll('.watchdog-match').length };
            });
            throw new Error(`Article scrolling failed at ${viewport.width}x${viewport.height}: ${JSON.stringify(metrics)}`, { cause: error });
        });
        const after = await positions();
        assert.equal(after.page, 0, 'The page scrolled instead of the article list');
        assert.equal(after.filters, before.filters, 'Filters moved with the articles');
        assert.equal(after.sidebar, before.sidebar, 'Watchdog selection moved with the articles');
        await page.screenshot({ path: path.join(outputDirectory, `watchdog-scroll-${viewport.width}.png`) });
        await page.evaluate(() => {
            document.querySelectorAll('[data-scroll-fixture]').forEach(node => node.remove());
            document.querySelector('#watchdog-inbox').scrollTop = 0;
        });
    }
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.locator('.oj-toast-dismiss').evaluateAll(nodes => nodes.forEach(node => node.click()));
    await page.screenshot({ path: path.join(outputDirectory, 'watchdog-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(outputDirectory, 'watchdog-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile layout overflows');
    await page.locator('#watchdog-new').click(); await dialog.waitFor({ state: 'visible' });
    await page.locator('#watchdog-name').focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('#watchdog-dialog'))), true, 'Dialog focus escaped');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await page.locator('#watchdog-rules [data-action="delete"]').click();
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await page.waitForFunction(() => document.querySelectorAll('.watchdog-rule').length === 0);

    // Real paginated data: a state mutation and its SSE event must retain every
    // loaded page, the oldest-page cursor and the reader's scroll position.
    database(`await db.transaction(async () => {
        for (let index = 0; index < 175; index++) await db.run("INSERT INTO articles (feedId,externalId,title,contentHash,publishedAt,fetchedAt,createdAt,updatedAt) VALUES (1,?,?,'pagination',datetime('now'),datetime('now'),datetime('now'),datetime('now'))", ['pagination-' + index, 'Pagination fixture ' + index]);
    });`);
    const pagingRule = await (await page.request.post(`${origin}/api/watchdogs`, { data: { name: 'Pagination', includeAny: ['Pagination fixture'], includeHistory: true } })).json();
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.locator(`[data-watchdog-id="${pagingRule.watchdog.id}"] .watchdog-rule-meta`).click();
    await page.waitForFunction(() => document.querySelectorAll('.watchdog-match').length === 50 && document.querySelector('#watchdog-results').getAttribute('aria-busy') === 'false');
    let releaseAppend, heldAppend;
    const holdAppend = async route => {
        if (new URL(route.request().url()).searchParams.has('before') && !heldAppend) {
            heldAppend = route.request();
            await new Promise(resolve => { releaseAppend = resolve; });
        }
        await route.continue();
    };
    await page.route('**/api/watchdogs/matches?*', holdAppend);
    await page.locator('#watchdog-more').click();
    await waitFor(() => Boolean(releaseAppend), 'held Load more request');
    try {
        await page.request.patch(`${origin}/api/watchdogs/${pagingRule.watchdog.id}`, { data: { name: 'Pagination during Load more' } });
        await page.waitForFunction(() => document.querySelectorAll('.watchdog-match').length === 100 && document.querySelector('#watchdog-results').getAttribute('aria-busy') === 'false');
        const oldAppendFinished = page.waitForResponse(response => response.request() === heldAppend);
        releaseAppend();
        await oldAppendFinished;
    } finally { releaseAppend?.(); await page.unroute('**/api/watchdogs/matches?*', holdAppend); }
    assert.equal(await page.locator('.watchdog-match').count(), 100, 'Live refresh lost the requested second page');
    const selectedMatchId = await page.locator('.watchdog-match').nth(99).getAttribute('data-match-id');
    const selectedMatch = await (await page.request.get(`${origin}/api/watchdogs/matches/${selectedMatchId}`)).json();
    assert.notEqual(selectedMatch.articleId, selectedMatch.id, 'List regression fixture must distinguish article IDs from match IDs');
    const selectedCard = page.locator(`[data-match-id="${selectedMatchId}"]`);
    await selectedCard.locator('[data-action="list"]').click();
    await page.locator('#modal-backdrop').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#watchdog-article-dialog').isVisible(), false);
    assert.equal(await selectedCard.evaluate(card => card.classList.contains('is-unread')), true);
    await page.locator('#modal-list-select').selectOption(String(readingList.id), { force: true });
    await page.locator('#modal-confirm').click();
    await page.locator('#modal-backdrop').waitFor({ state: 'hidden' });
    const membership = await (await page.request.post(`${origin}/api/articles/lists/bulk`, { data: { articleIds: [selectedMatch.articleId, selectedMatch.id] } })).json();
    assert.equal(membership.listsByArticleId[String(selectedMatch.articleId)][0].id, readingList.id);
    assert.deepEqual(membership.listsByArticleId[String(selectedMatch.id)] || [], []);
    await selectedCard.locator('[data-action="list"]').click();
    await page.locator('#modal-backdrop').waitFor({ state: 'visible' });
    assert.match(await page.locator('#modal-existing-lists').textContent(), /Watchdog reading list/);
    await page.locator('#modal-cancel').click();
    await page.locator('#modal-backdrop').waitFor({ state: 'hidden' });

    const beforeReadIds = await page.locator('.watchdog-match').evaluateAll(cards => cards.map(card => card.dataset.matchId));
    await selectedCard.locator('[data-action="read"]').scrollIntoViewIfNeeded();
    const beforeReadScroll = await page.locator('#watchdog-inbox').evaluate(inbox => inbox.scrollTop);
    await selectedCard.locator('[data-action="read"]').click();
    await page.waitForFunction(id => document.querySelector(`[data-match-id="${id}"] [data-action="read"]`)?.textContent === 'Mark unread', selectedMatchId);
    assert.deepEqual(await page.locator('.watchdog-match').evaluateAll(cards => cards.map(card => card.dataset.matchId)), beforeReadIds);
    assert.equal(await page.locator('#watchdog-more').isVisible(), true);
    assert.ok(Math.abs(await page.locator('#watchdog-inbox').evaluate(inbox => inbox.scrollTop) - beforeReadScroll) < 2, 'Mark read moved the inbox');
    await page.locator('#watchdog-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.watchdog-match').length === 150);
    await page.locator('#watchdog-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.watchdog-match').length === 175);
    assert.equal(await page.locator('#watchdog-more').isVisible(), false);
    const lastMatchId = await page.locator('.watchdog-match').last().getAttribute('data-match-id');
    await page.locator(`[data-match-id="${lastMatchId}"] [data-action="read"]`).click();
    await page.waitForFunction(id => document.querySelector(`[data-match-id="${id}"] [data-action="read"]`)?.textContent === 'Mark unread', lastMatchId);
    assert.equal(await page.locator('.watchdog-match').count(), 175, 'Last-page mutation collapsed pagination');

    // An explicit live refresh must also preserve the loaded depth.
    await page.request.patch(`${origin}/api/watchdogs/${pagingRule.watchdog.id}`, { data: { name: 'Pagination updated' } });
    await page.waitForFunction(() => document.querySelector('.watchdog-rule-name')?.textContent === 'Pagination updated' && document.querySelector('#watchdog-results').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('.watchdog-match').count(), 175);
    await page.locator('#watchdog-status-filter').selectOption('unread', { force: true });
    await page.waitForFunction(() => document.querySelectorAll('.watchdog-match').length === 50 && document.querySelector('#watchdog-results').getAttribute('aria-busy') === 'false');
    const unreadId = await page.locator('.watchdog-match').first().getAttribute('data-match-id');
    await page.locator(`[data-match-id="${unreadId}"] [data-action="read"]`).click();
    await page.waitForFunction(id => !document.querySelector(`[data-match-id="${id}"]`), unreadId);
    assert.equal(await page.locator('#watchdog-more').isVisible(), true, 'Unread removal hid the next page');
    await page.request.delete(`${origin}/api/watchdogs/${pagingRule.watchdog.id}`);
    await page.waitForFunction(() => document.querySelectorAll('.watchdog-rule').length === 0);
    assert.deepEqual(errors, []);
    // Exercise the actual permission UI and HTTP persistence with a native IPC
    // boundary stub. The browser must never request real OS permissions.
    const desktop = await browser.newPage();
    await desktop.addInitScript(() => {
        window.permissionResult = 'granted';
        window.permissionError = null;
        window.permissionCalls = [];
        window.__TAURI__ = { core: { invoke: async (command, args) => {
            if (command !== 'watchdog_notification_permission') return null;
            window.permissionCalls.push(args);
            if (window.permissionError) throw window.permissionError;
            return window.permissionResult;
        } } };
    });
    await desktop.goto(origin);
    await desktop.locator('#view-main').waitFor({ state: 'visible' });
    await desktop.locator('[data-view="settings"]').click();
    await desktop.locator('#settings-notifications-tab').click();
    const enable = desktop.locator('#watchdog-notifications');
    const status = desktop.locator('#watchdog-notification-status');
    await desktop.waitForFunction(() => document.querySelector('#watchdog-notification-status').textContent.startsWith('Notifications are off.') && document.querySelector('#watchdog-notifications').dataset.enabled === 'false');
    await desktop.screenshot({ path: path.join(outputDirectory, 'watchdog-settings-notifications.png'), fullPage: true });
    await desktop.evaluate(() => { window.permissionCalls = []; });
    const preference = async () => (await (await page.request.get(`${origin}/api/watchdogs/notifications`)).json()).enabled;
    async function allowNotifications(expectedStatus) {
        await enable.click();
        await desktop.locator('dialog[open]').getByRole('button', { name: 'Allow notifications', exact: true }).click();
        await desktop.waitForFunction(expected => document.querySelector('#watchdog-notification-status').textContent.startsWith(expected), expectedStatus);
        await desktop.waitForFunction(() => !document.querySelector('#watchdog-notifications').disabled);
    }
    // Cancelling consent never requests OS authorization (read-only status
    // queries may still complete while the view finishes initializing).
    await enable.click();
    await desktop.getByRole('button', { name: 'Not now', exact: true }).click();
    assert.deepEqual(await desktop.evaluate(() => window.permissionCalls.filter(call => call.request)), []);
    for (const [nativeResult, nativeError, expected] of [
        ['granted', 'Native permission command rejected', 'Native permission command rejected'],
        ['denied', null, 'Notifications denied.'],
        ['unavailable', null, 'macOS notification permissions are unavailable.'],
    ]) {
        await desktop.evaluate(({ nativeResult, nativeError }) => {
            window.permissionResult = nativeResult; window.permissionError = nativeError;
        }, { nativeResult, nativeError });
        await allowNotifications(expected);
        assert.ok((await status.textContent()).startsWith(expected));
        assert.equal(await preference(), false, 'Failed authorization must not enable notifications');
    }
    await desktop.evaluate(() => { window.permissionResult = 'granted'; window.permissionCalls = []; });
    await desktop.route('**/api/watchdogs/notifications', route => route.request().method() === 'PATCH'
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Could not save notification preference' }) })
        : route.continue());
    await allowNotifications('Could not save notification preference');
    assert.equal(await status.textContent(), 'Could not save notification preference');
    assert.equal(await preference(), false);
    await desktop.unroute('**/api/watchdogs/notifications');
    await desktop.evaluate(() => { window.permissionCalls = []; });
    await allowNotifications('Notifications enabled.');
    assert.equal(await preference(), true);
    assert.equal(await enable.textContent(), 'Disable notifications');
    assert.match(await status.textContent(), /^Notifications enabled/);
    assert.deepEqual(await desktop.evaluate(() => window.permissionCalls), [{ request: true }], 'Granting permission must not immediately invoke native permission again');
    // A previously saved preference can outlive macOS permission state. The UI
    // must offer authorization again instead of reporting that banners work.
    await desktop.evaluate(() => { window.permissionResult = 'prompt'; });
    await desktop.locator('[data-view="main"]').click();
    await desktop.locator('[data-view="settings"]').click();
    await desktop.waitForFunction(() => document.querySelector('#watchdog-notification-status').textContent.startsWith('macOS permission is missing.'));
    assert.equal(await enable.textContent(), 'Allow notifications');
    assert.equal(await preference(), true);
    await desktop.evaluate(() => { window.permissionResult = 'granted'; window.permissionCalls = []; });
    await allowNotifications('Notifications enabled.');
    assert.equal(await preference(), true);
    assert.deepEqual(await desktop.evaluate(() => window.permissionCalls), [{ request: true }]);
    await enable.click();
    await waitFor(async () => !await preference(), 'disable notifications');
    await desktop.evaluate(() => { window.permissionResult = 'unavailable'; });
    await desktop.locator('[data-view="main"]').click();
    await desktop.locator('[data-view="settings"]').click();
    await desktop.waitForFunction(() => document.querySelector('#watchdog-notifications').disabled);
    assert.match(await status.textContent(), /^Notifications require the bundled macOS app/);
    await desktop.close();
    console.log('Watchdog browser smoke passed: CRUD, matching/history, SSE, time filters, Feed-schema exports, full-card activation, read/archive, 175-match pagination and scroll preservation, Add to list with real article IDs, RSS Feeds tab, deep links, responsive keyboard scrolling, and Settings notification flows. Screenshots: .desktop-cache/watchdog-qa/.');
} finally {
    await browser?.close();
    if (backend) { backend.stdin.end(); await Promise.race([once(backend, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]); if (backend.exitCode === null) backend.kill(); }
    if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
}
