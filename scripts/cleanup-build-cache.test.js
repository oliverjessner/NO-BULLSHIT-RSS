import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupBuildCache, formatCleanupReport, generatedDirectories, generatedFiles } from './cleanup-build-cache.js';

const expectedTargets = [
    ...generatedDirectories, ...generatedFiles,
    '.desktop-cache/24.22.0', '.desktop-cache/26.11.1',
    '.desktop-cache/runtime-Ab123x', '.desktop-cache/runtime-cD4567.previous',
];

async function fixture(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-cache-cleanup-'));
    const root = await realpath(directory);
    t.after(() => rm(root, { recursive: true, force: true }));
    const put = async (relative, contents = 'fixture') => {
        const filename = path.join(root, relative);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, contents);
    };
    execFileSync('git', ['init', '--quiet', root]);
    await put('package.json', JSON.stringify({ name: 'no-bullshit-rss', version: '1.7.0' }));
    await put('src-tauri/Cargo.toml', '[package]\nname = "no-bullshit-rss"\n');
    const removable = [
        ...generatedDirectories.map(directory => `${directory}/generated.bin`),
        ...generatedFiles,
        '.desktop-cache/26.11.1/node/bin/node',
        '.desktop-cache/24.22.0/archive.tar.gz',
        '.desktop-cache/runtime-Ab123x/temporary',
        '.desktop-cache/runtime-cD4567.previous/temporary',
    ];
    const preserved = [
        'dist/NO.BULLSHIT.RSS-1.7.0-arm64.dmg', 'data-v2.db', 'publisher-sessions/nbs-golem.json',
        'public/images/logo.svg', 'backend/server.js', 'topics.rules.json', 'node_modules/package/index.js',
        'src-tauri/resources/personal.txt', 'src-tauri/binaries/other-tool',
        'src-tauri/vendor/glib/src/lib.rs', 'src-tauri/icons/icon.png', '.env', 'backups/saved.db',
        '.desktop-cache/desktop-resources.lock', '.desktop-cache/release-recovery-v1.5.0/release.dmg',
        '.desktop-cache/runtime-foreign/notes', '.desktop-cache/26.11.1-custom/notes',
    ];
    for (const relative of [...removable, ...preserved]) await put(relative);
    const options = { directory: root, env: {}, processCommands: [], getRelease: async () => null,
        lock: async (_, operation) => operation() };
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
    assert.deepEqual(result.targets, expectedTargets);
    assert.equal(result.bytes, f.removable.length * Buffer.byteLength('fixture'));
    assert.deepEqual(result.entries.map(entry => entry.path), expectedTargets);
    assert.match(formatCleanupReport(result), /Would remove \d+ generated paths \([\d.]+ MiB of file contents\)/);
    assert.deepEqual(result.removed, []);
    for (const relative of [...f.removable, ...f.preserved]) assert.equal(await exists(path.join(f.root, relative)), true, relative);
});

test('apply removes generated runtime, sidecar, schemas, tests and caches while preserving releases and original inputs', async t => {
    const f = await fixture(t);
    const lockInode = (await lstat(path.join(f.root, '.desktop-cache/desktop-resources.lock'))).ino;
    const result = await cleanupBuildCache({ ...f.options, dryRun: false });
    assert.equal(result.removed.length, expectedTargets.length);
    assert.match(formatCleanupReport(result), /Removed \d+ generated paths/);
    for (const relative of f.removable) assert.equal(await exists(path.join(f.root, relative)), false, relative);
    for (const relative of f.preserved) assert.equal(await exists(path.join(f.root, relative)), true, relative);
    assert.equal((await lstat(path.join(f.root, '.desktop-cache/desktop-resources.lock'))).ino, lockInode);
    assert.deepEqual((await cleanupBuildCache({ ...f.options, dryRun: false })).removed, []);
});

