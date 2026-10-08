import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function dryRun(changelog, version = '1.1.2') {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-publish-test-'));
    try {
        await copyFile(new URL('../publish.sh', import.meta.url), path.join(directory, 'publish.sh'));
        await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version }));
        await writeFile(path.join(directory, 'changelog.md'), changelog);
        // Tests never contact GitHub or depend on the host's release platform.
        await writeFile(path.join(directory, 'gh'), '#!/bin/sh\ncase "$1 $2" in\n  "auth status") exit 0 ;;\n  "release view") exit 1 ;;\n  *) exit 2 ;;\nesac\n', { mode: 0o755 });
        await writeFile(path.join(directory, 'uname'), '#!/bin/sh\ncase "$1" in\n  -s) echo Darwin ;;\n  -m) echo arm64 ;;\n  *) exit 2 ;;\nesac\n', { mode: 0o755 });
        await writeFile(path.join(directory, 'brew'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        for (const args of [['init', '-b', 'main'], ['remote', 'add', 'origin', 'https://example.invalid/rss.git']]) {
            const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
        }
        return spawnSync('bash', ['publish.sh', '--dry-run'], {
            cwd: directory,
            encoding: 'utf8',
            env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, PACKAGE_JSON_FILE: 'package.json', CHANGELOG_FILE: 'changelog.md', GIT_REMOTE: 'origin', TAG_PREFIX: 'v', RELEASE_OUTPUT_DIR: 'dist' },
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('publish dry run reads # release headings and only the newest notes', async () => {
    const result = await dryRun('# 1.1.2\n\n- New release\n\n# 1.1.1\n\n- Old release\n');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Tag: v1\.1\.2/);
    assert.match(result.stdout, /Mockups: generate five WebP screenshots before the release commit/);
    assert.match(result.stdout, /Homebrew: update oliverjessner\/homebrew-tap after the DMG upload/);
    assert.match(result.stdout, /Release notes:\n1\.1\.2\n\n- New release\n$/);
    assert.doesNotMatch(result.stdout, /Old release/);
});

test('publish does not accept ## as a release heading', async () => {
    const result = await dryRun('## 1.1.2\n\n- New release\n');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not find a top-level changelog section/);
});

test('publish preserves nested release headings', async () => {
    const result = await dryRun('# 1.1.2\n\n## Features\n\n- New feature\n\n### Details\n\n- Detail\n\n## Fixes\n\n- Fixed issue\n\n# 1.1.1\n\n- Old release\n');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /## Features\n\n- New feature/);
    assert.match(result.stdout, /### Details\n\n- Detail/);
    assert.match(result.stdout, /## Fixes\n\n- Fixed issue\n$/);
    assert.doesNotMatch(result.stdout, /Old release/);
});

test('publish rejects a changelog without a release section', async () => {
    const result = await dryRun('- No version heading\n');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not find a top-level changelog section/);
});

test('publish rejects non-version titles and mismatched package versions', async () => {
    const invalid = await dryRun('# Not a version\n\n- Notes\n');
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /top changelog title must be a version heading/);
    const mismatch = await dryRun('# 1.1.1\n\n- Notes\n');
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /package\.json version \(1\.1\.2\) does not match top changelog title \(1\.1\.1\)/);
});

