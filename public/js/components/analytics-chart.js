import { analyticsChartGeometry, analyticsNumber } from '../utils/analytics.js';
import { formatDate } from '../utils/format.js';
import { analyticsElement, createAnalyticsEmpty } from './analytics-metric.js';

let nextChartId = 0;
const chartCleanups = new WeakMap();
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const NS = 'http://www.w3.org/2000/svg';
const svgElement = (tag, attributes = {}, text) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
};

export function disposeAnalyticsCharts(root) {
    if (!root) return;
    const charts = [...(root.matches?.('.analytics-chart') ? [root] : []), ...root.querySelectorAll('.analytics-chart')];
    for (const chart of charts) { chartCleanups.get(chart)?.(); chartCleanups.delete(chart); }
}

export function createAnalyticsChart({ title, series = [], rank = false, description = '', showCaption = true, empty = 'No stored observations match these filters.' }) {
    const figure = analyticsElement('figure', 'analytics-chart');
    const document = figure.ownerDocument;
    let width = 760;
    let geometry = analyticsChartGeometry(series, { rank, width, height: 290 });
    if (!geometry.observedCount) { figure.append(createAnalyticsEmpty(empty)); return figure; }
    const id = `analytics-chart-${++nextChartId}`;
    const bucketCount = new Set(geometry.series.flatMap(item => item.points.map(point => point.time))).size;
    const summary = `${rank ? geometry.observedCount : bucketCount} ${rank ? 'captured appearances' : 'UTC date buckets'} across ${series.length} series. ${rank ? 'Rank 1 is at the top. Gaps indicate absence from an actual captured snapshot; points are observations, not pageviews.' : 'Lines connect article counts at their actual UTC timestamps. Empty dates do not establish continuous collection.'}`;
    const svg = svgElement('svg', { role: 'group', 'aria-labelledby': `${id}-title ${id}-description` });
    const plot = analyticsElement('div', 'analytics-chart-plot oj-scroll-area');
    plot.setAttribute('role', 'region');
    plot.setAttribute('aria-label', `${title} chart; use arrow keys to inspect values, scroll horizontally on narrow windows`);
    plot.tabIndex = 0; plot.append(svg);
    const legend = analyticsElement('ul', 'analytics-chart-legend'); legend.setAttribute('aria-label', 'Chart series');
    geometry.series.forEach((item, index) => {
        const entry = analyticsElement('li', `analytics-series-${index % 8}`);
        const swatch = analyticsElement('span', 'analytics-chart-swatch'); swatch.setAttribute('aria-hidden', 'true');
        entry.append(swatch, document.createTextNode(item.label)); legend.append(entry);
    });
    const tooltip = analyticsElement('div', 'analytics-chart-tooltip');
    tooltip.id = `${id}-tooltip`; tooltip.hidden = true;
    tooltip.setAttribute('role', 'tooltip'); tooltip.setAttribute('aria-live', 'polite'); tooltip.setAttribute('aria-atomic', 'true');
    const tooltipTime = analyticsElement('div', 'analytics-chart-tooltip-time');
    const tooltipSeries = analyticsElement('div', 'analytics-chart-tooltip-series');
    const tooltipValue = analyticsElement('div', 'analytics-chart-tooltip-value');
    const tooltipRelated = analyticsElement('div', 'analytics-chart-tooltip-related');
    tooltipRelated.hidden = true;
    tooltip.append(tooltipTime, tooltipSeries, tooltipValue, tooltipRelated);
    figure.append(legend, plot, tooltip);
    if (showCaption) figure.append(analyticsElement('figcaption', 'oj-helper', `${summary}${description ? ` ${description}` : ''}`));

    let points = [], activeIndex = 0, disposed = false;
    function dismissOnEscape(event) {
        if (event.key === 'Escape' && !tooltip.hidden) { event.preventDefault(); event.stopPropagation(); hideTooltip(); }
    }
    function hideTooltip() {
        tooltip.hidden = true;
        points[activeIndex]?.dot.classList.remove('is-active');
        document.removeEventListener('keydown', dismissOnEscape, true);
    }
    function positionTooltip(dot) {
        if (!figure.getBoundingClientRect || !dot.getBoundingClientRect) return;
        tooltip.style.left = '0px'; tooltip.style.top = '0px';
        const bounds = figure.getBoundingClientRect(), anchor = dot.getBoundingClientRect(), size = tooltip.getBoundingClientRect();
        const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - bounds.left - size.width / 2, bounds.width - size.width - 8));
        const above = anchor.top - bounds.top - size.height - 12;
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${above >= 0 ? above : anchor.bottom - bounds.top + 12}px`;
    }
    function showPoint(record) {
        if (disposed || !record) return;
        if (!tooltip.hidden && points[activeIndex] === record) { positionTooltip(record.dot); return; }
        const previous = points[activeIndex];
        previous?.dot.classList.remove('is-active'); previous?.dot.setAttribute('tabindex', '-1');
        activeIndex = record.index;
        record.dot.classList.add('is-active'); record.dot.setAttribute('tabindex', '0');
        tooltipTime.textContent = record.date;
        tooltipSeries.className = `analytics-chart-tooltip-series analytics-series-${record.seriesIndex % 8}`;
        tooltipSeries.textContent = record.label;
        tooltipValue.textContent = record.value;
        const related = points.filter(other => other.seriesIndex !== record.seriesIndex && other.point.time === record.point.time);
        tooltipRelated.replaceChildren(...related.map(other => {
            const row = analyticsElement('div', 'analytics-chart-tooltip-related-row');
            row.append(analyticsElement('span', `analytics-chart-tooltip-related-series analytics-series-${other.seriesIndex % 8}`, other.label), analyticsElement('span', 'analytics-chart-tooltip-related-value', other.value));
            return row;
        }));
        tooltipRelated.hidden = related.length === 0;
        tooltip.hidden = false;
        document.addEventListener('keydown', dismissOnEscape, true);
        positionTooltip(record.dot);
    }

    function renderPlot(nextWidth) {
        const focusedIndex = points.findIndex(record => record.dot === document.activeElement);
        const restoreTooltip = !tooltip.hidden;
        hideTooltip();
        width = nextWidth;
        geometry = analyticsChartGeometry(series, { rank, width, height: 290 });
        svg.setAttribute('viewBox', `0 0 ${width} ${geometry.height}`);
        svg.replaceChildren(svgElement('title', { id: `${id}-title` }, title), svgElement('desc', { id: `${id}-description` }, `${summary} ${description}`));
        const shownTicks = new Set();
        for (const tick of geometry.ticks) {
            const label = rank ? `#${tick.value}` : compactNumber.format(tick.value);
            if (shownTicks.has(label)) continue;
            shownTicks.add(label);
            svg.append(svgElement('line', { class: 'analytics-chart-grid', x1: geometry.left, x2: geometry.right, y1: tick.y, y2: tick.y }), svgElement('text', { class: 'analytics-chart-label', x: geometry.left - 8, y: tick.y + 4, 'text-anchor': 'end' }, label));
        }
        const tickCount = geometry.minTime === geometry.maxTime ? 1 : Math.max(2, Math.min(6, Math.floor((geometry.right - geometry.left) / (rank ? 180 : 110)) + 1));
        for (let index = 0; index < tickCount; index += 1) {
            const fraction = tickCount === 1 ? 0.5 : index / (tickCount - 1);
            const time = tickCount === 1 ? geometry.minTime : geometry.minTime + fraction * (geometry.maxTime - geometry.minTime);
            const date = new Date(time).toISOString();
            svg.append(svgElement('text', { class: 'analytics-chart-label', x: geometry.left + fraction * (geometry.right - geometry.left), y: geometry.height - 14, 'text-anchor': tickCount === 1 ? 'middle' : index === 0 ? 'start' : index === tickCount - 1 ? 'end' : 'middle' }, rank ? formatDate(date) : date.slice(0, 10)));
        }
        points = [];
        geometry.series.forEach((item, seriesIndex) => {
            const group = svgElement('g', { class: `analytics-chart-series analytics-series-${seriesIndex % 8}` });
            // Lines join only observed neighbors; null ranks still split the path.
            for (const segment of item.segments) {
                if (segment.length > 1) group.append(svgElement('path', { class: 'analytics-chart-line', d: segment.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' '), fill: 'none', 'vector-effect': 'non-scaling-stroke' }));
                for (const point of segment) {
                    const date = formatDate(point.capturedAt || point.bucket), value = `${rank ? '#' : ''}${analyticsNumber(point.value)}`;
                    const dot = svgElement('circle', { class: 'analytics-chart-point', cx: point.x, cy: point.y, r: 3.5, role: 'img', tabindex: '-1', 'aria-label': `${item.label}: ${date} · ${value}`, 'aria-describedby': tooltip.id, 'vector-effect': 'non-scaling-stroke' });
                    const record = { dot, point, date, value, label: item.label, seriesIndex, index: 0 };
                    dot.addEventListener('pointerenter', () => showPoint(record));
                    dot.addEventListener('pointermove', () => showPoint(record));
                    dot.addEventListener('pointerleave', () => { if (document.activeElement !== dot) hideTooltip(); });
                    dot.addEventListener('pointerdown', () => { dot.focus?.({ preventScroll: true }); showPoint(record); });
                    dot.addEventListener('focus', () => showPoint(record));
                    dot.addEventListener('blur', hideTooltip);
                    points.push(record); group.append(dot);
                }
            }
            svg.append(group);
        });
        points.sort((a, b) => a.point.time - b.point.time || a.seriesIndex - b.seriesIndex);
        points.forEach((record, index) => { record.index = index; });
        activeIndex = focusedIndex >= 0 ? focusedIndex : Math.min(activeIndex, points.length - 1);
        points[activeIndex]?.dot.setAttribute('tabindex', '0');
        if (focusedIndex >= 0) points[activeIndex]?.dot.focus?.({ preventScroll: true });
        if (restoreTooltip) showPoint(points[activeIndex]);
    }

    figure.addEventListener('keydown', event => {
        if (disposed) return;
        if (event.key === 'Escape' && !tooltip.hidden) { event.preventDefault(); event.stopPropagation(); hideTooltip(); return; }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !points.length) return;
        event.preventDefault(); event.stopPropagation();
        const focused = points.findIndex(record => record.dot === document.activeElement);
        const current = points[focused < 0 ? activeIndex : focused];
        let next;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            const seriesIndices = [...new Set(points.map(record => record.seriesIndex))].sort((a, b) => a - b);
            const index = Math.max(0, Math.min(seriesIndices.length - 1, seriesIndices.indexOf(current.seriesIndex) + (event.key === 'ArrowUp' ? -1 : 1)));
            next = points.filter(record => record.seriesIndex === seriesIndices[index]).reduce((nearest, record) => Math.abs(record.point.time - current.point.time) < Math.abs(nearest.point.time - current.point.time) ? record : nearest);
        } else {
            const candidates = points.filter(record => record.seriesIndex === current.seriesIndex);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? candidates.length - 1 : Math.max(0, Math.min(candidates.length - 1, candidates.indexOf(current) + (event.key === 'ArrowLeft' ? -1 : 1)));
            next = candidates[index];
        }
        next.dot.focus?.({ preventScroll: true }); showPoint(next);
    });
    plot.addEventListener('scroll', hideTooltip);
    renderPlot(width);
    const Observer = document.defaultView?.ResizeObserver || globalThis.ResizeObserver;
    const observer = typeof Observer === 'function' ? new Observer(entries => {
        if (disposed) return;
        const measured = entries[0]?.contentRect.width;
        if (!measured) return;
        const nextWidth = Math.max(360, Math.floor(measured));
        if (nextWidth !== width) renderPlot(nextWidth);
    }) : null;
    observer?.observe(plot);
    chartCleanups.set(figure, () => { disposed = true; observer?.disconnect(); hideTooltip(); });
    return figure;
}
