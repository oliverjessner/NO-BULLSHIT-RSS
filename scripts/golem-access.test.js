import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createGolemAccessService } from '../backend/services/golem-access.js';
import {
    GOLEM_SESSION_NAME, GOLEM_SESSION_ORIGIN, getRankingSessionDirectory, getGolemSessionOptions,
} from '../backend/services/ranking-session.js';

const savedAt = '2026-11-01T12:00:00.000Z';
const metadata = () => ({ session: GOLEM_SESSION_NAME, origin: GOLEM_SESSION_ORIGIN, savedAt, cookieCount: 2, activeCookieCount: 2 });
const env = { NBS_RANKING_SESSION_DIR: path.resolve('/isolated/publisher-sessions') };
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture({ saved = null, failSave = false, holdCleanup = false, holdSave = false, ...overrides } = {}) {
    const state = { saved, logins: [], configurations: 0, closed: 0, logouts: [], calls: [] };
    const closeGate = deferred();
    const saveGate = deferred();
    const dependencies = {
        env,
        configureBrowser: () => { state.configurations += 1; state.calls.push('configure'); },
        listSessions: async options => {
            assert.equal(options.sessionDir, env.NBS_RANKING_SESSION_DIR);
            return state.saved ? [state.saved] : [];
        },
        login: async (url, options) => {
            state.calls.push('login');
            state.logins.push({ url, options });
            let onAbort;
            const aborted = new Promise((_, reject) => {
                onAbort = () => reject(new Error('private protocol cookie details'));
                options.signal.addEventListener('abort', onAbort, { once: true });
                if (options.signal.aborted) onAbort();
            });
            try {
                await Promise.race([options.confirm({ session: options.session, origin: GOLEM_SESSION_ORIGIN, signal: options.signal }), aborted]);
                if (holdSave) await Promise.race([saveGate.promise, aborted]);
                options.signal.throwIfAborted();
                if (failSave) throw new Error('private protocol cookie details');
                state.saved = metadata();
                return metadata();
            } finally {
                options.signal.removeEventListener('abort', onAbort);
                if (holdCleanup) await closeGate.promise;
                state.closed += 1;
            }
        },
        logout: async (name, options) => {
            state.logouts.push({ name, options });
            state.saved = null;
            return { session: name, removed: true };
        },
        ...overrides,
    };
    return { service: createGolemAccessService(dependencies), state, closeGate, saveGate };
}

async function phase(service, expected) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = await service.getGolemAccessStatus();
        if (status.state === expected) return status;
    }
    assert.fail(`Golem access did not reach ${expected}`);
}

test('opening access requires a separate explicit save and exposes metadata without credentials', async () => {
    const { service, state } = fixture();
    assert.equal((await service.getGolemAccessStatus()).state, 'idle');
    const opening = await service.startGolemAccess();
    assert.equal(opening.state, 'opening');
    assert.match(opening.jobId, /^[a-f\d-]{36}$/);
    const ready = await phase(service, 'awaiting_confirmation');
    assert.equal(ready.saved, false);
    assert.deepEqual(state.calls, ['configure', 'login']);
    const { url, options } = state.logins[0];
    assert.equal(url, 'https://www.golem.de/');
    assert.equal(options.session, 'nbs-golem');
    assert.equal(options.sessionDir, env.NBS_RANKING_SESSION_DIR);
    assert.equal(options.insecure, false);
    assert.equal(options.timeout, 300_000);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.cookiesFromBrowser, undefined);
    assert.equal(options.cookieFile, undefined);
    assert.equal(options.consent, undefined, 'Login leaves the publisher decision entirely to the user');

    const result = await service.confirmGolemAccess(opening.jobId);
    assert.deepEqual(result, { state: 'saved', jobId: null, saved: true, savedAt, message: null });
    assert.equal(state.closed, 1);
    assert.deepEqual(Object.keys(result).sort(), ['jobId', 'message', 'saved', 'savedAt', 'state']);
});

