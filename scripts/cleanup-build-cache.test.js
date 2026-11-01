import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupBuildCache } from './cleanup-build-cache.js';

async function fixture(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-cache-cleanup-'));
    const root = await realpath(directory);
    t.after(() => rm(root, { recursive: true, force: true }));
    const put = async (relative, contents = 'fixture') => {
        const filename = path.join(root, relative);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, contents);
    };
    await put('package.json', JSON.stringify({ name: 'no-bullshit-rss' }));
    const removable = [
        'src-tauri/target/release/cache',
        '.desktop-cache/26.11.1/node/bin/node',
        '.desktop-cache/24.22.0/archive.tar.gz',
        '.desktop-cache/runtime-Ab123x/temporary',
        '.desktop-cache/runtime-cD4567.previous/temporary',
    ];
    const preserved = [
        'dist/NO.BULLSHIT.RSS-1.7.0-arm64.dmg', 'data-v2.db', 'publisher-sessions/nbs-golem.json',
        'public/images/logo.svg', 'backend/server.js', 'topics.rules.json', 'node_modules/package/index.js',
        'src-tauri/resources/runtime/backend/server.js', 'src-tauri/binaries/rss-node-aarch64-apple-darwin',
        '.desktop-cache/desktop-resources.lock', '.desktop-cache/release-recovery-v1.5.0/release.dmg',
        '.desktop-cache/runtime-foreign/notes', '.desktop-cache/26.11.1-custom/notes',
    ];
    for (const relative of [...removable, ...preserved]) await put(relative);
    const options = { directory: root, env: {}, processCommands: [], lock: async (_, operation) => operation() };
    return { root, put, removable, preserved, options };
}

async function exists(filename) {
    return Boolean(await lstat(filename).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
    }));
}

test('dry-run lists only known build caches and does not mutate any cache or application file', async t => {
    const f = await fixture(t);
    const result = await cleanupBuildCache(f.options);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.targets, [
        'src-tauri/target', '.desktop-cache/24.22.0', '.desktop-cache/26.11.1',
        '.desktop-cache/runtime-Ab123x', '.desktop-cache/runtime-cD4567.previous',
    ]);
    assert.deepEqual(result.removed, []);
    for (const relative of [...f.removable, ...f.preserved]) assert.equal(await exists(path.join(f.root, relative)), true, relative);
});

test('apply removes allowed build caches while preserving releases, dependencies, source, sessions and runtime inputs', async t => {
    const f = await fixture(t);
    const lockInode = (await lstat(path.join(f.root, '.desktop-cache/desktop-resources.lock'))).ino;
    const result = await cleanupBuildCache({ ...f.options, dryRun: false });
    assert.equal(result.removed.length, 5);
    for (const relative of f.removable) assert.equal(await exists(path.join(f.root, relative)), false, relative);
    for (const relative of f.preserved) assert.equal(await exists(path.join(f.root, relative)), true, relative);
    assert.equal((await lstat(path.join(f.root, '.desktop-cache/desktop-resources.lock'))).ino, lockInode);
    assert.deepEqual((await cleanupBuildCache({ ...f.options, dryRun: false })).removed, []);
});

test('rejects symlink targets and cache ancestors before deleting anything, without touching outside destinations', async t => {
    for (const relative of ['src-tauri/target', '.desktop-cache', '.desktop-cache/26.11.1']) {
        const f = await fixture(t);
        const outside = await mkdtemp(path.join(os.tmpdir(), 'rss-cache-outside-'));
        t.after(() => rm(outside, { recursive: true, force: true }));
        await writeFile(path.join(outside, 'keep.txt'), 'user data');
        const target = path.join(f.root, relative);
        await rm(target, { recursive: true });
        await symlink(outside, target, 'dir');
        await assert.rejects(cleanupBuildCache({ ...f.options, dryRun: false }), /Refusing symbolic link/);
        assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'user data');
        assert.equal(await exists(path.join(f.root, 'dist/NO.BULLSHIT.RSS-1.7.0-arm64.dmg')), true);
    }
});

test('nested symlinks are unlinked without following them outside the cache', async t => {
    const f = await fixture(t);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'rss-cache-linked-data-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, 'keep.txt'), 'user data');
    await symlink(outside, path.join(f.root, 'src-tauri/target/user-link'), 'dir');
    await cleanupBuildCache({ ...f.options, dryRun: false });
    assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'user data');
});

test('keeps configured data, session storage and release outputs even when they live inside an allowed cache', async t => {
    const f = await fixture(t);
    await f.put('src-tauri/target/custom.db', 'database');
    await f.put('.desktop-cache/26.11.1/publisher-sessions/nbs-golem.json', 'session');
    const result = await cleanupBuildCache({ ...f.options, dryRun: false, env: {
        DB_PATH: path.join(f.root, 'src-tauri/target/custom.db'),
        NBS_RANKING_SESSION_DIR: path.join(f.root, '.desktop-cache/26.11.1/publisher-sessions'),
    } });
    assert.equal(result.skipped.length, 2);
    assert.equal(await readFile(path.join(f.root, 'src-tauri/target/custom.db'), 'utf8'), 'database');
    assert.equal(await readFile(path.join(f.root, '.desktop-cache/26.11.1/publisher-sessions/nbs-golem.json'), 'utf8'), 'session');
    const other = await fixture(t);
    const artifact = 'src-tauri/target/release/current-arm64.dmg';
    await other.put(artifact, 'current DMG');
    await cleanupBuildCache({ ...other.options, dryRun: false, env: { RELEASE_OUTPUT_DIR: 'src-tauri/target/release' } });
    assert.equal(await readFile(path.join(other.root, artifact), 'utf8'), 'current DMG');
});

