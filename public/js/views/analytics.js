import { api } from '../api/client.js';
import { createAnalyticsChart } from '../components/analytics-chart.js';
import { analyticsElement as el, createAnalyticsEmpty, createAnalyticsMetrics, createAnalyticsPanel } from '../components/analytics-metric.js';
import { createAnalyticsTable } from '../components/analytics-table.js';
import { openArticle, openExternal } from '../services/article-viewer.js';
import { store } from '../state/store.js';
import { createMultiselect, initOJ } from '../ui/design-system.js';
import { openListModal } from '../ui/modal.js';
import { initSelectDropdowns, setSelectValue } from '../ui/select-dropdown.js';
import { analyticsChange, analyticsGrowth, analyticsNumber as number, analyticsPercent as percent, analyticsRequestKey, analyticsSpan } from '../utils/analytics.js';
import { isAbortError } from '../utils/data.js';
import { formatDate, normalizeArticleUrl } from '../utils/format.js';

const sections = ['overview', 'trends', 'publishers', 'most-read', 'topics', 'library'];
const rankingLabels = { most_read: 'Most read', most_commented: 'Most commented', top_news: 'Top news · editorial' };
const RANKING_PAGE_SIZE = 40;
const HISTORY_PAGE_SIZE = 1000;
const panelCleanups = new Map();
let initialized = false;
let requestController = null;
let requestId = 0;
let historyController = null;
let historyRequestId = 0;
let metadataController = null;
let metadata = null;
let metadataPromise = null;
let metadataError = false;
const historyCache = new Map();

function state() {
    const analytics = store.analytics ||= {};
    analytics.section ||= 'overview';
    analytics.filters ||= { period: '30d', publisher: '', topic: '', group: 'day', basis: 'publishedAt', rankingKey: 'all' };
    analytics.cache ||= new Map(); analytics.articlesById ||= new Map();
    analytics.topicSelections ||= [];
    analytics.compare ||= ['', ''];
    analytics.rankingSort ||= { key: 'bestRank', direction: 'asc' };
    analytics.rankingOffset ||= 0;
    analytics.historyOffset ||= 0;
    return analytics;
}

const root = () => document.getElementById('view-analytics');
const panel = () => document.getElementById(`analytics-${state().section}`);
const active = () => store.ui.activeView === 'analytics';
const rows = value => Array.isArray(value) ? value : [];
const rankLabel = key => rankingLabels[key] || String(key || 'Unknown ranking type');
const rankValue = value => value === null || value === undefined ? 'Absent' : `#${number(value)}`;
const countColumn = (key, label = key) => ({ key, label, numeric: true, render: row => number(row[key]) });
const percentColumn = (key, label, ratio = false) => ({ key, label, numeric: true, render: row => percent(row[key], { ratio }) });
const dateColumn = (key, label) => ({ key, label, render: row => formatDate(row[key]) });

function button(label, callback, className = 'oj-button oj-button-ghost oj-button-compact') {
    const node = el('button', className, label); node.type = 'button'; node.addEventListener('click', callback); return node;
}

function paramsFor(section = state().section) {
    const current = state();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(current.filters)) {
        if (value !== '' && value !== undefined && value !== null && (key !== 'rankingKey' || section === 'most-read')) params.set(key, value);
    }
    if (section === 'trends' && current.topicSelections.length) params.set('topics', current.topicSelections.join(','));
    if (section === 'publishers' && current.compare.every(Boolean)) params.set('compare', current.compare.join(','));
    if (section === 'most-read') {
        params.set('sort', current.rankingSort.key); params.set('direction', current.rankingSort.direction);
        params.set('limit', String(RANKING_PAGE_SIZE)); params.set('offset', String(current.rankingOffset));
    }
    return params;
}

function clearHistoryRequest() { historyController?.abort(); historyController = null; ++historyRequestId; }

function changeFilters(patch) {
    Object.assign(state().filters, patch);
    state().rankingOffset = 0; state().historyOffset = 0; state().selectedHistory = null;
    clearHistoryRequest(); syncFilterControls(); void loadCurrent();
}

function setOptions(select, options, fallbackLabel) {
    const previous = select.value || state().filters[select.id.replace('analytics-', '')] || '';
    const nodes = options.map(option => { const node = document.createElement('option'); node.value = String(option.value); node.textContent = option.label; return node; });
    if (previous && !options.some(option => String(option.value) === previous)) {
        const option = document.createElement('option'); option.value = previous; option.textContent = `${fallbackLabel}: ${previous}`; nodes.push(option);
    }
    select.replaceChildren(...nodes); setSelectValue(select, previous);
}

function syncFilterControls() {
    for (const key of ['period', 'publisher', 'topic', 'group', 'basis']) {
        const select = document.getElementById(`analytics-${key}`);
        if (select) setSelectValue(select, state().filters[key] || (key === 'period' ? '30d' : ''));
    }
}

