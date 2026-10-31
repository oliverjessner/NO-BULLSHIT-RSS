import {
    all,
    get,
    initSchema,
    run,
    transaction,
} from '../backend/database/datenbank.js';
import { ensureTopicDefinitionsInitialized } from '../backend/services/topics.js';
import { ensureRebuildWindowDigestPeriods, generateDirtyDigestPeriods, recoverInterruptedDigestGenerations } from '../backend/services/digest-store.js';
import { seedDefaultFeeds } from './default-feeds.js';
import { DEFAULT_BULLSHIT_RULES_MARKER, seedDefaultBullshitRules } from './default-bullshit-rules.js';

export async function initDatabase() {
    const freshBullshitRules = !await get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bullshit_rules'");
    await initSchema();
    if (freshBullshitRules) {
        await run(
            "INSERT INTO app_metadata (key, value, updatedAt) VALUES (?, 'fresh', datetime('now')) ON CONFLICT(key) DO NOTHING",
            [DEFAULT_BULLSHIT_RULES_MARKER],
        );
    }
    await recoverInterruptedDigestGenerations();
    await ensureTopicDefinitionsInitialized();
    await seedDefaultFeeds({ get, run, transaction });
    await seedDefaultBullshitRules({ all, get, run, transaction }, { fresh: freshBullshitRules });
    await ensureRebuildWindowDigestPeriods();
    await generateDirtyDigestPeriods();
    await run('ANALYZE');
    await run('PRAGMA optimize');
}

if (process.argv[1] && process.argv[1].endsWith('init-db.js')) {
    initDatabase()
        .then(() => {
            console.log('DB initialized');
        })
        .catch(err => {
            console.error('DB init failed:', err);
            process.exit(1);
        });
}
