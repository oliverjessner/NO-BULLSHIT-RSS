import sqlite3 from '@vscode/sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data-v2.db');
const BUSY_TIMEOUT_MS = Math.max(1_000, Number(process.env.SQLITE_BUSY_TIMEOUT_MS) || 5_000);
const db = new sqlite3.Database(DB_PATH);
// A transaction owns this connection until commit/rollback. Concurrent API and
// scheduler work must not accidentally join another request's transaction.
const context = new AsyncLocalStorage();
let queue = Promise.resolve();
function access(operation) {
    if (context.getStore()?.active) return operation();
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
}


db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON');
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
});

function isBusyError(error) {
    return error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';
}

function withBusyRetry(operation, attempt = 0) {
    return operation().catch(error => {
        if (!isBusyError(error) || attempt >= 4) throw error;
        const delayMs = 20 * 2 ** attempt;
        return new Promise(resolve => setTimeout(resolve, delayMs)).then(() => withBusyRetry(operation, attempt + 1));
    });
}

function runQuery(sql, params = []) {
    return withBusyRetry(
        () =>
            new Promise((resolve, reject) => {
                db.run(sql, params, function (err) {
                    if (err) return reject(err);
                    resolve({ lastID: this.lastID, changes: this.changes });
                });
            }),
    );
}

function execQuery(sql) {
    return withBusyRetry(
        () =>
            new Promise((resolve, reject) => {
                db.exec(sql, err => {
                    if (err) return reject(err);
                    resolve();
                });
            }),
    );
}

export function transaction(callback, options = {}) {
    if (context.getStore()?.active) throw new Error('Nested transactions are not supported');
    return access(() => {
        const scope = { active: true };
        return context.run(scope, async () => {
            try { return await runTransaction(callback, options); }
            finally { scope.active = false; }
        });
    });
}

async function runTransaction(callback, { mode = 'IMMEDIATE' } = {}) {
    await run(`BEGIN ${mode}`);
    try {
        const result = await callback({ run, get, all });
        await run('COMMIT');
        return result;
    } catch (error) {
        try {
            await run('ROLLBACK');
        } catch {
            // Preserve the operation error.
        }
        throw error;
    }
}

export function closeDatabase() {
    return new Promise((resolve, reject) => {
        db.close(error => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function getQuery(sql, params = []) {
    return withBusyRetry(
        () =>
            new Promise((resolve, reject) => {
                db.get(sql, params, (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                });
            }),
    );
}

function allQuery(sql, params = []) {
    return withBusyRetry(
        () =>
            new Promise((resolve, reject) => {
                db.all(sql, params, (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                });
            }),
    );
}

export const run = (...args) => access(() => runQuery(...args));
export const exec = (...args) => access(() => execQuery(...args));
export const get = (...args) => access(() => getQuery(...args));
export const all = (...args) => access(() => allQuery(...args));

export async function initSchema() {
    await get('PRAGMA journal_mode = WAL');
    await run('PRAGMA synchronous = NORMAL');
    await run('PRAGMA foreign_keys = ON');
    await run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

    const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
    const migrationFiles = (await readdir(migrationsDir))
        .filter(file => /^\d+_.+\.sql$/u.test(file))
        .sort((left, right) => left.localeCompare(right));

    await run(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            appliedAt TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
    );

    for (const file of migrationFiles) {
        const applied = await get('SELECT version FROM schema_migrations WHERE version = ?', [file]);
        if (applied) {
            continue;
        }

        const migrationSql = await readFile(path.join(migrationsDir, file), 'utf-8');
        await transaction(async () => {
            await exec(migrationSql);
            await run('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, datetime(\'now\'))', [file]);
        });
    }

    await run('PRAGMA optimize');
}

export default db;
