CREATE TABLE most_read (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceId INTEGER NOT NULL,
    articleId INTEGER,
    canonicalUrl TEXT NOT NULL,
    title TEXT,
    rank INTEGER NOT NULL CHECK (rank > 0),
    rankingKey TEXT NOT NULL DEFAULT 'most_read'
        CHECK (rankingKey IN ('most_read', 'most_commented')),
    capturedAt TEXT NOT NULL,
    FOREIGN KEY (sourceId) REFERENCES sources(id) ON DELETE CASCADE,
    FOREIGN KEY (articleId) REFERENCES articles(id) ON DELETE SET NULL,
    UNIQUE (sourceId, rankingKey, capturedAt, rank),
    UNIQUE (sourceId, rankingKey, capturedAt, canonicalUrl)
);

CREATE INDEX idx_most_read_latest
    ON most_read (sourceId, rankingKey, capturedAt DESC, rank);

CREATE INDEX idx_most_read_article_history
    ON most_read (articleId, capturedAt DESC);
