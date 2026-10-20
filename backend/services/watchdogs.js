import { all, get, run, transaction } from '../database/datenbank.js';
import { publish } from './events.js';
import { watchdogMatchFilter } from './watchdog-filters.js';

const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const maxArticleId = async () => Number((await get('SELECT COALESCE(MAX(id), 0) AS id FROM articles')).id);
const changed = data => publish('watchdogs.updated', data);
const selectMatches = `SELECT m.*, w.name AS watchdogName, a.title, a.teaser, a.content, a.url, a.publishedAt, a.feedId,
    COALESCE(NULLIF(f.name, ''), s.name) AS feedName
    FROM watchdog_matches m JOIN watchdogs w ON w.id = m.watchdogId JOIN articles a ON a.id = m.articleId
    JOIN feeds f ON f.id = a.feedId JOIN sources s ON s.id = f.sourceId`;

export function matchesWatchdog(article, rule) {
    if (!rule.enabled || (rule.feedIds?.length && !rule.feedIds.includes(Number(article.feedId)))) return false;
    const text = [article.title, article.teaser, article.content].map(normalize).join('\n');
    return (!rule.includeAny.length || rule.includeAny.some(term => text.includes(normalize(term))))
        && rule.includeAll.every(term => text.includes(normalize(term)))
        && !rule.exclude.some(term => text.includes(normalize(term)));
}

function mapWatchdog(row) {
    if (!row) return null;
    const { includeAnyJson, includeAllJson, excludeJson, feedIdsJson, ...rest } = row;
    return { ...rest, enabled: Boolean(row.enabled), includeAny: JSON.parse(includeAnyJson), includeAll: JSON.parse(includeAllJson),
        exclude: JSON.parse(excludeJson), feedIds: JSON.parse(feedIdsJson), unreadCount: Number(row.unreadCount || 0) };
}

function validateRule(input) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 200 || typeof input.enabled !== 'boolean') throw new Error('A name and enabled status are required');
    const rule = { name, enabled: input.enabled };
    for (const key of ['includeAny', 'includeAll', 'exclude']) {
        if (!Array.isArray(input[key]) || input[key].length > 100 || input[key].some(term => typeof term !== 'string' || !term.trim() || term.length > 200)) {
            throw new Error(`${key} must contain at most 100 non-empty terms, each at most 200 characters`);
        }
        rule[key] = [...new Map(input[key].map(term => [normalize(term), term.trim()])).values()];
    }
    if (!rule.includeAny.length && !rule.includeAll.length) throw new Error('Add at least one includeAny or includeAll term');
    if (!Array.isArray(input.feedIds) || input.feedIds.length > 500 || input.feedIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid feed IDs');
    rule.feedIds = [...new Set(input.feedIds)];
    return rule;
}

async function checkFeeds(ids) {
    if (ids.length && (await all(`SELECT id FROM feeds WHERE id IN (${ids.map(() => '?').join(',')})`, ids)).length !== ids.length) {
        throw new Error('One or more selected feeds no longer exist');
    }
}

export async function listWatchdogs() {
    const rows = await all(`SELECT w.*, (SELECT COUNT(*) FROM watchdog_matches m WHERE m.watchdogId = w.id AND m.readAt IS NULL AND m.archivedAt IS NULL) AS unreadCount FROM watchdogs w ORDER BY w.id`);
    return rows.map(mapWatchdog);
}
export async function getWatchdog(id) { return mapWatchdog(await get('SELECT * FROM watchdogs WHERE id = ?', [id])); }

