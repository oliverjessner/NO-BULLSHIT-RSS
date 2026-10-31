import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
test('macOS Watchdog bridge presents foreground notices and reports OS enqueue failures', { skip: process.platform !== 'darwin', timeout: 30_000 }, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-watchdog-native-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const binary = path.join(directory, 'watchdog-notifications');
    const source = fileURLToPath(new URL('../src-tauri/tests/watchdog-notifications.m', import.meta.url));
    await execute('xcrun', ['clang', '-fobjc-arc', '-fblocks', '-framework', 'Foundation', '-framework', 'UserNotifications', source, '-o', binary]);
    const { stdout } = await execute(binary, [], { timeout: 10_000 });
    assert.match(stdout, /Watchdog native bridge fixture passed/);
});
