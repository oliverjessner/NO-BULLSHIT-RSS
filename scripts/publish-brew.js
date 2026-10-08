import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const releaseRepository = 'oliverjessner/NO-BULLSHIT-RSS';
const tapRepository = 'oliverjessner/homebrew-tap';
const caskPath = 'Casks/no-bullshit-rss.rb';
const tapFiles = [caskPath, 'README.md'];
const description = 'Local-first RSS reader with clustered digests';

function run(command, args, { cwd = projectDirectory, acceptedStatuses = [0] } = {}) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
    if (!acceptedStatuses.includes(result.status)) {
        throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim() || result.signal || result.status}`);
    }
    return result;
}

function inspectLocalTap(tapDirectory, branch) {
    const git = args => run('git', args, { cwd: tapDirectory }).stdout.trim();
    if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(tapDirectory)) {
        throw new Error(`The tap path must be the root of its Git checkout: ${tapDirectory}`);
    }
    const validRemotes = [
        `https://github.com/${tapRepository}`,
        `git@github.com:${tapRepository}`,
        `ssh://git@github.com/${tapRepository}`,
    ];
    for (const args of [['remote', 'get-url', 'origin'], ['remote', 'get-url', '--push', 'origin']]) {
        const remote = git(args).replace(/\/$/, '').replace(/\.git$/, '');
        if (!validRemotes.includes(remote)) throw new Error(`The tap origin must point to ${tapRepository}.`);
    }
    if (git(['branch', '--show-current']) !== branch) throw new Error(`Check out the tap's ${branch} branch before publishing.`);
    if (git(['status', '--porcelain'])) throw new Error(`The tap has uncommitted changes: ${tapDirectory}`);
    return git(['rev-parse', 'HEAD']);
}

function refreshLocalTap(tapDirectory, branch, tag) {
    const git = args => run('git', args, { cwd: tapDirectory }).stdout.trim();
    git(['fetch', 'origin']);
    const remoteRef = `refs/remotes/origin/${branch}`;
    const counts = git(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]);
    if (!/^\d+\s+\d+$/.test(counts)) throw new Error('Could not determine the tap branch state.');
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    if (ahead) {
        const subject = git(['log', '-1', '--format=%s']);
        const changed = git(['diff', '--name-only', `${remoteRef}..HEAD`]).split('\n').filter(Boolean);
        if (ahead !== 1 || behind || subject !== `Update NO BULLSHIT RSS cask to ${tag}`
            || !changed.length || changed.some(file => !tapFiles.includes(file))) {
            throw new Error('The tap has unpublished or diverged commits. Synchronize it with origin before publishing.');
        }
        return true; // Retry the previous publication if its commit succeeded but push failed.
    }
    if (behind) git(['merge', '--ff-only', remoteRef]);
    return false;
}

export function selectReleaseAsset(release, version, tag = `v${version}`) {
    if (release.tag_name !== tag || release.draft || release.prerelease) {
        throw new Error(`Expected a published stable GitHub release for ${tag}.`);
    }
    const assets = (release.assets || []).filter(asset => asset.name?.endsWith(`-${version}-arm64.dmg`));
    if (assets.length !== 1) throw new Error(`Expected exactly one ARM64 DMG for ${tag}, found ${assets.length}.`);
    const asset = assets[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(asset.name)) throw new Error('Invalid release asset filename.');
    const url = new URL(asset.browser_download_url);
    const expectedPath = `/${releaseRepository}/releases/download/${encodeURIComponent(tag)}/`;
    if (url.origin !== 'https://github.com' || !url.pathname.startsWith(expectedPath)
        || decodeURIComponent(url.pathname.slice(expectedPath.length)) !== asset.name || url.search || url.hash) {
        throw new Error('The DMG URL does not match the selected GitHub release asset.');
    }
    return asset;
}

export function renderCask({ version, sha256, url }) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid stable version: ${version}`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid SHA-256 checksum.');
    const versionedUrl = url.replaceAll(version, '#{version}');
    return `cask "no-bullshit-rss" do
  version "${version}"
  sha256 "${sha256}"

  url "${versionedUrl}"
  name "NO BULLSHIT RSS"
  desc "${description}"
  homepage "https://github.com/${releaseRepository}"

  depends_on arch: :arm64
  depends_on macos: :ventura

  app "NO BULLSHIT RSS.app"
  binary "#{appdir}/NO BULLSHIT RSS.app/Contents/Resources/bin/no-bullshit-rss",
         target: "no-bullshit-rss"

  uninstall quit: "com.oliverjessner.no-bullshit-rss"

  zap trash: [
    "~/Library/Application Support/NO-BULLSHIT-RSS",
    "~/Library/Preferences/com.oliverjessner.no-bullshit-rss.plist",
  ]