export async function createWatchdog(input) {
    const rule = validateRule({ enabled: true, includeAny: [], includeAll: [], exclude: [], feedIds: [], ...input });
    const result = await transaction(async () => {
        await checkFeeds(rule.feedIds);
        if ((await get('SELECT COUNT(*) AS count FROM watchdogs')).count >= 200) throw new Error('At most 200 watchdogs are supported');
        const start = await maxArticleId();
        const inserted = await run(`INSERT INTO watchdogs (name, enabled, includeAnyJson, includeAllJson, excludeJson, feedIdsJson, startArticleId, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [rule.name, Number(rule.enabled), JSON.stringify(rule.includeAny), JSON.stringify(rule.includeAll), JSON.stringify(rule.exclude), JSON.stringify(rule.feedIds), start]);
        const watchdog = await getWatchdog(inserted.lastID);
        let historicalCount = 0;
        if (input.includeHistory) {
            // Disabled watchdogs can still show explicitly requested historical results.
            historicalCount = await scanArticles({ ...watchdog, enabled: true }, 0, start, () => 'skipped', true);
        }
        return { watchdog, historicalCount };
    });
    changed({ action: 'created', id: result.watchdog.id });
    return result;
}

export async function updateWatchdog(id, input) {
    const watchdog = await transaction(async () => {
        const existing = await getWatchdog(id);
        if (!existing) return null;
        const rule = validateRule({ ...existing, ...input });
        if (Object.hasOwn(input, 'feedIds')) await checkFeeds(rule.feedIds);
        // Editing or re-enabling a rule only affects future articles.
        const start = await maxArticleId();
        await run(`UPDATE watchdogs SET name = ?, enabled = ?, includeAnyJson = ?, includeAllJson = ?, excludeJson = ?, feedIdsJson = ?, startArticleId = ?, updatedAt = datetime('now') WHERE id = ?`,
        [rule.name, Number(rule.enabled), JSON.stringify(rule.includeAny), JSON.stringify(rule.includeAll), JSON.stringify(rule.exclude), JSON.stringify(rule.feedIds), start, id]);
        return getWatchdog(id);
    });
    if (watchdog) changed({ action: 'updated', id: watchdog.id });
    return watchdog;
}
export async function deleteWatchdog(id) {
    const result = await run('DELETE FROM watchdogs WHERE id = ?', [id]);
    if (result.changes) changed({ action: 'deleted', id: Number(id) });
    return Boolean(result.changes);
}

async function scanArticles(watchdog, after, through, notificationState, historical = false) {
    let count = 0;
    let cursor = after;
    while (cursor < through) {
        const rows = await all('SELECT * FROM articles WHERE id > ? AND id <= ? ORDER BY id LIMIT 500', [cursor, through]);
        if (!rows.length) break;
        for (const article of rows) {
            if (!matchesWatchdog(article, watchdog)) continue;
            const result = await run(`INSERT INTO watchdog_matches (watchdogId, articleId, matchedAt, historical, notificationState)
                VALUES (?, ?, datetime('now'), ?, ?) ON CONFLICT(watchdogId, articleId) DO NOTHING`,
            [watchdog.id, article.id, Number(historical), notificationState(article)]);
            count += result.changes;
        }
        cursor = rows.at(-1).id;
    }
    return count;
}

export async function notificationSettings() {
    return { enabled: (await get("SELECT value FROM app_metadata WHERE key = 'watchdog.notifications'"))?.value === '1' };
}
export async function setNotificationSettings(enabled) {
    await run("UPDATE app_metadata SET value = ?, updatedAt = datetime('now') WHERE key = 'watchdog.notifications'", [enabled ? '1' : '0']);
    changed({ action: 'notifications' });
    return notificationSettings();
}

export async function processWatchdogArticles({ fetchedFeedIds = [] } = {}) {
    const count = await transaction(async () => {
        const after = Number((await get("SELECT value FROM app_metadata WHERE key = 'watchdog.lastArticleId'"))?.value || 0);
        const through = await maxArticleId();
        const initialized = new Set((await all('SELECT id FROM feeds WHERE watchdogInitializedAt IS NOT NULL')).map(row => row.id));
        const { enabled } = await notificationSettings();
        let matched = 0;
        for (const watchdog of await listWatchdogs()) {
            if (!watchdog.enabled) continue;
            matched += await scanArticles(watchdog, Math.max(after, watchdog.startArticleId), through,
                article => enabled && initialized.has(article.feedId) ? 'pending' : 'skipped');
        }
        for (const id of new Set(fetchedFeedIds)) await run("UPDATE feeds SET watchdogInitializedAt = datetime('now') WHERE id = ? AND watchdogInitializedAt IS NULL", [id]);
        await run("UPDATE app_metadata SET value = ?, updatedAt = datetime('now') WHERE key = 'watchdog.lastArticleId'", [String(through)]);
        return matched;
    });
    if (count) changed({ action: 'matched', count });
    return count;
}

// Claim before dispatch: a crash can lose an OS banner, but cannot replay it.
export async function dispatchWatchdogNotifications(send, { maxNotifications = 3 } = {}) {
    const batches = await transaction(async () => {
        const rows = await all(`${selectMatches} WHERE m.notificationState = 'pending' AND w.enabled = 1 ORDER BY m.id`);
        const enabled = (await notificationSettings()).enabled;
        await run("UPDATE watchdog_matches SET notificationState = ? WHERE notificationState = 'pending'", [enabled ? 'claimed' : 'skipped']);
        if (!enabled) return [];
        const grouped = new Map();
        for (const match of rows) {
            if (match.archivedAt || match.readAt) continue;
            if (!grouped.has(match.watchdogId)) grouped.set(match.watchdogId, []);
            grouped.get(match.watchdogId).push(match);
        }
        return [...grouped.values()].slice(0, maxNotifications).map(matches => ({
            id: matches[0].id, matchId: matches[0].id, watchdogId: matches[0].watchdogId,
            name: matches[0].watchdogName, title: matches[0].title || 'Untitled article', count: matches.length,
        }));
    });
    for (const batch of batches) {
        try { await send(batch); } catch { /* A failed notification never interrupts RSS fetching or gets replayed. */ }
    }
    return batches.length;
}

export async function listMatches({ before, limit = 50, ...filters } = {}) {
    const { where, params } = watchdogMatchFilter(filters);
    if (before) { where.push('m.id < ?'); params.push(before); }
    const matches = await all(`${selectMatches} WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`, [...params, limit + 1]);
    return { matches: matches.slice(0, limit), hasMore: matches.length > limit };
}
export async function getMatch(id) { return (await get(`${selectMatches} WHERE m.id = ?`, [id])) || null; }
export async function updateMatch(id, input) {
    const assignments = [], params = [];
    if (Object.hasOwn(input, 'read')) { assignments.push("readAt = CASE WHEN ? THEN datetime('now') ELSE NULL END"); params.push(Number(input.read)); }
    if (Object.hasOwn(input, 'archived')) { assignments.push("archivedAt = CASE WHEN ? THEN datetime('now') ELSE NULL END"); params.push(Number(input.archived)); }
    const result = await run(`UPDATE watchdog_matches SET ${assignments.join(', ')} WHERE id = ?`, [...params, id]);
    if (!result.changes) return null;
    changed({ action: 'match-state', id: Number(id) });
    return getMatch(id);
}
