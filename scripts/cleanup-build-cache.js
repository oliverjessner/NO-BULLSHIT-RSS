import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const nodeCacheName = /^\d+\.\d+\.\d+$/;
const runtimeCacheName = /^runtime-[A-Za-z0-9]{6}(?:\.previous)?$/;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releaseFile = /^NO\.BULLSHIT\.RSS-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-arm64\.dmg$/;
const releaseRepository = 'oliverjessner/NO-BULLSHIT-RSS';

// These paths contain disposable generated output, never original source/assets.
export const generatedDirectories = Object.freeze([
    'src-tauri/target',
    'src-tauri/resources/runtime',
    'src-tauri/gen',
    'src-tauri/vendor/glib/target',
    'coverage',
    'test-results',
    'playwright-report',
    '.desktop-cache/watchdog-qa',
]);
export const generatedFiles = Object.freeze([
    'src-tauri/binaries/rss-node-aarch64-apple-darwin',
    'src-tauri/binaries/rss-node-aarch64-apple-darwin.tmp',
    'src-tauri/vendor/glib/Cargo.lock',
]);

function isInside(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function inspectPath(root, relative) {
    const target = path.resolve(root, relative);
    if (target === root || !isInside(root, target)) throw new Error(`Refusing cache outside the project: ${relative}`);
    let current = root;
    for (const component of path.relative(root, target).split(path.sep)) {
        current = path.join(current, component);
        const info = await lstat(current).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (!info) return null;
        if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link in cache path: ${relative}`);
        if (!isInside(root, await realpath(current))) throw new Error(`Refusing cache outside the project: ${relative}`);
    }
    return lstat(target);
}

async function inspectProject(directory) {
    const root = await realpath(directory);
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    if (manifest.name !== 'no-bullshit-rss') throw new Error('Cache cleanup requires the NO BULLSHIT RSS project root');
    const cargo = await readFile(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
    if (!/^name\s*=\s*"no-bullshit-rss"\s*$/m.test(cargo)) throw new Error('Cache cleanup requires the NO BULLSHIT RSS project root');
    const checkout = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
    if (await realpath(checkout) !== root) throw new Error('Cache cleanup requires the root of the Git checkout');
    return root;
}

function protectedPaths(root, env, protectReleaseDirectory = true) {
    return [
        'node_modules', 'public', 'backend', 'cli', 'scripts', 'migrations', '.git',
        'data.db', 'data-v2.db', 'topics.rules.json', 'publisher-sessions', '.env', 'backups',
        env.DB_PATH, env.TOPIC_RULES_FILE_PATH, env.NBS_RANKING_SESSION_DIR,
        env.RSS_DATA_DIR, env.SERVER_LOG_PATH,
        ...(protectReleaseDirectory ? ['dist', env.RELEASE_OUTPUT_DIR] : []),
    ].filter(Boolean).map(value => path.resolve(root, value));
}

function overlaps(left, right) {
    return isInside(left, right) || isInside(right, left);
}

function refuseTrackedFiles(root, targets) {
    if (!targets.length) return;
    const tracked = execFileSync('git', ['--literal-pathspecs', 'ls-files', '-z', '--', ...targets], {
        cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    }).split('\0').filter(Boolean);
    if (tracked.length) throw new Error(`Refusing to remove tracked files: ${tracked.join(', ')}`);
}

async function sizeOf(filename) {
    const info = await lstat(filename);
    if (!info.isDirectory()) return info.size; // Includes symlinks, without following them.
    let bytes = 0;
    for (const name of await readdir(filename)) bytes += await sizeOf(path.join(filename, name));
    return bytes;
}

async function sha256(filename) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}

function olderThan(version, current) {
    if (!stableVersion.test(version) || !stableVersion.test(current)) return false;
    const left = version.split('.').map(BigInt);
    const right = current.split('.').map(BigInt);
    const index = left.findIndex((part, index) => part !== right[index]);
    return index >= 0 && left[index] < right[index];
}

function githubRelease(tag, directory) {
    try {
        return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', `repos/${releaseRepository}/releases/tags/${encodeURIComponent(tag)}`], {
            cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
        }));
    } catch (error) {
        if (String(error.stderr).includes('HTTP 404')) return null;
        throw new Error('GitHub release verification unavailable; check gh authentication and network access.');
    }
}

async function planOldReleases(root, env, getRelease) {
    const output = path.resolve(root, env.RELEASE_OUTPUT_DIR || 'dist');
    const targets = [];
    const preservedReleases = [];
    const digests = new Map();
    if (output === root || !isInside(root, output)) {
        preservedReleases.push({ path: output, reason: 'release output must be inside the checkout' });
        return { targets, preservedReleases, digests };
    }
    const relativeOutput = path.relative(root, output);
    const info = await inspectPath(root, relativeOutput);
    if (!info) return { targets, preservedReleases, digests };
    if (!info.isDirectory()) throw new Error('Release output must be a directory');
    const { version: current } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const protectedDirectories = protectedPaths(root, env, false);
    let unavailable;
    for (const name of (await readdir(output)).sort()) {
        const relative = path.join(relativeOutput, name);
        const version = releaseFile.exec(name)?.[1];
        const keep = reason => preservedReleases.push({ path: relative, reason });
        if (!version || !olderThan(version, current)) {
            keep('current, newer or unrecognized release file');
            continue;
        }
        const file = path.join(root, relative);
        const info = await inspectPath(root, relative);
        if (!info) continue;
        if (!info.isFile()) {
            keep('not a regular generated DMG');
            continue;
        }
        if (protectedDirectories.some(protectedPath => overlaps(file, protectedPath))) {
            keep('contains protected application data');
            continue;
        }
        try {
            if (unavailable) throw unavailable;
            const digest = await sha256(file);
            const tag = `${env.TAG_PREFIX || 'v'}${version}`;
            let remote;
            try { remote = await getRelease(tag, root); } catch (error) { unavailable = error; throw error; }
            const asset = remote?.assets?.find(item => item.name === name);
            if (remote?.tag_name !== tag || remote.draft !== false || remote.prerelease !== false
                || !remote.published_at || asset?.state !== 'uploaded' || asset.digest !== `sha256:${digest}`) {
                throw new Error('no published GitHub DMG with a matching SHA-256 digest');
            }
            targets.push(relative);
            digests.set(relative, digest);
        } catch (error) {
            keep(error.message);
        }
    }
    return { targets, preservedReleases, digests };
}

function activeTargetProcess(root, commands) {
    const target = path.join(root, 'src-tauri', 'target');
    return commands.some(command => command.includes(`${target}${path.sep}`)
        || command.includes('src-tauri/target/') || command.includes('src-tauri\\target\\')
        || command.includes(path.join(root, 'src-tauri', 'binaries', 'rss-node-'))
        || command.includes('src-tauri/binaries/rss-node-'));
}

function activeBuildProcess(commands) {
    return commands.some(command => {
        // Inspect the actual executable/script, not words appearing in grep,
        // editor arguments or inline JavaScript source.
        const words = (command.match(/"[^"]*"|'[^']*'|\S+/g) || [])
            .map(word => word.replace(/^(['"])(.*)\1$/, '$2'));
        const executable = path.basename(words.shift() || '').replace(/\.exe$/i, '');
        if (executable === 'rustc') return true;
        if (executable === 'cargo') {
            while (words[0]?.startsWith('-') || words[0]?.startsWith('+')) {
                const flag = words.shift();
                if (['--color', '--config', '-Z', '-C'].includes(flag)) words.shift();
            }
            return ['build', 'check', 'test', 'run'].includes(words[0]);
        }
        if (executable === 'tauri') return ['build', 'dev'].includes(words[0]);
        if (!['node', 'nodejs'].includes(executable)) return false;
        while (words[0]?.startsWith('-')) {
            const flag = words.shift();
            if (['-e', '--eval', '-p', '--print', '--test'].includes(flag) || /^(?:--eval|--print)=/.test(flag)) return false;
            if (['-r', '--require', '--import', '--loader', '--experimental-loader'].includes(flag)) words.shift();
        }
        const script = path.basename(words.shift() || '');
        return script === 'build-desktop.js' || (['tauri', 'tauri.js'].includes(script) && ['build', 'dev'].includes(words[0]));
    });
}

export async function planBuildCacheCleanup({ directory = projectDirectory, env = process.env, processCommands, getRelease = githubRelease } = {}) {
    const root = await inspectProject(directory);
    const candidates = [...generatedDirectories, ...generatedFiles];
    const cache = await inspectPath(root, '.desktop-cache');
    if (cache) {
        if (!cache.isDirectory()) throw new Error('Desktop cache must be a directory');
        for (const name of (await readdir(path.join(root, '.desktop-cache'))).sort()) {
            if (nodeCacheName.test(name) || runtimeCacheName.test(name)) candidates.push(`.desktop-cache/${name}`);
        }
    }
    const targets = [];
    const skipped = [];
    const protectedDirectories = protectedPaths(root, env);
    for (const relative of candidates) {
        const info = await inspectPath(root, relative);
        if (!info) continue;
        if (generatedFiles.includes(relative) ? !info.isFile() : !info.isDirectory()) throw new Error(`Unexpected generated output type: ${relative}`);
        const absolute = path.join(root, relative);
        if (protectedDirectories.some(protectedPath => overlaps(absolute, protectedPath))) {
            skipped.push({ path: relative, reason: 'contains protected application data or release output' });
        } else targets.push(relative);
    }
    const releases = await planOldReleases(root, env, getRelease);
    // A custom release directory may itself be inside an otherwise disposable path.
    // Never schedule both its parent and a verified release file for removal.
    for (const relative of releases.targets) {
        if (!targets.some(parent => isInside(path.join(root, parent), path.join(root, relative)))) targets.push(relative);
    }
    refuseTrackedFiles(root, targets);
    const commands = processCommands ?? execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).split('\n');
    const busyReason = activeBuildProcess(commands) ? 'a Rust or Tauri build is active'
        : activeTargetProcess(root, commands) ? 'a process is using a Tauri target directory or sidecar' : null;
    if (busyReason) {
        skipped.push(...targets.map(relative => ({ path: relative, reason: busyReason })));
        targets.length = 0;
    }
    const entries = [];
    for (const relative of targets) entries.push({ path: relative, bytes: await sizeOf(path.join(root, relative)) });
    return { root, targets, skipped, entries, bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
        preservedReleases: releases.preservedReleases, releaseDigests: Object.fromEntries(releases.digests) };
}

async function withDesktopResourceLock(root, operation) {
    await inspectPath(root, '.desktop-cache');
    await mkdir(path.join(root, '.desktop-cache'), { recursive: true });
    const lockPath = '.desktop-cache/desktop-resources.lock';
    await inspectPath(root, lockPath);
    // Keep the same inode used by prepare-desktop.js and build.rs. The holder
    // exits on stdin EOF, releasing its BSD flock after our operation finishes.
    const child = spawn('/usr/bin/lockf', ['-t', '0', '-k', path.join(root, lockPath), process.execPath, '-e',
        "process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); process.stdout.write('CACHE_LOCK_READY\\n');"],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => child.once('close', resolve));
    const acquired = new Promise((resolve, reject) => {
        let output = '';
        child.once('error', () => reject(new Error('Could not acquire the desktop resource lock')));
        child.stdout.on('data', chunk => {
            output += chunk;
            if (output.includes('CACHE_LOCK_READY\n')) resolve();
        });
        child.once('close', () => reject(new Error('Desktop resources are busy; cache cleanup was skipped')));
        child.stderr.resume();
    });
    try {
        await acquired;
        return await operation();
    } finally {
        child.stdin.end();
        await closed;
    }
}

export async function cleanupBuildCache({ directory = projectDirectory, env = process.env, dryRun = true, processCommands, getRelease = githubRelease,
    lock = withDesktopResourceLock } = {}) {
    const initial = await planBuildCacheCleanup({ directory, env, processCommands, getRelease });
    if (dryRun || !initial.targets.length) return { ...initial, dryRun, removed: [] };
    return lock(initial.root, async () => {
        // Recheck all boundaries and active processes while holding the build
        // resource lock; a dry-run plan is never reused for a later deletion.
        const plan = await planBuildCacheCleanup({ directory: initial.root, env, processCommands, getRelease });
        const removed = [];
        // Validate the whole set again before the first deletion, including Git state.
        refuseTrackedFiles(plan.root, plan.targets);
        for (const relative of plan.targets) await inspectPath(plan.root, relative);
        for (const relative of plan.targets) {
            if (!await inspectPath(plan.root, relative)) continue;
            if (plan.releaseDigests[relative] && await sha256(path.join(plan.root, relative)) !== plan.releaseDigests[relative]) {
                plan.preservedReleases.push({ path: relative, reason: 'DMG changed after verification' });
                continue;
            }
            // rm unlinks nested symlinks without following their destinations.
            await rm(path.join(plan.root, relative), { recursive: true, force: true });
            removed.push(relative);
        }
        return { ...plan, dryRun: false, removed };
    });
}

export function formatCleanupReport(result) {
    const selected = result.dryRun ? result.entries : result.entries.filter(entry => result.removed.includes(entry.path));
    const bytes = selected.reduce((total, entry) => total + entry.bytes, 0);
    const verb = result.dryRun ? 'Would remove' : 'Removed';
    return [
        `${verb} ${selected.length} generated paths (${(bytes / 1024 ** 2).toFixed(1)} MiB of file contents).`,
        ...selected.map(entry => `${verb}: ${entry.path} (${(entry.bytes / 1024 ** 2).toFixed(1)} MiB)`),
        ...[...result.skipped, ...result.preservedReleases].map(item => `Kept ${item.path}: ${item.reason}`),
        'Current and unverified releases, source, installed dependencies and application data are preserved.',
    ].join('\n');
}

async function main() {
    const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) {
        console.log('Usage: node scripts/cleanup-build-cache.js [--dry-run | --apply]\n\nDefaults to dry-run. Removes generated Tauri/runtime/test output and recognized desktop caches. Older DMGs are removed only after their SHA-256 matches a published GitHub asset (requires gh).\nPreserves current/unverified releases, tracked files, source, installed dependencies, user data, sessions and the installed app.');
        return;
    }
    if (values.apply && values['dry-run']) throw new Error('Choose either --apply or --dry-run');
    const result = await cleanupBuildCache({ dryRun: !values.apply });
    console.log(formatCleanupReport(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(`Cache cleanup: ${error.message}`); process.exitCode = 1; });
}
