import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-rankings-ui-'));
const screenshots = await mkdtemp('/tmp/rss-rankings-qa-');
const env = { ...process.env, DB_PATH: path.join(directory, 'fixture.db'), TOPIC_RULES_FILE_PATH: path.join(directory, 'topics.json'), SERVER_LOG_PATH: path.join(directory, 'server.log'), DISABLE_SCHEDULER: '1', HOST: '127.0.0.1', DESKTOP_PARENT_WATCHDOG: '1' };
let backend, browser;
const url = 'https://www.golem.de/news/rankings-ui-fixture.html';
const unmatchedUrl = 'https://www.golem.de/news/unmatched-ui-fixture.html';

async function waitFor(condition, label) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}`);
}

try {
    const fixture = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const db = await import('./backend/database/datenbank.js');
        const { DEFAULT_FEEDS_MARKER } = await import('./scripts/default-feeds.js');
        const { DEFAULT_BULLSHIT_RULES_MARKER } = await import('./scripts/default-bullshit-rules.js');
        const { ensureTopicDefinitionsInitialized } = await import('./backend/services/topics.js');
        const { saveMostReadSnapshot } = await import('./backend/services/most-read.js');
        await db.initSchema();
        for (const marker of [DEFAULT_FEEDS_MARKER, DEFAULT_BULLSHIT_RULES_MARKER]) await db.run("INSERT INTO app_metadata (key,value,updatedAt) VALUES (?, '1', datetime('now'))", [marker]);
        await ensureTopicDefinitionsInitialized();
        await db.exec("INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt) VALUES (1,'Golem','https://www.golem.de/','https://www.golem.de/',datetime('now'),datetime('now')); INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt) VALUES (1,1,'Golem RSS','https://rss.golem.de/fixture',datetime('now'),datetime('now'));");
        const article = await db.run("INSERT INTO articles (feedId,externalId,title,teaser,content,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt) VALUES (1,'rankings-ui','RSS fixture headline','Actual RSS teaser for the ranking card.','Actual stored RSS article body.',?,?,'fixture',datetime('now'),datetime('now'),datetime('now'),datetime('now'))", [${JSON.stringify(url)}, ${JSON.stringify(url)}]);
        const second = await db.run("INSERT INTO articles (feedId,externalId,title,teaser,content,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt) VALUES (1,'rankings-ui-second','Second RSS fixture headline','Second stored RSS teaser.','Second article body.',?,?,'fixture',datetime('now'),datetime('now'),datetime('now'),datetime('now'))", [${JSON.stringify(`${url}?id=second`)}, ${JSON.stringify(`${url}?id=second`)}]);
        const topic = await db.get('SELECT id,slug FROM topics ORDER BY id LIMIT 1');
        await db.run("INSERT INTO article_topics (articleId,topicId,score,classificationVersion,createdAt) VALUES (?,?,10,'fixture',datetime('now'))", [article.lastID,topic.id]);
        await saveMostReadSnapshot({ sourceId: 1, capturedAt: new Date().toISOString(), rankings: {
            most_read: [{ canonicalUrl: ${JSON.stringify(url)}, title: 'Publisher ranking headline', rank: 1 }, { canonicalUrl: ${JSON.stringify(`${url}?id=second`)}, title: 'Second publisher headline', rank: 2 }, { canonicalUrl: ${JSON.stringify(unmatchedUrl)}, title: 'Unmatched publisher headline', rank: 3 }],
            most_commented: [{ canonicalUrl: ${JSON.stringify(url)}, title: 'Publisher ranking headline', rank: 1 }]
        } });
        console.log(JSON.stringify({ articleId: article.lastID, secondArticleId: second.lastID, topicSlug: topic.slug }));
        await db.closeDatabase();
    `], { cwd: root, env, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    const { articleId, secondArticleId, topicSlug } = JSON.parse(fixture.stdout.trim().split('\n').at(-1));
    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    env.PORT = String(socket.address().port); await new Promise(resolve => socket.close(resolve));
    backend = spawn(process.execPath, ['backend/server.js'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    backend.stdout.on('data', value => { output += value; });
    backend.stderr.on('data', value => { output += value; });
    await waitFor(() => output.includes('NBS_DESKTOP_READY') || backend.exitCode !== null, 'fixture readiness');
    assert.equal(backend.exitCode, null, output);
    const origin = `http://127.0.0.1:${env.PORT}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
        if (route.request().url().startsWith(origin)) return route.continue();
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Isolated ranking article viewer fixture.</body></html>' });
    });
    await page.addInitScript(() => { window.openedFixtureUrls = []; window.open = url => { window.openedFixtureUrls.push(String(url)); return null; }; });
    const list = await (await page.request.post(`${origin}/api/lists`, { data: { name: 'Ranking reading list' } })).json();
    await page.goto(origin);
    await page.locator('[data-view="rankings"]').click();
    const cards = page.locator('#publisher-rankings .feed-card');
    const matched = () => page.locator(`#publisher-rankings .feed-card[data-article-id="${articleId}"]`);
    const unmatched = page.locator('#publisher-rankings .feed-card:not([data-article-id])');
    await waitFor(async () => await cards.count() === 4, 'ranked Feed cards');
    assert.equal(await matched().count(), 2);
    assert.equal(await matched().first().locator('.article-title-button').textContent(), 'RSS fixture headline');
    assert.equal(await matched().first().locator('.teaser').textContent(), 'Actual RSS teaser for the ranking card.');
    assert.equal(await unmatched.locator('.teaser').isVisible(), false);
    assert.equal(await unmatched.locator('.article-save-btn').isDisabled(), true);
    assert.equal(await unmatched.locator('.article-dismiss-btn').isDisabled(), true);
    assert.deepEqual(await page.locator('.publisher-ranking-title').allTextContents(), ['Most read', 'Most commented']);
    assert.equal(await page.locator('.publisher-rankings-note, .publisher-rankings-title, #rankings-header p').count(), 0);

    await matched().first().locator('.article-title-button').click();
    await page.locator('#rankings-article-viewer').waitFor({ state: 'visible' });
    await page.frameLocator('#rankings-article-viewer-frame').getByText('Isolated ranking article viewer fixture.').waitFor();
    await page.locator('#rankings-article-viewer-hide').click();
    await unmatched.locator('.article-title-button').click();
    await unmatched.locator('.btn-open-external').click();
    assert.deepEqual(await page.evaluate(() => window.openedFixtureUrls), [unmatchedUrl, unmatchedUrl]);

    await matched().first().locator('.article-save-btn').click();
    await page.locator('#modal-backdrop').waitFor({ state: 'visible' });
    await page.locator('#modal-list-select').selectOption(String(list.id), { force: true });
    await page.locator('#modal-confirm').click();
    await waitFor(async () => await page.locator('#publisher-rankings .article-save-btn.is-saved').count() === 2, 'saved badge in both ranking groups');
    assert.equal((await (await page.request.get(`${origin}/api/articles/${articleId}/lists`)).json())[0].id, list.id);
    await matched().first().locator('.article-save-btn').click();
    await page.locator('#modal-backdrop').waitFor({ state: 'visible' });
    await page.locator('#modal-existing-lists [data-action="remove-list"]').click();
    await waitFor(async () => await page.locator('#publisher-rankings .article-save-btn.is-saved').count() === 0, 'removed list membership');
    await page.locator('#modal-cancel').click();

    await matched().first().locator('[data-action="filter-topic"]').click();
    await page.locator('#view-main').waitFor({ state: 'visible' });
    await page.waitForFunction(slug => document.querySelector('#filter-topic').value === slug, topicSlug);
    await page.locator('[data-view="rankings"]').click();
    await matched().first().locator('[data-action="filter-source"]').click();
    await page.locator('#view-main').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#filter-source').inputValue(), '1');
    await page.locator('[data-view="rankings"]').click();

    await matched().first().locator('.article-dismiss-btn').click();
    await waitFor(async () => await matched().count() === 0, 'dismissed RSS card removed from both groups');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await waitFor(async () => await matched().count() === 2, 'dismiss Undo restores both groups');

    let failFirstDismiss;
    const firstDismissFailure = new Promise(resolve => { failFirstDismiss = resolve; });
    const dismissalUrl = `**/api/articles/${articleId}/dismissed`;
    await page.route(dismissalUrl, async route => {
        if (route.request().postDataJSON().dismissed) {
            await firstDismissFailure;
            return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated dismissal failure' }) });
        }
        return route.continue();
    });
    await matched().first().locator('.article-dismiss-btn').click();
    await page.locator(`#publisher-rankings .feed-card[data-article-id="${secondArticleId}"] .article-dismiss-btn`).click();
    await waitFor(async () => {
        const current = await (await page.request.get(`${origin}/api/rankings?medium=golem`)).json();
        return !current.rankings.some(group => group.items.some(item => item.articleId === secondArticleId));
    }, 'second dismissal committed while the first request is pending');
    failFirstDismiss();
    await waitFor(async () => await matched().count() === 2, 'failed first dismissal reloaded from current server state');
    assert.equal(await page.locator(`#publisher-rankings .feed-card[data-article-id="${secondArticleId}"]`).count(), 0, 'Failed first dismissal must not restore the successful second dismissal');
    await page.unroute(dismissalUrl);
    await page.request.patch(`${origin}/api/articles/${secondArticleId}/dismissed`, { data: { dismissed: false } });
    await page.locator('[data-view="rankings"]').click();
    await waitFor(async () => await cards.count() === 4, 'restored second fixture article');
    await page.locator('.oj-toast-dismiss').evaluateAll(buttons => buttons.forEach(button => button.click()));
    const savedPayload = await (await page.request.get(`${origin}/api/rankings?medium=golem`)).json();
    await page.route('**/api/rankings/refresh', route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ ...savedPayload, error: 'Refresh failed', rankingStatus: { state: 'error' } }) }));
    await page.locator('#rankings-refresh').click();
    await page.waitForFunction(() => document.querySelector('#rankings-refresh').textContent.includes('Retry refresh'));
    assert.equal(await page.locator('.publisher-rankings-status').isVisible(), false);
    assert.equal(await cards.count(), 4);

    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['narrow', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${name} horizontal overflow`);
        const medium = await page.locator('#rankings-medium-trigger').boundingBox();
        const refresh = await page.locator('#rankings-refresh').boundingBox();
        assert.ok(medium.x + medium.width <= refresh.x + 1 || refresh.x + refresh.width <= medium.x + 1
            || medium.y + medium.height <= refresh.y + 1 || refresh.y + refresh.height <= medium.y + 1, `${name} medium and refresh controls overlap`);
        await page.screenshot({ path: path.join(screenshots, `rankings-${name}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log(`Ranking browser fixture passed: RSS Feed cards, stored metadata, viewer, matched save/list/remove/dismiss/Undo/filter flows, unmatched links, quiet errors and responsive layout. Screenshots: ${screenshots}`);
} finally {
    await browser?.close();
    if (backend && backend.exitCode === null) {
        const exited = once(backend, 'exit'); backend.stdin.end();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
        if (backend.exitCode === null) backend.kill();
    }
    await rm(directory, { recursive: true, force: true });
}
