import { updateAllFeeds } from './fetcher.js';
import { all } from '../database/datenbank.js';
import { refreshMostReadRankings, isRankingRefreshRunning } from './most-read.js';
import { createRankingScheduler, readLastRankingAttempt, RANKING_REFRESH_INTERVAL_MS } from './ranking-scheduler.js';
import { logInfo, logWarn } from '../utils/logger.js';

const TIME = 5 * 60 * 1000;
const options = { intervalMs: TIME, rankingIntervalMs: RANKING_REFRESH_INTERVAL_MS };

export function startScheduler() {
    createRankingScheduler({
        readLastAttempt: () => readLastRankingAttempt({ all }),
        refresh: refreshMostReadRankings,
        isRefreshing: isRankingRefreshRunning,
        onError: error => logWarn('Scheduled publisher rankings update failed', { error: error.message }),
    }).start();
    updateAllFeeds().catch(() => {});

    setInterval(() => {
        return updateAllFeeds().catch(() => {});
    }, TIME);

    return logInfo('Scheduler started', options);
}
