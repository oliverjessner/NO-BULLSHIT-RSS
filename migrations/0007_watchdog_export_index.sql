-- Shared Feed-style exports look up matches by article, across any watchdog.
CREATE INDEX idx_watchdog_matches_article ON watchdog_matches (articleId, archivedAt, readAt, watchdogId);
