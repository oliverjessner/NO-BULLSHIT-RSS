import { RANKING_STATUS_KEY } from './ranking-status.js';

export const RANKING_REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000;
export const RANKING_DUE_CHECK_MS = 60 * 1000;

export async function readLastRankingAttempt(database) {
    const rows = await database.all('SELECT value FROM app_metadata WHERE key = ?', [RANKING_STATUS_KEY]);
    let attemptedAt;
    try { attemptedAt = JSON.parse(rows[0]?.value || 'null')?.attemptedAt; } catch { /* Fall back to saved captures. */ }
    if (Number.isFinite(Date.parse(attemptedAt))) return Date.parse(attemptedAt);
    const captures = await database.all('SELECT MAX(capturedAt) AS capturedAt FROM most_read');
    const timestamp = Date.parse(captures[0]?.capturedAt);
    return Number.isFinite(timestamp) ? timestamp : null;
}

// Independent of RSS refreshes. Persist all-media attempts, including failures,
// to avoid repeated browser launches and restart-triggered bursts. A selected
// medium's manual refresh does not postpone the next all-media update.
export function createRankingScheduler({ readLastAttempt, refresh, isRefreshing = () => false,
    now = Date.now, setTimer = setInterval, clearTimer = clearInterval, onError = () => {} }) {
    let pending = null;
    let timer = null;
    let lastLocalAttempt = null;
    let generation = 0;
    const check = () => {
        if (pending) return pending;
        const requestedGeneration = generation;
        pending = (async () => {
            if (isRefreshing()) return false;
            const stored = await readLastAttempt();
            if (requestedGeneration !== generation) return false;
            const timestamp = now();
            // Ignore future timestamps after a clock correction.
            const previous = Math.max(...[stored, lastLocalAttempt]
                .filter(value => Number.isFinite(value) && value <= timestamp), -Infinity);
            if (timestamp - previous < RANKING_REFRESH_INTERVAL_MS) return false;
            if (isRefreshing()) return false;
            lastLocalAttempt = timestamp;
            await refresh();
            return true;
        })().finally(() => { pending = null; });
        return pending;
    };
    const tick = () => { void check().catch(onError); };
    return {
        check,
        start() {
            if (timer !== null) return;
            tick();
            timer = setTimer(tick, RANKING_DUE_CHECK_MS);
        },
        stop() {
            generation += 1;
            if (timer !== null) clearTimer(timer);
            timer = null;
        },
    };
}
