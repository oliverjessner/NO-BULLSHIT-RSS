export const RANKING_STATUS_KEY = 'rankings.refresh.status';
const states = new Set(['idle', 'refreshing', 'ready', 'error']);

export function normalizeRankingStatus(value, { now = Date.now() } = {}) {
    let status = value;
    if (typeof status === 'string') {
        try { status = JSON.parse(status); } catch { status = null; }
    }
    let state = states.has(status?.state) ? status.state : 'idle';
    const timestamp = typeof status?.attemptedAt === 'string' ? Date.parse(status.attemptedAt) : NaN;
    const attemptedAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
    // A crashed backend must not leave the UI reporting an endless refresh.
    if (state === 'refreshing' && (!attemptedAt || now - timestamp > 120_000)) state = 'error';
    return {
        state,
        attemptedAt,
        errorCode: state === 'error' && status?.errorCode === 'GOLEM_CONSENT_REQUIRED' ? 'GOLEM_CONSENT_REQUIRED' : null,
        message: state !== 'error' ? null : status?.errorCode === 'GOLEM_CONSENT_REQUIRED'
            ? 'Automatic Golem consent could not be completed. Try refreshing again.'
            : 'Publisher rankings could not be refreshed. Try refreshing again.',
    };
}

export async function readRankingRefreshStatus(database) {
    const tables = await database.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_metadata'");
    if (!tables.length) return normalizeRankingStatus(null);
    const rows = await database.all('SELECT value FROM app_metadata WHERE key = ?', [RANKING_STATUS_KEY]);
    return normalizeRankingStatus(rows[0]?.value);
}
