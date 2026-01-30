import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, ensureFeedLogoColumns, ensureListColorColumn, initSchema, run } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function seedFeeds() {
  const existing = await all('SELECT id FROM feeds LIMIT 1');
  if (existing.length > 0) return;

  const sourcesPath = path.join(__dirname, '..', 'sources.json');
  const raw = await readFile(sourcesPath, 'utf-8');
  const sources = JSON.parse(raw);

  for (const source of sources) {
    if (!source.hasFeed || !Array.isArray(source.feeds)) continue;
    for (const feedUrl of source.feeds) {
      await run(
        `INSERT INTO feeds (name, websiteUrl, feedUrl) VALUES (?, ?, ?)` ,
        [source.name, source.url, feedUrl]
      );
    }
  }
}

export async function initDatabase() {
  await initSchema();
  await ensureFeedLogoColumns();
  await ensureListColorColumn();
  await seedFeeds();
}

if (process.argv[1] && process.argv[1].endsWith('init-db.js')) {
  initDatabase()
    .then(() => {
      console.log('DB initialized');
    })
    .catch((err) => {
      console.error('DB init failed:', err);
      process.exit(1);
    });
}
