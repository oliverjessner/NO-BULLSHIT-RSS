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
const winFutureUrl = 'https://winfuture.de/news,162334.html';
const computerBaseUrl = 'https://www.computerbase.de/news/pc-systeme/computerbase-fixture.12345/';
const heiseIxUrl = 'https://www.heise.de/ix/news/heise-ix-fixture-12345.html';
const t3nUrl = 'https://t3n.de/news/t3n-fixture-1234567/';
const techCrunchUrl = 'https://techcrunch.com/2026/11/01/techcrunch-fixture/';
const techCrunchSelection = Array.from({ length: 5 }, (_, index) => ({
    canonicalUrl: index ? `https://techcrunch.com/2026/11/01/techcrunch-fixture-${index + 1}/` : techCrunchUrl,
    title: `TechCrunch editorial fixture headline ${index + 1}`, rank: index + 1,
}));
const historyProviders = [
    { sourceId: 1, name: 'Golem', keys: ['most_read', 'most_commented'], prefix: 'https://www.golem.de/news/mixed-history-', suffix: '.html' },
    { sourceId: 2, name: 'WinFuture', keys: ['most_read', 'most_commented'], prefix: 'https://winfuture.de/news,9100', suffix: '.html' },
    { sourceId: 3, name: 'ComputerBase', keys: ['most_read'], prefix: 'https://www.computerbase.de/news/pc-systeme/mixed-history.9200', suffix: '/' },
    { sourceId: 5, name: 'heise iX', keys: ['top_news'], prefix: 'https://www.heise.de/ix/news/mixed-history-9300', suffix: '.html' },
    { sourceId: 6, name: 't3n', keys: ['most_read'], prefix: 'https://t3n.de/news/mixed-history-9400', suffix: '/' },
    { sourceId: 7, name: 'TechCrunch', keys: ['top_news'], prefix: 'https://techcrunch.com/2025/12/31/mixed-history-', suffix: '/' },
];
const watermarkUrl = 'https://www.golem.de/news/new-watermark-ui-fixture.html';

