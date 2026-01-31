import fs from 'node:fs';

const SERVER_LOG_PATH = process.env.SERVER_LOG_PATH || '';

export function logLine(message) {
    if (!SERVER_LOG_PATH) return;
    try {
        fs.appendFileSync(SERVER_LOG_PATH, `[server] ${message}\n`);
    } catch {
        // Ignore logging failures to avoid crashing on startup.
    }
}

export function logInfo(message, meta = {}) {
    const suffix = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    console.log(`[INFO] ${message}${suffix}`);
}

export function logWarn(message, meta = {}) {
    const suffix = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    console.warn(`[WARN] ${message}${suffix}`);
}

export function logError(message, meta = {}) {
    const suffix = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    console.error(`[ERROR] ${message}${suffix}`);
}
