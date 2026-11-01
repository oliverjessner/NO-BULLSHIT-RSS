import { randomUUID } from 'node:crypto';
import { login as fetcharyLogin, listSessions as fetcharyListSessions, logout as fetcharyLogout } from 'fetchary';
import { configureRankingBrowser } from './ranking-browser.js';
import {
    GOLEM_SESSION_NAME, GOLEM_SESSION_ORIGIN, getRankingSessionDirectory, readGolemSessionInfo, rankingAccessError,
} from './ranking-session.js';

const SETUP_ERROR = 'Golem access setup could not be completed. Your previous saved access has been kept.';

export function createGolemAccessService({
    login = fetcharyLogin,
    listSessions = fetcharyListSessions,
    logout = fetcharyLogout,
    configureBrowser = configureRankingBrowser,
    env = process.env,
    platform = process.platform,
    homeDir,
    cleanupTimeoutMs = 2_000,
} = {}) {
    const sessionConfiguration = { env, platform, ...(homeDir === undefined ? {} : { homeDir }) };
    const sessionDir = () => getRankingSessionDirectory(sessionConfiguration);
    let activeJob = null;
    let forgetting = false;
    let lastError = null;

    const savedSession = () => readGolemSessionInfo({ ...sessionConfiguration, listSessions });
    const status = (saved, job = activeJob) => ({
        state: job ? job.state : lastError ? 'error' : saved ? 'saved' : 'idle',
        jobId: job?.id || null,
        saved: Boolean(saved),
        savedAt: saved?.savedAt || null,
        message: job?.message || lastError || null,
    });

    async function getGolemAccessStatus() {
        try { return status(await savedSession()); }
        catch (error) {
            return { ...status(null), state: activeJob?.state || 'error', message: error.message };
        }
    }

    async function runJob(job, preflight) {
        try {
            await preflight;
            job.controller.signal.throwIfAborted();
            await configureBrowser({ env, platform });
            job.controller.signal.throwIfAborted();
            await login(`${GOLEM_SESSION_ORIGIN}/`, {
                session: GOLEM_SESSION_NAME,
                sessionDir: sessionDir(),
                insecure: false,
                timeout: 300_000,
                signal: job.controller.signal,
                confirm: ({ signal }) => {
                    signal.throwIfAborted();
                    if (activeJob !== job || job.controller.signal.aborted) throw new Error('Setup cancelled');
                    job.state = 'awaiting_confirmation';
                    return new Promise(resolve => { job.save = resolve; });
                },
            });
            lastError = null;
        } catch (error) {
            if (job.controller.signal.aborted) {
                job.error = rankingAccessError('ACCESS_CANCELLED', 'Golem access setup was cancelled.');
            } else {
                job.error = error?.code === 'ACCESS_STORAGE' ? error : rankingAccessError('ACCESS_FAILED', SETUP_ERROR);
                lastError = job.error.message;
            }
        } finally {
            job.save = null;
            if (activeJob === job) activeJob = null;
        }
    }

    async function startGolemAccess() {
        if (activeJob || forgetting) throw rankingAccessError('ACCESS_BUSY', 'Golem access setup is already open.');
        const job = { id: randomUUID(), state: 'opening', controller: new AbortController(), save: null, error: null, message: null };
        activeJob = job;
        lastError = null;
        const preflight = savedSession();
        job.promise = runJob(job, preflight);
        const saved = await preflight;
        // Starting setup never waits for a user's choice or saves a session.
        return { ...status(saved, job), state: 'opening' };
    }

    async function confirmGolemAccess(jobId) {
        const job = activeJob;
        if (!job || jobId !== job.id) throw rankingAccessError('ACCESS_STALE', 'This Golem access setup is no longer active.');
        if (job.state !== 'awaiting_confirmation' || !job.save || job.controller.signal.aborted) {
            throw rankingAccessError('ACCESS_NOT_READY', 'Complete Golem access setup in the browser before saving.');
        }
        job.state = 'saving';
        const save = job.save;
        job.save = null;
        save();
        await job.promise;
        if (job.controller.signal.aborted) throw rankingAccessError('ACCESS_CANCELLED', 'Golem access setup was cancelled.');
        if (job.error) throw job.error;
        return getGolemAccessStatus();
    }

    async function cancelGolemAccess(jobId) {
        const job = activeJob;
        if (jobId !== undefined && (!job || jobId !== job.id)) {
            throw rankingAccessError('ACCESS_STALE', 'This Golem access setup is no longer active.');
        }
        if (!job) return getGolemAccessStatus();
        job.state = 'cancelling';
        job.controller.abort();
        let timer;
        try {
            await Promise.race([
                job.promise || Promise.resolve(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(rankingAccessError('ACCESS_CLEANUP', 'The Golem access window is still closing. Try again.')), cleanupTimeoutMs);
                }),
            ]);
        } catch (error) {
            if (error?.code === 'ACCESS_CLEANUP') {
                job.state = 'error';
                job.message = error.message;
            }
            throw error;
        } finally { clearTimeout(timer); }
        lastError = null;
        return getGolemAccessStatus();
    }

    async function forgetGolemAccess() {
        if (forgetting) throw rankingAccessError('ACCESS_BUSY', 'Golem access is already being removed.');
        forgetting = true;
        try {
            await cancelGolemAccess();
            try { await logout(GOLEM_SESSION_NAME, { sessionDir: sessionDir() }); }
            catch { throw rankingAccessError('ACCESS_STORAGE', 'Saved Golem access could not be removed. Try again.'); }
            lastError = null;
            return getGolemAccessStatus();
        } finally { forgetting = false; }
    }

    return { getGolemAccessStatus, startGolemAccess, confirmGolemAccess, cancelGolemAccess, forgetGolemAccess };
}

const service = createGolemAccessService();
export const getGolemAccessStatus = (...args) => service.getGolemAccessStatus(...args);
export const startGolemAccess = (...args) => service.startGolemAccess(...args);
export const confirmGolemAccess = (...args) => service.confirmGolemAccess(...args);
export const cancelGolemAccess = (...args) => service.cancelGolemAccess(...args);
export const forgetGolemAccess = (...args) => service.forgetGolemAccess(...args);
