import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const NODE_VERSION = '26.11.1';

export function runtimeTarget(platform, arch) {
    if (platform !== 'darwin' || arch !== 'arm64') {
        throw new Error('Desktop builds currently support macOS Apple Silicon only.');
    }
    return 'aarch64-apple-darwin';
}

export function verifyRuntime(binary, directory) {
    execFileSync(binary, ['--input-type=module', '-e', `
        import sqlite3 from '@vscode/sqlite3';
        import { extractFavicon } from 'fetchary';
        const db = new sqlite3.Database(':memory:');
        db.get('SELECT 42 AS answer', (error, row) => {
            if (error || row.answer !== 42) throw error || new Error('SQLite smoke failed');
            db.close();
        });
        const result = await extractFavicon('https://example.com/', {
            mode: 'http',
            fetch: async url => new Response(url.endsWith('/favicon.ico')
                ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>'
                : '<html></html>'),
        });
        if (result.image.contentType !== 'image/svg+xml') throw new Error('Fetchary smoke failed');
    `], { cwd: directory, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
}

async function download(url, destination) {
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '180', url, '--output', destination], { stdio: 'inherit' });
}

async function prepareNode(cache) {
    const archive = `node-v${NODE_VERSION}-darwin-arm64.tar.gz`;
    const archivePath = path.join(cache, archive);
    const extracted = path.join(cache, `node-v${NODE_VERSION}-darwin-arm64`);
    const binary = path.join(extracted, 'bin', 'node');
    const baseUrl = `https://nodejs.org/dist/v${NODE_VERSION}/`;
    await mkdir(cache, { recursive: true });
    const checksumsPath = path.join(cache, 'SHASUMS256.txt');
    if (!(await stat(checksumsPath).catch(() => null))) await download(`${baseUrl}SHASUMS256.txt`, checksumsPath);
    const checksumLine = (await readFile(checksumsPath, 'utf8')).split('\n').find(line => line.endsWith(`  ${archive}`));
    if (!checksumLine) throw new Error(`Missing official checksum for ${archive}`);
    if (!(await stat(archivePath).catch(() => null))) {
        const temporary = `${archivePath}.download`;
        await download(`${baseUrl}${archive}`, temporary);
        await copyFile(temporary, archivePath);
        await rm(temporary);
    }
    const hash = createHash('sha256').update(await readFile(archivePath)).digest('hex');
    if (hash !== checksumLine.split(' ')[0]) {
        await rm(archivePath);
        throw new Error('Node archive checksum mismatch; corrupt download removed. Run preparation again.');
    }
    await rm(extracted, { recursive: true, force: true });
    execFileSync('tar', ['-xzf', archivePath, '-C', cache]);
    return { binary, license: path.join(extracted, 'LICENSE') };
}

export async function prepareDesktop() {
    const target = runtimeTarget(process.platform, process.arch);
    const { binary, license } = await prepareNode(path.join(root, '.desktop-cache', NODE_VERSION));
    const resources = path.join(root, 'src-tauri', 'resources', 'runtime');
    const binaries = path.join(root, 'src-tauri', 'binaries');
    await rm(resources, { recursive: true, force: true });
    await mkdir(resources, { recursive: true });
    await mkdir(binaries, { recursive: true });
    const bundledNode = path.join(binaries, `rss-node-${target}`);
    const temporaryNode = `${bundledNode}.tmp`;
    await copyFile(binary, temporaryNode);
    await chmod(temporaryNode, 0o755);
    execFileSync('codesign', ['--force', '--sign', '-', temporaryNode], { stdio: 'inherit' });
    // Replacing an inode in use can invalidate macOS code-signature caches.
    await rename(temporaryNode, bundledNode);
    // Only explicit application inputs and the installed production dependency tree.
    for (const directory of ['backend', 'cli', 'migrations', 'public']) {
        await cp(path.join(root, directory), path.join(resources, directory), {
            recursive: true,
            filter: source => !source.endsWith('.test.js'),
        });
    }
    await mkdir(path.join(resources, 'scripts'));
    for (const file of ['scripts/init-db.js', 'scripts/sources.json', 'topics.rules.json', 'LICENSE']) {
        await copyFile(path.join(root, file), path.join(resources, file));
    }
    await copyFile(license, path.join(resources, 'NODE-LICENSE'));
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    await writeFile(path.join(resources, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: pkg.type, dependencies: pkg.dependencies }, null, 2));
    const dependencies = execFileSync('npm', ['ls', '--all', '--omit=dev', '--parseable'], { cwd: root, encoding: 'utf8' }).trim().split('\n').slice(1);
    for (const dependency of dependencies) {
        const relative = path.relative(root, dependency);
        if (!relative.startsWith('node_modules/')) throw new Error(`Dependency outside project: ${relative}`);
        await cp(dependency, path.join(resources, relative), { recursive: true, dereference: true });
    }
    // Exercise SQLite and HTTP icon extraction with the bundled runtime.
    verifyRuntime(bundledNode, resources);
    console.log(`Prepared Node ${NODE_VERSION}, SQLite and ${dependencies.length} production packages for ${target}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    prepareDesktop().catch(error => { console.error(error.message); process.exitCode = 1; });
}
