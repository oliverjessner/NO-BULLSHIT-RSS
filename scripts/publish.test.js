import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
