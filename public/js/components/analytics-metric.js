import { analyticsNumber } from '../utils/analytics.js';

export function analyticsElement(tag, className = '', text = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
}

export function createAnalyticsMetrics(metrics) {
    const list = analyticsElement('dl', 'analytics-metrics');
    list.dataset.count = String(metrics.length);
    for (const { label, value, note, display } of metrics) {
        const card = analyticsElement('div', 'analytics-metric oj-panel oj-soft');
        card.append(analyticsElement('dt', 'oj-muted', label), analyticsElement('dd', 'analytics-metric-value oj-mono', display ?? analyticsNumber(value)));
        if (note) card.append(analyticsElement('dd', 'analytics-metric-note oj-helper', note));
        list.append(card);
    }
    return list;
}

export function createAnalyticsPanel(title, description = '') {
    const panel = analyticsElement('section', 'analytics-panel oj-panel');
    panel.append(analyticsElement('h2', 'oj-heading-3', title));
    if (description) panel.append(analyticsElement('p', 'oj-helper', description));
    return panel;
}

export function createAnalyticsEmpty(message, title = 'No data in this selection') {
    const node = analyticsElement('div', 'oj-empty-state');
    node.append(analyticsElement('h3', 'oj-empty-state-title', title), analyticsElement('p', 'oj-empty-state-description', message));
    return node;
}