async function waitFor(condition, label) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}`);
}

function mutateFixture(code) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const db = await import('./backend/database/datenbank.js');
        ${code}
        await db.closeDatabase();
    `], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
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
        await db.exec("INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt) VALUES (2,'WinFuture','https://winfuture.de/','https://winfuture.de/',datetime('now'),datetime('now')); INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt) VALUES (2,2,'WinFuture RSS','https://static.winfuture.de/fixture',datetime('now'),datetime('now'));");
        const winfuture = await db.run("INSERT INTO articles (feedId,externalId,title,teaser,content,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt) VALUES (2,'winfuture-ui','WinFuture RSS fixture headline','WinFuture stored teaser.','WinFuture article body.',?,?,'fixture',datetime('now'),datetime('now'),datetime('now'),datetime('now'))", [${JSON.stringify(winFutureUrl)}, ${JSON.stringify(winFutureUrl)}]);
        await saveMostReadSnapshot({ sourceId: 2, capturedAt: new Date().toISOString(), rankings: {
            most_read: [{ canonicalUrl: ${JSON.stringify(winFutureUrl)}, title: 'WinFuture publisher headline', rank: 1 }],
            most_commented: [{ canonicalUrl: ${JSON.stringify(winFutureUrl)}, title: 'WinFuture publisher headline', rank: 1 }]
        } });
        await db.exec("INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt) VALUES (3,'ComputerBase','https://www.computerbase.de/','https://www.computerbase.de/',datetime('now'),datetime('now')); INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt) VALUES (3,3,'ComputerBase RSS','https://www.computerbase.de/rss/news.xml',datetime('now'),datetime('now'));");
        await db.run("INSERT INTO articles (feedId,externalId,title,teaser,content,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt) VALUES (3,'computerbase-ui','ComputerBase RSS fixture headline','ComputerBase stored RSS teaser.','ComputerBase article body.',?,?,'fixture',datetime('now'),datetime('now'),datetime('now'),datetime('now'))", [${JSON.stringify(computerBaseUrl)}, ${JSON.stringify(computerBaseUrl)}]);
        await saveMostReadSnapshot({ sourceId: 3, capturedAt: new Date().toISOString(), rankings: {
            most_read: [{ canonicalUrl: ${JSON.stringify(computerBaseUrl)}, title: 'ComputerBase publisher headline', rank: 1 }]
        } });
        await db.exec("INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt) VALUES (4,'Generic Heise','https://www.heise.de/','https://www.heise.de/',datetime('now'),datetime('now')), (5,'heise iX','https://www.heise.de/ix/','https://www.heise.de/ix/',datetime('now'),datetime('now')); INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt) VALUES (4,4,'Generic Heise RSS','https://www.heise.de/rss/heise-atom.xml',datetime('now'),datetime('now')), (5,5,'heise iX RSS','https://www.heise.de/ix/feed.xml',datetime('now'),datetime('now'));");
        await db.run("INSERT INTO articles (feedId,externalId,title,teaser,content,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt) VALUES (5,'heise-ix-ui','heise iX RSS fixture headline','heise iX stored RSS teaser.','heise iX article body.',?,?,'fixture',datetime('now'),datetime('now'),datetime('now'),datetime('now'))", [${JSON.stringify(heiseIxUrl)}, ${JSON.stringify(heiseIxUrl)}]);
        await saveMostReadSnapshot({ sourceId: 5, capturedAt: new Date().toISOString(), rankings: {
            top_news: [{ canonicalUrl: ${JSON.stringify(heiseIxUrl)}, title: 'heise iX editorial headline', rank: 1 }]
        } });
        await db.exec("INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt) VALUES (6,'t3n','https://t3n.de/','https://t3n.de/',datetime('now'),datetime('now')); INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt) VALUES (6,6,'t3n RSS','https://t3n.de/rss.xml',datetime('now'),datetime('now'));");
        await db.run("INSERT INTO articles (feedId,externalId,title,teaser,content,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt) VALUES (6,'t3n-ui','t3n RSS fixture headline','t3n stored RSS teaser.','t3n article body.',?,?,'fixture',datetime('now'),datetime('now'),datetime('now'),datetime('now'))", [${JSON.stringify(t3nUrl)}, ${JSON.stringify(t3nUrl)}]);
        await saveMostReadSnapshot({ sourceId: 6, capturedAt: new Date().toISOString(), rankings: {
            most_read: [{ canonicalUrl: ${JSON.stringify(t3nUrl)}, title: 't3n publisher headline', rank: 1 }]
        } });
        await db.exec("INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt) VALUES (7,'TechCrunch','https://techcrunch.com/','https://techcrunch.com/',datetime('now'),datetime('now')); INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt) VALUES (7,7,'TechCrunch RSS','https://techcrunch.com/feed/',datetime('now'),datetime('now'));");
        await db.run("INSERT INTO articles (feedId,externalId,title,teaser,content,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt) VALUES (7,'techcrunch-ui','TechCrunch RSS fixture headline','TechCrunch stored RSS teaser.','TechCrunch article body.',?,?,'fixture',datetime('now'),datetime('now'),datetime('now'),datetime('now'))", [${JSON.stringify(techCrunchUrl)}, ${JSON.stringify(techCrunchUrl)}]);
        await db.run("INSERT INTO articles (feedId,externalId,title,teaser,content,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt) VALUES (7,'techcrunch-unranked','TechCrunch unranked latest RSS headline','Unranked RSS teaser.','Unranked article body.','https://techcrunch.com/2026/11/01/unranked-latest-rss/','https://techcrunch.com/2026/11/01/unranked-latest-rss/','fixture',datetime('now'),datetime('now'),datetime('now'),datetime('now'))");
        await saveMostReadSnapshot({ sourceId: 7, capturedAt: new Date().toISOString(), rankings: {
            top_news: ${JSON.stringify(techCrunchSelection)}
        } });
        const historyProviders = ${JSON.stringify(historyProviders)};
        for (const [providerIndex, provider] of historyProviders.entries()) {
            const entries = [];
            for (let index = 1; index <= 14; index += 1) {
                const canonicalUrl = provider.prefix + index + provider.suffix;
                const title = 'Mixed ' + provider.name + ' RSS article ' + index;
                const publishedAt = new Date(Date.UTC(2025, 11, 31, 23, 59 - ((index - 1) * 6 + providerIndex))).toISOString();
                await db.run("INSERT INTO articles (feedId,externalId,title,teaser,content,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,'mixed-fixture',?,datetime('now'),datetime('now'),datetime('now'))", [provider.sourceId, 'mixed-' + provider.sourceId + '-' + index, title, 'Stored mixed RSS teaser from ' + provider.name + '.', 'Stored mixed RSS article body.', canonicalUrl, canonicalUrl, publishedAt]);
                entries.push({ canonicalUrl, title: 'Historical publisher title ' + index, rank: index });
            }
            if (provider.sourceId === 1) entries.push({ canonicalUrl: ${JSON.stringify(url)}, title: 'Older duplicate of the current Golem article', rank: 15 });
            await saveMostReadSnapshot({ sourceId: provider.sourceId, capturedAt: '2026-01-01T00:00:00.000Z', rankings: Object.fromEntries(provider.keys.map(key => [key, entries])) });
        }
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
    await page.addInitScript(() => {
        window.openedFixtureUrls = [];
        window.open = url => { window.openedFixtureUrls.push(String(url)); return null; };
        // Retain native observers for the rest of the app, but let this fixture
        // trigger ranking pagination without viewport timing or click scrolling.
        const NativeIntersectionObserver = window.IntersectionObserver;
        const observers = [];
        window.IntersectionObserver = class extends NativeIntersectionObserver {
            constructor(callback, options) {
                super(callback, options);
                this.fixtureCallback = callback;
                this.fixtureTargets = new Set();
                observers.push(this);
            }
            observe(target) { this.fixtureTargets.add(target); if (target.id !== 'rankings-load-more') super.observe(target); }
            unobserve(target) { this.fixtureTargets.delete(target); super.unobserve(target); }
            disconnect() { this.fixtureTargets.clear(); super.disconnect(); }
        };
        window.triggerRankingsIntersection = () => {
            const target = document.getElementById('rankings-load-more');
            let count = 0;
            for (const observer of observers) if (observer.fixtureTargets.has(target)) {
                observer.fixtureCallback([{ target, isIntersecting: true, intersectionRatio: 1 }], observer);
                count += 1;
            }
            return count;
        };
    });
    const list = await (await page.request.post(`${origin}/api/lists`, { data: { name: 'Ranking reading list' } })).json();
    await page.goto(origin);
    await page.locator('[data-view="rankings"]').click();
    const cards = page.locator('#publisher-rankings .feed-card');
    const matched = () => page.locator(`#publisher-rankings .feed-card[data-article-id="${articleId}"]`);
    const unmatched = page.locator('#publisher-rankings .feed-card:not([data-article-id])');
    await waitFor(async () => await cards.count() === 40, 'initial mixed page of forty Feed cards');
    assert.equal(await page.locator('#rankings-medium').inputValue(), 'all');
    assert.equal(await matched().count(), 1, 'Mixed cards deduplicate current ranking kinds and older snapshots');
    assert.equal(await page.locator('.publisher-ranking-title').count(), 0, 'All media is one Feed card collection');
    assert.ok(await page.locator('.publisher-ranking-provenance').count() >= 40);
    const initialTop = await (await page.request.get(`${origin}/api/rankings/top?medium=all&limit=40`)).json();
    assert.equal(initialTop.items.length, 40);
    assert.equal(initialTop.hasMore, true);
    assert.ok(initialTop.nextCursor);
    assert.deepEqual([...new Set(initialTop.items.flatMap(item => item.rankings.map(ranking => ranking.medium)))].sort(), ['computerbase', 'golem', 'heise-ix', 't3n', 'techcrunch', 'winfuture']);
    assert.equal(new Set(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.itemUrl))).size, 40);
    const mixedProvenance = (await matched().locator('.publisher-ranking-provenance').allTextContents()).join(' ');
    assert.match(mixedProvenance, /Most read/);
    assert.match(mixedProvenance, /Most commented/);
    await matched().locator('.article-title-button').click();
    await page.locator('#rankings-article-viewer').waitFor({ state: 'visible' });
    await page.frameLocator('#rankings-article-viewer-frame').getByText('Isolated ranking article viewer fixture.').waitFor();
    assert.equal(await page.locator('#rankings-article-viewer-frame').getAttribute('data-loaded-url'), url);
    await page.locator('#rankings-article-viewer-hide').click();
    const mixedExternal = unmatched.first();
    const mixedExternalUrl = await mixedExternal.getAttribute('data-item-url');
    await mixedExternal.locator('.article-title-button').click();
    assert.deepEqual(await page.evaluate(() => window.openedFixtureUrls), [mixedExternalUrl]);
    await page.evaluate(() => { window.openedFixtureUrls = []; });

    mutateFixture(`
        const { saveMostReadSnapshot } = await import('./backend/services/most-read.js');
        await saveMostReadSnapshot({ sourceId: 1, capturedAt: new Date(Date.now() + 1000).toISOString(), rankings: {
            most_read: [{ canonicalUrl: ${JSON.stringify(watermarkUrl)}, title: 'New watermark fixture article', rank: 1 }],
            most_commented: [{ canonicalUrl: ${JSON.stringify(watermarkUrl)}, title: 'New watermark fixture article', rank: 1 }]
        } });
    `);
    await page.locator('#rankings-load-more').click();
    await waitFor(async () => await cards.count() === 80, 'second mixed page of forty Feed cards');
    assert.equal(new Set(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.itemUrl))).size, 80);
    assert.ok(await page.evaluate(() => window.triggerRankingsIntersection()) > 0, 'Mixed view must register its pagination observer');
    await waitFor(async () => await cards.count() === 96, 'observer loads the final sixteen historical articles');
    assert.equal(new Set(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.itemUrl))).size, 96);
    assert.equal(await page.locator('#rankings-load-more').isVisible(), false);
    assert.equal(await page.locator(`#publisher-rankings .feed-card[data-item-url="${watermarkUrl}"]`).count(), 0, 'Continuation stays pinned to the initial snapshot watermark');
    const freshTop = await (await page.request.get(`${origin}/api/rankings/top?medium=all&limit=40`)).json();
    assert.equal(freshTop.items.some(item => item.canonicalUrl === watermarkUrl), true, 'A fresh request sees the new snapshot watermark');
    mutateFixture(`await db.run('DELETE FROM most_read WHERE canonicalUrl = ?', [${JSON.stringify(watermarkUrl)}]);`);

    // Save while looking at a later page, keeping that card in the viewport so
    // opening its list dialog does not itself scroll the collection.
    const mixedLast = cards.last();
    await mixedLast.scrollIntoViewIfNeeded();
    const laterPageArticleId = await mixedLast.getAttribute('data-article-id');
    assert.ok(laterPageArticleId);
    const loadedCount = await cards.count();
    const scrollBeforeSave = await page.evaluate(() => window.scrollY);
    await mixedLast.locator('.article-save-btn').click();
    await page.locator('#modal-backdrop').waitFor({ state: 'visible' });
    await page.locator('#modal-list-select').selectOption(String(list.id), { force: true });
    await page.locator('#modal-confirm').click();
    await waitFor(async () => await page.locator(`#publisher-rankings .feed-card[data-article-id="${laterPageArticleId}"] .article-save-btn.is-saved`).count() === 1, 'save updates the later mixed card');
    assert.equal(await cards.count(), loadedCount, 'Saving preserves every loaded mixed page');
    assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - scrollBeforeSave) < 80, 'Saving retains the mixed-view scroll position');
    await page.locator(`#publisher-rankings .feed-card[data-article-id="${laterPageArticleId}"] .article-save-btn`).click();
    await page.locator('#modal-existing-lists [data-action="remove-list"]').click();
    await waitFor(async () => await page.locator(`#publisher-rankings .feed-card[data-article-id="${laterPageArticleId}"] .article-save-btn.is-saved`).count() === 0, 'remove later mixed card list membership');
    await page.locator('#modal-cancel').click();
    await page.locator(`#publisher-rankings .feed-card[data-article-id="${laterPageArticleId}"] .article-dismiss-btn`).click();
    await waitFor(async () => await cards.count() === loadedCount - 1, 'dismiss removes only the later mixed card');
    assert.ok(await cards.count() > 40, 'Dismiss must not collapse mixed pagination');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await waitFor(async () => await cards.count() === loadedCount, 'mixed dismiss Undo restores the loaded collection');
    await page.locator('.oj-toast-dismiss').evaluateAll(buttons => buttons.forEach(button => button.click()));

    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['narrow', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForFunction(() => [...document.querySelectorAll('.publisher-top-list .feed-card')].filter(card => {
            const bounds = card.getBoundingClientRect(); return bounds.top < innerHeight && bounds.bottom > 0;
        }).every(card => card.checkVisibility({ contentVisibilityAuto: true })));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `All media ${name} horizontal overflow`);
        await page.screenshot({ path: path.join(screenshots, `rankings-all-${name}.png`), fullPage: false });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#rankings-medium-trigger').click();
    await page.getByRole('menuitemradio', { name: 'Golem', exact: true }).click();
    await waitFor(async () => await cards.count() === 4, 'source selector filters back to current Golem groups');
    assert.equal(await page.locator('#rankings-load-more').isVisible(), false);
    await page.locator('#rankings-medium-trigger').click();
    await page.getByRole('menuitemradio', { name: 'All media', exact: true }).click();
    await waitFor(async () => await cards.count() === 40, 'return to the first mixed page');
    let releasePagination;
    const paginationHeld = new Promise(resolve => { releasePagination = resolve; });
    let paginationStarted, paginationCompleted;
    const paginationRequestStarted = new Promise(resolve => { paginationStarted = resolve; });
    const paginationRequestCompleted = new Promise(resolve => { paginationCompleted = resolve; });
    const paginationRoute = requestUrl => requestUrl.pathname === '/api/rankings/top' && requestUrl.searchParams.has('cursor');
    await page.route(paginationRoute, async route => {
        try {
            const response = await route.fetch();
            paginationStarted();
            await paginationHeld;
            try { await route.fulfill({ response }); }
            catch (error) { if (!route.request().failure()?.errorText?.includes('ABORTED')) throw error; }
        } finally { paginationCompleted(); }
    });
    await page.locator('#rankings-load-more').click();
    await paginationRequestStarted;
    await page.locator('#rankings-medium-trigger').click();
    await page.getByRole('menuitemradio', { name: 'Golem', exact: true }).click();
    await waitFor(async () => await cards.count() === 4, 'source switch completes while a mixed page is pending');
    releasePagination();
    await paginationRequestCompleted;
    await page.unroute(paginationRoute);
    assert.equal(await page.locator('#rankings-medium').inputValue(), 'golem');
    await waitFor(async () => await cards.count() === 4, 'ranked Feed cards');
    assert.equal(await matched().count(), 2);
    assert.equal(await matched().first().locator('.article-title-button').textContent(), 'RSS fixture headline');
    assert.equal(await matched().first().locator('.teaser').textContent(), 'Actual RSS teaser for the ranking card.');
    assert.equal(await unmatched.locator('.teaser').isVisible(), false);
    assert.equal(await unmatched.locator('.article-save-btn').isDisabled(), true);
    assert.equal(await unmatched.locator('.article-dismiss-btn').isDisabled(), true);
    assert.deepEqual(await page.locator('.publisher-ranking-title').allTextContents(), ['Most read', 'Most commented']);
    assert.equal(await page.locator('.publisher-rankings-note, .publisher-rankings-title, #rankings-header p').count(), 0);

    await page.locator('#rankings-medium-trigger').click();
    await page.getByRole('menuitemradio', { name: 'WinFuture', exact: true }).click();
    await waitFor(async () => await cards.count() === 2 && (await cards.first().textContent()).includes('WinFuture RSS fixture headline'), 'WinFuture selection and ranked RSS cards');
    assert.equal(await page.locator('#rankings-medium').inputValue(), 'winfuture');
    assert.equal(await cards.first().locator('.teaser').textContent(), 'WinFuture stored teaser.');
    assert.equal(await matched().count(), 0);
    await cards.first().locator('.article-title-button').click();
    await page.locator('#rankings-article-viewer').waitFor({ state: 'visible' });
    await page.frameLocator('#rankings-article-viewer-frame').getByText('Isolated ranking article viewer fixture.').waitFor();
    await page.locator('#rankings-medium-trigger').click();
    await page.getByRole('menuitemradio', { name: 'ComputerBase', exact: true }).click();
    await waitFor(async () => await cards.count() === 1 && (await cards.first().textContent()).includes('ComputerBase RSS fixture headline'), 'ComputerBase most-read RSS card');
    assert.equal(await page.locator('#rankings-medium').inputValue(), 'computerbase');
    assert.deepEqual(await page.locator('.publisher-ranking-title').allTextContents(), ['Most read']);
    assert.equal(await page.locator('[data-ranking-key="most_commented"]').count(), 0, 'ComputerBase must not invent a most-commented section');
    assert.equal(await cards.first().locator('.teaser').textContent(), 'ComputerBase stored RSS teaser.');
    const computerbase = await (await page.request.get(`${origin}/api/rankings?medium=computerbase`)).json();
    assert.equal(computerbase.medium, 'computerbase');
    assert.equal(computerbase.rankings.length, 1);
    assert.equal(computerbase.rankings[0].sourceId, 3);
    assert.equal(computerbase.rankings[0].rankingKey, 'most_read');
    assert.equal(computerbase.rankings[0].items[0].article.sourceName, 'ComputerBase RSS');
    assert.ok(Number.isFinite(Date.parse(computerbase.rankings[0].capturedAt)));
    await cards.first().locator('.article-title-button').click();
    await page.locator('#rankings-article-viewer').waitFor({ state: 'visible' });
    await page.frameLocator('#rankings-article-viewer-frame').getByText('Isolated ranking article viewer fixture.').waitFor();
    assert.equal(await page.locator('#rankings-article-viewer-frame').getAttribute('data-loaded-url'), computerBaseUrl);
    await page.locator('#rankings-article-viewer-hide').click();
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['narrow', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `ComputerBase ${name} horizontal overflow`);
        await page.screenshot({ path: path.join(screenshots, `rankings-computerbase-${name}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#rankings-medium-trigger').click();
    await page.getByRole('menuitemradio', { name: 'heise iX', exact: true }).click();
    await waitFor(async () => await cards.count() === 1 && (await cards.first().textContent()).includes('heise iX RSS fixture headline'), 'heise iX editorial Top-News RSS card');
    assert.equal(await page.locator('#rankings-medium').inputValue(), 'heise-ix');
    assert.deepEqual(await page.locator('.publisher-ranking-title').allTextContents(), ['Top-News']);
    assert.equal(await page.locator('[data-ranking-key="most_read"], [data-ranking-key="most_commented"]').count(), 0, 'Editorial Top-News must not be labelled most-read or most-commented');
    assert.equal(await cards.first().locator('.teaser').textContent(), 'heise iX stored RSS teaser.');
    assert.equal(await cards.first().locator('.article-save-btn').isEnabled(), true);
    assert.equal(await cards.first().locator('.article-dismiss-btn').isEnabled(), true);
    const heiseIx = await (await page.request.get(`${origin}/api/rankings?medium=heise-ix`)).json();
    assert.equal(heiseIx.medium, 'heise-ix');
    assert.equal(heiseIx.rankings.length, 1);
    assert.equal(heiseIx.rankings[0].sourceId, 5, 'Generic Heise RSS must not supply the heise iX selection');
    assert.equal(heiseIx.rankings[0].rankingKey, 'top_news');
    assert.equal(heiseIx.rankings[0].items[0].article.sourceName, 'heise iX RSS');
    assert.ok(Number.isFinite(Date.parse(heiseIx.rankings[0].capturedAt)));
    await cards.first().locator('.article-title-button').click();
    await page.locator('#rankings-article-viewer').waitFor({ state: 'visible' });
    await page.frameLocator('#rankings-article-viewer-frame').getByText('Isolated ranking article viewer fixture.').waitFor();
    assert.equal(await page.locator('#rankings-article-viewer-frame').getAttribute('data-loaded-url'), heiseIxUrl);
    await page.locator('#rankings-article-viewer-hide').click();
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['narrow', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `heise iX ${name} horizontal overflow`);
        await page.screenshot({ path: path.join(screenshots, `rankings-heise-ix-${name}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#rankings-medium-trigger').click();
    await page.getByRole('menuitemradio', { name: 't3n', exact: true }).click();
    await waitFor(async () => await cards.count() === 1 && (await cards.first().textContent()).includes('t3n RSS fixture headline'), 't3n most-read RSS card');
    assert.equal(await page.locator('#rankings-medium').inputValue(), 't3n');
    assert.deepEqual(await page.locator('.publisher-ranking-title').allTextContents(), ['Most read']);
    assert.equal(await page.locator('[data-ranking-key="most_commented"], [data-ranking-key="top_news"]').count(), 0, 't3n must only show its available most-read group');
    assert.equal(await cards.first().locator('.teaser').textContent(), 't3n stored RSS teaser.');
    assert.equal(await cards.first().locator('.article-save-btn').isEnabled(), true);
    assert.equal(await cards.first().locator('.article-dismiss-btn').isEnabled(), true);
    const t3n = await (await page.request.get(`${origin}/api/rankings?medium=t3n`)).json();
    assert.equal(t3n.medium, 't3n');
    assert.equal(t3n.rankings.length, 1);
    assert.equal(t3n.rankings[0].sourceId, 6);
    assert.equal(t3n.rankings[0].rankingKey, 'most_read');
    assert.equal(t3n.rankings[0].items[0].article.sourceName, 't3n RSS');
    assert.ok(Number.isFinite(Date.parse(t3n.rankings[0].capturedAt)));
    await cards.first().locator('.article-title-button').click();
    await page.locator('#rankings-article-viewer').waitFor({ state: 'visible' });
    await page.frameLocator('#rankings-article-viewer-frame').getByText('Isolated ranking article viewer fixture.').waitFor();
    assert.equal(await page.locator('#rankings-article-viewer-frame').getAttribute('data-loaded-url'), t3nUrl);
    await page.locator('#rankings-article-viewer-hide').click();
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['narrow', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `t3n ${name} horizontal overflow`);
        await page.screenshot({ path: path.join(screenshots, `rankings-t3n-${name}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#rankings-medium-trigger').click();
    await page.getByRole('menuitemradio', { name: 'TechCrunch', exact: true }).click();
    await waitFor(async () => await cards.count() === 5 && (await cards.first().textContent()).includes('TechCrunch RSS fixture headline'), 'TechCrunch Top Headlines RSS card and editorial selection');
    assert.equal(await page.locator('#rankings-medium').inputValue(), 'techcrunch');
    assert.deepEqual(await page.locator('.publisher-ranking-title').allTextContents(), ['Top Headlines']);
    assert.equal(await page.locator('[data-ranking-key="most_read"], [data-ranking-key="most_commented"]').count(), 0, 'TechCrunch editorial headlines must not become most-read/commented lists');
    assert.equal(await cards.first().locator('.teaser').textContent(), 'TechCrunch stored RSS teaser.');
    assert.equal(await cards.first().locator('.article-save-btn').isEnabled(), true);
    assert.equal(await cards.first().locator('.article-dismiss-btn').isEnabled(), true);
    assert.doesNotMatch(await page.locator('#publisher-rankings').textContent(), /unranked latest RSS headline|Top-News/);
    const techCrunch = await (await page.request.get(`${origin}/api/rankings?medium=techcrunch`)).json();
    assert.equal(techCrunch.medium, 'techcrunch');
    assert.equal(techCrunch.rankings.length, 1);
    assert.equal(techCrunch.rankings[0].sourceId, 7);
    assert.equal(techCrunch.rankings[0].rankingKey, 'top_news');
    assert.equal(techCrunch.rankings[0].label, 'Top Headlines');
    assert.deepEqual(techCrunch.rankings[0].items.map(item => item.rank), [1, 2, 3, 4, 5]);
    assert.equal(techCrunch.rankings[0].items[0].article.sourceName, 'TechCrunch RSS');
    assert.ok(Number.isFinite(Date.parse(techCrunch.rankings[0].capturedAt)));
    await cards.first().locator('.article-title-button').click();
    await page.locator('#rankings-article-viewer').waitFor({ state: 'visible' });
    await page.frameLocator('#rankings-article-viewer-frame').getByText('Isolated ranking article viewer fixture.').waitFor();
    assert.equal(await page.locator('#rankings-article-viewer-frame').getAttribute('data-loaded-url'), techCrunchUrl);
    await page.locator('#rankings-article-viewer-hide').click();
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['narrow', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `TechCrunch ${name} horizontal overflow`);
        await page.screenshot({ path: path.join(screenshots, `rankings-techcrunch-${name}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#rankings-medium-trigger').click();
    await page.getByRole('menuitemradio', { name: 'Golem', exact: true }).click();
    await waitFor(async () => await cards.count() === 4 && await matched().count() === 2, 'return to Golem rankings');
    assert.equal(await page.locator('#rankings-article-viewer').isVisible(), false);

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
    console.log(`Ranking browser fixture passed: All media 40/80/96 pagination, canonical dedup, snapshot watermark, source-switch race, loaded-depth save/dismiss/Undo and scroll; all six grouped media, RSS viewers/actions, unmatched links, quiet errors and responsive layout. Screenshots: ${screenshots}`);
} finally {
    await browser?.close();
    if (backend && backend.exitCode === null) {
        const exited = once(backend, 'exit'); backend.stdin.end();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
        if (backend.exitCode === null) backend.kill();
    }
    await rm(directory, { recursive: true, force: true });
}
