import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import sqlite3 from '@vscode/sqlite3';
import { ensureMockupServer } from './lib/mockup-server.js';

function openDatabase(filename) {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(filename, error => error ? reject(error) : resolve(database));
    });
}

function exec(database, sql) {
    return new Promise((resolve, reject) => database.exec(sql, error => error ? reject(error) : resolve()));
}

function all(database, sql) {
    return new Promise((resolve, reject) => database.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
}

function closeDatabase(database) {
    return new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return new URL(`http://127.0.0.1:${server.address().port}`);
}

async function closeServer(server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function unavailableUrl() {
    const server = createServer();
    const url = await listen(server);
    await closeServer(server);
    return url;
}

async function fixture(t, { mode = 'ready' } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-mockup-test-'));
    let database;
    t.after(async () => {
        if (database) await closeDatabase(database);
        await rm(directory, { recursive: true, force: true });
    });
    const projectDirectory = path.join(directory, 'project');
    await mkdir(path.join(projectDirectory, 'backend'), { recursive: true });
    await writeFile(path.join(projectDirectory, 'package.json'), JSON.stringify({ name: 'no-bullshit-rss', type: 'module' }));
    const databasePath = path.join(directory, 'existing.db');
    const rulesPath = path.join(directory, 'existing.rules.json');
    const startupMarker = path.join(directory, 'started.json');
    const shutdownMarker = path.join(directory, 'stopped');
    const sqliteModule = pathToFileURL(path.resolve('node_modules/@vscode/sqlite3/lib/sqlite3.js')).href;
    const serverPath = path.join(projectDirectory, 'backend', 'server.js');
    const originalRules = JSON.stringify({ local: { label: 'Existing rules', strong: ['local'], medium: [], weak: [] } });
    await writeFile(rulesPath, originalRules);
    await writeFile(serverPath, `
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import sqlite3 from ${JSON.stringify(sqliteModule)};
const information = {
    pid: process.pid,
    databasePath: process.env.DB_PATH,
    rulesPath: process.env.TOPIC_RULES_FILE_PATH,
    logPath: process.env.SERVER_LOG_PATH,
    host: process.env.HOST,
    schedulerDisabled: process.env.DISABLE_SCHEDULER,
};
await writeFile(process.env.MOCKUP_START_MARKER, JSON.stringify(information));
process.on('SIGTERM', async () => {
    await writeFile(process.env.MOCKUP_SHUTDOWN_MARKER, 'stopped');
    process.exit(0);
});
if (${JSON.stringify(mode)} === 'exit') {
    console.error('Mock backend startup failed');
    process.exit(47);
}
if (${JSON.stringify(mode)} === 'timeout') {
    setInterval(() => {}, 1000);
} else {
    const database = await new Promise((resolve, reject) => {
        const opened = new sqlite3.Database(process.env.DB_PATH, error => error ? reject(error) : resolve(opened));
    });
    information.originalRules = await readFile(process.env.TOPIC_RULES_FILE_PATH, 'utf8');
    await writeFile(process.env.TOPIC_RULES_FILE_PATH, 'rules modified by temporary backend');
    await new Promise((resolve, reject) => database.exec("INSERT INTO mockup_test VALUES ('child')", error => error ? reject(error) : resolve()));
    information.rows = await new Promise((resolve, reject) => database.all('SELECT value FROM mockup_test ORDER BY rowid', (error, rows) => error ? reject(error) : resolve(rows)));
    const server = createServer((request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(request.url === '/api/health' ? { ok: true } : information));
    });
    server.listen(Number(process.env.PORT), process.env.HOST);
}
`);
    database = await openDatabase(databasePath);
    await exec(database, "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE mockup_test (value TEXT); INSERT INTO mockup_test VALUES ('persisted'); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO mockup_test VALUES ('wal-only');");
    const env = {
        ...process.env,
        DB_PATH: databasePath,
        TOPIC_RULES_FILE_PATH: rulesPath,
        SERVER_LOG_PATH: path.join(directory, 'original.log'),
        HOST: '0.0.0.0',
        MOCKUP_START_MARKER: startupMarker,
        MOCKUP_SHUTDOWN_MARKER: shutdownMarker,
    };
    return { database, databasePath, rulesPath, originalRules, startupMarker, shutdownMarker, projectDirectory, serverPath, env };
}

test('an existing healthy server stays running without opening a database or starting another backend', async t => {
    const server = createServer((_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ok: true }));
    });
    const url = await listen(server);
    t.after(() => closeServer(server));
    const app = await ensureMockupServer({
        url,
        projectDirectory: '/missing-project',
        env: { DB_PATH: '/missing-database' },
        serverPath: '/missing-backend',
    });
    assert.equal(app.url.href, url.href);
    await app.close();
    await app.close();
    assert.equal((await fetch(new URL('/api/health', url))).status, 200);
});