test('rejects symlink targets and cache ancestors before deleting anything, without touching outside destinations', async t => {
    for (const relative of ['src-tauri/target', 'src-tauri/resources', 'src-tauri/gen', 'src-tauri/binaries', '.desktop-cache', '.desktop-cache/26.11.1']) {
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
    const linkSize = (await lstat(path.join(f.root, 'src-tauri/target/user-link'))).size;
    const result = await cleanupBuildCache({ ...f.options, dryRun: false });
    assert.equal(result.bytes, f.removable.length * Buffer.byteLength('fixture') + linkSize);
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
    assert.equal(result.skipped.length, expectedTargets.length);
    assert.equal(await exists(path.join(f.root, f.removable[0])), true);
    const installed = await cleanupBuildCache({ ...f.options, dryRun: false,
        processCommands: ['/Applications/NO BULLSHIT RSS.app/Contents/MacOS/rss-desktop'] });
    assert.equal(installed.removed.length, expectedTargets.length);
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
        assert.equal(result.skipped.length, expectedTargets.length, command);
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
        `rg '${f.root}/src-tauri/target/debug/no-bullshit-rss' README.md`,
        `editor ${f.root}/src-tauri/target/debug/output`,
        `node -e "console.log('${f.root}/src-tauri/binaries/rss-node-aarch64-apple-darwin')"`,
        `/bin/zsh -c 'cat ${f.root}/src-tauri/target/debug/output'`,
        `/Applications/NO BULLSHIT RSS.app/Contents/MacOS/rss-node backend/server.js --log ${f.root}/src-tauri/target/log.txt`,
        '/other-checkout/src-tauri/target/debug/no-bullshit-rss',
        '/other-checkout/src-tauri/binaries/rss-node-aarch64-apple-darwin',
    ];
    const result = await cleanupBuildCache({ ...f.options, dryRun: false, processCommands: commands });
    assert.equal(result.removed.length, expectedTargets.length);
    assert.deepEqual(result.skipped, []);
});

test('target checks use the OS executable path, preserve spaces and identify the blocking PID', async t => {
    const f = await fixture(t);
    const executable = `${f.root}/src-tauri/target/release/bundle/macos/NO BULLSHIT RSS.app/Contents/MacOS/no-bullshit-rss`;
    const result = await cleanupBuildCache({ ...f.options, dryRun: false, processRecords: [
        { pid: 456, executable, command: `${executable} --some-argument` },
    ] });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.blocker, { pid: 456, executable });
    assert.ok(formatCleanupReport(result).includes(`Cleanup blocked by PID 456: ${executable}`));
    for (const relative of f.removable) assert.equal(await exists(path.join(f.root, relative)), true, relative);
});

