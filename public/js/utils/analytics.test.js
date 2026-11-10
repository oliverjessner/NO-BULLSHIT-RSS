import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { analyticsChange, analyticsChartGeometry, analyticsGrowth, analyticsNumber, analyticsPercent, analyticsRequestKey, analyticsSpan, sortAnalyticsRows } from './analytics.js';
import { createAnalyticsChart, disposeAnalyticsCharts } from '../components/analytics-chart.js';
import { createAnalyticsTable } from '../components/analytics-table.js';
import { formatDate } from './format.js';

test('analytics formatting distinguishes unknown values, zero baselines, ratios and observed spans', () => {
    assert.equal(analyticsNumber(null), '—');
    assert.equal(analyticsNumber(0), '0');
    assert.equal(analyticsNumber(1234), '1,234');
    assert.equal(analyticsPercent(12.5), '12.5%');
    assert.equal(analyticsPercent(0.125, { ratio: true }), '12.5%');
    assert.equal(analyticsPercent(null), '—');
    assert.equal(analyticsGrowth(null, 0, 7), 'New · no baseline');
    assert.equal(analyticsGrowth(null, 0, 0), 'No change');
    assert.equal(analyticsGrowth(100, 3, 6), '+100%');
    assert.equal(analyticsGrowth(-50, 6, 3), '-50%');
    assert.equal(analyticsChange(5), '+5');
    assert.equal(analyticsChange(null), '—');
    assert.equal(analyticsSpan(0), '0 min');
    assert.equal(analyticsSpan(3_600_000), '1 h');
    assert.equal(analyticsSpan(3 * 86_400_000), '3 days');
    assert.equal(analyticsSpan(null), '—');
});

test('analytics cache keys canonicalize filter order and sorting keeps unavailable values last', () => {
    assert.equal(analyticsRequestKey('overview', { period: '30d', publisher: '', group: 'day' }), analyticsRequestKey('overview', new URLSearchParams({ group: 'day', period: '30d' })));
    assert.notEqual(analyticsRequestKey('overview', { period: '30d' }), analyticsRequestKey('overview', { period: '7d' }));
    const rows = [{ id: 'unknown', rate: null }, { id: 'two', rate: 2 }, { id: 'one', rate: 1 }];
    assert.deepEqual(sortAnalyticsRows(rows, 'rate').map(row => row.id), ['one', 'two', 'unknown']);
    assert.deepEqual(sortAnalyticsRows(rows, 'rate', 'desc').map(row => row.id), ['two', 'one', 'unknown']);
    assert.equal(rows[0].id, 'unknown');
});

test('ranking geometry places rank 1 at the top, uses true timestamp distances and splits absences', () => {
    const geometry = analyticsChartGeometry([{ label: 'Most read', points: [
        { capturedAt: '2026-11-01T00:00:00Z', rank: 8 }, { capturedAt: '2026-11-01T01:00:00Z', rank: 3 },
        { capturedAt: '2026-11-01T08:00:00Z', rank: null }, { capturedAt: '2026-11-01T12:00:00Z', rank: 1 },
    ] }], { rank: true });
    const [first, second] = geometry.series[0].segments;
    assert.deepEqual([first.length, second.length], [2, 1]);
    assert.equal(second[0].y, geometry.top);
    assert.equal(first[0].y, geometry.bottom);
    assert.equal(geometry.observedCount, 3);
    assert.ok(Math.abs((first[1].x - first[0].x) / (second[0].x - first[0].x) - 1 / 12) < 0.0001);
    for (const tick of geometry.ticks) {
        assert.equal(Number.isInteger(tick.value), true);
        assert.equal(tick.y, geometry.top + (tick.value - 1) / 7 * (geometry.bottom - geometry.top));
    }
    assert.ok(geometry.ticks.some(tick => tick.value === 1));
});

