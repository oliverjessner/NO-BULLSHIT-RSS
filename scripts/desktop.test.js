import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createViewerSync } from '../public/js/services/desktop.js';
import { runtimeTarget, stageDesktopResources } from './prepare-desktop.js';

test('article navigation is serialized and the latest hide wins during an in-flight request', async () => {
    const sent = [];
    let finish;
    const sync = createViewerSync(async payload => {
        sent.push(payload);
        if (sent.length === 1) await new Promise(resolve => { finish = resolve; });
    });
    const running = sync({ url: 'https://example.com/first' });
    await sync({ url: 'https://example.com/second' });
    await sync({ url: null, bounds: null });
    finish();
    await running;
    assert.deepEqual(sent, [{ url: 'https://example.com/first' }, { url: null, bounds: null }]);
});

test('unsupported desktop targets fail before downloading or copying files', () => {
    assert.equal(runtimeTarget('darwin', 'arm64'), 'aarch64-apple-darwin');
    for (const target of [['darwin', 'x64'], ['win32', 'arm64'], ['linux', 'x64']]) {
        assert.throws(() => runtimeTarget(...target), /Apple Silicon/);
    }
});

test('failed resource preparation keeps the complete previous runtime available', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-resource-stage-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const resources = path.join(directory, 'resources', 'runtime');
    const cache = path.join(directory, 'cache');
    const dependency = path.join(resources, 'node_modules', 'minipass', 'package.json');
    await mkdir(path.dirname(dependency), { recursive: true });
    await writeFile(dependency, '{"name":"minipass"}');
    await assert.rejects(stageDesktopResources(resources, cache, async staged => {
        await writeFile(path.join(staged, 'partial.js'), 'incomplete');
        assert.equal(await readFile(dependency, 'utf8'), '{"name":"minipass"}');
        throw new Error('simulated copy failure');
    }), /simulated copy failure/);
    assert.equal(await readFile(dependency, 'utf8'), '{"name":"minipass"}');
    assert.deepEqual(await readdir(cache), []);
});

test('publishes a complete new runtime and removes stale files only after preparation succeeds', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-resource-publish-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const resources = path.join(directory, 'runtime');
    const cache = path.join(directory, 'cache');
    await mkdir(resources);
    await writeFile(path.join(resources, 'stale.js'), 'old');
    await stageDesktopResources(resources, cache, async staged => {
        await mkdir(path.join(staged, 'node_modules', 'minipass'), { recursive: true });
        await writeFile(path.join(staged, 'node_modules', 'minipass', 'package.json'), '{"name":"minipass"}');
        assert.equal(await readFile(path.join(resources, 'stale.js'), 'utf8'), 'old');
    });
    assert.deepEqual(await readdir(resources), ['node_modules']);
    assert.equal(await readFile(path.join(resources, 'node_modules', 'minipass', 'package.json'), 'utf8'), '{"name":"minipass"}');
    assert.deepEqual(await readdir(cache), []);
});

test('restores the previous runtime if publishing the staged tree fails', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-resource-rollback-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const resources = path.join(directory, 'runtime');
    const cache = path.join(directory, 'cache');
    await mkdir(resources);
    await writeFile(path.join(resources, 'previous.js'), 'old');
    await assert.rejects(stageDesktopResources(resources, cache, staged => rm(staged, { recursive: true })), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(resources, 'previous.js'), 'utf8'), 'old');
    assert.deepEqual(await readdir(cache), []);
});

test('bundled CLI follows symlinks, forwards arguments and clears Node injection variables', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-tauri-cli-'));
    try {
        const resources = path.join(directory, 'NO BULLSHIT RSS.app', 'Contents', 'Resources');
        const macos = path.join(resources, '..', 'MacOS');
        await mkdir(path.join(resources, 'bin'), { recursive: true });
        await mkdir(path.join(resources, 'runtime', 'cli'), { recursive: true });
        await mkdir(macos);
        const launcher = path.join(resources, 'bin', 'no-bullshit-rss');
        await copyFile(new URL('../cli/launchers/macos/no-bullshit-rss', import.meta.url), launcher);
        const entry = path.join(resources, 'runtime', 'cli', 'no-bullshit-rss.js');
        await writeFile(entry, '');
        await writeFile(path.join(macos, 'rss-node'), '#!/bin/sh\nprintf "entry=%s\\narg=%s\\noptions=%s\\npath=%s\\n" "$1" "$2" "${NODE_OPTIONS-}" "${NODE_PATH-}"\n', { mode: 0o755 });
        const link = path.join(directory, 'rss');
        await symlink(launcher, link);
        const child = spawn('sh', [link, 'a quoted argument'], { env: { ...process.env, NODE_OPTIONS: '--invalid', NODE_PATH: '/invalid' } });
        let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        const [code] = await once(child, 'exit');
        assert.equal(code, 0);
        assert.equal(stdout, `entry=${await realpath(entry)}\narg=a quoted argument\noptions=\npath=\n`);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

async function managedServer(t, port) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-tauri-backend-'));
    const child = spawn(process.execPath, [new URL('../backend/server.js', import.meta.url).pathname], {
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DB_PATH: path.join(directory, 'data-v2.db'), TOPIC_RULES_FILE_PATH: path.join(directory, 'topics.rules.json'), DISABLE_SCHEDULER: '1', DESKTOP_PARENT_WATCHDOG: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = once(child, 'exit');
    t.after(async () => {
        if (child.exitCode === null) child.kill();
        await exited;
        await rm(directory, { recursive: true, force: true });
    });
    return { child, exited, output: () => output };
}

test('managed backend announces readiness, serves the app and exits when its desktop parent closes', { timeout: 15000 }, async t => {
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const server = await managedServer(t, port);
    const ready = new Promise(resolve => server.child.stdout.on('data', () => { if (server.output().includes('NBS_DESKTOP_READY')) resolve(); }));
    await Promise.race([ready, server.exited.then(() => { throw new Error(server.output()); })]);
    const base = `http://127.0.0.1:${port}`;
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
    assert.match(await (await fetch(base)).text(), /NO BULLSHIT RSS/);
    assert.equal((await fetch(`${base}/vendor/oj-designsystem/styles.css`)).status, 200);
    await t.test('build caches, server sources and npm internals are not frontend assets', async () => {
        for (const pathname of [
            '/.desktop-cache/24.22.0/node-v24.22.0-darwin-arm64/lib/node_modules/npm/node_modules/sigstore/dist/config.js',
            '/.desktop-cache/26.11.1/node-v26.11.1-darwin-arm64/lib/node_modules/npm/node_modules/sigstore/dist/config.js',
            '/node_modules/npm/node_modules/sigstore/dist/config.js',
            '/backend/server.js',
            '/scripts/prepare-desktop.js',
            '/package.json',
            '/.env',
        ]) {
            const response = await fetch(`${base}${pathname}`);
            await response.body?.cancel();
            assert.equal(response.status, 404, pathname);
        }
    });
    const feeds = await (await fetch(`${base}/api/feeds`)).json();
    assert.ok(feeds.length > 0);
    server.child.stdin.end();
    const [code] = await server.exited;
    assert.equal(code, 0);
});

test('port collisions fail startup without announcing another process as ready', { timeout: 15000 }, async t => {
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    t.after(() => new Promise(resolve => socket.close(resolve)));
    const server = await managedServer(t, socket.address().port);
    const [code] = await server.exited;
    assert.equal(code, 1);
    assert.match(server.output(), /EADDRINUSE/);
    assert.doesNotMatch(server.output(), /NBS_DESKTOP_READY/);
});
