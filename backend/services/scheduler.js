import { updateAllFeeds } from './fetcher.js';
import { logInfo } from '../utils/logger.js';

const TIME = 5 * 60 * 1000;
const options = { intervalMs: TIME };

export function startScheduler() {
    updateAllFeeds().catch(() => {});

    setInterval(() => {
        return updateAllFeeds().catch(() => {});
    }, TIME);

    return logInfo('Scheduler started', options);
}
