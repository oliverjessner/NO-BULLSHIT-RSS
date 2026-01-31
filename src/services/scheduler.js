import { updateAllFeeds } from './fetcher.js';
import { logInfo } from '../utils/logger.js';

const FIVE_MINUTES = 5 * 60 * 1000;
const options = { intervalMs: FIVE_MINUTES };

export function startScheduler() {
    updateAllFeeds().catch(() => {});

    setInterval(() => {
        return updateAllFeeds().catch(() => {});
    }, FIVE_MINUTES);

    return logInfo('Scheduler started', options);
}
