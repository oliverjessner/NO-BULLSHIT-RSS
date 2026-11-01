import { execFileSync, spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const nodeCacheName = /^\d+\.\d+\.\d+$/;
const runtimeCacheName = /^runtime-[A-Za-z0-9]{6}(?:\.previous)?$/;

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
    return root;
}

function protectedPaths(root, env) {
    return [
        'dist', 'node_modules', 'public', 'backend', 'cli', 'scripts', 'migrations', '.git',
        'data.db', 'data-v2.db', 'topics.rules.json', 'publisher-sessions',
        env.DB_PATH, env.TOPIC_RULES_FILE_PATH, env.NBS_RANKING_SESSION_DIR,
        env.RELEASE_OUTPUT_DIR,
    ].filter(Boolean).map(value => path.resolve(root, value));
}

function activeTargetProcess(root, commands) {
    const target = path.join(root, 'src-tauri', 'target');
    return commands.some(command => command.includes(`${target}${path.sep}`)
        || command.includes('src-tauri/target/') || command.includes('src-tauri\\target\\'));
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

export async function planBuildCacheCleanup({ directory = projectDirectory, env = process.env, processCommands } = {}) {
    const root = await inspectProject(directory);
    const candidates = ['src-tauri/target'];
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
        if (!info.isDirectory()) throw new Error(`Cache target must be a directory: ${relative}`);
        const absolute = path.join(root, relative);
        if (protectedDirectories.some(protectedPath => isInside(absolute, protectedPath) || isInside(protectedPath, absolute))) {
            skipped.push({ path: relative, reason: 'contains protected application data or release output' });
        } else targets.push(relative);
    }
    const commands = processCommands ?? execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).split('\n');
    const busyReason = activeBuildProcess(commands) ? 'a Rust or Tauri build is active'
        : activeTargetProcess(root, commands) ? 'a process is using a Tauri target directory' : null;
    if (busyReason) {
        skipped.push(...targets.map(relative => ({ path: relative, reason: busyReason })));
        targets.length = 0;
    }
    return { root, targets, skipped };
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

export async function cleanupBuildCache({ directory = projectDirectory, env = process.env, dryRun = true, processCommands,
    lock = withDesktopResourceLock } = {}) {
    const initial = await planBuildCacheCleanup({ directory, env, processCommands });
    if (dryRun || !initial.targets.length) return { ...initial, dryRun, removed: [] };
    return lock(initial.root, async () => {
        // Recheck all boundaries and active processes while holding the build
        // resource lock; a dry-run plan is never reused for a later deletion.
        const plan = await planBuildCacheCleanup({ directory: initial.root, env, processCommands });
        const removed = [];
        for (const relative of plan.targets) {
            await inspectPath(plan.root, relative);
            // rm unlinks nested symlinks without following their destinations.
            await rm(path.join(plan.root, relative), { recursive: true, force: true });
            removed.push(relative);
        }
        return { ...plan, dryRun: false, removed };
    });
}

async function main() {
    const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) {
        console.log('Usage: node scripts/cleanup-build-cache.js [--dry-run | --apply]\n\nDefaults to dry-run. Removes only Tauri build output and recognized desktop build caches.\nPreserves dist, dependencies, generated runtime inputs, user data, sessions and the installed app.');
        return;
    }
    if (values.apply && values['dry-run']) throw new Error('Choose either --apply or --dry-run');
    const result = await cleanupBuildCache({ dryRun: !values.apply });
    for (const relative of result.dryRun ? result.targets : result.removed) console.log(`${result.dryRun ? 'Would remove' : 'Removed'} build cache: ${relative}`);
    for (const item of result.skipped) console.log(`Kept ${item.path}: ${item.reason}`);
    if (!result.targets.length && !result.skipped.length) console.log('No removable build caches found.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(`Cache cleanup: ${error.message}`); process.exitCode = 1; });
}