test('rejects duplicate windows and stale or premature confirmation', async () => {
    const gate = deferred();
    const { service, state } = fixture({ configureBrowser: () => gate.promise });
    const opening = await service.startGolemAccess();
    await assert.rejects(service.startGolemAccess(), { code: 'ACCESS_BUSY' });
    await assert.rejects(service.confirmGolemAccess('old-job'), { code: 'ACCESS_STALE' });
    await assert.rejects(service.confirmGolemAccess(opening.jobId), { code: 'ACCESS_NOT_READY' });
    gate.resolve();
    await phase(service, 'awaiting_confirmation');
    await service.cancelGolemAccess(opening.jobId);
    assert.equal(state.closed, 1);
});

test('cancelling or replacing an old job preserves previous access and cannot confirm a new window', async () => {
    const original = metadata();
    const { service, state } = fixture({ saved: original });
    const first = await service.startGolemAccess();
    await phase(service, 'awaiting_confirmation');
    const cancelled = await service.cancelGolemAccess(first.jobId);
    assert.equal(cancelled.state, 'saved');
    assert.equal(cancelled.saved, true);
    assert.equal(state.saved, original);
    const second = await service.startGolemAccess();
    assert.notEqual(second.jobId, first.jobId);
    await phase(service, 'awaiting_confirmation');
    await assert.rejects(service.confirmGolemAccess(first.jobId), { code: 'ACCESS_STALE' });
    await service.cancelGolemAccess(second.jobId);
    assert.equal(state.closed, 2);
});

test('failed saving keeps previous access and redacts browser/protocol failures', async () => {
    const original = metadata();
    const { service, state } = fixture({ saved: original, failSave: true });
    const opening = await service.startGolemAccess();
    await phase(service, 'awaiting_confirmation');
    await assert.rejects(service.confirmGolemAccess(opening.jobId), error => {
        assert.equal(error.code, 'ACCESS_FAILED');
        assert.doesNotMatch(error.message, /private|protocol|cookie/);
        return true;
    });
    const result = await service.getGolemAccessStatus();
    assert.equal(result.state, 'error');
    assert.equal(result.saved, true);
    assert.equal(state.saved, original);
    assert.equal(state.closed, 1);
    assert.doesNotMatch(JSON.stringify(result), /private|protocol|cookieCount|cookie details/);
});

test('cancellation while saving never reports success or verifies the previous saved session', async () => {
    const original = metadata();
    const { service, state } = fixture({ saved: original, holdSave: true });
    const opening = await service.startGolemAccess();
    await phase(service, 'awaiting_confirmation');
    let verifications = 0;
    const confirmation = service.confirmGolemAccess(opening.jobId).then(() => { verifications += 1; });
    const rejected = assert.rejects(confirmation, { code: 'ACCESS_CANCELLED' });
    await phase(service, 'saving');
    const cancelled = await service.cancelGolemAccess(opening.jobId);
    await rejected;
    assert.equal(verifications, 0);
    assert.equal(cancelled.state, 'saved');
    assert.equal(cancelled.jobId, null);
    assert.equal(state.saved, original);
    assert.equal(state.closed, 1);
});

test('a storage error during an active setup retains its phase and job ID so the window can still be cancelled', async () => {
    let brokenStorage = false;
    const { service } = fixture({ listSessions: async () => {
        if (brokenStorage) throw new Error('private cookie data');
        return [];
    } });
    const opening = await service.startGolemAccess();
    await phase(service, 'awaiting_confirmation');
    brokenStorage = true;
    const status = await service.getGolemAccessStatus();
    assert.equal(status.state, 'awaiting_confirmation');
    assert.equal(status.jobId, opening.jobId);
    assert.equal(status.saved, false);
    assert.doesNotMatch(status.message, /private|cookie data/);
    await service.cancelGolemAccess(opening.jobId);
    brokenStorage = false;
    assert.equal((await service.getGolemAccessStatus()).state, 'idle');
});

