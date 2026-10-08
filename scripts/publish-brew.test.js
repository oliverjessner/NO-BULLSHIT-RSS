import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, realpathSync, rmSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderCask, selectReleaseAsset, updateTapReadme } from './publish-brew.js';

const version = '1.1.3';
const asset = {
    name: `NO.BULLSHIT.RSS-${version}-arm64.dmg`,
    browser_download_url: `https://github.com/oliverjessner/NO-BULLSHIT-RSS/releases/download/v${version}/NO.BULLSHIT.RSS-${version}-arm64.dmg`,
};

function release(overrides = {}) {
    return {
        tag_name: `v${version}`,
        draft: false,
        prerelease: false,
        assets: [asset],
        ...overrides,
    };
}

const readme = `# Homebrew Tap: oliverjessner/tap

\`\`\`sh
brew tap oliverjessner/tap
\`\`\`

## Installable Packages

| Name | Type | Description | Installation |
| --- | --- | --- | --- |
| \`clipspin\` | Formula | Temporary second paste queue for macOS | \`brew install oliverjessner/tap/clipspin\` |
| \`pinefetch\` | Cask | Local-first yt-dlp desktop client | \`brew install --cask oliverjessner/tap/pinefetch\` |

After tapping the repository, packages can also be installed with short names:

\`\`\`sh
brew install clipspin
brew install --cask pinefetch
\`\`\`

## PineFetch Cask

Existing installation instructions stay intact.
`;

test('selects the released Apple Silicon DMG for the package version', () => {
    const selected = selectReleaseAsset(release({ assets: [
        { ...asset, name: `NO.BULLSHIT.RSS-${version}-x64.dmg` },
        { ...asset, name: `NO.BULLSHIT.RSS-1.1.2-arm64.dmg` },
        { ...asset, name: `${asset.name}.blockmap` },
        asset,
    ] }), version);
    assert.deepEqual(selected, asset);
});

test('accepts an explicitly supplied release tag', () => {
    const tag = `release-${version}`;
    const customAsset = {
        ...asset,
        browser_download_url: asset.browser_download_url.replace(`v${version}`, tag),
    };
    assert.deepEqual(selectReleaseAsset(release({ tag_name: tag, assets: [customAsset] }), version, tag), customAsset);
});

test('rejects the wrong release, drafts, and prereleases', () => {
    for (const overrides of [
        { tag_name: 'v1.1.2' },
        { draft: true },
        { prerelease: true },
    ]) {
        assert.throws(() => selectReleaseAsset(release(overrides), version), JSON.stringify(overrides));
    }
});

test('requires exactly one DMG for this version and architecture', () => {
    for (const assets of [
        [],
        [{ ...asset, name: `NO.BULLSHIT.RSS-${version}-x64.dmg` }],
        [{ ...asset, name: `NO.BULLSHIT.RSS-1.1.2-arm64.dmg` }],
        [asset, { ...asset, name: `Another.App-${version}-arm64.dmg` }],
    ]) {
        assert.throws(() => selectReleaseAsset(release({ assets }), version));
    }
});

test('rejects asset URLs outside the source repository on GitHub', () => {
    for (const browser_download_url of [
        '',
        'not a URL',
        asset.browser_download_url.replace('https:', 'http:'),
        asset.browser_download_url.replace('github.com', 'example.invalid'),
        asset.browser_download_url.replace('github.com', 'github.com.example.invalid'),
        asset.browser_download_url.replace('/oliverjessner/', '/somebody-else/'),
        asset.browser_download_url.replace('/NO-BULLSHIT-RSS/', '/another-project/'),
    ]) {
        assert.throws(() => selectReleaseAsset(release({ assets: [{ ...asset, browser_download_url }] }), version), browser_download_url);
    }
});

