import { watchdogMatchFilter } from './watchdog-filters.js';

const selectMatches = `SELECT m.*, w.name AS watchdogName, a.title, a.teaser, a.content, a.url, a.publishedAt, a.feedId,
    COALESCE(NULLIF(f.name, ''), s.name) AS feedName
    FROM watchdog_matches m JOIN watchdogs w ON w.id = m.watchdogId JOIN articles a ON a.id = m.articleId
    JOIN feeds f ON f.id = a.feedId JOIN sources s ON s.id = f.sourceId`;

function mapWatchdog(row) {
    if (!row) return null;
    const { includeAnyJson, includeAllJson, excludeJson, feedIdsJson, ...rest } = row;
    return { ...rest, enabled: Boolean(row.enabled), includeAny: JSON.parse(includeAnyJson), includeAll: JSON.parse(includeAllJson),
        exclude: JSON.parse(excludeJson), feedIds: JSON.parse(feedIdsJson), unreadCount: Number(row.unreadCount || 0) };
}

export async function readStoredWatchdogs(database) {
    const rows = await database.all(`SELECT w.*, (SELECT COUNT(*) FROM watchdog_matches m WHERE m.watchdogId = w.id AND m.readAt IS NULL AND m.archivedAt IS NULL) AS unreadCount FROM watchdogs w ORDER BY w.id`);
    return rows.map(mapWatchdog);
}

export async function readStoredWatchdog(database, id) {
    return mapWatchdog(await database.get('SELECT * FROM watchdogs WHERE id = ?', [id]));
}

export async function readWatchdogNotificationSettings(database) {
    return { enabled: (await database.get("SELECT value FROM app_metadata WHERE key = 'watchdog.notifications'"))?.value === '1' };
}

export async function readStoredWatchdogMatches(database, { before, limit = 50, ...filters } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) throw new Error('Watchdog limit must be between 1 and 250.');
    const { where, params } = watchdogMatchFilter(filters);
    if (before) { where.push('m.id < ?'); params.push(before); }
    const matches = await database.all(`${selectMatches} WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`, [...params, limit + 1]);
    return { matches: matches.slice(0, limit), hasMore: matches.length > limit };
}

export async function readStoredWatchdogMatch(database, id) {
    return (await database.get(`${selectMatches} WHERE m.id = ?`, [id])) || null;
}
