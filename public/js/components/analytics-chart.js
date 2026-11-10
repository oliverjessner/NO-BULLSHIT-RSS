import { analyticsChartGeometry, analyticsNumber } from '../utils/analytics.js';
import { formatDate } from '../utils/format.js';
import { analyticsElement, createAnalyticsEmpty } from './analytics-metric.js';
import { createAnalyticsTable } from './analytics-table.js';

let nextChartId = 0;
const NS = 'http://www.w3.org/2000/svg';
const svgElement = (tag, attributes = {}, text) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
};

export function createAnalyticsChart({ title, series = [], rank = false, description = '', empty = 'No stored observations match these filters.' }) {
    const figure = analyticsElement('figure', 'analytics-chart');
    const geometry = analyticsChartGeometry(series, { rank });
    if (!geometry.observedCount) { figure.append(createAnalyticsEmpty(empty)); return figure; }
    const id = `analytics-chart-${++nextChartId}`;
    const bucketCount = new Set(geometry.series.flatMap(item => item.points.map(point => point.time))).size;
    const summary = `${rank ? geometry.observedCount : bucketCount} ${rank ? 'captured appearances' : 'UTC date buckets'} across ${series.length} series. ${rank ? 'Rank 1 is at the top. Gaps indicate absence from an actual captured snapshot; points are observations, not pageviews.' : 'Bars mark article counts in date buckets, with actual UTC spacing. Empty dates do not establish continuous collection.'}`;
    const svg = svgElement('svg', { viewBox: `0 0 ${geometry.width} ${geometry.height}`, role: 'img', 'aria-labelledby': `${id}-title ${id}-description` });
    svg.append(svgElement('title', { id: `${id}-title` }, title), svgElement('desc', { id: `${id}-description` }, `${summary} ${description}`));
    const shownTicks = new Set();
    for (const tick of geometry.ticks) {
        const label = tick.value;
        if (shownTicks.has(label)) continue;
        shownTicks.add(label);
        svg.append(svgElement('line', { class: 'analytics-chart-grid', x1: geometry.left, x2: geometry.right, y1: tick.y, y2: tick.y }), svgElement('text', { class: 'analytics-chart-label', x: geometry.left - 10, y: tick.y + 4, 'text-anchor': 'end' }, rank ? `#${label}` : analyticsNumber(label)));
    }
    const domain = [geometry.minTime, ...(geometry.minTime !== geometry.maxTime ? [geometry.maxTime] : [])];
    for (const [index, time] of domain.entries()) {
        const date = new Date(time).toISOString();
        const label = rank ? formatDate(date) : date.slice(0, 10);
        svg.append(svgElement('text', { class: 'analytics-chart-label', x: domain.length === 1 ? (geometry.left + geometry.right) / 2 : index === 0 ? geometry.left : geometry.right, y: geometry.height - 12, 'text-anchor': domain.length === 1 ? 'middle' : index === 0 ? 'start' : 'end' }, label));
    }
    const legend = analyticsElement('ul', 'analytics-chart-legend'); legend.setAttribute('aria-label', 'Chart series');
    const rows = [];
    geometry.series.forEach((item, index) => {
        const group = svgElement('g', { class: `analytics-chart-series analytics-series-${index % 8}` });
        // A segment never crosses a null observation. Singletons are still visible.
        for (const segment of item.segments) {
            if (rank && segment.length > 1) group.append(svgElement('path', { d: segment.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' '), fill: 'none', 'vector-effect': 'non-scaling-stroke' }));
            for (const point of segment) {
                if (!rank) group.append(svgElement('path', { d: `M${point.x.toFixed(2)},${geometry.bottom} L${point.x.toFixed(2)},${point.y.toFixed(2)}`, fill: 'none', 'vector-effect': 'non-scaling-stroke' }));
                const dot = svgElement('circle', { cx: point.x, cy: point.y, r: rank ? 3.5 : 2.5 });
                dot.append(svgElement('title', {}, `${item.label}: ${formatDate(point.capturedAt || point.bucket)} · ${rank ? '#' : ''}${analyticsNumber(point.value)}`));
                group.append(dot);
            }
        }
        svg.append(group);
        const legendItem = analyticsElement('li', `analytics-series-${index % 8}`);
        const swatch = analyticsElement('span', 'analytics-chart-swatch'); swatch.setAttribute('aria-hidden', 'true');
        legendItem.append(swatch, document.createTextNode(item.label)); legend.append(legendItem);
        item.points.forEach(point => rows.push({ series: item.label, date: point.capturedAt || point.bucket, count: point.value }));
    });
    const plot = analyticsElement('div', 'analytics-chart-plot oj-scroll-area');
    plot.setAttribute('role', 'region'); plot.setAttribute('aria-label', `${title} chart; scroll horizontally on narrow windows`); plot.tabIndex = 0; plot.append(svg);
    figure.append(plot, legend, analyticsElement('figcaption', 'oj-helper', `${summary}${description ? ` ${description}` : ''}`));
    const details = document.createElement('details'); details.className = 'analytics-chart-data';
    details.append(analyticsElement('summary', 'oj-link', 'View chart data'));
    details.append(createAnalyticsTable({ title: `${title} data`, rows, columns: [
        { key: 'series', label: 'Series' }, { key: 'date', label: 'Observed time (local)', render: row => formatDate(row.date) },
        { key: 'count', label: rank ? 'Observed rank' : 'Articles', numeric: true, render: row => row.count === null ? 'Absent from snapshot' : rank ? `#${analyticsNumber(row.count)}` : analyticsNumber(row.count) },
    ], pageSize: 20 }));
    figure.append(details);
    return figure;
}