test('a stopped app starts from its existing database including WAL data, then cleans up only its own backend', async t => {
    const source = await fixture(t);
    // The newest row is still in the live database's WAL rather than its main file.
    await access(`${source.databasePath}-wal`);
    const app = await ensureMockupServer({
        url: await unavailableUrl(),
        projectDirectory: source.projectDirectory,
        env: source.env,
        startupTimeoutMs: 10000,
    });
    t.after(() => app.close());
    const information = await (await fetch(new URL('/test', app.url))).json();
    assert.deepEqual(information.rows, [{ value: 'persisted' }, { value: 'wal-only' }, { value: 'child' }]);
    assert.equal(information.originalRules, source.originalRules);
    assert.notEqual(information.databasePath, source.databasePath);
    assert.notEqual(information.rulesPath, source.rulesPath);
    assert.notEqual(information.logPath, source.env.SERVER_LOG_PATH);
    assert.equal(information.host, '127.0.0.1');
    assert.equal(information.schedulerDisabled, '1');
    assert.deepEqual(await all(source.database, 'SELECT value FROM mockup_test ORDER BY rowid'), [{ value: 'persisted' }, { value: 'wal-only' }]);
    assert.equal(await readFile(source.rulesPath, 'utf8'), source.originalRules);
    await app.close();
    await app.close();
    await assert.rejects(access(path.dirname(information.databasePath)), { code: 'ENOENT' });
    assert.equal(await readFile(source.shutdownMarker, 'utf8'), 'stopped');
    await assert.rejects(fetch(new URL('/api/health', app.url)));
});

test('a failed temporary backend reports its startup error and removes its database snapshot', async t => {
    const source = await fixture(t, { mode: 'exit' });
    await assert.rejects(ensureMockupServer({
        url: await unavailableUrl(),
        projectDirectory: source.projectDirectory,
        env: source.env,
        startupTimeoutMs: 10000,
    }), /Mock backend startup failed/);
    const information = JSON.parse(await readFile(source.startupMarker, 'utf8'));
    await assert.rejects(access(path.dirname(information.databasePath)), { code: 'ENOENT' });
    assert.deepEqual(await all(source.database, 'SELECT value FROM mockup_test ORDER BY rowid'), [{ value: 'persisted' }, { value: 'wal-only' }]);
});

test('a startup timeout stops the owned backend and removes its snapshot', async t => {
    const source = await fixture(t, { mode: 'timeout' });
    await assert.rejects(ensureMockupServer({
        url: await unavailableUrl(),
        projectDirectory: source.projectDirectory,
        env: source.env,
        startupTimeoutMs: 1000,
    }), /timed? ?out|timeout|not become ready/i);
    const information = JSON.parse(await readFile(source.startupMarker, 'utf8'));
    await assert.rejects(access(path.dirname(information.databasePath)), { code: 'ENOENT' });
    assert.equal(await readFile(source.shutdownMarker, 'utf8'), 'stopped');
});

test('an explicit missing DB_PATH fails before starting a backend instead of creating new app data', async t => {
    const source = await fixture(t);
    const missingPath = path.join(source.projectDirectory, 'missing.db');
    await assert.rejects(ensureMockupServer({
        url: await unavailableUrl(),
        projectDirectory: source.projectDirectory,
        env: { ...source.env, DB_PATH: missingPath },
        startupTimeoutMs: 1000,
    }), /No existing app database found/);
    await assert.rejects(access(missingPath), { code: 'ENOENT' });
    await assert.rejects(access(source.startupMarker), { code: 'ENOENT' });
});

test('an unavailable HTTPS URL does not start a replacement local backend', async () => {
    const url = await unavailableUrl();
    url.protocol = 'https:';
    await assert.rejects(ensureMockupServer({
        url,
        projectDirectory: '/missing-project',
        env: { DB_PATH: '/missing-database' },
        startupTimeoutMs: 1000,
    }), /unavailable|cannot|auto.*start/i);
});
