import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-analytics-ui-'));
const screenshots = await mkdtemp('/tmp/rss-analytics-qa-');
const env = { ...process.env, DB_PATH: path.join(directory, 'fixture.db'), TOPIC_RULES_FILE_PATH: path.join(directory, 'topics.json'), SERVER_LOG_PATH: path.join(directory, 'server.log'), DISABLE_SCHEDULER: '1', HOST: '127.0.0.1', DESKTOP_PARENT_WATCHDOG: '1' };
const engine = process.argv.includes('--webkit') ? webkit : chromium;
let backend, browser;
let output = '';
const errors = [];
async function waitFor(check, label) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}`);
}

async function checkChartTooltip(page, chart, { series = 0, pointIndex = 0, label, date, value, rank = false, touch = false, keyboard = true } = {}) {
    const points = chart.locator('.analytics-chart-series').nth(series).locator('.analytics-chart-point');
    const point = points.nth(pointIndex), tooltip = chart.locator('.analytics-chart-tooltip');
    await point.scrollIntoViewIfNeeded();
    const expectedDate = await page.evaluate(async timestamp => (await import('/js/utils/format.js')).formatDate(timestamp), date);
    const expectedValue = `${rank ? '#' : ''}${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)}`;
    assert.equal(await point.getAttribute('aria-label'), `${label}: ${expectedDate} · ${expectedValue}`);
    assert.equal(await point.getAttribute('aria-describedby'), await tooltip.getAttribute('id'));
    assert.equal(await tooltip.getAttribute('role'), 'tooltip');
    if (touch) await point.dispatchEvent('pointerdown', { pointerType: 'touch' });
    else await point.hover();
    await tooltip.waitFor({ state: 'visible' });
    assert.equal(await tooltip.locator('.analytics-chart-tooltip-series').textContent(), label);
    assert.equal(await tooltip.locator('.analytics-chart-tooltip-value').textContent(), expectedValue);
    assert.equal(await tooltip.locator('.analytics-chart-tooltip-series').evaluate(node => getComputedStyle(node).color),
        await chart.locator('.analytics-chart-series').nth(series).evaluate(node => getComputedStyle(node).color), 'Tooltip series color matches its chart line');
    assert.ok((await tooltip.textContent()).includes(expectedDate), 'Tooltip shows the actual observation date in the application format');
    if (!touch) {
        await page.mouse.move(0, 0);
        await tooltip.waitFor({ state: 'hidden' });
    }
    await point.focus(); await tooltip.waitFor({ state: 'visible' });
    assert.equal(await chart.locator('.analytics-chart-point[tabindex="0"]').count(), 1, 'One observed point is in the chart tab order');
    if (keyboard && pointIndex === 0 && await points.count() > 1) {
        await page.keyboard.press('ArrowRight');
        await waitFor(() => points.nth(1).evaluate(node => node === document.activeElement), 'ArrowRight focuses the next observed point');
        assert.equal(await points.nth(1).getAttribute('tabindex'), '0');
        assert.equal(await point.getAttribute('tabindex'), '-1');
        assert.ok((await points.nth(1).getAttribute('aria-label')).includes(await tooltip.locator('.analytics-chart-tooltip-value').textContent()));
        await page.keyboard.press('ArrowLeft');
        await waitFor(() => point.evaluate(node => node === document.activeElement), 'ArrowLeft returns to the previous observation');
    }
    await page.keyboard.press('Escape'); await tooltip.waitFor({ state: 'hidden' });
    await point.dispatchEvent('pointerdown', { pointerType: 'touch' }); await tooltip.waitFor({ state: 'visible' });
    await chart.locator('.analytics-chart-plot').dispatchEvent('scroll'); await tooltip.waitFor({ state: 'hidden' });
    await point.evaluate(node => node.blur());
}

try {
    const fixture = spawnSync(process.execPath, ['--input-type=module', '-e', "const db = await import('./backend/database/datenbank.js'); const { seedAnalyticsUiFixture } = await import('./scripts/analytics-ui-fixture.js'); await seedAnalyticsUiFixture(db); await db.closeDatabase();"], { cwd: root, env, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    env.PORT = String(socket.address().port); await new Promise(resolve => socket.close(resolve));
    backend = spawn(process.execPath, ['backend/server.js'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    backend.stdout.on('data', chunk => { output += chunk; }); backend.stderr.on('data', chunk => { output += chunk; });
    await waitFor(() => output.includes('NBS_DESKTOP_READY') || backend.exitCode !== null, 'isolated backend readiness');
    assert.equal(backend.exitCode, null, output);
    const origin = `http://127.0.0.1:${env.PORT}`;
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Isolated Analytics article viewer fixture.</p>' }));
    await page.goto(origin);
    await page.locator('#articles-list .feed-card').first().waitFor();
    assert.equal(await page.locator('#statistics-dialog').count(), 0);
    await page.locator('[data-view="analytics"]').click();
    await page.locator('#analytics-overview .analytics-metric').first().waitFor();
    assert.equal(await page.locator('#analytics-period').inputValue(), '30d');
    assert.equal(await page.locator('#analytics-overview .analytics-metric').count(), 5);
    assert.equal(await page.locator('#analytics-overview .analytics-metric').filter({ hasText: 'Articles in period' }).locator('.analytics-metric-value').textContent(), '23');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--oj-accent').trim()), '#fedd3e');
    assert.equal(await page.evaluate(async () => typeof (await import('/vendor/oj-designsystem/index.js')).initOJ), 'function');
    const choose = (id, value) => page.locator(`#analytics-${id}`).selectOption(value, { force: true });
    const settled = () => waitFor(async () => (await page.locator('#analytics-status').textContent()).trim() === '', 'Analytics response painted');
    const overview = await (await page.request.get(`${origin}/api/analytics/overview?period=30d&group=day`)).json();
    const overviewChart = page.locator('#analytics-overview .analytics-chart').first();
    assert.equal(await overviewChart.locator('.analytics-chart-series path').count(), 1, 'Article observations share a connected line');
    await checkChartTooltip(page, overviewChart, { label: 'Articles', date: overview.volume[0].bucket, value: overview.volume[0].count });
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['narrow', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        for (const section of ['overview', 'trends', 'publishers', 'most-read', 'topics']) {
            await page.locator(`#analytics-${section}-tab`).click();
            await settled();
            await page.locator(`#analytics-${section} .analytics-panel, #analytics-${section} .analytics-metric`).first().waitFor();
            assert.ok(await page.locator(`#analytics-${section}`).textContent(), `${section} has stored content`);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${section}/${name}: no document overflow`);
            await page.screenshot({ path: path.join(screenshots, `analytics-${section}-${name}.png`), fullPage: true });
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(screenshots, `analytics-${section}-${name}-viewport.png`) });
        }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#analytics-most-read-tab').click(); await settled();
    const performers = page.getByRole('region', { name: 'Top performers', exact: true });
    const historyTrigger = performers.getByRole('button', { name: 'History', exact: true }).first();
    const historyDialog = page.locator('#analytics-history-dialog');
    assert.equal(await historyDialog.isVisible(), false, 'Ranking history starts closed');
    await historyTrigger.focus();
    const historyResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/analytics/most-read/history');
    await historyTrigger.click();
    const historyData = await (await historyResponse).json();
    await historyDialog.waitFor({ state: 'visible' });
    assert.equal(await historyDialog.evaluate(dialog => dialog.open && dialog.matches(':modal')), true, 'History opens as a native modal dialog');
    assert.equal(await historyDialog.getAttribute('aria-labelledby'), 'analytics-history-dialog-title');
    assert.ok((await page.locator('#analytics-history-dialog-title').textContent()).trim(), 'History dialog has an accessible title');
    assert.equal(await page.getByRole('dialog').count(), 1, 'Only the ranking history dialog is visible');
    await page.locator('#analytics-history svg').first().waitFor();
    assert.equal(await page.locator('#analytics-history svg').count(), 2, 'Each ranking type has its own chart');
    assert.match(await page.locator('#analytics-history').textContent(), /Observed span/);
    assert.equal(await historyDialog.evaluate(dialog => dialog.contains(document.activeElement)), true, 'Opening history moves focus inside the modal');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await historyDialog.evaluate(dialog => dialog.contains(document.activeElement)), true, 'Keyboard focus stays inside the modal');
    const historyChart = page.locator('#analytics-history .analytics-chart').first();
    const firstAppearance = historyData.series[0].points.find(point => point.rank !== null);
    const historyLabel = await historyChart.locator('.analytics-chart-legend li').first().textContent();
    await checkChartTooltip(page, historyChart, { label: historyLabel, date: firstAppearance.capturedAt, value: firstAppearance.rank, rank: true });
    assert.equal(await historyDialog.evaluate(dialog => dialog.open), true, 'Escape dismisses the tooltip while preserving ranking history');
    await page.screenshot({ path: path.join(screenshots, 'analytics-history-desktop.png'), fullPage: true });
    await page.locator('#analytics-history > section').first().screenshot({ path: path.join(screenshots, 'analytics-history-chart.png') });
    await page.keyboard.press('Escape');
    await historyDialog.waitFor({ state: 'hidden' });
    await waitFor(() => historyTrigger.evaluate(trigger => document.activeElement === trigger), 'Escape restores focus to the History trigger');
    assert.equal(await historyDialog.evaluate(dialog => dialog.open), false, 'Escape closes the native dialog');
    await page.setViewportSize({ width: 390, height: 844 });
    await historyTrigger.click();
    await historyDialog.waitFor({ state: 'visible' });
    await page.locator('#analytics-history svg').first().waitFor();
    assert.equal(await page.locator('#analytics-history svg').count(), 2, 'Reopened history preserves both ranking charts');
    assert.equal(await historyDialog.evaluate(dialog => dialog.open && dialog.matches(':modal')), true, 'Reopened history remains modal');
    await checkChartTooltip(page, page.locator('#analytics-history .analytics-chart').first(), {
        label: historyLabel, date: firstAppearance.capturedAt, value: firstAppearance.rank, rank: true, touch: true,
    });
    assert.equal(await historyDialog.evaluate(dialog => dialog.open), true, 'Touch tooltip controls preserve the narrow ranking modal');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'History/narrow: no document overflow');
    assert.ok(await historyDialog.evaluate(dialog => {
        const bounds = dialog.getBoundingClientRect();
        return bounds.left >= -1 && bounds.right <= window.innerWidth + 1 && dialog.scrollWidth <= dialog.clientWidth + 1;
    }), 'History/narrow: dialog fits the window without horizontal overflow');
    await page.screenshot({ path: path.join(screenshots, 'analytics-history-narrow.png'), fullPage: true });
    await historyDialog.getByRole('button', { name: 'Close ranking history', exact: true }).click();
    await historyDialog.waitFor({ state: 'hidden' });
    await waitFor(() => historyTrigger.evaluate(trigger => document.activeElement === trigger), 'Close restores focus to the History trigger');
    assert.equal(await historyDialog.evaluate(dialog => dialog.open), false, 'Close button closes the reopened dialog');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await performers.locator('.analytics-article-title').first().click();
    await page.locator('#analytics-article-viewer').waitFor({ state: 'visible' });
    await page.frameLocator('#analytics-article-viewer-frame').getByText('Isolated Analytics article viewer fixture.').waitFor();
    await page.locator('#analytics-article-viewer-hide').click();
    await performers.getByRole('button', { name: 'Save', exact: true }).first().click();
    await page.locator('#modal-backdrop').waitFor({ state: 'visible' });
    await page.locator('#modal-cancel').click();
    assert.match(await page.getByRole('region', { name: 'Top performers', exact: true }).textContent(), /The Verge/);
    await page.locator('#analytics-publishers-tab').click(); await settled();
    await page.locator('#analytics-compare-0').selectOption('1', { force: true }); await settled();
    await page.locator('#analytics-compare-1').selectOption('2', { force: true }); await settled();
    assert.equal(await page.getByRole('region', { name: 'Publisher topic distribution', exact: true }).count(), 1);
    assert.match(await page.getByRole('region', { name: 'Publisher ranking appearance comparison', exact: true }).textContent(), /Unavailable/);
    assert.ok(await page.locator('#analytics-publishers svg').count() >= 1);
    const comparison = await (await page.request.get(`${origin}/api/analytics/publishers?period=30d&group=day&compare=1,2`)).json();
    const comparisonChart = page.locator('#analytics-publishers .analytics-chart').first();
    assert.equal(await comparisonChart.locator('.analytics-chart-series').count(), 2, 'Publisher comparison has two independent lines');
    assert.equal(await comparisonChart.locator('.analytics-chart-series').evaluateAll(groups => new Set(groups.map(group => getComputedStyle(group).color)).size), 2, 'Compared publishers use distinguishable series colors');
    for (const [index, publisher] of comparison.comparison.entries()) {
        const unique = publisher.volume.findIndex(point => !comparison.comparison.some(other => other.id !== publisher.id
            && other.volume.some(candidate => candidate.bucket === point.bucket && candidate.count === point.count)));
        const pointIndex = Math.max(0, unique), observation = publisher.volume[pointIndex];
        await checkChartTooltip(page, comparisonChart, { series: index, pointIndex, keyboard: false,
            label: publisher.name, date: observation.bucket, value: observation.count });
    }
    await page.getByRole('heading', { name: 'Compare publishers', exact: true }).locator('..').screenshot({ path: path.join(screenshots, 'analytics-publisher-comparison.png') });
    await page.locator('#analytics-trends-tab').click(); await settled();
    const topics = page.locator('#analytics-trends .oj-multiselect');
    await topics.locator('button[aria-expanded]').first().click();
    await topics.getByRole('checkbox', { name: 'Artificial intelligence', exact: true }).check();
    await topics.getByRole('checkbox', { name: 'Security', exact: true }).check();
    await page.locator('#analytics-apply-topics').click();
    await settled();
    assert.match(await page.locator('#analytics-trends').textContent(), /Artificial intelligence/);
    await choose('period', '7d'); await settled();
    await choose('publisher', '1'); await settled();
    await page.locator('#analytics-overview-tab').click(); await settled();
    assert.equal(await page.locator('#analytics-period').inputValue(), '7d');
    assert.equal(await page.locator('#analytics-publisher').inputValue(), '1');
    await choose('group', 'week'); await settled();
    await choose('topic', 'analytics-security'); await settled();
    await page.locator('#analytics-topics-tab').click(); await settled();
    assert.match(await page.locator('#analytics-topics').textContent(), /Security/);
    await choose('topic', ''); await settled(); await choose('publisher', ''); await settled(); await choose('period', '30d'); await settled();
    await page.locator('#analytics-overview-tab').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#analytics-trends-tab').getAttribute('aria-selected'), 'true');
    await settled();
    await page.locator('#home-trigger').click();
    assert.equal(await page.locator('#view-main').isVisible(), true);
    for (const view of ['digest', 'rankings', 'watchdog', 'settings']) {
        await page.locator(`.nav [data-view="${view}"]`).click();
        await page.locator(`#view-${view}`).waitFor({ state: 'visible' });
    }
    assert.deepEqual(errors, []);
    console.log(`Analytics ${engine.name()} browser checks passed: five real-data sections, OJ theme/tabs, shared filters, connected charts with hover/touch/keyboard tooltips, modal ranking history with focus restoration, preserved existing views and desktop/narrow layouts. Screenshots: ${screenshots}`);
} catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) await page.screenshot({ path: path.join(screenshots, 'analytics-failure.png'), fullPage: true }).catch(() => {});
    console.error(`Analytics QA failure; screenshots: ${screenshots}; browser errors: ${JSON.stringify(errors)}; backend: ${output.slice(-3000)}`);
    throw error;
} finally {
    await browser?.close();
    if (backend && backend.exitCode === null) {
        const exited = once(backend, 'exit'); backend.stdin.end();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
        if (backend.exitCode === null) backend.kill();
    }
    await rm(directory, { recursive: true, force: true });
}
