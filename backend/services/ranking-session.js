import path from 'node:path';
import os from 'node:os';
import { listSessions as fetcharyListSessions } from 'fetchary';

export const GOLEM_SESSION_NAME = 'nbs-golem';
export const GOLEM_SESSION_ORIGIN = 'https://www.golem.de';

export function rankingAccessError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

export function getRankingSessionDirectory({ env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
    const configured = String(env.NBS_RANKING_SESSION_DIR || '').trim();
    if (configured) return path.resolve(configured);
    const databasePath = String(env.DB_PATH || '').trim();
    if (databasePath) return path.join(path.dirname(path.resolve(databasePath)), 'publisher-sessions');
    const applicationData = platform === 'darwin'
        ? path.join(homeDir, 'Library', 'Application Support')
        : platform === 'win32'
            ? env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')
            : env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    return path.join(applicationData, 'NO-BULLSHIT-RSS', 'publisher-sessions');
}

export async function readGolemSessionInfo({ listSessions = fetcharyListSessions, ...options } = {}) {
    try {
        const sessions = await listSessions({ sessionDir: getRankingSessionDirectory(options) });
        const session = sessions.find(item => item.session === GOLEM_SESSION_NAME);
        if (!session) return null;
        const savedAt = typeof session.savedAt === 'string' ? Date.parse(session.savedAt) : NaN;
        if (session.origin !== GOLEM_SESSION_ORIGIN || !Number.isFinite(savedAt)) throw new Error('Invalid session metadata');
        return { savedAt: new Date(savedAt).toISOString() };
    } catch {
        throw rankingAccessError('ACCESS_STORAGE', 'Saved Golem access could not be read. Set up access again.');
    }
}

export async function getGolemSessionOptions(options = {}) {
    const saved = await readGolemSessionInfo(options);
    return saved ? { session: GOLEM_SESSION_NAME, sessionDir: getRankingSessionDirectory(options) } : {};
}
