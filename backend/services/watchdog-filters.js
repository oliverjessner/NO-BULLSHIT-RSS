export const WATCHDOG_RANGES = ['24h', '7d', 'month', 'year', 'all'];

// Rolling UTC windows; calendar months/years clamp to the last valid day.
export function watchdogDateBounds(range = 'all', asOf = Date.now()) {
    if (!WATCHDOG_RANGES.includes(range)) throw new Error('Invalid Watchdog time range');
    const end = new Date(Number(asOf));
    if (!Number.isFinite(end.getTime())) throw new Error('Invalid Watchdog reference time');
    if (range === 'all') return null;
    const start = new Date(end);
    if (range === '24h' || range === '7d') start.setUTCDate(start.getUTCDate() - (range === '24h' ? 1 : 7));
    else {
        const day = start.getUTCDate();
        start.setUTCDate(1);
        if (range === 'month') start.setUTCMonth(start.getUTCMonth() - 1);
        else start.setUTCFullYear(start.getUTCFullYear() - 1);
        const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
        start.setUTCDate(Math.min(day, lastDay));
    }
    return { from: start.toISOString(), to: end.toISOString() };
}

export function watchdogMatchFilter({ status = 'all', watchdogId, archived = false, range = 'all', asOf } = {}, { match = 'm', article = 'a' } = {}) {
    const where = [`${match}.archivedAt IS ${archived ? 'NOT NULL' : 'NULL'}`];
    const params = [];
    if (status !== 'all') where.push(`${match}.readAt IS ${status === 'unread' ? 'NULL' : 'NOT NULL'}`);
    if (watchdogId) { where.push(`${match}.watchdogId = ?`); params.push(watchdogId); }
    const bounds = watchdogDateBounds(range, asOf);
    if (bounds) {
        where.push(`julianday(COALESCE(NULLIF(${article}.publishedAt, ''), ${match}.matchedAt)) BETWEEN julianday(?) AND julianday(?)`);
        params.push(bounds.from, bounds.to);
    }
    return { where, params };
}
