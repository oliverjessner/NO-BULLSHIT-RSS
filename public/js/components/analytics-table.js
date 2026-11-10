import { sortAnalyticsRows } from '../utils/analytics.js';
import { analyticsElement, createAnalyticsEmpty } from './analytics-metric.js';

export function createAnalyticsTable({ title, columns, rows = [], empty = 'Collect articles or choose a wider period to see results.', initialSort, onSort, pageSize = 20, total, truncated = false }) {
    const container = analyticsElement('div', 'analytics-table-block');
    if (!rows.length) { container.append(createAnalyticsEmpty(empty)); return container; }
    const region = analyticsElement('div', 'oj-table-container');
    region.setAttribute('role', 'region'); region.setAttribute('aria-label', title); region.tabIndex = 0;
    const table = analyticsElement('table', 'oj-table oj-table-compact oj-table-hover');
    const caption = analyticsElement('caption', 'oj-sr-only', title);
    const head = document.createElement('thead'), body = document.createElement('tbody');
    const headerRow = document.createElement('tr');
    const sortButtons = new Map();
    let sort = initialSort || null;
    let page = 0;
    columns.forEach(column => {
        const th = analyticsElement('th', column.numeric ? 'oj-numeric' : ''); th.scope = 'col';
        if (column.sortable === false) th.textContent = column.label;
        else {
            const button = analyticsElement('button', 'oj-table-sort', column.label); button.type = 'button';
            button.id = `analytics-sort-${title}-${column.key}`.replace(/[^a-zA-Z0-9_-]+/gu, '-').toLowerCase();
            button.addEventListener('click', () => {
                sort = { key: column.key, direction: sort?.key === column.key && sort.direction === 'asc' ? 'desc' : 'asc' };
                page = 0;
                if (onSort) onSort(sort);
                else render();
            });
            th.append(button); sortButtons.set(column.key, { th, button, label: column.label });
        }
        headerRow.append(th);
    });
    head.append(headerRow); table.append(caption, head, body); region.append(table);
    const footer = analyticsElement('div', 'analytics-table-footer');
    const status = analyticsElement('span', 'oj-helper'); status.setAttribute('aria-live', 'polite');
    const previous = analyticsElement('button', 'oj-button oj-button-ghost oj-button-compact', 'Previous'); previous.type = 'button'; previous.setAttribute('aria-label', `Previous page of ${title}`);
    const next = analyticsElement('button', 'oj-button oj-button-ghost oj-button-compact', 'Next'); next.type = 'button'; next.setAttribute('aria-label', `Next page of ${title}`);
    previous.addEventListener('click', () => { page -= 1; render(); }); next.addEventListener('click', () => { page += 1; render(); });
    footer.append(status, previous, next); container.append(region, footer);
    function render() {
        const selectedColumn = columns.find(column => column.key === sort?.key);
        const sorted = sort && !onSort ? sortAnalyticsRows(rows, sort.key, sort.direction, selectedColumn?.value) : rows;
        const offset = page * pageSize;
        const fragment = document.createDocumentFragment();
        for (const row of sorted.slice(offset, offset + pageSize)) {
            const tr = document.createElement('tr');
            for (const column of columns) {
                const td = analyticsElement('td', column.numeric ? 'oj-numeric' : '');
                const value = column.render ? column.render(row) : (column.value ? column.value(row) : row[column.key]);
                if (value?.nodeType) td.append(value);
                else td.textContent = value === null || value === undefined ? '—' : String(value);
                tr.append(td);
            }
            fragment.append(tr);
        }
        body.replaceChildren(fragment);
        for (const [key, item] of sortButtons) {
            item.th.removeAttribute('aria-sort'); item.button.textContent = item.label;
            if (key === sort?.key) { item.th.setAttribute('aria-sort', sort.direction === 'asc' ? 'ascending' : 'descending'); item.button.append(document.createTextNode(sort.direction === 'asc' ? ' ↑' : ' ↓')); }
        }
        previous.disabled = page === 0; next.disabled = offset + pageSize >= rows.length;
        previous.hidden = next.hidden = rows.length <= pageSize;
        const universe = Number.isFinite(Number(total)) && total !== null ? Number(total) : rows.length;
        status.textContent = `${offset + 1}–${Math.min(offset + pageSize, rows.length)} of ${rows.length} loaded${truncated || universe > rows.length ? ` (${universe} available; loaded rows only)` : ''}`;
    }
    render();
    return container;
}
