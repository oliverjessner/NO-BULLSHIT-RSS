import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getElectronDatabasePath } from '../../cli/lib/database-path.js';

async function healthy(url) {
    try {
        const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(1000) });
        return response.ok && (await response.json()).ok === true;
    } catch {
        return false;
    }
}

async function databasePath(projectDirectory, env) {
    const configured = String(env.DB_PATH || '').trim();
    const candidates = configured
        ? [path.resolve(projectDirectory, configured)]
        : [getElectronDatabasePath({ env }), path.join(projectDirectory, 'data-v2.db')];
    for (const candidate of candidates) {
        const info = await stat(candidate).catch(() => null);
        if (info?.isFile() && info.size > 0) return candidate;
    }
    throw new Error(`No existing app database found. Set DB_PATH to your database. Checked: ${candidates.join(', ')}`);
}

async function freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

async function waitForClose(closed, timeoutMs) {
    let timer;
    try {
        await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    } finally {
        clearTimeout(timer);
    }
}

export async function ensureMockupServer({
    url,
    projectDirectory,
    env = process.env,
    startupTimeoutMs = 60000,
    serverPath = path.join(projectDirectory, 'backend', 'server.js'),
}) {
    if (await healthy(url)) return { url, close: async () => {} };
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        throw new Error(`App unavailable at ${url}. Automatic startup requires a local HTTP address.`);
    }

    const sourcePath = await databasePath(projectDirectory, env);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-mockup-server-'));
    let child;
    let childClosed = false;
    let closed;
    let closePromise;
    let failure;
    let output = '';

    const close = () => closePromise ??= (async () => {
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
        if (child && !childClosed) {
            child.kill('SIGTERM');
            await waitForClose(closed, 3000);
            if (!childClosed) {
                child.kill('SIGKILL');
                await waitForClose(closed, 3000);
            }
            if (!childClosed) throw new Error('Could not stop the temporary screenshot server.');
        }
        await rm(directory, { recursive: true, force: true });
    })();
    const onInterrupt = () => { void close().finally(() => process.exit(130)); };
    const onTerminate = () => { void close().finally(() => process.exit(143)); };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);

    try {
        console.log(`Starting temporary screenshot server using ${sourcePath}`);
        const { backupSqliteDatabase } = await import('./sqlite-backup.js');
        const snapshotPath = path.join(directory, 'data-v2.db');
        await backupSqliteDatabase(sourcePath, snapshotPath);

        const rulesPath = path.join(directory, 'topics.rules.json');
        const sourceRulesPath = env.TOPIC_RULES_FILE_PATH
            ? path.resolve(projectDirectory, env.TOPIC_RULES_FILE_PATH)
            : path.join(path.dirname(sourcePath), 'topics.rules.json');
        await copyFile(sourceRulesPath, rulesPath).catch(error => {
            if (error.code !== 'ENOENT' || env.TOPIC_RULES_FILE_PATH) throw error;
        });

        const port = await freePort();
        const serverUrl = new URL(`http://127.0.0.1:${port}/`);
        child = spawn(process.execPath, [serverPath], {
            cwd: projectDirectory,
            env: {
                ...env,
                HOST: '127.0.0.1',
                PORT: String(port),
                DB_PATH: snapshotPath,
                TOPIC_RULES_FILE_PATH: rulesPath,
                SERVER_LOG_PATH: path.join(directory, 'server.log'),
                DISABLE_SCHEDULER: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const collect = chunk => { output = `${output}${chunk}`.slice(-8000); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.once('error', error => { failure = error; });
        child.once('exit', (code, signal) => { failure ??= new Error(`Server exited (${signal || code}).`); });
        closed = new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); }));

        const deadline = Date.now() + startupTimeoutMs;
        while (Date.now() < deadline) {
            if (failure) throw new Error(`Screenshot server startup failed: ${failure.message}\n${output.trim()}`);
            if (await healthy(serverUrl)) return { url: serverUrl, close };
            await delay(200);
        }
        throw new Error(`Screenshot server did not become ready within ${startupTimeoutMs} ms.\n${output.trim()}`);
    } catch (error) {
        await close();
        throw error;
    }
}
