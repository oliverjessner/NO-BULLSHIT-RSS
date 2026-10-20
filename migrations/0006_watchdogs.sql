ALTER TABLE feeds ADD COLUMN watchdogInitializedAt TEXT;
UPDATE feeds SET watchdogInitializedAt = datetime('now') WHERE EXISTS (SELECT 1 FROM articles WHERE articles.feedId = feeds.id);

CREATE TABLE watchdogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    includeAnyJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(includeAnyJson)),
    includeAllJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(includeAllJson)),
    excludeJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(excludeJson)),
    feedIdsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(feedIdsJson)),
    startArticleId INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
);
CREATE TABLE watchdog_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watchdogId INTEGER NOT NULL REFERENCES watchdogs(id) ON DELETE CASCADE,
    articleId INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    matchedAt TEXT NOT NULL,
    readAt TEXT,
    archivedAt TEXT,
    historical INTEGER NOT NULL DEFAULT 0 CHECK (historical IN (0, 1)),
    notificationState TEXT NOT NULL CHECK (notificationState IN ('pending', 'claimed', 'skipped')),
    UNIQUE (watchdogId, articleId)
);
CREATE INDEX idx_watchdog_matches_inbox ON watchdog_matches (watchdogId, archivedAt, readAt, id DESC);
CREATE INDEX idx_watchdog_matches_pending ON watchdog_matches (notificationState, id) WHERE notificationState = 'pending';
-- Upgrades begin after the existing library, without replaying old notifications.
INSERT INTO app_metadata (key, value, updatedAt)
VALUES ('watchdog.lastArticleId', CAST((SELECT COALESCE(MAX(id), 0) FROM articles) AS TEXT), datetime('now'));
INSERT INTO app_metadata (key, value, updatedAt) VALUES ('watchdog.notifications', '0', datetime('now'));
