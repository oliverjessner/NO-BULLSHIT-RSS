import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDirectory = fileURLToPath(new URL('../../', import.meta.url));
// An optional browser in desktop resources uses this layout. Its complete
// Contents/Frameworks tree and symlinks must be preserved when packaging it.
export const BUNDLED_RANKING_BROWSER_PATH = 'browser/chrome.app/Contents/MacOS/Google Chrome for Testing';
export const SYSTEM_RANKING_BROWSER_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function usableFile(filename, mode, fileSystem) {
    try {
        fileSystem.accessSync(filename, mode);
        const stat = fileSystem.statSync(filename);
        return stat.isFile() && stat.size > 0;
    } catch {
        return false;
    }
}

export function inspectRankingBrowser(executablePath, { platform = process.platform, fileSystem = fs } = {}) {
    if (!usableFile(executablePath, fs.constants.X_OK, fileSystem)) return 'browser executable is missing or not executable';
    if (platform !== 'darwin') return null;
    const executable = path.basename(executablePath);
    if (!['Google Chrome', 'Google Chrome for Testing'].includes(executable)) return null;
    const contents = path.dirname(path.dirname(executablePath));
    if (path.basename(path.dirname(executablePath)) !== 'MacOS' || path.basename(contents) !== 'Contents') return null;
    if (!usableFile(path.join(contents, 'Info.plist'), fs.constants.R_OK, fileSystem)) return 'Chrome app metadata is missing';
    const frameworkName = `${executable} Framework`;
    const framework = path.join(contents, 'Frameworks', `${frameworkName}.framework`, 'Versions', 'Current');
    if (!usableFile(path.join(framework, frameworkName), fs.constants.R_OK, fileSystem)) return 'Chrome framework is missing';
    const helperName = `${executable} Helper`;
    const helperContents = path.join(framework, 'Helpers', `${helperName}.app`, 'Contents');
    if (!usableFile(path.join(helperContents, 'Info.plist'), fs.constants.R_OK, fileSystem)
        || !usableFile(path.join(helperContents, 'MacOS', helperName), fs.constants.X_OK, fileSystem)) {
        return 'Chrome helper is missing or not executable';
    }
    return null;
}

export function resolveRankingBrowser({ env = process.env, platform = process.platform, runtimeRoot = runtimeDirectory, fileSystem = fs } = {}) {
    const explicit = env.PUPPETEER_EXECUTABLE_PATH;
    if (explicit) {
        const issue = inspectRankingBrowser(explicit, { platform, fileSystem });
        if (issue) throw new Error(`Configured ranking browser is unavailable: ${issue}`);
        return { source: 'override', executablePath: explicit };
    }
    if (platform !== 'darwin') return { source: 'puppeteer', executablePath: null };

    const bundled = path.join(runtimeRoot, BUNDLED_RANKING_BROWSER_PATH);
    const bundleExists = fileSystem.existsSync(path.join(runtimeRoot, 'browser', 'chrome.app'));
    const bundleIssue = bundleExists ? inspectRankingBrowser(bundled, { platform, fileSystem }) : null;
    if (bundleExists && !bundleIssue) return { source: 'bundled', executablePath: bundled };

    const systemIssue = inspectRankingBrowser(SYSTEM_RANKING_BROWSER_PATH, { platform, fileSystem });
    if (!systemIssue) return {
        source: 'system', executablePath: SYSTEM_RANKING_BROWSER_PATH,
        ...(bundleIssue ? { warning: `Bundled ranking browser is incomplete: ${bundleIssue}; using installed Google Chrome` } : {}),
    };
    if (bundleIssue) throw new Error(`Bundled ranking browser is incomplete: ${bundleIssue}; no complete system Google Chrome is available`);
    // Other platforms and installations without a bundled/system Chrome retain
    // Puppeteer's managed-browser configuration and its installation diagnostic.
    return { source: 'puppeteer', executablePath: null };
}

export function configureRankingBrowser(options = {}) {
    const env = options.env || process.env;
    const resolved = resolveRankingBrowser({ ...options, env });
    // Fetchary loads Puppeteer lazily when browser capture is required. Its
    // supported environment setting must exist before that first load.
    if (resolved.executablePath && resolved.source !== 'override') env.PUPPETEER_EXECUTABLE_PATH = resolved.executablePath;
    return resolved;
}
