import { stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function isFile(filePath) {
    try {
        return (await stat(filePath)).isFile();
    } catch {
        return false;
    }
}

async function findRepositoryDatabase(cwd) {
    let directory = path.resolve(cwd);
    while (true) {
        const packagePath = path.join(directory, 'package.json');
        try {
            const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
            if (packageJson?.name === 'no-bullshit-rss') {
                const v2Candidate = path.join(directory, 'data-v2.db');
                return (await isFile(v2Candidate)) ? v2Candidate : null;
            }
        } catch {
            // Keep walking until the filesystem root.
        }

        const parent = path.dirname(directory);
        if (parent === directory) {
            return null;
        }
        directory = parent;
    }
}

export function getDesktopDatabasePath({ platform = process.platform, env = process.env, homeDir = os.homedir() } = {}) {
    if (platform === 'darwin') {
        return path.join(homeDir, 'Library', 'Application Support', 'NO-BULLSHIT-RSS', 'data-v2.db');
    }
    if (platform === 'win32') {
        const appData = env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
        return path.join(appData, 'NO-BULLSHIT-RSS', 'data-v2.db');
    }

    const configDirectory = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    return path.join(configDirectory, 'NO-BULLSHIT-RSS', 'data-v2.db');
}

export async function discoverDatabasePath({ cwd = process.cwd(), env = process.env, platform, homeDir } = {}) {
    const configuredPath = String(env.DB_PATH || '').trim();
    if (configuredPath) {
        const resolvedPath = path.resolve(cwd, configuredPath);
        if (!(await isFile(resolvedPath))) {
            throw new Error(`Database not found at DB_PATH: ${resolvedPath}`);
        }
        return resolvedPath;
    }

    const repositoryDatabase = await findRepositoryDatabase(cwd);
    if (repositoryDatabase) {
        return repositoryDatabase;
    }

    const desktopDatabase = getDesktopDatabasePath({ platform, env, homeDir });
    if (await isFile(desktopDatabase)) {
        return desktopDatabase;
    }

    throw new Error(
        `NO BULLSHIT RSS database not found. Start the app at least once or set the existing DB_PATH environment variable. Checked: ${desktopDatabase}`,
    );
}