async function loadMetadata(force = false) {
    if (metadata && !force) return metadata;
    if (metadataPromise) return metadataPromise;
    const controller = new AbortController(); metadataController = controller;
    const promise = (async () => {
        try {
            const data = await api.analyticsFilters(controller.signal);
            if (controller.signal.aborted) return null;
            metadata = data; metadataError = false;
            const publisher = document.getElementById('analytics-publisher'), topic = document.getElementById('analytics-topic');
            setOptions(publisher, [{ value: '', label: 'All publishers' }, ...rows(data.publishers).map(item => ({ value: item.id, label: item.name }))], 'Publisher');
            setOptions(topic, [{ value: '', label: 'All topics' }, ...rows(data.topics).map(item => ({ value: item.slug, label: item.label }))], 'Topic');
            syncFilterControls(); return data;
        } catch (error) {
            if (!isAbortError(error)) {
                metadataError = true;
                const status = document.getElementById('analytics-status');
                status.textContent = 'Filter choices could not be loaded. Refresh Analytics to retry.';
            }
            return null;
        } finally { if (metadataController === controller) metadataController = null; if (metadataPromise === promise) metadataPromise = null; }
    })();
    metadataPromise = promise; return promise;
}

function selectControl(id, label, options, value, onChange) {
    const field = el('div', 'oj-field'); const text = el('label', 'oj-label', label); text.htmlFor = id;
    const select = document.createElement('select'); select.id = id; select.setAttribute('data-oj-select-dropdown', '');
    options.forEach(item => { const option = document.createElement('option'); option.value = String(item.value); option.textContent = item.label; option.selected = String(item.value) === String(value); select.append(option); });
    // Let the shared dropdown close and return focus before replacing its panel.
    select.addEventListener('change', () => queueMicrotask(() => onChange(select.value))); field.append(text, select); return field;
}

function tablePanel(title, data, columns, options = {}) {
    const section = createAnalyticsPanel(title, options.description || '');
    section.append(createAnalyticsTable({ title, rows: rows(data), columns, ...options })); return section;
}

function chartPanel(title, points, description = '') {
    const section = createAnalyticsPanel(title);
    section.append(createAnalyticsChart({ title, series: [{ label: 'Articles', points: rows(points) }], description })); return section;
}

function grid(...children) { const node = el('div', 'analytics-grid'); node.append(...children); return node; }

function metadataNotes(data) {
    const container = el('div', 'analytics-metadata');
    const coverage = data.metadata?.coverage || data.coverage;
    const notes = [];
    if (coverage && typeof coverage === 'object') for (const [key, value] of Object.entries(coverage)) {
        const groups = Array.isArray(value) ? value : [value];
        for (const group of groups) if (group?.truncated) notes.push(`${group.slug || key}: ${number(group.returned)} of ${number(group.total)} results shown`);
    }
    if (notes.length) container.append(el('p', 'analytics-coverage oj-helper', `${notes.join(' · ')}. Tables sort the loaded results. Narrow the filters to inspect smaller groups.`));
    const definitions = data.metadata?.definitions || data.methodology;
    const explanation = typeof definitions === 'string' ? [definitions] : Array.isArray(definitions) ? definitions : definitions && typeof definitions === 'object' ? Object.entries(definitions).flatMap(([key, value]) => typeof value === 'string' ? [`${key.replace(/([a-z])([A-Z])/gu, '$1 $2')}: ${value}`] : []) : [];
    if (explanation.length) {
        const details = el('details', 'analytics-definitions'); details.append(el('summary', 'oj-link', 'Metric definitions and coverage'));
        const list = el('ul', 'oj-bullet-list'); explanation.forEach(value => list.append(el('li', '', value))); details.append(list); container.append(details);
    }
    return container;
}

function momentumTable(data, title = 'Topic momentum', description = '') {
    return tablePanel(title, data, [
        { key: 'label', label: 'Topic' }, countColumn('previous', 'Previous'), countColumn('current', 'Current'),
        { key: 'change', label: 'Change', numeric: true, render: row => analyticsChange(row.change) },
        { key: 'percentChange', label: 'Growth', numeric: true, render: row => analyticsGrowth(row.percentChange, row.previous, row.current) },
    ], { description, empty: 'No comparable topic counts are available. All time has no immediately preceding period; choose 7, 30 or 90 days.' });
}