test('storage failures stay safe and can be removed explicitly without exposing or importing cookies', async () => {
    let corrupt = true;
    let logins = 0;
    const { service } = fixture({
        listSessions: async () => {
            if (corrupt) throw new Error('private cookie secret from disk');
            return [];
        },
        login: async () => { logins += 1; },
        logout: async (name, options) => {
            assert.equal(name, 'nbs-golem');
            assert.equal(options.sessionDir, env.NBS_RANKING_SESSION_DIR);
            corrupt = false;
        },
    });
    const broken = await service.getGolemAccessStatus();
    assert.equal(broken.state, 'error');
    assert.doesNotMatch(broken.message, /private|cookie|secret/);
    await assert.rejects(service.startGolemAccess(), { code: 'ACCESS_STORAGE' });
    assert.equal(logins, 0);
    assert.equal((await service.forgetGolemAccess()).state, 'idle');
});

test('bounded cancellation waits for cleanup and prevents another job while the old window is closing', async () => {
    const { service, closeGate } = fixture({ holdCleanup: true, cleanupTimeoutMs: 5 });
    const opening = await service.startGolemAccess();
    await phase(service, 'awaiting_confirmation');
    const cancellation = assert.rejects(service.cancelGolemAccess(opening.jobId), { code: 'ACCESS_CLEANUP' });
    assert.equal((await service.getGolemAccessStatus()).state, 'cancelling');
    await cancellation;
    await assert.rejects(service.startGolemAccess(), { code: 'ACCESS_BUSY' });
    closeGate.resolve();
    await phase(service, 'idle');
});

test('forget cancels the active window and removes only the dedicated publisher session', async () => {
    const { service, state } = fixture({ saved: metadata() });
    await service.startGolemAccess();
    await phase(service, 'awaiting_confirmation');
    const result = await service.forgetGolemAccess();
    assert.equal(result.state, 'idle');
    assert.equal(result.saved, false);
    assert.equal(state.closed, 1);
    assert.deepEqual(state.logouts, [{ name: 'nbs-golem', options: { sessionDir: env.NBS_RANKING_SESSION_DIR } }]);
});

test('session options stay opt-in, validate the Golem origin and honor dedicated application paths', async () => {
    assert.deepEqual(await getGolemSessionOptions({ env, listSessions: async () => [] }), {});
    assert.deepEqual(await getGolemSessionOptions({ env, listSessions: async () => [metadata()] }), {
        session: 'nbs-golem', sessionDir: env.NBS_RANKING_SESSION_DIR,
    });
    assert.deepEqual(await getGolemSessionOptions({ env, listSessions: async () => [{ ...metadata(), session: 'unrelated' }] }), {});
    await assert.rejects(getGolemSessionOptions({ env, listSessions: async () => [{ ...metadata(), origin: 'https://other.example' }] }), { code: 'ACCESS_STORAGE' });
    assert.equal(getRankingSessionDirectory({ env: { DB_PATH: '/data/library.db' } }), path.join('/data', 'publisher-sessions'));
    assert.equal(getRankingSessionDirectory({ env: { ...env, DB_PATH: '/data/library.db' } }), env.NBS_RANKING_SESSION_DIR);
    assert.equal(getRankingSessionDirectory({ env: {}, platform: 'darwin', homeDir: '/home/test' }),
        path.join('/home/test', 'Library', 'Application Support', 'NO-BULLSHIT-RSS', 'publisher-sessions'));
    assert.equal(getRankingSessionDirectory({ env: { XDG_CONFIG_HOME: '/config' }, platform: 'linux', homeDir: '/home/test' }),
        path.join('/config', 'NO-BULLSHIT-RSS', 'publisher-sessions'));
    assert.equal(getRankingSessionDirectory({ env: { APPDATA: '/appdata' }, platform: 'win32', homeDir: '/home/test' }),
        path.join('/appdata', 'NO-BULLSHIT-RSS', 'publisher-sessions'));
});
