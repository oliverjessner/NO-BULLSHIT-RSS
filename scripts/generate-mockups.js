import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { ensureMockupServer } from './lib/mockup-server.js';
import { ANALYTICS_SCREENSHOTS, captureAnalytics } from './lib/analytics-screenshots.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const outputDirectory = path.join(projectDirectory, 'public', 'images', 'mockups');
const viewport = { width: 1920, height: 1080 };

async function capture(page, filename, errors, { target, preserveInteraction = false, fullPage = false } = {}) {
    if (!preserveInteraction) await page.mouse.move(0, 0);
    await page.evaluate(async preserve => {
        if (!preserve) {
            document.activeElement?.blur?.();
            window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        }
        await document.fonts.ready;
        const images = [...document.images].filter(image => image.getClientRects().length > 0);
        await Promise.all(images.map(image => image.decode().catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, preserveInteraction);
    if (errors.length) throw new Error(errors.join('\n'));

    const options = {
        type: 'png',
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        ...(target ? { style: '.topbar { visibility: hidden !important; }' } : {}),
    };
    const screenshot = target ? await target.screenshot(options) : await page.screenshot({ ...options, fullPage });
    const conversion = sharp(screenshot);
    const dimensions = await conversion.metadata();
    await conversion.webp({ quality: 90, effort: 6 }).toFile(path.join(outputDirectory, filename));
    console.log(`Created public/images/mockups/${filename} (${dimensions.width} × ${dimensions.height})`);
}

async function captureAnalyticsViews(page, url, errors) {
    const created = new Set();
    await captureAnalytics(page, url, errors, async (...args) => { await capture(...args); created.add(args[1]); });
    const missing = ANALYTICS_SCREENSHOTS.filter(filename => !created.has(filename));
    if (missing.length) throw new Error(`Missing Analytics captures: ${missing.join(', ')}`);
}

async function captureMostRead(page, url, errors) {
    const loaded = page.waitForResponse(response => {
        const requestUrl = new URL(response.url());
        return requestUrl.origin === url.origin && requestUrl.pathname === '/api/rankings/top'
            && requestUrl.searchParams.get('medium') === 'all' && !requestUrl.searchParams.has('cursor');
    });
    await page.locator('.nav-link[data-view="rankings"]').click();
    const response = await loaded;
    if (!response.ok()) throw new Error(`Could not load Most read articles: HTTP ${response.status()}.`);
    const payload = await response.json();
    if (payload.medium !== 'all' || !Array.isArray(payload.items) || !payload.items.length) {
        throw new Error('Most read has no saved articles. Refresh publisher rankings in the app before generating screenshots.');
    }
    await page.locator('#view-rankings').waitFor({ state: 'visible' });
    await page.locator('#publisher-rankings .feed-card').first().waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('rankings-refresh')?.getAttribute('aria-busy') === 'false');
    if (await page.locator('#rankings-medium').inputValue() !== 'all') throw new Error('Most read must show All media.');
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await page.waitForFunction(() => {
        const visibleCards = [...document.querySelectorAll('#publisher-rankings .feed-card')].filter(card => {
            const bounds = card.getBoundingClientRect();
            return bounds.top < innerHeight && bounds.bottom > 0;
        });
        return visibleCards.length > 0 && visibleCards.every(card => card.checkVisibility({ contentVisibilityAuto: true }));
    });
    await capture(page, 'most_read.webp', errors);
}

async function generateMockups(url, { only } = {}) {
    let browser;
    try {
        browser = await chromium.launch();
    } catch (error) {
        if (error.message.includes("Executable doesn't exist")) {
            throw new Error('Chromium is missing. Run npm run screenshots:install once before generating screenshots.');
        }
        throw error;
    }

    const errors = [];
    try {
        const page = await browser.newPage({
            viewport,
            deviceScaleFactor: 1,
            colorScheme: 'dark',
            reducedMotion: 'reduce',
            locale: 'en-US',
            timezoneId: 'Europe/Vienna',
        });
        page.setDefaultTimeout(30000);
        // Original publisher frames can throw their own script errors. Report
        // failures from the application document without treating those as ours.
        await page.exposeBinding('__reportMockupAppError', ({ frame }, message) => {
            if (frame === page.mainFrame()) errors.push(String(message));
        });
        page.on('response', response => {
            if (new URL(response.url()).origin === url.origin && response.status() >= 400) {
                errors.push(`HTTP ${response.status()}: ${response.url()}`);
            }
        });
        page.on('requestfailed', request => {
            const reason = request.failure()?.errorText;
            if (new URL(request.url()).origin === url.origin && reason !== 'net::ERR_ABORTED') {
                errors.push(`${reason}: ${request.url()}`);
            }
        });
        await page.addInitScript(appOrigin => {
            if (window !== window.top || location.origin !== appOrigin) return;
            const report = message => { void window.__reportMockupAppError(message).catch(() => {}); };
            window.addEventListener('error', event => {
                // Browser resize notifications may be deferred to the next
                // frame; Analytics separately waits for final SVG dimensions.
                if (event.message && !/^ResizeObserver loop (?:completed with undelivered notifications\.|limit exceeded)$/u.test(event.message)) report(event.message);
            });
            window.addEventListener('unhandledrejection', event => report(event.reason?.message || String(event.reason)));
            localStorage.setItem('fnnd.layout', 'list');
            localStorage.setItem('fnnd.digestRange', 'month');
            localStorage.setItem('fnnd.digestSort', 'desc');
        }, url.origin);

        // SSE keeps a connection open, so wait for rendered views instead of networkidle.
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        if (only) {
            await mkdir(outputDirectory, { recursive: true });
            if (only === 'most-read') await captureMostRead(page, url, errors);
            else await captureAnalyticsViews(page, url, errors);
            return;
        }
        await page.waitForFunction(() => {
            const count = document.getElementById('feed-count');
            const loading = document.getElementById('loading-row');
            return count && count.textContent !== 'Loading…' && loading?.classList.contains('hide');
        });
        await page.locator('#articles-list.is-list').waitFor({ state: 'attached' });
        await page.locator('#feed-layout-slider[aria-valuetext="Compact"]').waitFor({ state: 'visible' });
        if (errors.length) throw new Error(errors.join('\n'));

        // Only delete the previous generation once the app and browser are ready.
        await rm(outputDirectory, { recursive: true, force: true });
        await mkdir(outputDirectory, { recursive: true });
        await capture(page, 'feed_compact.webp', errors);

        await page.locator('#feed-layout-slider').focus();
        await page.locator('#feed-layout-slider').press('End');
        await page.locator('#feed-layout-slider[aria-valuetext="Cards"]').waitFor({ state: 'visible' });
        await page.locator('#articles-list:not(.is-list)').waitFor({ state: 'attached' });
        await capture(page, 'feed_cards.webp', errors);

        await page.locator('.nav-link[data-view="digest"]').click();
        await page.waitForFunction(() => {
            const subtitle = document.getElementById('digest-subtitle')?.textContent || '';
            const range = document.getElementById('digest-range-toggle');
            return (
                subtitle.startsWith('Month ·') &&
                !subtitle.includes('Loading') &&
                range &&
                range.getAttribute('aria-busy') !== 'true'
            );
        });
        await page.locator('[data-digest-range="month"][aria-pressed="true"]').waitFor({ state: 'visible' });
        await capture(page, 'digest_month.webp', errors);

        await captureMostRead(page, url, errors);
        await captureAnalyticsViews(page, url, errors);

        const watchdogLoaded = page.waitForResponse(response =>
            new URL(response.url()).pathname === '/api/watchdogs/matches' && response.ok());
        await page.locator('.nav-link[data-view="watchdog"]').click();
        await watchdogLoaded;
        await page.locator('#view-watchdog').waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.getElementById('watchdog-results')?.getAttribute('aria-busy') === 'false');
        await page.locator('#watchdog-inbox').evaluate(inbox => { inbox.scrollTop = 0; });
        await capture(page, 'watchdog.webp', errors);

        await page.locator('.nav-link[data-view="settings"]').click();
        await page.locator('#settings-feeds-tab').click();
        await page.locator('#settings-feeds').waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
            const count = document.getElementById('article-count-status')?.textContent || '';
            return (
                count.startsWith('Saved articles: ') &&
                !count.includes('—') &&
                Boolean(document.getElementById('topics-json-input')?.value)
            );
        });
        await capture(page, 'settings_rss_feeds.webp', errors);

        await page.locator('#settings-topics-tab').click();
        await page.locator('#settings-topics').waitFor({ state: 'visible' });
        await capture(page, 'settings_topics.webp', errors);
    } catch (error) {
        if (errors.length && !error.message.includes(errors.join('\n'))) {
            throw new Error(`${error.message}\n${errors.join('\n')}`, { cause: error });
        }
        throw error;
    } finally {
        await browser.close();
    }
}