function renderOverview(data, target) {
    const k = data.kpis || {};
    target.append(createAnalyticsMetrics([
        { label: 'Total articles', value: k.totalArticles, note: 'Stored library · selected publisher/topic' },
        { label: 'Articles in period', value: k.periodArticles }, { label: 'Bullshit matches', value: k.bullshitArticles, note: 'Distinct matched articles in period' },
        { label: 'Active feeds', value: k.activeFeeds, note: 'Configured RSS feeds · publisher filter only' }, { label: 'Saved articles', value: k.savedArticles },
        { label: 'Read articles', value: k.readArticles }, { label: 'Ranked articles', value: k.rankedArticles, note: 'Distinct local articles with ranking appearances' },
    ]), chartPanel('Articles over time', data.volume, `${state().filters.basis === 'fetchedAt' ? 'Fetched' : 'Published'} article dates, grouped by ${state().filters.group}.`), grid(
        tablePanel('Top 10 feeds', data.topFeeds, [{ key: 'name', label: 'Feed' }, { key: 'publisherName', label: 'Publisher' }, countColumn('count', 'Articles'), percentColumn('share', 'Share')], { description: 'Share of distinct articles in the selected period.' }),
        tablePanel('Top 10 topics', data.topTopics, [{ key: 'label', label: 'Topic' }, countColumn('count', 'Articles'), percentColumn('share', 'Share')], { description: 'Share of distinct selected articles. An article can have several topics; shares can add up to more than 100%.' }),
    ));
}

function renderTrends(data, target, cleanups) {
    target.append(chartPanel('Article volume', data.volume));
    const topicPanel = createAnalyticsPanel('Topic trends', 'Choose up to 8 topics. With no selection, the leading topics are shown. The shared publisher and topic filters also apply.');
    const choices = rows(metadata?.topics).map(item => ({ value: item.slug, label: item.label }));
    const multiselect = createMultiselect({ label: 'Topics to compare', options: choices, value: state().topicDraft || state().topicSelections, description: 'Select up to 8 topics, then apply the selection.' });
    multiselect.node.addEventListener('oj:change', event => {
        if (event.target !== multiselect.node) return;
        const value = rows(event.detail?.value).slice(0, 8);
        if (event.detail.value.length > 8) multiselect.setValue(value);
        state().topicDraft = value;
    });
    const apply = button('Apply topics', () => {
        state().topicSelections = [...(state().topicDraft || state().topicSelections)];
        void loadCurrent().then(() => { if (active() && state().section === 'trends') document.getElementById('analytics-apply-topics')?.focus({ preventScroll: true }); });
    }, 'oj-button oj-button-secondary'); apply.id = 'analytics-apply-topics';
    const controls = el('div', 'analytics-controls'); controls.append(multiselect.node, apply); topicPanel.append(controls);
    cleanups.push(() => multiselect.dispose());
    topicPanel.append(createAnalyticsChart({ title: 'Topic coverage over time', series: rows(data.topicSeries).map(item => ({ label: item.label, points: rows(item.points) })), description: 'Distinct article counts per topic; articles can contribute to several series.' }));
    const emerging = data.metadata?.momentum?.emerging;
    const emergingDescription = emerging ? `At least ${number(emerging.minimumCurrent)} current articles, at least ${number(emerging.minimumAbsoluteGrowth)} more than the previous period, and at least ${number(emerging.minimumRatio)}× the previous count. A zero baseline still requires the minimum volume; no percentage is invented.` : 'Deterministic growth requires at least 5 current articles, an absolute increase of at least 5 and at least twice the previous count. Zero baselines have no percentage.';
    target.append(topicPanel, momentumTable(data.momentum, 'Topic momentum', 'Current selected period compared with the immediately preceding period of equal duration. A zero baseline is labeled as new, with no percentage.'), momentumTable(data.emerging, 'Emerging topics', emergingDescription));
}

function publisherColumns({ feeds = false } = {}) {
    return [
        { key: 'name', label: feeds ? 'Feed' : 'Publisher' }, ...(feeds ? [{ key: 'publisherName', label: 'Publisher' }] : []),
        countColumn('totalArticles', 'Total articles'), countColumn('periodArticles', 'In period'), countColumn('averagePerDay', 'Articles/day'),
        countColumn('bullshitArticles', 'Bullshit matches'), percentColumn('bullshitRate', 'Match rate'),
        { key: 'rankedArticles', label: 'Ranked articles', numeric: true, render: row => row.rankingSupported ? number(row.rankedArticles) : 'Not supported' },
        { key: 'rankingKeys', label: 'Ranking coverage', sortable: false, render: row => row.rankingSupported ? rows(row.rankingKeys).map(rankLabel).join(', ') || 'Available' : 'No collector' },
    ];
}

