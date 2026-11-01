-- The migration runner wraps this rebuild in a transaction. Keep the original
-- AUTOINCREMENT high-water mark even when its highest rows were deleted.
CREATE TEMP TABLE migration_0009_most_read_sequence (seq INTEGER);
INSERT INTO temp.migration_0009_most_read_sequence (seq)
    SELECT seq FROM sqlite_sequence WHERE name = 'most_read';

CREATE TABLE most_read_rebuilt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceId INTEGER NOT NULL,
    articleId INTEGER,
    canonicalUrl TEXT NOT NULL,
    title TEXT,
    rank INTEGER NOT NULL CHECK (rank > 0),
    rankingKey TEXT NOT NULL DEFAULT 'most_read'
        CHECK (rankingKey IN ('most_read', 'most_commented', 'top_news')),
    capturedAt TEXT NOT NULL,
    FOREIGN KEY (sourceId) REFERENCES sources(id) ON DELETE CASCADE,
    FOREIGN KEY (articleId) REFERENCES articles(id) ON DELETE SET NULL,
    UNIQUE (sourceId, rankingKey, capturedAt, rank),
    UNIQUE (sourceId, rankingKey, capturedAt, canonicalUrl)
);

INSERT INTO most_read_rebuilt (id, sourceId, articleId, canonicalUrl, title, rank, rankingKey, capturedAt)
    SELECT id, sourceId, articleId, canonicalUrl, title, rank, rankingKey, capturedAt FROM most_read;
DROP TABLE most_read;
ALTER TABLE most_read_rebuilt RENAME TO most_read;

INSERT INTO temp.migration_0009_most_read_sequence (seq)
    SELECT seq FROM sqlite_sequence WHERE name = 'most_read';
DELETE FROM sqlite_sequence WHERE name = 'most_read';
INSERT INTO sqlite_sequence (name, seq)
    SELECT 'most_read', MAX(seq) FROM temp.migration_0009_most_read_sequence HAVING COUNT(*) > 0;
DROP TABLE temp.migration_0009_most_read_sequence;

CREATE INDEX idx_most_read_latest
    ON most_read (sourceId, rankingKey, capturedAt DESC, rank);

CREATE INDEX idx_most_read_article_history
    ON most_read (articleId, capturedAt DESC);