async function main() {
    const { values } = parseArgs({
        options: { url: { type: 'string' }, only: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
    if (values.help) {
        console.log(
            `Usage: npm run screenshots -- [--url http://127.0.0.1:1377] [--only most-read|analytics]\nCreates ${7 + ANALYTICS_SCREENSHOTS.length} WebPs using a 1920 × 1080 viewport; Analytics panel captures keep their full height. A full run replaces public/images/mockups/. --only most-read writes most_read.webp; --only analytics writes ${ANALYTICS_SCREENSHOTS.length} Analytics captures. Both keep other images. Analytics-only runs without --url use a temporary database snapshot; otherwise an available app server is reused or a temporary local server is started.`,
        );
        return;
    }
    if (values.only !== undefined && !['most-read', 'analytics'].includes(values.only)) throw new Error('--only supports most-read or analytics.');
    const url = new URL(values.url || `http://127.0.0.1:${process.env.PORT || 1377}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--url must use http or https.');
    const server = await ensureMockupServer({ url, projectDirectory, reuseExisting: values.only !== 'analytics' || Boolean(values.url) });
    try {
        await generateMockups(server.url, { only: values.only });
    } finally {
        await server.close();
    }
}

main().catch(error => {
    console.error(`Mockup generation failed: ${error.message}`);
    process.exitCode = 1;
});