test('chart geometry handles empty data, single observations and malformed dates without fabrication', () => {
    assert.equal(analyticsChartGeometry([]).observedCount, 0);
    const geometry = analyticsChartGeometry([{ label: 'Articles', points: [{ bucket: 'invalid', count: 10 }, { bucket: '2026-11-01', count: 0 }, { bucket: '2026-11-03', count: 4 }] }]);
    assert.equal(geometry.observedCount, 2);
    assert.equal(geometry.series[0].points.length, 2);
    assert.equal(geometry.series[0].points.filter(point => point.bucket === '2026-11-02').length, 0);
    const singleton = analyticsChartGeometry([{ label: 'Rank', points: [{ capturedAt: '2026-11-01T01:00:00Z', rank: 1 }] }], { rank: true });
    assert.equal(singleton.series[0].segments[0][0].x, (singleton.left + singleton.right) / 2);
    assert.equal(singleton.series[0].segments[0][0].y, singleton.top);
});

test('charts expose observed timestamps and literal labels, without connecting missing ranking snapshots', () => {
    const previous = globalThis.document;
    const { document } = parseHTML('<html><body></body></html>'); globalThis.document = document;
    try {
        const chart = createAnalyticsChart({ title: '<img src=x onerror=alert(1)>', rank: true, series: [{ label: '<script>data</script>', points: [
            { capturedAt: '2026-11-01T00:00:00Z', rank: 8 }, { capturedAt: '2026-11-01T01:00:00Z', rank: 3 },
            { capturedAt: '2026-11-01T03:00:00Z', rank: null }, { capturedAt: '2026-11-01T12:00:00Z', rank: 1 },
        ] }] });
        assert.equal(chart.querySelectorAll('script, img').length, 0);
        assert.equal(chart.querySelectorAll('.analytics-chart-series path').length, 1);
        assert.equal(chart.querySelectorAll('.analytics-chart-series circle').length, 3);
        assert.match(chart.querySelector('svg desc').textContent, /Rank 1 is at the top/);
        assert.match(chart.querySelector('svg title').textContent, /<img/);
        assert.equal(chart.querySelector('.analytics-chart-plot').getAttribute('role'), 'region');
        assert.equal(chart.querySelector('.analytics-chart-plot').getAttribute('tabindex'), '0');
        const volume = createAnalyticsChart({ title: 'Volume', series: [{ label: 'Articles', points: [{ bucket: '2026-11-01', count: 2 }, { bucket: '2026-11-09', count: 7 }] }] });
        assert.equal(volume.querySelectorAll('.analytics-chart-series path').length, 1);
        assert.deepEqual(volume.querySelector('.analytics-chart-series path').getAttribute('d').match(/[ML]/gu), ['M', 'L']);
        assert.equal(volume.querySelectorAll('.analytics-chart-series circle').length, 2);
        assert.match(volume.querySelector('figcaption').textContent, /Lines connect/);
        assert.match(volume.querySelector('figcaption').textContent, /^2 UTC date buckets/);
        assert.match(chart.querySelector('figcaption').textContent, /^3 captured appearances/);
        disposeAnalyticsCharts(chart); disposeAnalyticsCharts(volume);
    } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test('chart tooltips expose literal dates, series and values on hover, focus and touch, then hide on dismissal', () => {
    const previous = globalThis.document;
    const { document, window } = parseHTML('<html><body></body></html>'); globalThis.document = document;
    let chart;
    try {
        const firstDate = '2026-11-01';
        const label = '<img src=x onerror=alert(1)> Articles';
        chart = createAnalyticsChart({ title: 'Observed article volume', series: [
            { label, points: [{ bucket: firstDate, count: 0 }, { bucket: '2026-11-09', count: 7 }] },
            { label: 'Second publisher', points: [{ bucket: firstDate, count: 4 }, { bucket: '2026-11-02', count: 6 }] },
        ] });
        document.body.append(chart);
        const tooltip = chart.querySelector('.analytics-chart-tooltip');
        const allPoints = [...chart.querySelectorAll('.analytics-chart-point')];
        const points = [...chart.querySelector('.analytics-chart-series').querySelectorAll('.analytics-chart-point')];
        const plot = chart.querySelector('.analytics-chart-plot');
        const bounds = { left: 0, top: 0, right: 760, bottom: 250, width: 760, height: 250 };
        for (const node of [chart, tooltip, plot, ...allPoints]) node.getBoundingClientRect = () => bounds;
        const emit = (node, type, properties = {}) => {
            const event = new window.Event(type, { bubbles: true, cancelable: true });
            Object.assign(event, { clientX: 100, clientY: 80 }, properties); node.dispatchEvent(event); return event;
        };
        assert.equal(tooltip.getAttribute('role'), 'tooltip');
        assert.equal(tooltip.hidden, true);
        assert.equal(allPoints.length, 4, 'Each observed value has one interactive point, with no duplicate hit circles');
        assert.equal(chart.querySelectorAll('.analytics-chart-series circle').length, allPoints.length);
        assert.equal(points[0].getAttribute('aria-describedby'), tooltip.id);
        assert.equal(points[0].getAttribute('role'), 'img');
        emit(points[0], 'pointerenter');
        assert.equal(tooltip.hidden, false);
        assert.equal(tooltip.querySelector('.analytics-chart-tooltip-series').textContent, label);
        assert.equal(tooltip.querySelector('.analytics-chart-tooltip-value').textContent, '0');
        assert.ok(tooltip.textContent.includes(formatDate(firstDate)));
        assert.equal(tooltip.querySelector('img'), null, 'Untrusted series labels remain literal text');
        assert.ok(points[0].getAttribute('aria-label').includes(formatDate(firstDate)));
        const related = tooltip.querySelector('.analytics-chart-tooltip-related');
        assert.equal(related.hidden, false);
        assert.equal(related.querySelectorAll('.analytics-chart-tooltip-related-row').length, 1, 'Only actual observations at the exact same timestamp are related');
        assert.equal(related.querySelector('.analytics-chart-tooltip-related-series').textContent, 'Second publisher');
        assert.equal(related.querySelector('.analytics-chart-tooltip-related-value').textContent, '4');
        const hoverEscape = emit(document.body, 'keydown', { key: 'Escape' });
        assert.equal(tooltip.hidden, true, 'Escape dismisses a hover-only tooltip even when focus is outside the chart');
        assert.equal(hoverEscape.defaultPrevented, true);
        assert.equal(emit(document.body, 'keydown', { key: 'Escape' }).defaultPrevented, false, 'Hidden tooltips do not consume unrelated Escape presses');
        emit(points[0], 'pointerenter');
        emit(points[0], 'pointerleave'); assert.equal(tooltip.hidden, true);
        emit(points[1], 'focus');
        assert.equal(tooltip.hidden, false);
        assert.equal(tooltip.querySelector('.analytics-chart-tooltip-value').textContent, '7');
        assert.equal(related.hidden, true, 'A different timestamp does not reuse related values from the previous tooltip');
        assert.equal(related.querySelectorAll('.analytics-chart-tooltip-related-row').length, 0);
        emit(points[1], 'blur'); assert.equal(tooltip.hidden, true);
        emit(points[1], 'pointerdown'); assert.equal(tooltip.hidden, false);
        emit(points[1], 'keydown', { key: 'Escape' }); assert.equal(tooltip.hidden, true);
        emit(points[0], 'pointerenter'); emit(plot, 'scroll'); assert.equal(tooltip.hidden, true);
    } finally {
        if (chart) disposeAnalyticsCharts(chart);
        if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
    }
});

test('disposing a chart container releases resize observers once', () => {
    const previous = { document: globalThis.document, ResizeObserver: globalThis.ResizeObserver };
    const { document } = parseHTML('<html><body></body></html>'); globalThis.document = document;
    const observers = [];
    globalThis.ResizeObserver = class {
        constructor() { this.disconnects = 0; observers.push(this); }
        observe(target) { this.target = target; }
        disconnect() { this.disconnects += 1; }
    };
    try {
        const container = document.createElement('section');
        const chart = createAnalyticsChart({ title: 'Disposable chart', series: [{ label: 'Articles', points: [{ bucket: '2026-11-01', count: 2 }] }] });
        container.append(chart); document.body.append(container);
        assert.ok(observers.some(observer => observer.target), 'Responsive charts observe their plot dimensions');
        disposeAnalyticsCharts(container);
        assert.ok(observers.every(observer => observer.disconnects === 1));
        disposeAnalyticsCharts(container);
        assert.ok(observers.every(observer => observer.disconnects === 1), 'Repeated view cleanup is safe');
    } finally {
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    }
});

test('chart arrow keys keep chronological navigation within a series and switch to the closest adjacent series observation', () => {
    const previous = globalThis.document;
    const { document, window } = parseHTML('<html><body></body></html>'); globalThis.document = document;
    let chart;
    try {
        chart = createAnalyticsChart({ title: 'Publisher comparison', series: [
            { label: 'First publisher', points: [{ bucket: '2026-11-01', count: 2 }, { bucket: '2026-11-09', count: 7 }] },
            { label: 'Second publisher', points: [{ bucket: '2026-11-02', count: 1 }, { bucket: '2026-11-08', count: 4 }] },
        ] });
        document.body.append(chart);
        const groups = [...chart.querySelectorAll('.analytics-chart-series')];
        const first = [...groups[0].querySelectorAll('.analytics-chart-point')];
        const second = [...groups[1].querySelectorAll('.analytics-chart-point')];
        const points = [...first, ...second], tooltip = chart.querySelector('.analytics-chart-tooltip');
        const bounds = { left: 0, top: 0, right: 760, bottom: 250, width: 760, height: 250 };
        for (const node of [chart, tooltip, chart.querySelector('.analytics-chart-plot'), ...points]) node.getBoundingClientRect = () => bounds;
        let focused;
        points.forEach(point => { point.focus = () => {
            focused?.dispatchEvent(new window.Event('blur')); focused = point; point.dispatchEvent(new window.Event('focus'));
        }; });
        const key = value => {
            const event = new window.Event('keydown', { bubbles: true, cancelable: true }); event.key = value; focused.dispatchEvent(event);
        };
        first[0].focus(); key('ArrowRight'); assert.equal(focused, first[1]);
        key('Home'); assert.equal(focused, first[0]);
        key('End'); assert.equal(focused, first[1]);
        key('ArrowDown'); assert.equal(focused, second[1], 'Adjacent-series navigation uses the nearest actual timestamp');
        assert.equal(tooltip.querySelector('.analytics-chart-tooltip-series').textContent, 'Second publisher');
        assert.equal(tooltip.querySelector('.analytics-chart-tooltip-value').textContent, '4');
        key('ArrowUp'); assert.equal(focused, first[1]);
        assert.equal(points.filter(point => point.getAttribute('tabindex') === '0').length, 1);
    } finally {
        if (chart) disposeAnalyticsCharts(chart);
        if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
    }
});

test('chart keyboard navigation visits only observed points and rank tooltips keep ordinal positions', () => {
    const previous = globalThis.document;
    const { document, window } = parseHTML('<html><body></body></html>'); globalThis.document = document;
    let chart;
    try {
        chart = createAnalyticsChart({ title: 'Ranking observations', rank: true, series: [{ label: 'Most read', points: [
            { capturedAt: '2026-11-01T00:00:00Z', rank: 8 }, { capturedAt: '2026-11-01T01:00:00Z', rank: null },
            { capturedAt: '2026-11-01T08:00:00Z', rank: 1 },
        ] }] });
        document.body.append(chart);
        const points = [...chart.querySelectorAll('.analytics-chart-point')];
        const tooltip = chart.querySelector('.analytics-chart-tooltip');
        const bounds = { left: 0, top: 0, right: 760, bottom: 250, width: 760, height: 250 };
        for (const node of [chart, tooltip, chart.querySelector('.analytics-chart-plot'), ...points]) node.getBoundingClientRect = () => bounds;
        let focused;
        points.forEach(point => { point.focus = () => {
            focused?.dispatchEvent(new window.Event('blur')); focused = point;
            point.dispatchEvent(new window.Event('focus'));
        }; });
        const key = (point, value) => {
            const event = new window.Event('keydown', { bubbles: true, cancelable: true });
            event.key = value; point.dispatchEvent(event);
        };
        assert.equal(points.length, 2, 'An observed absence is not a focusable invented rank');
        assert.equal(points.filter(point => point.getAttribute('tabindex') === '0').length, 1);
        assert.equal(points[0].getAttribute('tabindex'), '0');
        points[0].focus();
        assert.equal(tooltip.querySelector('.analytics-chart-tooltip-value').textContent, '#8');
        key(points[0], 'ArrowRight');
        assert.equal(focused, points[1]);
        assert.equal(points[0].getAttribute('tabindex'), '-1');
        assert.equal(points[1].getAttribute('tabindex'), '0');
        assert.equal(tooltip.querySelector('.analytics-chart-tooltip-series').textContent, 'Most read');
        assert.equal(tooltip.querySelector('.analytics-chart-tooltip-value').textContent, '#1');
        key(points[1], 'ArrowLeft'); assert.equal(focused, points[0]);
        key(points[0], 'Escape'); assert.equal(tooltip.hidden, true);
    } finally {
        if (chart) disposeAnalyticsCharts(chart);
        if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
    }
});

test('semantic analytics tables sort safely, paginate and disclose bounded results', () => {
    const previous = globalThis.document;
    const { document, window } = parseHTML('<html><body></body></html>'); globalThis.document = document;
    try {
        const table = createAnalyticsTable({ title: 'Publisher data', rows: [{ name: 'Zeta', count: 2 }, { name: '<img src=x>', count: null }, { name: 'Alpha', count: 1 }], total: 40, truncated: true, pageSize: 2, columns: [{ key: 'name', label: 'Publisher' }, { key: 'count', label: 'Articles', numeric: true }] });
        assert.equal(table.querySelector('table').classList.contains('oj-table'), true);
        assert.equal(table.querySelector('caption').textContent, 'Publisher data');
        assert.equal(table.querySelectorAll('tbody tr').length, 2);
        assert.equal(table.querySelector('img'), null);
        assert.match(table.textContent, /40 available; loaded rows only/);
        table.querySelector('.oj-table-sort').dispatchEvent(new window.Event('click'));
        assert.match(table.querySelector('tbody tr').textContent, /<img src=x>/);
        assert.equal(table.querySelector('th').getAttribute('aria-sort'), 'ascending');
        const next = table.querySelector('[aria-label="Next page of Publisher data"]'); next.dispatchEvent(new window.Event('click'));
        assert.equal(table.querySelectorAll('tbody tr').length, 1);
        assert.match(table.querySelector('.analytics-table-footer').textContent, /3–3 of 3 loaded/);
    } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test('Analytics lifecycle preserves filters, caches sections, aborts stale reads and supports retry', async () => {
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const { document, window } = parseHTML(await readFile(new URL('../../index.html', import.meta.url), 'utf8'));
    globalThis.document = document; globalThis.window = window;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
    for (const select of document.querySelectorAll('#view-analytics select')) Object.defineProperty(select, 'value', { configurable: true, writable: true, value: select.id === 'analytics-period' ? '30d' : select.id === 'analytics-group' ? 'day' : '' });
    const uiStub = `export const initOJ=()=>()=>{}; export const createMultiselect=()=>({node:document.createElement('div'),dispose(){},setValue(){}}); export const openDialog=dialog=>dialog?.setAttribute('open',''); export const closeDialog=dialog=>dialog?.removeAttribute('open');`;
    const selectStub = `export const initSelectDropdowns=()=>()=>{}; export const setSelectValue=(select,value)=>{select.value=value};`;
    const actionStub = `export const openArticle=()=>{};export const openExternal=()=>{};export const openListModal=()=>{};`;
    const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    const viewUrl = new URL('../views/analytics.js', import.meta.url);
    const source = (await readFile(viewUrl, 'utf8')).replace(/from '([^']+)'/gu, (match, specifier) => `from '${specifier.endsWith('/ui/design-system.js') ? dataUrl(uiStub) : specifier.endsWith('/ui/select-dropdown.js') ? dataUrl(selectStub) : specifier.endsWith('/services/article-viewer.js') || specifier.endsWith('/ui/modal.js') ? dataUrl(actionStub) : new URL(specifier, viewUrl).href}'`);
    const requests = [];
    let staleResolve, mode = 'ready';
    const payload = value => ({ kpis: { totalArticles: value, periodArticles: value, bullshitArticles: 0, activeFeeds: 1, savedArticles: 0, readArticles: 0, rankedArticles: 0 }, volume: [], topFeeds: [], topTopics: [] });
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url === '/api/analytics/filters') return Response.json({ publishers: [{ id: 1, name: 'Publisher' }], topics: [{ id: 1, slug: 'security', label: 'Security' }] });
        if (String(url).startsWith('/api/analytics/overview?') && new URL(url, 'http://fixture').searchParams.get('period') === '30d') return new Promise(resolve => { staleResolve = resolve; });
        if (mode === 'error') return Response.json({ error: 'Synthetic read failed' }, { status: 500 });
        if (String(url).startsWith('/api/analytics/topics?')) return Response.json({ ...payload(7), topics: [], publishers: [], momentum: [], cooccurrence: [], rankings: [] });
        return Response.json(payload(7));
    };
    const settle = async predicate => { for (let i = 0; i < 30; i += 1) { if (predicate()) return; await new Promise(setImmediate); } assert.ok(predicate(), 'controller reached expected state'); };
    let view;
    try {
        const { store } = await import('../state/store.js');
        store.analytics = { section: 'overview', filters: { period: '30d', publisher: '', topic: '', group: 'day', basis: 'publishedAt', rankingKey: 'all' }, cache: new Map(), articlesById: new Map(), needsRefresh: true };
        store.ui.activeView = 'analytics';
        view = await import(dataUrl(source)); view.activateAnalytics();
        await settle(() => Boolean(staleResolve));
        const staleRequest = requests.find(request => request.url.startsWith('/api/analytics/overview?'));
        const period = document.getElementById('analytics-period'); period.value = '7d'; period.dispatchEvent(new window.Event('change'));
        await settle(() => document.querySelector('#analytics-overview .analytics-metric-value')?.textContent === '7');
        assert.equal(staleRequest.options.signal.aborted, true);
        staleResolve(Response.json(payload(99))); await new Promise(setImmediate);
        assert.equal(document.querySelector('#analytics-overview .analytics-metric-value').textContent, '7');
        function section(name) { document.getElementById('view-analytics').dispatchEvent(new window.CustomEvent('oj:change', { detail: { tab: document.getElementById(`analytics-${name}-tab`) } })); }
        section('topics'); await settle(() => Boolean(document.querySelector('#analytics-topics .analytics-panel')));
        const reads = requests.filter(request => request.url.includes('/overview?')).length;
        section('overview'); await new Promise(setImmediate);
        assert.equal(requests.filter(request => request.url.includes('/overview?')).length, reads);
        assert.equal(store.analytics.filters.period, '7d');
        assert.equal(document.getElementById('analytics-refresh').disabled, false);
        mode = 'error'; period.value = '90d'; period.dispatchEvent(new window.Event('change'));
        await settle(() => /Synthetic read failed/.test(document.getElementById('analytics-overview').textContent));
        mode = 'ready'; document.querySelector('#analytics-overview button').dispatchEvent(new window.Event('click'));
        await settle(() => document.querySelector('#analytics-overview .analytics-metric-value')?.textContent === '7');
        view.deactivateAnalytics(); store.ui.activeView = 'main';
        assert.equal(document.getElementById('analytics-refresh').disabled, false);
    } finally {
        view?.deactivateAnalytics();
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
        if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage;
    }
});