async function fullPublish({ failUpload = false, failMockups = false } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-publish-order-test-'));
    try {
        await mkdir(path.join(directory, 'scripts'));
        await copyFile(new URL('../publish.sh', import.meta.url), path.join(directory, 'publish.sh'));
        await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.1.2' }));
        await writeFile(path.join(directory, 'changelog.md'), '# 1.1.2\n\n- New release\n');
        const eventLog = path.join(directory, 'events.jsonl');
        await writeFile(eventLog, '');
        const logEvent = `const fs = require('node:fs');\nfs.appendFileSync(process.env.MOCK_PUBLISH_LOG, JSON.stringify({ command: COMMAND, args: process.argv.slice(2) }) + '\\n');\n`;
        const commandMock = `#!${process.execPath}
const path = require('node:path');
const COMMAND = path.basename(process.argv[1]);
${logEvent}
const args = process.argv.slice(2);
if (COMMAND === 'git') {
    if (args[0] === 'rev-parse' && args[1] === '--verify') process.exit(1);
    if (args[0] === 'symbolic-ref') process.stdout.write('main\\n');
    if (args[0] === 'diff' && args.includes('--cached')) process.exit(1);
} else if (COMMAND === 'gh') {
    if (args[0] === 'release' && args[1] === 'view') process.exit(1);
    if (args[0] === 'release' && args[1] === 'upload' && process.env.MOCK_FAIL_UPLOAD === '1') {
        process.stderr.write('Mock release upload rejected\\n');
        process.exit(42);
    }
} else if (COMMAND === 'uname') {
    process.stdout.write(args[0] === '-s' ? 'Darwin\\n' : 'arm64\\n');
} else if (COMMAND !== 'brew') {
    process.exit(2);
}
`;
        for (const command of ['git', 'gh', 'brew', 'uname']) {
            await writeFile(path.join(directory, command), commandMock, { mode: 0o755 });
        }
        await writeFile(path.join(directory, 'scripts', 'publish-brew.js'), `const COMMAND = 'publish-brew';\n${logEvent}`);
        await writeFile(path.join(directory, 'scripts', 'generate-mockups.js'), `const COMMAND = 'generate-mockups';\n${logEvent}\nif (process.env.MOCK_FAIL_MOCKUPS === '1') {\n  process.stderr.write('Mock screenshot generation failed\\n');\n  process.exit(43);\n}\n`);
        await writeFile(path.join(directory, 'fake-build.cjs'), `const COMMAND = 'build';\n${logEvent}\nfs.mkdirSync('dist');\nfs.writeFileSync('dist/NO.BULLSHIT.RSS-1.1.2-arm64.dmg', 'mock DMG');\n`);
        const quotedNode = `'${process.execPath.replaceAll("'", "'\\''")}'`;
        const result = spawnSync('bash', ['publish.sh'], {
            cwd: directory,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${directory}${path.delimiter}${process.env.PATH}`,
                PACKAGE_JSON_FILE: 'package.json',
                CHANGELOG_FILE: 'changelog.md',
                GIT_REMOTE: 'origin',
                TAG_PREFIX: 'v',
                RELEASE_OUTPUT_DIR: 'dist',
                BUILD_COMMAND: `${quotedNode} fake-build.cjs`,
                MOCK_PUBLISH_LOG: eventLog,
                MOCK_FAIL_UPLOAD: failUpload ? '1' : '0',
                MOCK_FAIL_MOCKUPS: failMockups ? '1' : '0',
            },
        });
        const events = (await readFile(eventLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        return { result, events };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('full publish generates screenshots before committing, then uploads the DMG before Homebrew', async () => {
    const { result, events } = await fullPublish();
    assert.equal(result.status, 0, result.stderr);
    const createIndex = events.findIndex(event => event.command === 'gh' && event.args[0] === 'release' && event.args[1] === 'create');
    const uploadIndex = events.findIndex(event => event.command === 'gh' && event.args[0] === 'release' && event.args[1] === 'upload');
    const brewIndex = events.findIndex(event => event.command === 'publish-brew');
    const mockupsIndex = events.findIndex(event => event.command === 'generate-mockups');
    const addIndex = events.findIndex(event => event.command === 'git' && event.args[0] === 'add');
    const commitIndex = events.findIndex(event => event.command === 'git' && event.args[0] === 'commit');
    const buildIndex = events.findIndex(event => event.command === 'build');
    assert.deepEqual(events.filter(event => event.command === 'generate-mockups').map(event => event.args), [[]]);
    assert.ok(mockupsIndex >= 0);
    assert.ok(addIndex > mockupsIndex);
    assert.ok(commitIndex > addIndex);
    assert.ok(buildIndex > commitIndex);
    assert.ok(createIndex > buildIndex);
    assert.ok(uploadIndex > createIndex);
    assert.ok(brewIndex > uploadIndex);
    assert.deepEqual(events[uploadIndex].args, ['release', 'upload', 'v1.1.2', 'dist/NO.BULLSHIT.RSS-1.1.2-arm64.dmg']);
    assert.deepEqual(events.filter(event => event.command === 'publish-brew').map(event => event.args), [['--version', '1.1.2']]);
});

test('full publish stops before staging, building, or releasing when screenshots fail', async () => {
    const { result, events } = await fullPublish({ failMockups: true });
    assert.equal(result.status, 43);
    assert.match(result.stderr, /Mock screenshot generation failed/);
    assert.equal(events.filter(event => event.command === 'generate-mockups').length, 1);
    assert.ok(!events.some(event => event.command === 'git' && ['add', 'commit', 'push', 'tag'].includes(event.args[0])));
    assert.ok(!events.some(event => ['build', 'publish-brew'].includes(event.command)));
    assert.ok(!events.some(event => event.command === 'gh' && event.args[0] === 'release' && ['create', 'upload'].includes(event.args[1])));
});

test('full publish never updates Homebrew when the release asset upload fails', async () => {
    const { result, events } = await fullPublish({ failUpload: true });
    assert.equal(result.status, 42);
    assert.match(result.stderr, /Mock release upload rejected/);
    assert.ok(events.some(event => event.command === 'gh' && event.args[0] === 'release' && event.args[1] === 'upload'));
    assert.ok(!events.some(event => event.command === 'publish-brew'));
});