test('running Tauri target binaries prevent removal while an installed app does not affect the allowlist', async t => {
    const f = await fixture(t);
    const result = await cleanupBuildCache({ ...f.options, dryRun: false,
        processCommands: [`${f.root}/src-tauri/target/debug/rss-desktop`] });
    assert.deepEqual(result.removed, []);
    assert.equal(result.skipped.length, 5);
    assert.equal(await exists(path.join(f.root, f.removable[0])), true);
    const installed = await cleanupBuildCache({ ...f.options, dryRun: false,
        processCommands: ['/Applications/NO BULLSHIT RSS.app/Contents/MacOS/rss-desktop'] });
    assert.equal(installed.removed.length, 5);
});

test('active Rust or Tauri compilation keeps caches even before a target binary exists', async t => {
    const f = await fixture(t);
    for (const command of [
        'cargo build --release', '/toolchain/bin/cargo check --manifest-path src-tauri/Cargo.toml',
        'cargo +nightly test', 'cargo --color always run', '/toolchain/bin/rustc --crate-name rss source.rs',
        'tauri build', '/tools/tauri dev', 'node scripts/build-desktop.js',
        'node --require loader.cjs scripts/build-desktop.js',
        'node node_modules/@tauri-apps/cli/tauri.js build',
        'node node_modules/.bin/tauri dev',
    ]) {
        const result = await cleanupBuildCache({ ...f.options, dryRun: false, processCommands: [command] });
        assert.deepEqual(result.removed, [], command);
        assert.equal(result.skipped.length, 5, command);
        assert.ok(result.skipped.every(item => item.reason === 'a Rust or Tauri build is active'), command);
        assert.equal(await exists(path.join(f.root, '.desktop-cache/26.11.1/node/bin/node')), true, command);
    }
});

test('source-text mentions and read-only Cargo/Tauri commands do not impersonate active builds', async t => {
    const f = await fixture(t);
    const commands = [
        'rg cargo build README.md', 'grep rustc source.rs', 'editor scripts/build-desktop.js',
        'node -e "console.log(\'cargo build\')"', 'node --eval="rustc"',
        'node --test scripts/cleanup-build-cache.test.js', 'cargo metadata --format-version 1', 'tauri info',
        'node node_modules/@tauri-apps/cli/tauri.js --version',
    ];
    const result = await cleanupBuildCache({ ...f.options, dryRun: false, processCommands: commands });
    assert.equal(result.removed.length, 5);
    assert.deepEqual(result.skipped, []);
});

test('revalidates path boundaries after acquiring the shared resource lock', async t => {
    const f = await fixture(t);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'rss-cache-swapped-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, 'keep.txt'), 'user data');
    await assert.rejects(cleanupBuildCache({ ...f.options, dryRun: false, lock: async (_, operation) => {
        await rm(path.join(f.root, 'src-tauri/target'), { recursive: true });
        await symlink(outside, path.join(f.root, 'src-tauri/target'), 'dir');
        return operation();
    } }), /Refusing symbolic link/);
    assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'user data');
    assert.equal(await exists(path.join(f.root, '.desktop-cache/26.11.1/node/bin/node')), true);
});

test('refuses cleanup in a different project', async t => {
    const f = await fixture(t);
    await f.put('package.json', JSON.stringify({ name: 'another-project' }));
    await assert.rejects(cleanupBuildCache({ ...f.options, dryRun: false }), /project root/);
    assert.equal(await exists(path.join(f.root, f.removable[0])), true);
});

test('shares the desktop resource lock and preserves its inode', { skip: process.platform !== 'darwin' }, async t => {
    const f = await fixture(t);
    const filename = path.join(f.root, '.desktop-cache/desktop-resources.lock');
    const inode = (await lstat(filename)).ino;
    const child = spawn('/usr/bin/lockf', ['-k', filename, process.execPath, '-e',
        "process.stdin.resume(); process.stdout.write('ready\\n');"], { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => child.once('close', resolve));
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    try {
        const { lock, ...realLockOptions } = f.options;
        await assert.rejects(cleanupBuildCache({ ...realLockOptions, dryRun: false }), /resources are busy/);
        assert.equal(await exists(path.join(f.root, f.removable[0])), true);
    } finally {
        child.stdin.end();
        await closed;
    }
    const { lock, ...realLockOptions } = f.options;
    await cleanupBuildCache({ ...realLockOptions, dryRun: false });
    assert.equal((await lstat(filename)).ino, inode);
});
