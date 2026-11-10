const countFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const percentFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export function analyticsNumber(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value)) ? countFormat.format(Number(value)) : '—';
}

export function analyticsPercent(value, { ratio = false } = {}) {
    return value !== null && value !== undefined && Number.isFinite(Number(value)) ? `${percentFormat.format(Number(value) * (ratio ? 100 : 1))}%` : '—';
}

export function analyticsChange(value) {
    return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${Number(value) > 0 ? '+' : ''}${analyticsNumber(value)}`;
}

export function analyticsGrowth(value, previous, current) {
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) return `${Number(value) > 0 ? '+' : ''}${analyticsPercent(value)}`;
    return Number(previous) === 0 && Number(current) > 0 ? 'New · no baseline' : Number(previous) === 0 && Number(current) === 0 ? 'No change' : 'Unavailable';
}

export function analyticsSpan(value) {
    if (!Number.isFinite(Number(value)) || value === null || Number(value) < 0) return '—';
    const hours = Number(value) / 3600000;
    if (hours < 1) return `${analyticsNumber(Number(value) / 60000)} min`;
    return hours < 48 ? `${analyticsNumber(hours)} h` : `${analyticsNumber(hours / 24)} days`;
}

export function analyticsRequestKey(section, params) {
    const entries = params instanceof URLSearchParams ? [...params] : Object.entries(params || {});
    return JSON.stringify([section, entries.filter(([, value]) => value !== '' && value !== null && value !== undefined).map(([key, value]) => [key, String(value)]).sort(([a], [b]) => a.localeCompare(b))]);
}

export function sortAnalyticsRows(rows, key, direction = 'asc', accessor = row => row[key]) {
    const sign = direction === 'desc' ? -1 : 1;
    return [...rows].sort((left, right) => {
        const a = accessor(left), b = accessor(right);
        // Unknown values remain last in either direction; absence is never zero.
        if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
        if (b === null || b === undefined) return -1;
        return sign * (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true }));
    });
}

// Shared native-SVG geometry. Horizontal spacing reflects actual timestamps;
// null ranks split paths, preserving observed absences instead of interpolating them.
export function analyticsChartGeometry(series, { width = 760, height = 250, rank = false } = {}) {
    const left = 52, right = width - 20, top = 24, bottom = height - 42;
    const normalized = (Array.isArray(series) ? series : []).map(item => ({
        ...item,
        points: (Array.isArray(item.points) ? item.points : []).map(point => {
            const raw = rank ? point.rank : point.count;
            return { ...point, time: Date.parse(point.capturedAt || point.bucket), value: raw !== null && raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : null };
        }).filter(point => Number.isFinite(point.time)).sort((a, b) => a.time - b.time),
    }));
    const points = normalized.flatMap(item => item.points);
    const observed = points.filter(point => point.value !== null);
    const minTime = points.length ? Math.min(...points.map(point => point.time)) : 0;
    const maxTime = points.length ? Math.max(...points.map(point => point.time)) : 1;
    const minValue = rank ? 1 : 0;
    const maxValue = Math.max(rank ? 2 : 1, ...observed.map(point => point.value));
    const x = time => left + (maxTime === minTime ? 0.5 : (time - minTime) / (maxTime - minTime)) * (right - left);
    const y = value => rank ? top + (value - minValue) / (maxValue - minValue) * (bottom - top) : bottom - value / maxValue * (bottom - top);
    return {
        width, height, left, right, top, bottom, minTime, maxTime, minValue, maxValue,
        observedCount: observed.length,
        series: normalized.map(item => {
            const segments = [];
            let segment = [];
            for (const point of item.points) {
                if (point.value === null) { if (segment.length) segments.push(segment); segment = []; continue; }
                segment.push({ ...point, x: x(point.time), y: y(point.value) });
            }
            if (segment.length) segments.push(segment);
            return { ...item, segments };
        }),
        ticks: (rank ? [...new Set(Array.from({ length: Math.min(5, maxValue) }, (_, index) => Math.round(minValue + (maxValue - minValue) * index / Math.max(1, Math.min(5, maxValue) - 1))))] : Array.from({ length: 5 }, (_, index) => maxValue * index / 4)).map(value => ({ value, y: y(value) })),
    };
}