test('installed processes and path mentions in arguments do not block the checkout cleanup', async t => {
    const f = await fixture(t);
    const target = `${f.root}/src-tauri/target/debug/no-bullshit-rss`;
    const sidecar = `${f.root}/src-tauri/binaries/rss-node-aarch64-apple-darwin`;
    const result = await cleanupBuildCache({ ...f.options, dryRun: false, processRecords: [
        { pid: 1, executable: '/usr/bin/rg', command: `rg ${target} log.txt` },
        { pid: 2, executable: '/usr/bin/node', command: `node -e "console.log('${sidecar}')"` },
        { pid: 3, executable: '/Applications/NO BULLSHIT RSS.app/Contents/MacOS/rss-node', command: `rss-node server.js --log ${target}` },
        { pid: 4, executable: '/other-checkout/src-tauri/target/debug/rss', command: '/other-checkout/src-tauri/target/debug/rss' },
    ] });
    assert.equal(result.removed.length, expectedTargets.length);
    assert.equal(result.blocker, null);
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

test('refuses tracked files before removing any cache, including files tracked after the initial plan', async t => {
    for (const afterLock of [false, true]) {
        const f = await fixture(t);
        const filename = 'src-tauri/gen/generated.bin';
        const track = () => execFileSync('git', ['add', '--force', '--', filename], { cwd: f.root });
        if (!afterLock) track();
        await assert.rejects(cleanupBuildCache({ ...f.options, dryRun: false,
            lock: async (_, operation) => { if (afterLock) track(); return operation(); },
        }), /Refusing to remove tracked files: src-tauri\/gen\/generated.bin/);
        for (const relative of f.removable) assert.equal(await exists(path.join(f.root, relative)), true, relative);
    }
});

test('requires the checkout root and matching Cargo package', async t => {
    const f = await fixture(t);
    await f.put('nested/package.json', JSON.stringify({ name: 'no-bullshit-rss', version: '1.7.0' }));
    await f.put('nested/src-tauri/Cargo.toml', '[package]\nname = "no-bullshit-rss"\n');
    await assert.rejects(cleanupBuildCache({ ...f.options, directory: path.join(f.root, 'nested') }), /root of the Git checkout/);
    await f.put('src-tauri/Cargo.toml', '[package]\nname = "another-app"\n');
    await assert.rejects(cleanupBuildCache(f.options), /project root/);
});

test('an active checkout sidecar protects all generated output', async t => {
    const f = await fixture(t);
    const result = await cleanupBuildCache({ ...f.options, dryRun: false,
        processCommands: [`${f.root}/src-tauri/binaries/rss-node-aarch64-apple-darwin backend/server.js`],
    });
    assert.deepEqual(result.removed, []);
    assert.equal(result.skipped.length, expectedTargets.length);
    for (const relative of f.removable) assert.equal(await exists(path.join(f.root, relative)), true, relative);
});

function publishedRelease(version, contents = 'older DMG') {
    return {
        tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-11-01T12:00:00Z',
        assets: [{ name: `NO.BULLSHIT.RSS-${version}-arm64.dmg`, state: 'uploaded',
            digest: `sha256:${createHash('sha256').update(contents).digest('hex')}` }],
    };
}

test('previews and removes only numerically older DMGs whose published GitHub digest matches', async t => {
    const f = await fixture(t);
    await f.put('package.json', JSON.stringify({ name: 'no-bullshit-rss', version: '1.10.0' }));
    const old = 'dist/NO.BULLSHIT.RSS-1.9.10-arm64.dmg';
    await f.put(old, 'older DMG');
    const keep = [
        'dist/NO.BULLSHIT.RSS-1.10.0-arm64.dmg', 'dist/NO.BULLSHIT.RSS-1.11.0-arm64.dmg',
        'dist/NO.BULLSHIT.RSS-01.0.0-arm64.dmg', 'dist/NO.BULLSHIT.RSS-1.0.0-beta-arm64.dmg',
        'dist/personal.txt', 'dist/recovery/notes',
    ];
    for (const relative of keep) await f.put(relative, 'keep');
    const requested = [];
    const options = { ...f.options, getRelease: async tag => {
        requested.push(tag);
        return publishedRelease(tag.slice(1), tag === 'v1.9.10' ? 'older DMG' : 'does not match');
    } };
    const preview = await cleanupBuildCache(options);
    assert.ok(preview.targets.includes(old));
    assert.equal(await readFile(path.join(f.root, old), 'utf8'), 'older DMG');
    assert.ok(preview.preservedReleases.some(item => item.path.endsWith('personal.txt')));
    const result = await cleanupBuildCache({ ...options, dryRun: false });
    assert.ok(result.removed.includes(old));
    assert.equal(await exists(path.join(f.root, old)), false);
    for (const relative of keep) assert.equal(await readFile(path.join(f.root, relative), 'utf8'), 'keep', relative);
    assert.ok(!requested.includes('v1.10.0'));
    assert.ok(!requested.includes('v1.11.0'));
});

test('keeps missing, draft, unpublished, prerelease, incomplete and mismatching GitHub releases', async t => {
    for (const change of [
        () => null,
        release => ({ ...release, draft: true }),
        release => ({ ...release, published_at: null }),
        release => ({ ...release, prerelease: true }),
        release => ({ ...release, tag_name: 'v0.0.0' }),
        release => ({ ...release, assets: [] }),
        release => ({ ...release, assets: [{ ...release.assets[0], state: 'new' }] }),
        release => ({ ...release, assets: [{ ...release.assets[0], digest: null }] }),
        () => publishedRelease('1.6.0', 'different DMG'),
    ]) {
        const f = await fixture(t);
        const old = 'dist/NO.BULLSHIT.RSS-1.6.0-arm64.dmg';
        await f.put(old, 'older DMG');
        const result = await cleanupBuildCache({ ...f.options, dryRun: false,
            getRelease: async () => change(publishedRelease('1.6.0')) });
        assert.equal(await readFile(path.join(f.root, old), 'utf8'), 'older DMG');
        assert.ok(result.preservedReleases.some(item => item.path === old && /matching SHA-256/.test(item.reason)));
        assert.equal(result.removed.length, expectedTargets.length);
    }
});

test('GitHub failure preserves remaining releases while disposable output is still removed', async t => {
    const f = await fixture(t);
    const old = ['dist/NO.BULLSHIT.RSS-1.5.0-arm64.dmg', 'dist/NO.BULLSHIT.RSS-1.6.0-arm64.dmg'];
    for (const relative of old) await f.put(relative, 'older DMG');
    let calls = 0;
    const result = await cleanupBuildCache({ ...f.options, dryRun: false, getRelease: async () => {
        calls++;
        throw new Error('GitHub unavailable');
    } });
    assert.equal(calls, 2); // One attempt in each of the initial and locked plans.
    assert.equal(result.removed.length, expectedTargets.length);
    for (const relative of old) {
        assert.equal(await readFile(path.join(f.root, relative), 'utf8'), 'older DMG');
        assert.ok(result.preservedReleases.some(item => item.path === relative && item.reason === 'GitHub unavailable'));
    }
});

test('old DMGs are revalidated under the resource lock and again immediately before deletion', async t => {
    for (const duringVerification of [false, true]) {
        const f = await fixture(t);
        const old = 'dist/NO.BULLSHIT.RSS-1.6.0-arm64.dmg';
        await f.put(old, 'older DMG');
        let calls = 0;
        const result = await cleanupBuildCache({ ...f.options, dryRun: false,
            getRelease: async () => {
                if (duringVerification && ++calls === 2) await f.put(old, 'modified DMG');
                return publishedRelease('1.6.0');
            },
            lock: async (_, operation) => {
                if (!duringVerification) await f.put(old, 'modified DMG');
                return operation();
            },
        });
        assert.equal(await readFile(path.join(f.root, old), 'utf8'), 'modified DMG');
        assert.ok(!result.removed.includes(old));
        assert.ok(result.preservedReleases.some(item => item.path === old));
    }
});

test('tracked and symlinked old release files abort cleanup before disposable output is deleted', async t => {
    for (const mode of ['tracked', 'symlink', 'directory-symlink']) {
        const f = await fixture(t);
        const old = 'dist/NO.BULLSHIT.RSS-1.6.0-arm64.dmg';
        await f.put(old, 'older DMG');
        const outside = await mkdtemp(path.join(os.tmpdir(), 'rss-release-outside-'));
        t.after(() => rm(outside, { recursive: true, force: true }));
        await writeFile(path.join(outside, 'keep'), 'outside');
        if (mode === 'tracked') execFileSync('git', ['add', '--force', '--', old], { cwd: f.root });
        else {
            const relative = mode === 'symlink' ? old : 'dist';
            await rm(path.join(f.root, relative), { recursive: true, force: true });
            await symlink(mode === 'symlink' ? path.join(outside, 'keep') : outside,
                path.join(f.root, relative), mode === 'symlink' ? 'file' : 'dir');
        }
        await assert.rejects(cleanupBuildCache({ ...f.options, dryRun: false,
            getRelease: async () => publishedRelease('1.6.0'),
        }), /Refusing (to remove tracked files|symbolic link)/);
        for (const relative of f.removable) assert.equal(await exists(path.join(f.root, relative)), true, relative);
        assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'outside');
    }
});

test('a configured release directory inside target keeps its parent and current DMG', async t => {
    const f = await fixture(t);
    const old = 'src-tauri/target/release/NO.BULLSHIT.RSS-1.6.0-arm64.dmg';
    const current = 'src-tauri/target/release/NO.BULLSHIT.RSS-1.7.0-arm64.dmg';
    await f.put(old, 'older DMG');
    await f.put(current, 'current');
    const tags = [];
    const result = await cleanupBuildCache({ ...f.options, dryRun: false,
        env: { RELEASE_OUTPUT_DIR: 'src-tauri/target/release', TAG_PREFIX: 'release-' },
        getRelease: async tag => {
            tags.push(tag);
            return { ...publishedRelease('1.6.0'), tag_name: 'release-1.6.0' };
        },
    });
    assert.ok(result.removed.includes(old));
    assert.ok(!result.removed.includes('src-tauri/target'));
    assert.equal(await readFile(path.join(f.root, current), 'utf8'), 'current');
    assert.equal(await exists(path.join(f.root, f.removable[0])), true);
    assert.deepEqual(tags, ['release-1.6.0', 'release-1.6.0']);
});

test('protected data and release directories outside the checkout are never deleted', async t => {
    const f = await fixture(t);
    const old = 'dist/NO.BULLSHIT.RSS-1.6.0-arm64.dmg';
    await f.put(old, 'saved data');
    const result = await cleanupBuildCache({ ...f.options, dryRun: false,
        env: { DB_PATH: old }, getRelease: async () => { throw new Error('Must not verify protected data'); },
    });
    assert.equal(await readFile(path.join(f.root, old), 'utf8'), 'saved data');
    assert.ok(result.preservedReleases.some(item => item.path === old && /protected/.test(item.reason)));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'rss-release-output-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, path.basename(old)), 'external DMG');
    const external = await cleanupBuildCache({ ...f.options, dryRun: false, env: { RELEASE_OUTPUT_DIR: outside } });
    assert.equal(await readFile(path.join(outside, path.basename(old)), 'utf8'), 'external DMG');
    assert.ok(external.preservedReleases.some(item => item.path === outside && /inside the checkout/.test(item.reason)));
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
