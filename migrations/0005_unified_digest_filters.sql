-- Keep existing word filters as ordinary title and teaser rules.
INSERT INTO bullshit_rules (name, enabled, field, operator, value, createdAt, updatedAt)
SELECT trim(words.word) || ' (' || CASE fields.field WHEN 'title' THEN 'Title' ELSE 'Teaser' END || ')',
       1, fields.field, 'contains', trim(words.word), words.createdAt, datetime('now')
FROM digest_blocked_words AS words
CROSS JOIN (SELECT 'title' AS field UNION ALL SELECT 'teaser') AS fields
WHERE length(trim(words.word)) > 0
  AND NOT EXISTS (
    SELECT 1 FROM bullshit_rules AS existing
    WHERE existing.enabled = 1 AND existing.field = fields.field
      AND existing.operator = 'contains' AND existing.value = trim(words.word) COLLATE NOCASE
  );

INSERT OR IGNORE INTO article_bullshit_matches (articleId, ruleId, matchedAt)
SELECT articles.id, rules.id, datetime('now')
FROM articles
JOIN bullshit_rules AS rules ON rules.enabled = 1 AND rules.operator = 'contains'
JOIN digest_blocked_words AS words ON rules.value = trim(words.word) COLLATE NOCASE
WHERE (rules.field = 'title' AND instr(lower(coalesce(articles.title, '')), lower(trim(words.word))) > 0)
   OR (rules.field = 'teaser' AND instr(lower(coalesce(articles.teaser, '')), lower(trim(words.word))) > 0);

UPDATE digest_periods SET dirtyAt = datetime('now'), updatedAt = datetime('now') WHERE status <> 'closed';
DROP TABLE digest_blocked_words;