function renderPublishers(data, target) {
    target.append(tablePanel('Publishers', data.publishers, publisherColumns(), { description: 'Publishers combine their feeds. Counts use distinct local article URL identities to avoid counting the same URL across feeds; unsupported ranking collection is shown as unavailable.' }));
    const comparisonPanel = createAnalyticsPanel('Compare publishers', 'Choose two publishers. The shared time and topic filters apply; the shared publisher filter is replaced by this pair.');
    const options = [{ value: '', label: 'Choose publisher' }, ...rows(metadata?.publishers).map(item => ({ value: item.id, label: item.name }))];
    const controls = el('div', 'analytics-controls');
    [0, 1].forEach(index => controls.append(selectControl(`analytics-compare-${index}`, `Publisher ${index + 1}`, options, state().compare[index], value => {
        state().compare[index] = value;
        if (state().compare[0] && state().compare[0] === state().compare[1]) {
            state().compare[1 - index] = ''; void loadCurrent(); return;
        }
        void loadCurrent();
    })));
    comparisonPanel.append(controls);
    const comparison = rows(data.comparison);
    if (comparison.length === 2) {
        comparisonPanel.append(createAnalyticsChart({ title: 'Publisher publication volume', series: comparison.map(item => ({ label: item.name, points: rows(item.volume) })) }));
        comparisonPanel.append(createAnalyticsMetrics(comparison.flatMap(item => [
            { label: `${item.name} · match rate`, display: percent(item.bullshitRate) },
            { label: `${item.name} · ranked articles`, value: item.rankedArticles, display: item.rankingSupported ? number(item.rankedArticles) : 'Unavailable', note: item.rankingSupported ? rows(item.rankingKeys).map(rankLabel).join(' · ') : 'Publisher has no ranking collector' },
        ])));
        const topicMap = new Map();
        comparison.forEach((item, index) => rows(item.topics).forEach(topic => {
            if (!topicMap.has(topic.slug)) topicMap.set(topic.slug, { label: topic.label, count0: 0, count1: 0, share0: null, share1: null });
            Object.assign(topicMap.get(topic.slug), { [`count${index}`]: topic.count, [`share${index}`]: topic.share });
        }));
        comparisonPanel.append(createAnalyticsTable({ title: 'Publisher topic distribution', rows: [...topicMap.values()], columns: [
            { key: 'label', label: 'Topic' }, ...comparison.flatMap((item, index) => [countColumn(`count${index}`, `${item.name} articles`), percentColumn(`share${index}`, `${item.name} share`)]),
        ] }));
        const rankingRows = Object.keys(rankingLabels).map(rankingKey => {
            const row = { rankingKey };
            comparison.forEach((item, index) => {
                const observed = rows(item.rankingAppearances).find(ranking => ranking.rankingKey === rankingKey);
                const available = Boolean(item.rankingSupported && rows(item.rankingKeys).includes(rankingKey));
                row[`articles${index}`] = available ? observed?.articles ?? 0 : null;
                row[`appearances${index}`] = available ? observed?.appearances ?? 0 : null;
            });
            return row;
        });
        comparisonPanel.append(el('h3', 'oj-heading-3', 'Observed ranking appearances'), el('p', 'oj-helper', 'Snapshot appearances count actual stored captures and remain separate by type. Unsupported collectors or ranking types are unavailable. No collection history can establish a publisher’s total readership.'));
        comparisonPanel.append(createAnalyticsTable({ title: 'Publisher ranking appearance comparison', rows: rankingRows, columns: [
            { key: 'rankingKey', label: 'Ranking type', render: row => rankLabel(row.rankingKey) }, ...comparison.flatMap((item, index) => [
                { key: `articles${index}`, label: `${item.name} ranked articles`, numeric: true, render: row => row[`articles${index}`] === null ? 'Unavailable' : number(row[`articles${index}`]) },
                { key: `appearances${index}`, label: `${item.name} appearances`, numeric: true, render: row => row[`appearances${index}`] === null ? 'Unavailable' : number(row[`appearances${index}`]) },
            ]),
        ] }));
    } else comparisonPanel.append(createAnalyticsEmpty('Choose two different publishers to compare publication volume, topics, match rates and observed ranking appearances.', 'Select a publisher pair'));
    target.append(comparisonPanel, tablePanel('Individual feeds', data.feeds, publisherColumns({ feeds: true }), { description: 'Feed rows explain the publisher totals. A publisher may have several RSS feeds; ranking appearances are not summed across them.' }));
}

