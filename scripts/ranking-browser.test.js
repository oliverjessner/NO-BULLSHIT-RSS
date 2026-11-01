import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { constants } from 'node:fs';
import {
    BUNDLED_RANKING_BROWSER_PATH, SYSTEM_RANKING_BROWSER_PATH,
    configureRankingBrowser, inspectRankingBrowser, resolveRankingBrowser,
} from '../backend/services/ranking-browser.js';

function fixture() {
    const files = new Map();
    const directories = new Set();
    const fileSystem = {
        existsSync: filename => files.has(filename) || directories.has(filename),
        accessSync(filename, mode) {
            const file = files.get(filename);
            if (!file || (mode === constants.X_OK && !file.executable)) throw new Error('Unavailable');
        },
        statSync(filename) {
            const file = files.get(filename);
            if (!file) throw new Error('Missing');
            return { size: file.size, isFile: () => true };
        },
    };
    const addFile = (filename, executable = false, size = 100) => files.set(filename, { executable, size });
    function addChrome(executablePath) {
        addFile(executablePath, true);
        const contents = path.dirname(path.dirname(executablePath));
        directories.add(path.dirname(contents));
        const name = path.basename(executablePath);
        addFile(path.join(contents, 'Info.plist'));
        const framework = path.join(contents, 'Frameworks', `${name} Framework.framework`, 'Versions', 'Current');
        addFile(path.join(framework, `${name} Framework`));
        const helper = path.join(framework, 'Helpers', `${name} Helper.app`, 'Contents');
        addFile(path.join(helper, 'Info.plist'));
        addFile(path.join(helper, 'MacOS', `${name} Helper`), true);
        return { contents, framework, helper };
    }
    return { fileSystem, files, addFile, addChrome };
}

test('prefers a complete packaged Chrome over system Chrome without changing caller environment', () => {
    const fixtureData = fixture();
    const bundled = path.join('/runtime', BUNDLED_RANKING_BROWSER_PATH);
    fixtureData.addChrome(bundled);
    fixtureData.addChrome(SYSTEM_RANKING_BROWSER_PATH);
    const env = {};
    assert.deepEqual(resolveRankingBrowser({ env, platform: 'darwin', runtimeRoot: '/runtime', fileSystem: fixtureData.fileSystem }), {
        source: 'bundled', executablePath: bundled,
    });
    assert.deepEqual(env, {});
});

test('uses installed system Chrome when there is no packaged browser or its installation is incomplete', () => {
    const fixtureData = fixture();
    fixtureData.addChrome(SYSTEM_RANKING_BROWSER_PATH);
    const options = { env: {}, platform: 'darwin', runtimeRoot: '/runtime', fileSystem: fixtureData.fileSystem };
    assert.equal(resolveRankingBrowser(options).source, 'system');
    const bundled = path.join('/runtime', BUNDLED_RANKING_BROWSER_PATH);
    const { contents } = fixtureData.addChrome(bundled);
    fixtureData.files.delete(path.join(contents, 'Info.plist'));
    const resolved = resolveRankingBrowser(options);
    assert.equal(resolved.source, 'system');
    assert.equal(resolved.executablePath, SYSTEM_RANKING_BROWSER_PATH);
    assert.match(resolved.warning, /metadata is missing/);
});

test('rejects the partial-install shape of an executable without framework or helper resources', () => {
    const fixtureData = fixture();
    const bundled = path.join('/runtime', BUNDLED_RANKING_BROWSER_PATH);
    const { contents, framework, helper } = fixtureData.addChrome(bundled);
    fixtureData.files.delete(path.join(framework, `${path.basename(bundled)} Framework`));
    assert.match(inspectRankingBrowser(bundled, { platform: 'darwin', fileSystem: fixtureData.fileSystem }), /framework is missing/);
    fixtureData.addFile(path.join(framework, `${path.basename(bundled)} Framework`));
    fixtureData.files.delete(path.join(helper, 'MacOS', 'Google Chrome for Testing Helper'));
    assert.match(inspectRankingBrowser(bundled, { platform: 'darwin', fileSystem: fixtureData.fileSystem }), /helper is missing/);
    assert.throws(() => resolveRankingBrowser({ env: {}, platform: 'darwin', runtimeRoot: '/runtime', fileSystem: fixtureData.fileSystem }), /Bundled ranking browser is incomplete/);
    assert.ok(fixtureData.files.has(path.join(contents, 'Info.plist')));
});

test('preserves explicit executable overrides and reports invalid overrides instead of silently substituting another browser', () => {
    const fixtureData = fixture();
    fixtureData.addFile('/custom/chrome', true);
    fixtureData.addChrome(SYSTEM_RANKING_BROWSER_PATH);
    const env = { PUPPETEER_EXECUTABLE_PATH: '/custom/chrome' };
    assert.deepEqual(configureRankingBrowser({ env, platform: 'darwin', runtimeRoot: '/runtime', fileSystem: fixtureData.fileSystem }), {
        source: 'override', executablePath: '/custom/chrome',
    });
    assert.equal(env.PUPPETEER_EXECUTABLE_PATH, '/custom/chrome');
    fixtureData.files.delete('/custom/chrome');
    assert.throws(() => configureRankingBrowser({ env, platform: 'darwin', runtimeRoot: '/runtime', fileSystem: fixtureData.fileSystem }), /Configured ranking browser is unavailable/);
    assert.equal(env.PUPPETEER_EXECUTABLE_PATH, '/custom/chrome');
});

test('sets Puppeteer supported configuration for the selected browser without loading or launching it', () => {
    const fixtureData = fixture();
    fixtureData.addChrome(SYSTEM_RANKING_BROWSER_PATH);
    const env = {};
    const resolved = configureRankingBrowser({ env, platform: 'darwin', runtimeRoot: '/runtime', fileSystem: fixtureData.fileSystem });
    assert.equal(resolved.source, 'system');
    assert.equal(env.PUPPETEER_EXECUTABLE_PATH, SYSTEM_RANKING_BROWSER_PATH);
});

test('retains Puppeteer managed-browser behavior on other platforms and installations without system Chrome', () => {
    const fixtureData = fixture();
    const env = {};
    for (const platform of ['darwin', 'linux', 'win32']) {
        assert.deepEqual(configureRankingBrowser({ env, platform, runtimeRoot: '/runtime', fileSystem: fixtureData.fileSystem }), {
            source: 'puppeteer', executablePath: null,
        });
    }
    assert.deepEqual(env, {});
});

test('rejects nonexecutable and empty browser files before an attempt to launch them', () => {
    const fixtureData = fixture();
    fixtureData.addFile('/custom/chrome', false);
    assert.match(inspectRankingBrowser('/custom/chrome', { platform: 'linux', fileSystem: fixtureData.fileSystem }), /not executable/);
    fixtureData.addFile('/custom/chrome', true, 0);
    assert.match(inspectRankingBrowser('/custom/chrome', { platform: 'linux', fileSystem: fixtureData.fileSystem }), /missing or not executable/);
});
