import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import sharp from 'sharp';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const outputDirectory = path.join(projectDirectory, 'public', 'images', 'mockups');
const viewport = { width: 1920, height: 1080 };

async function capture(page, filename, errors) {
    await page.mouse.move(0, 0);
    await page.evaluate(async () => {
        document.activeElement?.blur?.();
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        await document.fonts.ready;
        const images = [...document.images].filter(image => image.getClientRects().length > 0);
        await Promise.all(images.map(image => image.decode().catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    if (errors.length) throw new Error(errors.join('\n'));

    const screenshot = await page.screenshot({
        type: 'png',
        fullPage: false,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
    });
    await sharp(screenshot).webp({ quality: 90, effort: 6 }).toFile(path.join(outputDirectory, filename));
    console.log(`Created public/images/mockups/${filename} (${viewport.width} × ${viewport.height})`);
}

async function generateMockups(url) {
    try {
        const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(5000) });
        if (!response.ok || !(await response.json()).ok) throw new Error('Health check failed');
    } catch (error) {
        throw new Error(`App unavailable at ${url}. Start the Electron app or run npm start first.`, { cause: error });
    }

    let browser;
    try {
        browser = await chromium.launch();
    } catch (error) {
        if (error.message.includes("Executable doesn't exist")) {
            throw new Error('Chromium is missing. Run npm run mockups:install once before generating screenshots.');
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
        page.on('pageerror', error => errors.push(error.message));
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
        await page.addInitScript(() => {
            localStorage.setItem('fnnd.layout', 'list');
            localStorage.setItem('fnnd.digestRange', 'month');
            localStorage.setItem('fnnd.digestSort', 'desc');
        });

        // SSE keeps a connection open, so wait for rendered views instead of networkidle.
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            const count = document.getElementById('feed-count');
            const loading = document.getElementById('loading-row');
            return count && count.textContent !== 'Loading…' && loading?.classList.contains('hide');
        });
        await page.locator('#articles-list.is-list').waitFor({ state: 'attached' });
        await page.locator('[data-layout="list"][aria-pressed="true"]').waitFor({ state: 'visible' });
        if (errors.length) throw new Error(errors.join('\n'));

        // Only delete the previous generation once the app and browser are ready.
        await rm(outputDirectory, { recursive: true, force: true });
        await mkdir(outputDirectory, { recursive: true });
        await capture(page, 'feed_compact_1920.webp', errors);

        await page.locator('.nav-link[data-view="digest"]').click();
        await page.waitForFunction(() => {
            const subtitle = document.getElementById('digest-subtitle')?.textContent || '';
            const range = document.getElementById('digest-range-toggle');
            return subtitle.startsWith('Month ·') && !subtitle.includes('Loading') && range && range.getAttribute('aria-busy') !== 'true';
        });
        await page.locator('[data-digest-range="month"][aria-pressed="true"]').waitFor({ state: 'visible' });
        await capture(page, 'digest_month_1920.webp', errors);

        await page.locator('.nav-link[data-view="settings"]').click();
        await page.locator('#settings-feeds-tab').click();
        await page.locator('#settings-feeds').waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
            const count = document.getElementById('article-count-status')?.textContent || '';
            return count.startsWith('Saved articles: ') && !count.includes('—') && Boolean(document.getElementById('topics-json-input')?.value);
        });
        await capture(page, 'settings_rss_feeds_1920.webp', errors);

        await page.locator('#settings-topics-tab').click();
        await page.locator('#settings-topics').waitFor({ state: 'visible' });
        await capture(page, 'settings_topics_1920.webp', errors);
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
        options: { url: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
    if (values.help) {
        console.log('Usage: npm run mockups -- [--url http://127.0.0.1:1377]\nCreates four 1920 × 1080 WebPs using the running app and replaces public/images/mockups/.');
        return;
    }
    const url = new URL(values.url || `http://127.0.0.1:${process.env.PORT || 1377}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--url must use http or https.');
    await generateMockups(url);
}

main().catch(error => {
    console.error(`Mockup generation failed: ${error.message}`);
    process.exitCode = 1;
});