function registerArticle(row) {
    const id = Number(row.articleId);
    if (Number.isSafeInteger(id) && id > 0) state().articlesById.set(id, { ...(row.article || {}), id, title: row.title || 'Untitled', url: row.canonicalUrl, sourceName: row.sourceName });
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function articleCell(row, { history = true } = {}) {
    const node = el('div', 'analytics-article');
    const id = registerArticle(row), url = normalizeArticleUrl(row.canonicalUrl);
    const title = button(row.title || row.canonicalUrl || 'Untitled article', () => id ? openArticle(id) : openExternal(null, url), 'analytics-article-title');
    title.disabled = !id && !url;
    const actions = el('div', 'analytics-row-actions');
    if (url) actions.append(button('Open original', () => openExternal(id, url)));
    if (id) actions.append(button('Save', () => { void openListModal([id]); }));
    if (history && url) actions.append(button('History', () => { state().selectedHistory = { sourceId: row.sourceId, url: row.canonicalUrl, title: row.title }; state().historyOffset = 0; void loadHistory(); }));
    node.append(title, actions); return node;
}

function rankedColumns({ span = false } = {}) {
    return [
        { key: 'title', label: 'Article', render: row => articleCell(row) }, { key: 'sourceName', label: 'Publisher' },
        { key: 'rankingKey', label: 'Ranking type', render: row => rankLabel(row.rankingKey) },
        { key: 'bestRank', label: 'Best rank', numeric: true, render: row => rankValue(row.bestRank) },
        { key: 'latestRank', label: 'Latest observed rank', numeric: true, render: row => rankValue(row.latestRank) },
        dateColumn('firstCaptured', 'First observed'), dateColumn('lastCaptured', 'Last observed'), countColumn('snapshotAppearances', 'Snapshot appearances'),
        ...(span ? [{ key: 'observedSpanMs', label: 'Observed span', render: row => analyticsSpan(row.observedSpanMs) }] : []),
    ];
}

function paginationControls(pagination, onPage, { size = RANKING_PAGE_SIZE, label = 'ranked articles' } = {}) {
    const container = el('div', 'analytics-pagination');
    const offset = Number(pagination?.offset || 0), total = Number(pagination?.total || 0), limit = Number(pagination?.limit || size);
    container.append(el('p', 'oj-helper', `${number(total)} ${label}${total ? ` · results ${number(offset + 1)}–${number(Math.min(offset + limit, total))}` : ''}`));
    if (offset > 0 || pagination?.hasMore) {
        const previous = button('Previous page', () => onPage(Math.max(0, offset - limit))); previous.disabled = offset <= 0;
        const next = button('Next page', () => onPage(offset + limit)); next.disabled = !pagination?.hasMore;
        container.append(previous, next);
    }
    return container;
}

function movementPanel(title, items, description, total) {
    const columns = [
        { key: 'title', label: 'Article', render: row => articleCell(row) }, { key: 'sourceName', label: 'Publisher' }, { key: 'rankingKey', label: 'Ranking type', render: row => rankLabel(row.rankingKey) },
        { key: 'previousRank', label: 'Previous rank', numeric: true, render: row => rankValue(row.previousRank) },
        { key: 'currentRank', label: 'Current rank', numeric: true, render: row => rankValue(row.currentRank) },
        { key: 'change', label: 'Positions gained', numeric: true, render: row => analyticsChange(row.change) },
        dateColumn('previousCapturedAt', 'Previous snapshot'), dateColumn('capturedAt', 'Current snapshot'),
    ];
    return tablePanel(title, items, columns, { description, total, empty: `No ${title.toLowerCase()} between the last two actual snapshots of each publisher and ranking type.`, initialSort: { key: 'change', direction: 'desc' } });
}

function renderMostRead(data, target) {
    const controls = el('div', 'analytics-controls');
    controls.append(selectControl('analytics-ranking-key', 'Ranking type', [{ value: 'all', label: 'All ranking types · kept separate' }, ...Object.entries(rankingLabels).map(([value, label]) => ({ value, label }))], state().filters.rankingKey, value => changeFilters({ rankingKey: value })));
    const note = el('p', 'oj-helper', 'Ranking positions are observed publisher selections, not pageview or audience counts. Top news is an editorial selection. Most read, Most commented and Top news remain separate throughout.');
    const k = data.metrics || {};
    target.append(controls, note, createAnalyticsMetrics([
        { label: 'Unique ranked articles', value: k.uniqueRankedArticles }, { label: 'New ranking entries', value: k.newEntries, note: 'First ever observed in this period' },
        { label: 'Articles reaching #1', value: k.numberOneArticles }, { label: 'Captured snapshots', value: k.snapshots }, { label: 'Publishers with data', value: k.publishers },
    ]));
    const performers = createAnalyticsPanel('Top performers', 'Best and latest observed positions are within the selected capture period. Latest observed rank is the last recorded appearance; it does not imply the article is still listed.');
    performers.append(createAnalyticsTable({ title: 'Top performers', rows: rows(data.topPerformers), columns: rankedColumns(), initialSort: state().rankingSort, onSort: sort => {
        state().rankingSort = sort; state().rankingOffset = 0; void loadCurrent();
    }, empty: 'No publisher ranking history matches these filters. Ranking history becomes available after supported publishers have been captured.' }));
    performers.append(paginationControls(data.pagination, offset => { state().rankingOffset = offset; void loadCurrent(); }));
    target.append(performers);
    const history = createAnalyticsPanel('Ranking history', 'Select History on an article to inspect its observed ranking positions. Rank 1 appears at the top. Each ranking type has its own chart.');
    const holder = el('div', 'analytics-history'); holder.id = 'analytics-history'; holder.setAttribute('aria-live', 'polite');
    holder.append(createAnalyticsEmpty('Choose History beside an article in any ranking table.', 'Select an article'));
    history.append(holder); target.append(history);
    const movement = data.movements || {};
    target.append(
        movementPanel('Climbers', movement.climbers, 'Improvement between the latest actual consecutive snapshots of the same publisher and ranking type. Positive change means positions gained.', movement.counts?.climbers),
        movementPanel('Decliners', movement.decliners, 'Negative change means positions lost between the same actual snapshot pair.', movement.counts?.decliners),
        movementPanel('Unchanged', movement.unchanged, 'The observed rank was identical in the two consecutive snapshots.', movement.counts?.unchanged),
        movementPanel('New entries', movement.newEntries, 'Absent from the preceding observed snapshot. No artificial previous rank or position change is assigned.', movement.counts?.newEntries),
        movementPanel('Dropped out', movement.droppedOut, 'Present in the preceding snapshot and absent from the latest actual captured snapshot. This is an observed absence, not a popularity score.', movement.counts?.droppedOut),
    );
    if (rows(movement.unavailable).length) target.append(tablePanel('Movement unavailable', movement.unavailable, [{ key: 'sourceName', label: 'Publisher' }, { key: 'rankingKey', label: 'Ranking type', render: row => rankLabel(row.rankingKey) }, { key: 'reason', label: 'Reason', sortable: false, render: row => row.reason || 'No earlier snapshot to compare.' }], { description: 'A previous snapshot is required before a position change can be calculated.' }));
    target.append(tablePanel('Longest running', data.longestRunning, rankedColumns({ span: true }), { description: 'Ordered by distinct snapshot appearances. First-to-last observed span may include collection gaps or absences; it is not uninterrupted time in the rankings.', initialSort: { key: 'snapshotAppearances', direction: 'desc' } }),
        tablePanel('Topic performance in rankings', data.topicPerformance, [
            { key: 'label', label: 'Topic' }, { key: 'rankingKey', label: 'Ranking type', render: row => rankLabel(row.rankingKey) }, countColumn('rankedArticles', 'Distinct ranked articles'), countColumn('appearances', 'Ranking appearances'),
            countColumn('eligibleArticles', 'Eligible local articles'), percentColumn('share', 'Eligible articles ranked', true), countColumn('coveredPublishers', 'Covered publishers'),
        ], { description: 'Rates use only local articles from publishers with comparable ranking coverage and article dates in this period. Older or unmatched ranked URLs can add appearances without entering the eligible denominator. Editorial selections remain separate.' }),
        tablePanel('Publishers with ranking data', data.publishers, [{ key: 'name', label: 'Publisher' }, countColumn('snapshots', 'Snapshots'), countColumn('uniqueArticles', 'Unique articles'), { key: 'rankingKeys', label: 'Ranking types', sortable: false, render: row => rows(row.rankingKeys).map(rankLabel).join(', ') }]),
    );
}

function historyParams() {
    const params = paramsFor('most-read');
    params.delete('sort'); params.delete('direction'); params.delete('limit');
    params.set('sourceId', state().selectedHistory.sourceId); params.set('url', state().selectedHistory.url);
    params.set('historyLimit', String(HISTORY_PAGE_SIZE)); params.set('offset', String(state().historyOffset)); return params;
}

function renderHistory(data, target) {
    target.replaceChildren();
    const article = data.article || {};
    target.append(articleCell(article, { history: false }));
    const series = rows(data.series);
    if (!series.length) { target.append(createAnalyticsEmpty('No captured snapshots match this article and the selected ranking filters.')); return; }
    for (const item of series) {
        const statistics = item.statistics || {};
        const group = el('section', 'analytics-history');
        group.append(el('h3', 'oj-heading-3', rankLabel(item.rankingKey)), createAnalyticsMetrics([
            { label: 'Best rank', display: rankValue(statistics.bestRank) }, { label: 'Latest observed rank', display: rankValue(statistics.latestRank) },
            { label: 'First appearance', display: formatDate(statistics.firstCaptured) }, { label: 'Last appearance', display: formatDate(statistics.lastCaptured) },
            { label: 'Captured appearances', value: statistics.snapshotAppearances }, { label: 'Observed span', display: analyticsSpan(statistics.observedSpanMs), note: 'First to last appearance; may include gaps' },
        ]), createAnalyticsChart({ title: `${article.title || 'Article'} · ${rankLabel(item.rankingKey)}`, rank: true, series: [{ label: rankLabel(item.rankingKey), points: rows(item.points) }], empty: 'No appearances of this ranking type in this snapshot page. Period statistics above still cover the full selection.', description: 'Only actual captured snapshots appear. Null observations break the line. Uncollected intervals contain no invented measurements; connected points only indicate observed order.' }));
        target.append(group);
    }
    target.append(paginationControls(data.pagination, offset => { state().historyOffset = offset; void loadHistory(); }, { size: HISTORY_PAGE_SIZE, label: 'captured ranking snapshots · newest page first' }), metadataNotes(data));
}

async function loadHistory() {
    const holder = document.getElementById('analytics-history');
    if (!holder || !state().selectedHistory || !active() || state().section !== 'most-read') return;
    clearHistoryRequest();
    const controller = new AbortController(); historyController = controller;
    const id = ++historyRequestId, params = historyParams(), key = analyticsRequestKey('history', params);
    if (historyCache.has(key)) { renderHistory(historyCache.get(key), holder); historyController = null; return; }
    holder.replaceChildren(el('p', 'oj-status', 'Loading captured ranking history…')); holder.setAttribute('aria-busy', 'true');
    try {
        const data = await api.analyticsHistory(params, controller.signal);
        if (id !== historyRequestId || controller.signal.aborted || !active() || state().section !== 'most-read' || holder !== document.getElementById('analytics-history')) return;
        if (historyCache.size >= 20) historyCache.delete(historyCache.keys().next().value);
        historyCache.set(key, data); renderHistory(data, holder);
    } catch (error) {
        if (isAbortError(error) || id !== historyRequestId || !active()) return;
        holder.replaceChildren(el('p', 'oj-status oj-status-danger', `Ranking history could not be loaded: ${error.message}`), button('Retry history', () => { void loadHistory(); }));
    } finally { if (historyController === controller) historyController = null; if (id === historyRequestId) holder.setAttribute('aria-busy', 'false'); }
}

function renderTopics(data, target) {
    if (state().filters.topic) {
        const matching = rows(data.topics).find(topic => topic.slug === state().filters.topic);
        target.append(createAnalyticsMetrics([
            { label: 'Matching articles in period', value: data.kpis?.totalArticles ?? matching?.count ?? 0, note: matching?.label || metadata?.topics?.find(topic => topic.slug === state().filters.topic)?.label || state().filters.topic },
            { label: 'Matching ranked articles', value: data.kpis?.rankedArticles, note: 'Distinct local articles across included ranking types' },
        ]));
    }
    target.append(tablePanel('Top topics', data.topics, [
        { key: 'label', label: 'Topic', render: row => button(row.label, () => changeFilters({ topic: row.slug }), 'oj-tag') }, countColumn('count', 'Distinct articles'), percentColumn('share', 'Share'),
    ], { description: 'Select a topic to inspect its publishers, history and ranking appearances. Several topics can apply to one article; shares overlap.' }), chartPanel('Topic coverage over time', data.volume),
    tablePanel('Topic distribution across publishers', data.publishers, [{ key: 'label', label: 'Topic' }, { key: 'publisherName', label: 'Publisher' }, countColumn('count', 'Distinct articles')]),
    momentumTable(data.momentum),
    tablePanel('Topic co-occurrence', data.cooccurrence, [{ key: 'leftLabel', label: 'Topic' }, { key: 'rightLabel', label: 'With topic' }, countColumn('count', 'Articles containing both')], { description: 'Each pair counts distinct local articles containing both existing topic mappings. Classification is not rerun.' }),
    tablePanel('Ranking appearances for matching articles', data.rankings, [{ key: 'rankingKey', label: 'Ranking type', render: row => rankLabel(row.rankingKey) }, countColumn('count', 'Distinct ranked articles'), countColumn('appearances', 'Snapshot appearances')], { description: 'Observed positions are not readership measurements. Top news represents editorial selection.' }));
}

function renderLibrary(data, target) {
    const k = data.kpis || {};
    target.append(createAnalyticsMetrics([
        { label: 'Stored articles', value: k.totalArticles }, { label: 'In selected period', value: k.periodArticles }, { label: 'Read articles', value: k.readArticles }, { label: 'Unread articles', value: k.unreadArticles },
        { label: 'Saved articles', value: k.savedArticles }, { label: 'Dismissed articles', value: k.dismissedArticles }, { label: 'Without topics', value: k.unclassifiedArticles }, { label: 'Feeds', value: k.feeds }, { label: 'Publishers', value: k.publishers },
    ]), chartPanel('Article collection over time', data.collection, 'Stored collection timestamps show when articles entered the local library. Historical data before collection began cannot be reconstructed.'),
    tablePanel('Classification status', data.classification, [{ key: 'status', label: 'Stored classification status' }, countColumn('count', 'Articles')], { description: 'Counts use existing stored metadata; viewing Analytics never runs classification.' }));
    const quality = data.quality || {};
    const diagnostics = createAnalyticsPanel('Data-quality indicators', 'Diagnostics are signals to inspect, not confirmed errors. Ranking articles may legitimately have no corresponding RSS article. URL groups identify potential duplicates, not necessarily duplicate content.');
    diagnostics.append(createAnalyticsMetrics([
        { label: 'Unmatched ranking records', value: quality.orphanRankingRecords }, { label: 'Potential duplicate URL groups', value: quality.duplicateUrlGroups }, { label: 'Articles in those URL groups', value: quality.duplicateUrlArticles },
    ]));
    target.append(diagnostics, tablePanel('Feed freshness', data.feedFreshness, [{ key: 'name', label: 'Feed' }, { key: 'publisherName', label: 'Publisher' }, dateColumn('lastFetchedAt', 'Latest article fetched'), countColumn('articleCount', 'Selected articles')], { description: 'Latest stored article collection time is shown for each feed, independent of the topic and period. It does not establish the latest polling attempt or whether a feed is healthy.' }));
}

const renderers = { overview: renderOverview, trends: renderTrends, publishers: renderPublishers, 'most-read': renderMostRead, topics: renderTopics, library: renderLibrary };

function renderCurrent(data) {
    const current = state().section, target = panel();
    panelCleanups.get(current)?.();
    const cleanups = []; target.replaceChildren();
    renderers[current](data, target, cleanups); target.append(metadataNotes(data));
    const cleanupSelects = initSelectDropdowns(target), cleanupOJ = initOJ(target);
    panelCleanups.set(current, () => { cleanups.reverse().forEach(cleanup => cleanup()); cleanupOJ(); cleanupSelects(); });
    if (current === 'most-read' && state().selectedHistory) void loadHistory();
}

async function loadCurrent({ force = false } = {}) {
    if (!active() || !root()) return;
    const current = state().section, params = paramsFor(current), key = analyticsRequestKey(current, params);
    requestController?.abort(); requestController = null; ++requestId; clearHistoryRequest();
    const status = document.getElementById('analytics-status');
    const target = panel();
    const focusId = target.contains(document.activeElement) ? document.activeElement?.id : null;
    const restoreFocus = () => { if (focusId && active() && state().section === current) document.getElementById(focusId)?.focus({ preventScroll: true }); };
    const settledStatus = () => metadataError ? 'Filter choices could not be loaded. Refresh Analytics to retry.' : '';
    if (!force && state().cache.has(key)) {
        renderCurrent(state().cache.get(key)); restoreFocus(); status.textContent = settledStatus(); target.setAttribute('aria-busy', 'false'); document.getElementById('analytics-refresh').disabled = false; return;
    }
    const controller = new AbortController(); requestController = controller; const id = requestId;
    status.textContent = 'Loading Analytics…'; target.setAttribute('aria-busy', 'true');
    panelCleanups.get(current)?.(); panelCleanups.delete(current);
    target.replaceChildren(el('p', 'oj-status', 'Reading stored analytics…'));
    const refresh = document.getElementById('analytics-refresh'); refresh.disabled = true;
    try {
        await loadMetadata();
        if (controller.signal.aborted || id !== requestId) return;
        const data = await api.analytics(current, params, controller.signal);
        if (id !== requestId || controller.signal.aborted || !active() || state().section !== current || key !== analyticsRequestKey(current, paramsFor(current))) return;
        if (!data || typeof data !== 'object') throw new Error('Invalid analytics response');
        if (state().cache.size >= 36) state().cache.delete(state().cache.keys().next().value);
        state().cache.set(key, data); state().needsRefresh = false; renderCurrent(data); restoreFocus(); status.textContent = settledStatus();
    } catch (error) {
        if (isAbortError(error) || id !== requestId || !active()) return;
        status.textContent = 'Analytics could not be loaded.';
        target.replaceChildren(el('p', 'oj-status oj-status-danger', `Could not read analytics: ${error.message}`), button('Retry', () => { void loadCurrent({ force: true }); }));
    } finally {
        if (requestController === controller) requestController = null;
        if (id === requestId) { target.setAttribute('aria-busy', 'false'); refresh.disabled = false; }
    }
}

function initialize() {
    if (initialized || !root()) return;
    initialized = true; state();
    for (const key of ['period', 'publisher', 'topic', 'group', 'basis']) document.getElementById(`analytics-${key}`).addEventListener('change', event => changeFilters({ [key]: event.target.value }));
    document.getElementById('analytics-refresh').addEventListener('click', () => { markAnalyticsDirty(); void loadMetadata(true).then(() => loadCurrent({ force: true })); });
    root().addEventListener('oj:change', event => {
        const section = event.detail?.tab?.dataset.analyticsSection;
        if (!sections.includes(section) || section === state().section) return;
        state().section = section; void loadCurrent();
    });
    syncFilterControls();
}

export function activateAnalytics() {
    initialize();
    if (!root()) return;
    const current = state();
    if (current.needsRefresh) current.cache.clear();
    const tab = document.getElementById(`analytics-${current.section}-tab`);
    if (tab?.getAttribute('aria-selected') !== 'true') tab.click();
    void loadCurrent();
}

export function deactivateAnalytics() {
    requestController?.abort(); requestController = null; ++requestId; clearHistoryRequest();
    metadataController?.abort(); metadataController = null; metadataPromise = null;
    const refresh = document.getElementById('analytics-refresh'); if (refresh) refresh.disabled = false;
    root()?.querySelectorAll('.oj-multiselect [aria-expanded="true"]').forEach(trigger => trigger.click());
}

export function markAnalyticsDirty() {
    const current = state(); current.needsRefresh = true; current.cache.clear(); historyCache.clear(); metadata = null;
}