end
`;
}

export function updateTapReadme(readme) {
    const heading = /^## Installable Packages[ \t]*$/m.exec(readme);
    if (!heading) throw new Error('Could not find the Installable Packages section in the tap README.');
    const start = heading.index + heading[0].length;
    const nextHeading = /^## /m.exec(readme.slice(start));
    const end = nextHeading ? start + nextHeading.index : readme.length;
    let section = readme.slice(start, end);
    const rows = [...section.matchAll(/^\|.*\|[ \t]*$/gm)];
    if (rows.length < 2) throw new Error('Could not find the package table in the tap README.');
    const row = `| \`no-bullshit-rss\` | Cask | ${description} | \`brew install --cask oliverjessner/tap/no-bullshit-rss\` |`;
    const existingRow = /^\| `no-bullshit-rss` \|.*$/m;
    if (existingRow.test(section)) section = section.replace(existingRow, row);
    else {
        const lastRow = rows.at(-1);
        const insertion = lastRow.index + lastRow[0].length;
        section = `${section.slice(0, insertion)}\n${row}${section.slice(insertion)}`;
    }
    const installationBlock = /```sh\n([\s\S]*?)\n```/;
    if (!installationBlock.test(section)) throw new Error('Could not find the short-install code block in the tap README.');
    section = section.replace(installationBlock, (block, commands) => {
        if (commands.split('\n').includes('brew install --cask no-bullshit-rss')) return block;
        return `\`\`\`sh\n${commands.trimEnd()}\nbrew install --cask no-bullshit-rss\n\`\`\``;
    });
    let updated = `${readme.slice(0, start)}${section}${readme.slice(end)}`;
    if (!/^## NO BULLSHIT RSS Cask[ \t]*$/m.test(updated)) {
        updated = `${updated.trimEnd()}

## NO BULLSHIT RSS Cask

Requires macOS 13 (Ventura) or newer on Apple Silicon. Homebrew installs the desktop app and links its bundled \`no-bullshit-rss\` CLI automatically; no separate Node.js installation is required.

\`\`\`sh
brew install --cask oliverjessner/tap/no-bullshit-rss
no-bullshit-rss --help
\`\`\`

The app is currently not signed with an Apple Developer ID or notarized. If macOS blocks the first launch, right-click \`NO BULLSHIT RSS.app\` in \`/Applications\`, select \`Open\`, and confirm the dialog.
`;
    }
    return updated;
}

