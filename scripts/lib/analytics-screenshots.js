export const ANALYTICS_SCREENSHOTS = Object.freeze([
    'analytics_overview.webp',
    'analytics_filters.webp',
    'analytics_trends.webp',
    'analytics_topic_momentum.webp',
    'analytics_publishers.webp',
    'analytics_publisher_comparison.webp',
    'analytics_most_read.webp',
    'analytics_ranking_history.webp',
    'analytics_ranking_movement.webp',
    'analytics_ranking_details.webp',
    'analytics_topics.webp',
    'analytics_topic_details.webp',
    'analytics_article_viewer.webp',
    'analytics_save_article.webp',
]);

const sections = ['overview', 'trends', 'publishers', 'most-read', 'topics'];
const array = value => Array.isArray(value) ? value : [];

/** Capture the actual Analytics UI from the supplied, existing library snapshot. */
export async function captureAnalytics(page, url, errors, capture) {
    const origin = new URL(url).origin;
    const completed = new Set();
    const blockedWrites = [];
    let groupId = 0;
    const apiPattern = requestUrl => requestUrl.origin === origin && requestUrl.pathname.startsWith('/api/');
    const guard = async route => {
        const request = route.request();
        const method = request.method();
        const pathname = new URL(request.url()).pathname;
        // This existing POST only reads list membership; no Save confirmation occurs.
        const readOnlyPost = method === 'POST' && pathname === '/api/articles/lists/bulk';
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !readOnlyPost) {
            blockedWrites.push(`${method} ${pathname}`);
            await route.abort('blockedbyclient');
            return;
        }
        await route.fallback();
    };

    function requireData(condition, message) {
        if (!condition) throw new Error(`Analytics screenshots: ${message}`);
        if (blockedWrites.length) throw new Error(`Analytics screenshots blocked an unexpected write: ${blockedWrites.join(', ')}`);
        if (errors.length) throw new Error(errors.join('\n'));
    }

    async function readApi(pathname, params = {}) {
        const endpoint = new URL(pathname, origin);
        for (const [key, value] of Object.entries(params)) if (value !== '' && value !== null && value !== undefined) endpoint.searchParams.set(key, String(value));
        return page.evaluate(async href => {
            const response = await fetch(href, { credentials: 'same-origin' });
            if (!response.ok) throw new Error(`Could not read stored screenshot data: HTTP ${response.status} ${new URL(href).pathname}`);
            return response.json();
        }, endpoint.href);
    }

    async function stableCharts(scope = '#view-analytics') {
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        await page.waitForFunction(selector => [...document.querySelectorAll(`${selector} .analytics-chart-plot`)].every(plot => {
            if (!plot.getClientRects().length || !plot.clientWidth) return true;
            const svg = plot.querySelector('svg');
            return svg && Math.abs(svg.viewBox.baseVal.width - Math.max(360, Math.floor(plot.clientWidth))) <= 1;
        }), scope);
        requireData(true, 'Charts did not settle.');
    }

    async function settled(section) {
        requireData(sections.includes(section), `Unknown section: ${section}`);
        await page.locator(`#analytics-${section}`).waitFor({ state: 'visible' });
        await page.waitForFunction(name => {
            const target = document.getElementById(`analytics-${name}`);
            const status = document.getElementById('analytics-status')?.textContent?.trim();
            const failure = target?.querySelector('.oj-status-danger');
            if (failure) throw new Error(failure.textContent);
            return target && target.getAttribute('aria-busy') === 'false' && status === '' && target.querySelector('.analytics-panel, .analytics-metric');
        }, section);
        await stableCharts(`#analytics-${section}`);
    }

    async function section(name) {
        await page.locator(`#analytics-${name}-tab`).click();
        await settled(name);
    }

    async function choose(name, value, currentSection) {
        const select = page.locator(`#analytics-${name}`);
        if (await select.inputValue() !== String(value)) await select.selectOption(String(value), { force: true });
        await settled(currentSection);
    }

    async function filters(period, currentSection, { publisher = '', topic = '', group = 'day' } = {}) {
        await choose('topic', '', currentSection);
        await choose('publisher', '', currentSection);
        await choose('period', period, currentSection);
        await choose('group', group, currentSection);
        if (publisher) await choose('publisher', publisher, currentSection);
        if (topic) await choose('topic', topic, currentSection);
    }

    function panel(name, sectionName) {
        return page.locator(`#analytics-${sectionName} .analytics-panel`).filter({ has: page.getByRole('heading', { name, exact: true }) });
    }

    async function shot(filename, options = {}) {
        requireData(ANALYTICS_SCREENSHOTS.includes(filename), `Unexpected output: ${filename}`);
        await capture(page, filename, errors, options);
        completed.add(filename);
    }

    // Mark original locations, so even non-adjacent panels return to exactly the
    // same position if capture fails. Only existing rendered product UI is moved.
    async function groupShot(filename, locators) {
        const elements = await Promise.all(locators.map(locator => locator.elementHandle()));
        requireData(elements.every(Boolean), `Missing existing panels for ${filename}.`);
        const id = `analytics-screenshot-group-${++groupId}`;
        await page.evaluate(({ elements, id }) => {
            const parent = elements[0].parentElement;
            if (!parent || elements.some(element => element.parentElement !== parent)) throw new Error('Screenshot panels must share a parent.');
            const wrapper = document.createElement('div');
            wrapper.id = id; wrapper.className = 'analytics-section';
            elements[0].before(wrapper);
            wrapper.screenshotOrigins = elements.map(element => {
                const marker = document.createComment('analytics screenshot original position');
                element.before(marker); wrapper.append(element);
                return { marker, element };
            });
        }, { elements, id });
        try {
            const target = page.locator(`#${id}`);
            await target.scrollIntoViewIfNeeded();
            await stableCharts(`#${id}`);
            await shot(filename, { target, preserveInteraction: true });
        } finally {
            await page.evaluate(id => {
                const wrapper = document.getElementById(id);
                for (const { marker, element } of wrapper?.screenshotOrigins || []) marker.replaceWith(element);
                wrapper?.remove();
            }, id);
            await Promise.all(elements.map(element => element.dispose()));
        }
    }

    async function tooltipOn(chart) {
        await chart.scrollIntoViewIfNeeded();
        const index = await chart.locator('.analytics-chart-point').evaluateAll(points => {
            if (!points.length) return -1;
            const width = points[0].ownerSVGElement.viewBox.baseVal.width;
            const middle = width / 2;
            const records = points.map((point, index) => ({ index, x: Number(point.getAttribute('cx')), y: Number(point.getAttribute('cy')) }));
            const aboveBaseline = records.filter(point => point.y < 247);
            return (aboveBaseline.length ? aboveBaseline : records).sort((a, b) => Math.abs(a.x - middle) - Math.abs(b.x - middle) || a.y - b.y)[0].index;
        });
        requireData(index >= 0, 'The selected chart has no actual data points for its tooltip.');
        await chart.locator('.analytics-chart-point').nth(index).evaluate(point => point.focus({ preventScroll: true }));
        await chart.locator('.analytics-chart-tooltip:not([hidden])').waitFor({ state: 'visible' });
    }

    async function dismissTooltip() {
        if (await page.locator('.analytics-chart-tooltip:not([hidden])').count()) await page.keyboard.press('Escape');
    }

    async function withViewerEmbedding(captureViewer) {
        const external = requestUrl => requestUrl.origin !== origin && ['http:', 'https:'].includes(requestUrl.protocol);
        const embed = async route => {
            const request = route.request();
            if (!request.isNavigationRequest() || request.resourceType() !== 'document') { await route.fallback(); return; }
            const frame = request.frame();
            if (frame === page.mainFrame()) {
                console.warn(`Prevented a publisher from replacing the screenshot app: ${request.url()}`);
                await route.abort('blockedbyclient'); return;
            }
            if (frame.parentFrame() !== page.mainFrame()) { await route.fallback(); return; }
            // Screenshot-only adaptation for the browser iframe. The desktop
            // product opens the same original URL in its own top-level WebView.
            // Preserve redirects, status, response bytes and every other header.
            try {
                const response = await route.fetch({ maxRedirects: 0 });
                const headers = response.headers();
                for (const name of Object.keys(headers)) {
                    if (name.toLowerCase() === 'x-frame-options') delete headers[name];
                    else if (name.toLowerCase() === 'content-security-policy') {
                        const policy = headers[name].replace(/(^|[;,\r\n])[\t ]*frame-ancestors(?:[\t ]+[^;,\r\n]*)?(?=[;,\r\n]|$)/giu, '$1');
                        if (policy.replace(/[;,\s]/gu, '')) headers[name] = policy;
                        else delete headers[name];
                    }
                }
                await route.fulfill({ response, headers });
            } catch (error) {
                console.warn(`Original publisher document unavailable: ${request.url()} — ${error.message.split('\n')[0]}`);
                await route.abort('failed').catch(() => {});
            }
        };
        await page.route(external, embed);
        try { return await captureViewer(); }
        finally { await page.unroute(external, embed); }
    }

    async function captureRealArticleViewer(rankings, period, preferredPublishers = []) {
        const failures = [];
        const attemptedUrls = new Set();
        const priority = new Map(preferredPublishers.map((publisher, index) => [Number(publisher.id), index]));
        const viewerPublishers = [...array(rankings.publishers)].sort((a, b) => (priority.get(Number(a.id)) ?? Number.MAX_SAFE_INTEGER) - (priority.get(Number(b.id)) ?? Number.MAX_SAFE_INTEGER));
        await section('most-read');
        for (const publisher of viewerPublishers) {
            const stored = await readApi('/api/analytics/most-read', { period, publisher: publisher.id, sort: 'lastCaptured', direction: 'desc', limit: 200 });
            const candidates = array(stored.topPerformers).map((row, index) => ({ ...row, index })).filter(row => Number(row.articleId) > 0 && !attemptedUrls.has(row.canonicalUrl));
            const distinct = candidates.filter((row, index, all) => all.findIndex(other => other.canonicalUrl === row.canonicalUrl) === index).slice(0, 2);
            for (const candidate of distinct) {
                attemptedUrls.add(candidate.canonicalUrl);
                await filters(period, 'most-read', { publisher: publisher.id });
                const performers = panel('Top performers', 'most-read');
                const sort = performers.getByRole('button', { name: /^Last observed/ });
                for (let attempt = 0; attempt < 2 && await sort.locator('..').getAttribute('aria-sort') !== 'descending'; attempt += 1) { await sort.click(); await settled('most-read'); }
                requireData(await sort.locator('..').getAttribute('aria-sort') === 'descending', 'Could not sort actual local ranking rows by their last observation.');
                for (let offset = 0; offset < Math.floor(candidate.index / 40); offset += 1) {
                    await performers.locator('.analytics-pagination').getByRole('button', { name: 'Next page', exact: true }).click(); await settled('most-read');
                }
                if (candidate.index % 40 >= 20) await performers.getByRole('button', { name: 'Next page of Top performers', exact: true }).click();
                const row = performers.locator('tbody tr').filter({ hasText: candidate.sourceName }).filter({ has: page.getByRole('button', { name: candidate.title, exact: true }) }).first();
                await row.waitFor({ state: 'visible' });
                console.log(`Trying actual publisher iframe: ${publisher.name} — ${candidate.canonicalUrl}`);
                let ready = false;
                let reason;
                try {
                    const stopWords = new Set(['werden', 'wurde', 'haben', 'einer', 'einem', 'einen', 'eines', 'dieser', 'diese', 'dieses', 'nicht', 'durch', 'unter', 'about', 'their', 'these', 'those', 'which', 'would', 'could', 'should', 'after', 'before', 'there', 'being']);
                    const titleWords = [...new Set((candidate.title || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
                    const significant = titleWords.filter(word => word.length >= 5 && !stopWords.has(word));
                    const expectedWords = significant.length ? significant : titleWords.filter(word => word.length >= 3 && !stopWords.has(word));
                    if (!expectedWords.length) throw new Error('The stored headline has no significant words to verify against the real publisher page.');
                    // A failed embedding can also emit DOMContentLoaded. Inspect the
                    // actual frame protocol and rendered body before accepting it.
                    const navigated = page.waitForEvent('framenavigated', { predicate: frame => frame.parentFrame() === page.mainFrame() && frame.url() !== 'about:blank', timeout: 12000 }).catch(() => null);
                    await row.locator('.analytics-article-title').click();
                    await page.locator('#analytics-article-viewer').waitFor({ state: 'visible' });
                    const frame = await navigated;
                    if (!frame) throw new Error('The publisher iframe did not navigate.');
                    if (!/^https?:/iu.test(frame.url())) throw new Error(`Embedding failed: ${frame.url()}`);
                    await frame.waitForLoadState('domcontentloaded', { timeout: 8000 });
                    const rendered = await frame.waitForFunction(expectedWords => {
                        if (!['http:', 'https:'].includes(location.protocol)) return { usable: false, reason: `Embedding failed: ${location.href}` };
                        const title = document.title.trim();
                        if (/^(?:access denied|just a moment|attention required|403 forbidden|404 not found|zugriff verweigert)/iu.test(title)) return { usable: false, reason: `Publisher restriction: ${title}` };
                        const body = document.body;
                        const text = body?.innerText?.replace(/\s+/gu, ' ').trim() || '';
                        if (!body || body.getBoundingClientRect().width <= 0 || body.getBoundingClientRect().height <= 0 || text.length < 200) return false;
                        const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
                        const score = value => expectedWords.filter(word => normalize(value).includes(word)).length / expectedWords.length;
                        const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
                        const dialogs = [...document.querySelectorAll('dialog[open],[aria-modal="true"],[role="dialog"]')].filter(visible);
                        if (dialogs.some(dialog => /cookie|consent|einwillig|zustimm|privacy|tracking|abonn|subscription|subscribe|paywall/iu.test(dialog.innerText))) return false;
                        const headings = [...document.querySelectorAll('h1, article h2, [role="heading"][aria-level="1"]')];
                        const headingIndex = headings.findIndex(heading => visible(heading) && score(heading.innerText) >= 0.6);
                        // A correctly titled consent/loading document is still not
                        // an article: the headline must also be in rendered content.
                        if (headingIndex < 0 && !(score(title) >= 0.6 && score(text) >= 0.6)) return false;
                        return { usable: true, title, length: text.length, href: location.href, headingIndex };
                    }, expectedWords, { timeout: 8000 });
                    const result = await rendered.jsonValue(); await rendered.dispose();
                    if (!result.usable) throw new Error(result.reason);
                    if (result.headingIndex >= 0) await frame.locator('h1, article h2, [role="heading"][aria-level="1"]').nth(result.headingIndex).scrollIntoViewIfNeeded();
                    await frame.evaluate(async () => {
                        let deadline;
                        try {
                            const images = [...document.images].filter(image => {
                                const bounds = image.getBoundingClientRect();
                                return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight;
                            });
                            await Promise.race([
                                Promise.all([document.fonts.ready, ...images.map(image => image.decode().catch(() => {}))]),
                                new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Publisher fonts/images did not settle.')), 5000); }),
                            ]);
                        } finally { clearTimeout(deadline); }
                        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    });
                    console.log(`Actual publisher iframe rendered: ${result.title} (${result.length} visible characters).`);
                    ready = true;
                } catch (error) {
                    reason = `${publisher.name}: ${error.message.split('\n')[0]}`;
                    failures.push(`${reason} [${candidate.canonicalUrl}]`);
                    console.warn(`Skipping unavailable publisher iframe — ${reason}`);
                    const currentFrame = page.frames().find(frame => frame.parentFrame() === page.mainFrame() && /^https?:/iu.test(frame.url()));
                    if (currentFrame) {
                        const diagnostic = await currentFrame.evaluate(() => ({
                            url: location.href,
                            title: document.title,
                            headings: [...document.querySelectorAll('h1')].map(heading => heading.innerText.trim()).filter(Boolean).slice(0, 5),
                            bodyStart: (document.body?.innerText || '').replace(/\s+/gu, ' ').trim().slice(0, 200),
                        })).catch(() => null);
                        if (diagnostic) console.warn(`Actual publisher iframe diagnostic: ${JSON.stringify(diagnostic)}`);
                    }
                }
                if (ready) {
                    await shot('analytics_article_viewer.webp');
                    await page.locator('#analytics-article-viewer-hide').click();
                    return;
                }
                const hide = page.locator('#analytics-article-viewer-hide');
                if (await hide.isVisible()) await hide.click();
                // A browser-generated embedding error is a host restriction,
                // rather than a reason to try another article on the same host.
                if (/Embedding failed:/u.test(reason || '')) break;
            }
        }
        throw new Error(`Analytics screenshots: none of the representative stored local articles rendered a meaningful real publisher iframe. No blank viewer image was saved. Attempts:\n${failures.join('\n') || 'No mapped local article URLs were available.'}`);
    }

    await page.route(apiPattern, guard);
    try {
        const metadata = await readApi('/api/analytics/filters');
        requireData(array(metadata.publishers).length >= 2, 'At least two stored publishers are needed for the comparison screenshots.');
        requireData(array(metadata.topics).length > 0, 'Stored topic classifications are needed for the topic screenshots.');

        let period, overview;
        for (const candidate of ['30d', '90d', 'all']) {
            const data = await readApi('/api/analytics/overview', { period: candidate });
            if (Number(data.kpis?.periodArticles) > 0 && array(data.volume).length) { period = candidate; overview = data; break; }
        }
        requireData(overview, 'No stored articles are available. Collect actual articles before generating Analytics screenshots.');
        requireData(array(overview.topTopics).some(topic => topic.count > 0), 'No classified articles are available in the selected period.');
        const [publishers, topicData] = await Promise.all([
            readApi('/api/analytics/publishers', { period }),
            readApi('/api/analytics/topics', { period }),
        ]);
        const availablePublishers = array(publishers.publishers).filter(item => item.periodArticles > 0);
        availablePublishers.sort((a, b) => Number(b.rankingSupported) - Number(a.rankingSupported) || Number(b.rankedArticles || 0) - Number(a.rankedArticles || 0) || b.periodArticles - a.periodArticles);
        requireData(availablePublishers.length >= 2, 'Two publishers with actual articles in the selected period are required.');
        const pair = availablePublishers.slice(0, 2);
        const topicCandidates = array(topicData.topics).filter(item => item.count > 0 && array(metadata.topics).some(option => option.slug === item.slug));
        const topics = topicCandidates.slice(0, 3);
        requireData(topics.length > 0, 'No selectable topic has articles in this period.');

        await page.locator('.nav-link[data-view="analytics"]').click();
        await section('overview'); await filters(period, 'overview');
        await shot('analytics_overview.webp');

        const filterPeriod = period === 'all' ? 'all' : '90d';
        const publisherOverview = await readApi('/api/analytics/overview', { period: filterPeriod, publisher: pair[0].id });
        const filterTopic = array(publisherOverview.topTopics).find(topic => topic.count > 0);
        requireData(filterTopic, 'The selected publisher has no stored topics for the shared-filter screenshot.');
        await filters(filterPeriod, 'overview', { publisher: pair[0].id, topic: filterTopic.slug, group: 'week' });
        await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
        await tooltipOn(page.locator('#analytics-overview .analytics-chart').first());
        await shot('analytics_filters.webp', { preserveInteraction: true });
        await dismissTooltip(); await filters(period, 'overview');

        await section('trends');
        const multiselect = page.locator('#analytics-trends .oj-multiselect');
        await multiselect.locator('button[aria-expanded]').first().click();
        const checked = multiselect.locator('input[type="checkbox"]:checked');
        while (await checked.count()) await checked.first().uncheck();
        for (const topic of topics) {
            const index = await multiselect.locator('input[type="checkbox"]').evaluateAll((inputs, slug) => inputs.findIndex(input => input.value === slug), topic.slug);
            requireData(index >= 0, `Stored topic ${topic.slug} is missing from the multiselect.`);
            await multiselect.locator('input[type="checkbox"]').nth(index).check();
        }
        await page.locator('#analytics-apply-topics').click(); await settled('trends');
        const trendData = await readApi('/api/analytics/trends', { period, topics: topics.map(topic => topic.slug).join(',') });
        requireData(array(trendData.topicSeries).some(item => array(item.points).some(point => point.count > 0)), 'Selected topic trends have no actual article counts.');
        await shot('analytics_trends.webp', { target: panel('Topic trends', 'trends') });
        requireData(array(trendData.momentum).length > 0, 'Topic momentum requires articles within a rolling 7/30/90-day period; All time has no comparable preceding period.');
        await groupShot('analytics_topic_momentum.webp', [panel('Topic momentum', 'trends'), panel('Emerging topics', 'trends')]);

        await section('publishers'); await shot('analytics_publishers.webp', { target: panel('Publishers', 'publishers') });
        await choose('compare-0', pair[0].id, 'publishers');
        await choose('compare-1', pair[1].id, 'publishers');
        await page.locator('#analytics-publishers .analytics-comparison-results').waitFor({ state: 'visible' });
        const comparison = await readApi('/api/analytics/publishers', { period, compare: pair.map(item => item.id).join(',') });
        requireData(array(comparison.comparison).length === 2 && comparison.comparison.every(item => array(item.volume).some(point => point.count > 0)), 'The selected publisher comparison has no actual publication volume.');
        await shot('analytics_publisher_comparison.webp', { target: panel('Compare publishers', 'publishers') });

        let rankingPeriod, rankings;
        for (const candidate of [...new Set([period, '90d', 'all'])]) {
            const data = await readApi('/api/analytics/most-read', { period: candidate, sort: 'snapshotAppearances', direction: 'desc', limit: 200 });
            if (Number(data.metrics?.snapshots) > 0 && array(data.topPerformers).length) { rankingPeriod = candidate; rankings = data; break; }
        }
        requireData(rankings, 'No retained publisher rankings are available. Collect actual ranking history before generating these screenshots.');
        await section('most-read'); await filters(rankingPeriod, 'most-read');
        await shot('analytics_most_read.webp');
        requireData(array(rankings.movements?.climbers).length + array(rankings.movements?.decliners).length > 0, 'No actual ranking position changes exist between retained consecutive snapshots.');
        await groupShot('analytics_ranking_movement.webp', [panel('Climbers', 'most-read'), panel('Decliners', 'most-read')]);
        requireData(array(rankings.longestRunning).length && array(rankings.topicPerformance).length && array(rankings.publishers).length, 'Ranking details require retained appearances and matched local topic classifications.');
        await groupShot('analytics_ranking_details.webp', [panel('Longest running', 'most-read'), panel('Topic performance in rankings', 'most-read'), panel('Publishers with ranking data', 'most-read')]);

        const topPanel = panel('Top performers', 'most-read');
        const sort = topPanel.getByRole('button', { name: /^Snapshot appearances/ });
        for (let attempt = 0; attempt < 2 && await sort.locator('..').getAttribute('aria-sort') !== 'descending'; attempt += 1) { await sort.click(); await settled('most-read'); }
        requireData(await sort.locator('..').getAttribute('aria-sort') === 'descending', 'Could not sort the existing Top performers table by captured appearances.');
        const candidates = array(rankings.topPerformers).map((row, index) => ({ ...row, index })).filter(row => Number(row.articleId) > 0 && Number(row.snapshotAppearances) >= 2);
        const typeCount = row => new Set(array(rankings.topPerformers).filter(other => other.sourceId === row.sourceId && other.canonicalUrl === row.canonicalUrl).map(other => other.rankingKey)).size;
        candidates.sort((a, b) => typeCount(b) - typeCount(a) || b.snapshotAppearances - a.snapshotAppearances || a.index - b.index);
        const article = candidates[0];
        requireData(article, 'A matched local ranked article with at least two observed appearances is needed for history, viewer and Save screenshots.');
        const history = await readApi('/api/analytics/most-read/history', { period: rankingPeriod, sourceId: article.sourceId, url: article.canonicalUrl });
        requireData(array(history.series).some(item => array(item.points).filter(point => point.rank !== null).length >= 2), 'The selected article has insufficient retained history points.');
        for (let offset = 0; offset < Math.floor(article.index / 40); offset += 1) {
            await topPanel.locator('.analytics-pagination').getByRole('button', { name: 'Next page', exact: true }).click(); await settled('most-read');
        }
        if (article.index % 40 >= 20) await topPanel.getByRole('button', { name: 'Next page of Top performers', exact: true }).click();
        const articleRow = topPanel.locator('tbody tr').filter({ hasText: article.sourceName }).filter({ has: page.getByRole('button', { name: article.title, exact: true }) }).first();
        await articleRow.waitFor({ state: 'visible' });
        await articleRow.getByRole('button', { name: 'History', exact: true }).click();
        const historyDialog = page.locator('#analytics-history-dialog');
        await historyDialog.waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.getElementById('analytics-history')?.getAttribute('aria-busy') === 'false' && document.querySelector('#analytics-history .analytics-chart-point'));
        await stableCharts('#analytics-history-dialog');
        await tooltipOn(historyDialog.locator('.analytics-chart').first());
        await shot('analytics_ranking_history.webp', { target: historyDialog, preserveInteraction: true });
        await dismissTooltip(); await page.locator('#analytics-history-close').click();
        await historyDialog.waitFor({ state: 'hidden' });

        await articleRow.getByRole('button', { name: 'Save', exact: true }).click();
        await page.locator('#modal-backdrop').waitFor({ state: 'visible' });
        await shot('analytics_save_article.webp', { target: page.locator('#modal-backdrop') });
        await page.locator('#modal-cancel').click();
        await page.locator('#modal-backdrop').waitFor({ state: 'hidden' });

        await section('topics'); await filters(period, 'topics');
        let selectedTopic, selectedTopicData;
        for (const candidate of topicCandidates) {
            const data = await readApi('/api/analytics/topics', { period, topic: candidate.slug });
            if (data.kpis?.totalArticles > 0 && array(data.cooccurrence).length && array(data.rankings).length) { selectedTopic = candidate; selectedTopicData = data; break; }
        }
        requireData(selectedTopicData, 'Topic drilldown screenshots need an existing topic with co-occurring classifications and matched ranking appearances.');
        await choose('topic', selectedTopic.slug, 'topics');
        await groupShot('analytics_topics.webp', [page.locator('#analytics-topics > .analytics-metrics'), panel('Top topics', 'topics'), panel('Topic coverage over time', 'topics')]);
        await groupShot('analytics_topic_details.webp', [panel('Topic momentum', 'topics'), panel('Topic co-occurrence', 'topics'), panel('Ranking appearances for matching articles', 'topics')]);
        await withViewerEmbedding(() => captureRealArticleViewer(rankings, rankingPeriod, pair));
        requireData(completed.size === ANALYTICS_SCREENSHOTS.length, `Expected ${ANALYTICS_SCREENSHOTS.length} screenshots; completed ${completed.size}.`);
        console.log(`Analytics screenshots use real ${period} article data, publisher comparison ${pair.map(item => item.name).join(' / ')}, ${rankingPeriod} ranking captures and topic ${selectedTopic.label}.`);
    } finally {
        await dismissTooltip().catch(() => {});
        for (const selector of ['#analytics-history-close', '#modal-cancel']) {
            const close = page.locator(selector);
            if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
        }
        await page.unroute(apiPattern, guard);
    }
}