test('renders a cask from the selected URL and checksum with the bundled CLI', () => {
    const sha256 = 'a'.repeat(64);
    const cask = renderCask({ version, sha256, url: asset.browser_download_url });
    assert.match(cask, /^cask "no-bullshit-rss" do/m);
    assert.match(cask, /version "1\.1\.3"/);
    assert.match(cask, new RegExp(`sha256 "${sha256}"`));
    assert.ok(cask.includes('https://github.com/oliverjessner/NO-BULLSHIT-RSS/releases/download/v#{version}/NO.BULLSHIT.RSS-#{version}-arm64.dmg'));
    assert.match(cask, /depends_on arch: :arm64/);
    assert.match(cask, /depends_on macos: .*ventura/);
    assert.match(cask, /app "NO BULLSHIT RSS\.app"/);
    assert.match(cask, /binary "#\{appdir\}\/NO BULLSHIT RSS\.app\/Contents\/Resources\/bin\/no-bullshit-rss"/);
});

test('adds cask installation docs while preserving other tap packages', () => {
    const updated = updateTapReadme(readme);
    assert.match(updated, /\| `no-bullshit-rss` \| Cask \|[^\n]*`brew install --cask oliverjessner\/tap\/no-bullshit-rss` \|/);
    assert.match(updated, /brew install --cask pinefetch\nbrew install --cask no-bullshit-rss\n```/);
    assert.match(updated, /^## NO BULLSHIT RSS Cask$/m);
    assert.ok(updated.includes('## PineFetch Cask\n\nExisting installation instructions stay intact.'));
    assert.ok(updated.includes('| `clipspin` | Formula | Temporary second paste queue for macOS | `brew install oliverjessner/tap/clipspin` |'));
    assert.equal(updateTapReadme(updated), updated);
});

test('refreshes an existing package row and keeps installation docs unique', () => {
    const existing = readme.replace('| `pinefetch`', '| `no-bullshit-rss` | Formula | Outdated description | `brew install no-bullshit-rss` |\n| `pinefetch`');
    const updated = updateTapReadme(existing);
    assert.equal((updated.match(/^\| `no-bullshit-rss` \|/gm) ?? []).length, 1);
    assert.doesNotMatch(updated, /Outdated description/);
    assert.match(updated, /\| `no-bullshit-rss` \| Cask \|/);
    assert.equal((updated.match(/^## NO BULLSHIT RSS Cask$/gm) ?? []).length, 1);
    assert.equal((updated.match(/^brew install --cask no-bullshit-rss$/gm) ?? []).length, 1);
    assert.equal(updateTapReadme(updated), updated);
});

test('rejects unexpected README layouts before writing documentation', () => {
    assert.throws(() => updateTapReadme(readme.replace('## Installable Packages', '## Other Packages')));
    assert.throws(() => updateTapReadme(readme.replace(/```sh\nbrew install clipspin\n[\s\S]*?```/, 'No short-name commands')));
});

// Every external command is replaced, so these exercises cannot publish a release
// or change the user's real Homebrew tap. The checkout itself is a temporary fixture.
const mockCommand = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_COMMAND_LOG, JSON.stringify({ command, args, cwd: process.cwd() }) + '\\n');
const checkout = process.env.MOCK_TAP_CHECKOUT;
const baseline = process.env.MOCK_TAP_BASELINE;
if (command === 'gh') {
    if (args[0] === 'api') {
        process.stdout.write(fs.readFileSync(args[1].includes('/releases/') ? process.env.MOCK_RELEASE_FILE : process.env.MOCK_REPO_FILE));
    } else if (args[0] === 'release' && args[1] === 'download') {
        const directory = args[args.indexOf('--dir') + 1];
        fs.mkdirSync(directory, { recursive: true });
        fs.copyFileSync(process.env.MOCK_DMG_FILE, path.join(directory, args[args.indexOf('--pattern') + 1]));
    } else if (args[0] === 'auth' || args[0] === '--version') {
        process.exit(0);
    } else {
        process.stderr.write('Unexpected gh invocation: ' + JSON.stringify(args));
        process.exit(2);
    }
} else if (command === 'git') {
    const state = JSON.parse(fs.readFileSync(process.env.MOCK_GIT_STATE, 'utf8'));
    if (args[0] === 'rev-parse') {
        process.stdout.write(args[1] === '--show-toplevel' ? checkout : state.head);
    } else if (args[0] === 'remote' && args[1] === 'get-url') {
        process.stdout.write(args.includes('--push') ? state.pushRemote : state.fetchRemote);
    } else if (args[0] === 'branch' && args[1] === '--show-current') {
        process.stdout.write(state.branch);
    } else if (args[0] === 'status') {
        process.stdout.write(state.status);
    } else if (args[0] === 'rev-list') {
        process.stdout.write(state.counts);
    } else if (args[0] === 'log') {
        process.stdout.write(state.pendingCommitMessage);
    } else if (args[0] === 'diff' && args.includes('--name-only')) {
        process.stdout.write(state.pendingFiles.join('\\n'));
    } else if (args[0] === 'diff' && args.includes('--quiet')) {
        const files = args.slice(args.indexOf('--') + 1);
        const changed = files.some(file => {
            const original = path.join(baseline, file);
            return !fs.existsSync(original) || !fs.readFileSync(original).equals(fs.readFileSync(path.join(process.cwd(), file)));
        });
        process.exit(changed ? 1 : 0);
    } else if (args[0] === 'push') {
        state.counts = '0\\t0';
        fs.writeFileSync(process.env.MOCK_GIT_STATE, JSON.stringify(state));
    } else if (args[0] === 'merge') {
        state.counts = '0\\t0';
        state.head = 'fast-forwarded-head';
        fs.writeFileSync(process.env.MOCK_GIT_STATE, JSON.stringify(state));
    } else if (!['add', 'commit', 'fetch', 'diff'].includes(args[0])) {
        process.stderr.write('Unexpected git invocation: ' + JSON.stringify(args));
        process.exit(2);
    }
} else if (command !== 'brew') {
    process.stderr.write('Unexpected command: ' + command);
    process.exit(2);
}
`;

async function withCliFixture(callback, releaseOverrides = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-publish-brew-test-'));
    try {
        const scriptsDirectory = path.join(directory, 'scripts');
        const binDirectory = path.join(directory, 'bin');
        const tapDirectory = path.join(directory, 'homebrew-tap');
        const baselineDirectory = path.join(directory, 'tap-baseline');
        const gitStateFile = path.join(directory, 'git-state.json');
        await Promise.all([mkdir(scriptsDirectory), mkdir(binDirectory), mkdir(tapDirectory)]);
        await mkdir(path.join(tapDirectory, 'Casks'));
        const dmg = Buffer.from('mock release DMG content\n');
        const digest = `sha256:${createHash('sha256').update(dmg).digest('hex')}`;
        const releaseFile = path.join(directory, 'release.json');
        const repoFile = path.join(directory, 'repo.json');
        const dmgFile = path.join(directory, 'asset.dmg');
        const logFile = path.join(directory, 'commands.jsonl');
        await Promise.all([
            copyFile(new URL('./publish-brew.js', import.meta.url), path.join(scriptsDirectory, 'publish-brew.js')),
            writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', version })),
            writeFile(path.join(binDirectory, 'package.json'), JSON.stringify({ type: 'commonjs' })),
            writeFile(path.join(tapDirectory, 'README.md'), readme),
            writeFile(path.join(tapDirectory, 'Casks', 'other-app.rb'), 'cask "other-app" do\nend\n'),
            writeFile(releaseFile, JSON.stringify(release({ assets: [{ ...asset, size: dmg.length, digest }], ...releaseOverrides }))),
            writeFile(repoFile, JSON.stringify({ default_branch: 'main', permissions: { push: true } })),
            writeFile(dmgFile, dmg),
            writeFile(logFile, ''),
            writeFile(gitStateFile, JSON.stringify({
                fetchRemote: 'https://github.com/oliverjessner/homebrew-tap.git',
                pushRemote: 'git@github.com:oliverjessner/homebrew-tap.git',
                branch: 'main',
                status: '',
                head: 'fixture-head',
                counts: '0\t0',
                pendingCommitMessage: `Update NO BULLSHIT RSS cask to v${version}`,
                pendingFiles: ['Casks/no-bullshit-rss.rb', 'README.md'],
            })),
            ...['gh', 'git', 'brew'].map(command => writeFile(path.join(binDirectory, command), mockCommand, { mode: 0o755 })),
        ]);
        const env = {
            ...process.env,
            PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
            TAG_PREFIX: 'v',
            MOCK_COMMAND_LOG: logFile,
            MOCK_TAP_CHECKOUT: tapDirectory,
            MOCK_TAP_BASELINE: baselineDirectory,
            MOCK_GIT_STATE: gitStateFile,
            MOCK_RELEASE_FILE: releaseFile,
            MOCK_REPO_FILE: repoFile,
            MOCK_DMG_FILE: dmgFile,
        };
        await callback({
            run(args = [], { useTapEnv = false } = {}) {
                rmSync(baselineDirectory, { recursive: true, force: true });
                cpSync(tapDirectory, baselineDirectory, { recursive: true });
                const tapArgs = useTapEnv ? [] : ['--tap-path', tapDirectory];
                return spawnSync(process.execPath, ['scripts/publish-brew.js', ...tapArgs, ...args], {
                    cwd: directory,
                    encoding: 'utf8',
                    env: { ...env, HOMEBREW_TAP_DIR: tapDirectory },
                });
            },
            async commands() {
                return (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
            },
            async resetCommands() { await writeFile(logFile, ''); },
            async configureGit(updates) {
                const state = JSON.parse(await readFile(gitStateFile, 'utf8'));
                await writeFile(gitStateFile, JSON.stringify({ ...state, ...updates }));
            },
            tapDirectory,
            sha256: digest.slice('sha256:'.length),
            releaseFile,
            repoFile,
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('CLI dry run uses the local tap from the environment and leaves its files unchanged', async () => {
    await withCliFixture(async ({ run, commands, tapDirectory }) => {
        const existingCask = 'cask "no-bullshit-rss" do\n  version "1.1.2"\nend\n';
        const caskFile = path.join(tapDirectory, 'Casks', 'no-bullshit-rss.rb');
        await writeFile(caskFile, existingCask);
        const result = run(['--dry-run'], { useTapEnv: true });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /cask "no-bullshit-rss"/);
        const calls = await commands();
        assert.ok(calls.some(call => call.command === 'gh' && call.args[0] === 'release' && call.args[1] === 'download'));
        assert.ok(!calls.some(call => call.command === 'gh' && call.args[0] === 'repo'));
        assert.ok(calls.some(call => call.command === 'brew' && call.args[0] === 'style'));
        assert.ok(!calls.some(call => call.command === 'git' && ['fetch', 'merge', 'add', 'commit', 'push'].includes(call.args[0])));
        assert.equal(await readFile(caskFile, 'utf8'), existingCask);
        assert.equal(await readFile(path.join(tapDirectory, 'README.md'), 'utf8'), readme);
    });
});

test('CLI updates an older cask, publishes only its files, and skips an unchanged rerun', async () => {
    await withCliFixture(async ({ run, commands, resetCommands, tapDirectory }) => {
        await writeFile(path.join(tapDirectory, 'Casks', 'no-bullshit-rss.rb'), 'cask "no-bullshit-rss" do\n  version "1.1.2"\nend\n');
        const first = run();
        assert.equal(first.status, 0, first.stderr);
        const calls = await commands();
        const scopedFiles = ['Casks/no-bullshit-rss.rb', 'README.md'];
        assert.deepEqual(calls.find(call => call.command === 'git' && call.args[0] === 'add')?.args, ['add', '--', ...scopedFiles]);
        assert.deepEqual(calls.find(call => call.command === 'git' && call.args[0] === 'commit')?.args, ['commit', '-m', `Update NO BULLSHIT RSS cask to v${version}`, '--', ...scopedFiles]);
        assert.deepEqual(calls.find(call => call.command === 'git' && call.args[0] === 'push')?.args, ['push', 'origin', 'HEAD:refs/heads/main']);
        assert.ok(calls.filter(call => call.command === 'git').every(call => call.cwd === realpathSync(tapDirectory)));
        assert.ok(!calls.some(call => call.command === 'gh' && call.args[0] === 'repo'));
        assert.match(await readFile(path.join(tapDirectory, scopedFiles[0]), 'utf8'), /app "NO BULLSHIT RSS\.app"/);
        assert.match(await readFile(path.join(tapDirectory, 'README.md'), 'utf8'), /^## NO BULLSHIT RSS Cask$/m);
        assert.equal(await readFile(path.join(tapDirectory, 'Casks', 'other-app.rb'), 'utf8'), 'cask "other-app" do\nend\n');
        await resetCommands();
        const second = run();
        assert.equal(second.status, 0, second.stderr);
        assert.ok(!(await commands()).some(call => call.command === 'git' && ['commit', 'push'].includes(call.args[0])));
    });
});

test('CLI refuses to downgrade a newer tap cask before styling or staging changes', async () => {
    await withCliFixture(async ({ run, commands, tapDirectory }) => {
        const existingCask = 'cask "no-bullshit-rss" do\n  version "1.1.4"\nend\n';
        const caskFile = path.join(tapDirectory, 'Casks', 'no-bullshit-rss.rb');
        await writeFile(caskFile, existingCask);
        const result = run();
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Refusing to downgrade.*1\.1\.4.*1\.1\.3/);
        const calls = await commands();
        assert.ok(!calls.some(call => call.command === 'gh' && call.args[0] === 'repo'));
        assert.ok(!calls.some(call => call.command === 'brew' && call.args[0] === 'style'));
        assert.ok(!calls.some(call => call.command === 'git' && ['add', 'commit', 'push'].includes(call.args[0])));
        assert.equal(await readFile(caskFile, 'utf8'), existingCask);
        assert.equal(await readFile(path.join(tapDirectory, 'README.md'), 'utf8'), readme);
    });
});

test('CLI stops on a release digest mismatch before changing or publishing the tap', async () => {
    await withCliFixture(async ({ run, commands }) => {
        const result = run();
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /sha256|checksum|digest/i);
        const calls = await commands();
        assert.ok(calls.some(call => call.command === 'gh' && call.args[0] === 'release' && call.args[1] === 'download'));
        assert.ok(!calls.some(call => call.command === 'gh' && call.args[0] === 'repo'));
        assert.ok(!calls.some(call => call.command === 'git' && ['add', 'commit', 'push'].includes(call.args[0])));
    }, { assets: [{ ...asset, digest: `sha256:${'0'.repeat(64)}` }] });
});

for (const [name, state] of [
    ['wrong fetch origin', { fetchRemote: 'https://github.com/somebody-else/homebrew-tap.git' }],
    ['wrong push origin', { pushRemote: 'git@github.com:oliverjessner/another-project.git' }],
    ['dirty checkout', { status: ' M README.md\n' }],
    ['wrong branch', { branch: 'work-in-progress' }],
]) {
    test(`CLI refuses a local tap with ${name} before updating it`, async () => {
        await withCliFixture(async ({ run, commands, configureGit, tapDirectory }) => {
            await configureGit(state);
            const result = run();
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /origin|remote|clean|dirty|uncommitted|branch/i);
            const calls = await commands();
            assert.ok(!calls.some(call => call.command === 'git' && ['fetch', 'merge', 'add', 'commit', 'push'].includes(call.args[0])));
            assert.equal(await readFile(path.join(tapDirectory, 'README.md'), 'utf8'), readme);
        });
    });
}

test('CLI retries pushing its own pending publish commit without creating an empty commit', async () => {
    await withCliFixture(async ({ run, commands, configureGit, tapDirectory, sha256 }) => {
        await writeFile(path.join(tapDirectory, 'Casks', 'no-bullshit-rss.rb'), renderCask({ version, sha256, url: asset.browser_download_url }));
        await writeFile(path.join(tapDirectory, 'README.md'), updateTapReadme(readme));
        await configureGit({ counts: '1\t0' });
        const result = run();
        assert.equal(result.status, 0, result.stderr);
        const calls = await commands();
        assert.equal(calls.filter(call => call.command === 'git' && call.args[0] === 'push').length, 1);
        assert.ok(!calls.some(call => call.command === 'git' && call.args[0] === 'commit'));
    });
});

test('CLI refuses unrelated unpublished local commits', async () => {
    await withCliFixture(async ({ run, commands, configureGit, tapDirectory }) => {
        await configureGit({ counts: '1\t0', pendingCommitMessage: 'Unrelated local changes' });
        const result = run();
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /ahead|unpublished|commit/i);
        assert.ok(!(await commands()).some(call => call.command === 'git' && ['add', 'commit', 'push'].includes(call.args[0])));
        assert.equal(await readFile(path.join(tapDirectory, 'README.md'), 'utf8'), readme);
    });
});
