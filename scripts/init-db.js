import {
    get,
    initSchema,
    run,
    transaction,
} from '../backend/database/datenbank.js';
import { ensureTopicDefinitionsInitialized } from '../backend/services/topics.js';
import { ensureRebuildWindowDigestPeriods, generateDirtyDigestPeriods, recoverInterruptedDigestGenerations } from '../backend/services/digest-store.js';
import { seedDefaultFeeds } from './default-feeds.js';

export async function initDatabase() {
    await initSchema();
    await recoverInterruptedDigestGenerations();
    await ensureTopicDefinitionsInitialized();
    await seedDefaultFeeds({ get, run, transaction });
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