async function publishBrew({ version, dryRun, tapDirectory }) {
    const tag = `${process.env.TAG_PREFIX || 'v'}${version}`;
    run('gh', ['auth', 'status', '-h', 'github.com']);
    let release;
    try {
        release = JSON.parse(run('gh', ['api', `repos/${releaseRepository}/releases/tags/${tag}`]).stdout);
    } catch (error) {
        if (error.message.includes('HTTP 404')) {
            throw new Error(`GitHub release ${tag} is missing. Publish it with its ARM64 DMG before running publish:brew.`);
        }
        throw error;
    }
    const asset = selectReleaseAsset(release, version, tag);
    const tap = JSON.parse(run('gh', ['api', `repos/${tapRepository}`]).stdout);
    if (!dryRun && !tap.permissions?.push) throw new Error(`GitHub push access to ${tapRepository} is required.`);
    if (!tap.default_branch) throw new Error('The tap has no default branch.');
    run('brew', ['--version']);
    const tapInfo = await stat(tapDirectory).catch(() => null);
    if (!tapInfo?.isDirectory()) throw new Error(`Homebrew tap directory not found: ${tapDirectory}`);

    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-homebrew-'));
    const lockPath = path.join(os.tmpdir(), `rss-homebrew-${createHash('sha256').update(realpathSync(tapDirectory)).digest('hex')}.lock`);
    let lock;
    try {
        if (!dryRun) {
            lock = await open(lockPath, 'wx').catch(error => {
                if (error.code === 'EEXIST') {
                    throw new Error(`Another publication is using this tap. If it has stopped, remove the stale lock: ${lockPath}`);
                }
                throw error;
            });
        }
        inspectLocalTap(tapDirectory, tap.default_branch);
        const pendingPublication = !dryRun && refreshLocalTap(tapDirectory, tap.default_branch, tag);
        const initialHead = inspectLocalTap(tapDirectory, tap.default_branch);
        const assetDirectory = path.join(directory, 'asset');
        await mkdir(assetDirectory);
        console.log(`Downloading ${tag}/${asset.name}`);
        run('gh', ['release', 'download', tag, '--repo', releaseRepository, '--pattern', asset.name, '--dir', assetDirectory]);
        const dmgPath = path.join(assetDirectory, asset.name);
        const size = (await stat(dmgPath)).size;
        if (size === 0 || (asset.size > 0 && size !== asset.size)) throw new Error('Downloaded DMG size does not match the release asset.');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(dmgPath)) hash.update(chunk);
        const sha256 = hash.digest('hex');
        if (asset.digest && asset.digest !== `sha256:${sha256}`) throw new Error('Downloaded DMG SHA-256 does not match the GitHub release digest.');
        const cask = renderCask({ version, sha256, url: asset.browser_download_url });

        const existingCask = await readFile(path.join(tapDirectory, caskPath), 'utf8').catch(error => {
            if (error.code === 'ENOENT') return '';
            throw error;
        });
        const existingVersion = /^\s*version "(\d+\.\d+\.\d+)"[ \t]*$/m.exec(existingCask)?.[1];
        if (existingVersion) {
            const current = existingVersion.split('.').map(BigInt);
            const target = version.split('.').map(BigInt);
            const difference = current.findIndex((part, index) => part !== target[index]);
            if (difference >= 0 && current[difference] > target[difference]) {
                throw new Error(`Refusing to downgrade the Homebrew cask from ${existingVersion} to ${version}.`);
            }
        }
        const readmePath = path.join(tapDirectory, 'README.md');
        const readme = updateTapReadme(await readFile(readmePath, 'utf8'));
        const previewCaskPath = path.join(directory, caskPath);
        await mkdir(path.dirname(previewCaskPath), { recursive: true });
        await writeFile(previewCaskPath, cask);
        run('brew', ['style', previewCaskPath]);

        if (dryRun) {
            console.log(`\nDry run: ${tapDirectory} (${tap.default_branch})\nSHA-256: ${sha256}\n\n${cask}`);
            console.log('No local tap changes, commit or push performed.');
            return;
        }

        if (inspectLocalTap(tapDirectory, tap.default_branch) !== initialHead) {
            throw new Error('The tap HEAD changed during publication. Retry from the new checkout state.');
        }
        await mkdir(path.join(tapDirectory, 'Casks'), { recursive: true });
        await writeFile(path.join(tapDirectory, caskPath), cask);
        await writeFile(readmePath, readme);
        run('git', ['add', '--', ...tapFiles], { cwd: tapDirectory });
        const diff = run('git', ['diff', '--cached', '--quiet', '--', ...tapFiles], { cwd: tapDirectory, acceptedStatuses: [0, 1] });
        if (diff.status === 0 && !pendingPublication) {
            console.log(`Homebrew cask already up to date for ${tag}.`);
            return;
        }
        if (diff.status !== 0) {
            run('git', ['commit', '-m', `Update NO BULLSHIT RSS cask to ${tag}`, '--', ...tapFiles], { cwd: tapDirectory });
        }
        run('git', ['push', 'origin', `HEAD:refs/heads/${tap.default_branch}`], { cwd: tapDirectory });
        console.log(`Published ${tag}: brew install --cask oliverjessner/tap/no-bullshit-rss`);
    } finally {
        if (lock) {
            await lock.close();
            await rm(lockPath, { force: true });
        }
        await rm(directory, { recursive: true, force: true });
    }
}

async function main() {
    const { values } = parseArgs({
        options: {
            version: { type: 'string' },
            'dry-run': { type: 'boolean' },
            'tap-path': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    if (values.help) {
        console.log(`Usage: npm run publish:brew -- [--dry-run] [--version 1.1.3] [--tap-path ../homebrew-tap]

Downloads the published ARM64 DMG, verifies its SHA-256, validates the Homebrew
cask, then commits and pushes Casks/no-bullshit-rss.rb and README.md to
${tapRepository} using the existing local tap checkout.

Options:
  --dry-run          Validate and preview without committing or pushing
  --version <x.y.z>  Published release version (defaults to package.json.version)
  --tap-path <path>  Tap checkout, relative to the project root (defaults to ../homebrew-tap)
  -h, --help         Show this help

Requires Node.js, git, authenticated gh, and Homebrew. TAG_PREFIX defaults to v.
HOMEBREW_TAP_DIR overrides the default tap checkout path.`);
        return;
    }
    const version = values.version ?? JSON.parse(await readFile(
        path.resolve(projectDirectory, process.env.PACKAGE_JSON_FILE || 'package.json'), 'utf8',
    )).version;
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid stable version: ${version}`);
    const tapDirectory = path.resolve(projectDirectory, values['tap-path'] || process.env.HOMEBREW_TAP_DIR || '../homebrew-tap');
    await publishBrew({ version, dryRun: Boolean(values['dry-run']), tapDirectory });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`Homebrew publish failed: ${error.message}`);
        process.exitCode = 1;
    });
}
