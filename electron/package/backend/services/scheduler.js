import { updateAllFeeds } from './fetcher.js';
import { logInfo } from '../utils/logger.js';

const FIVE_MINUTES = 5 * 60 * 1000;

export function startScheduler() {
  updateAllFeeds().catch(() => {});
  setInterval(() => {
    updateAllFeeds().catch(() => {});
  }, FIVE_MINUTES);
  logInfo('Scheduler started', { intervalMs: FIVE_MINUTES });
}
