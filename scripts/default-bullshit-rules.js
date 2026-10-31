import { readFile } from 'node:fs/promises';
import { normalizeBullshitRule, reevaluateAllArticles } from '../backend/services/bullshit-rules.js';

export const DEFAULT_BULLSHIT_RULES_MARKER = 'defaults.bullshit-rules.production-2026-10-31';

function folded(value) {
    return String(value).normalize('NFKC').trim().toLocaleLowerCase();
}

function sameExpression(left, right) {
    return left.field === right.field && left.operator === right.operator && folded(left.value) === folded(right.value);
}

export async function seedDefaultBullshitRules(database, { fresh = false, rules, reevaluate = reevaluateAllArticles } = {}) {
    const defaults = (rules ?? JSON.parse(await readFile(new URL('./default-bullshit-rules.json', import.meta.url), 'utf8')))
        .map(rule => normalizeBullshitRule(rule));
    const result = await database.transaction(async () => {
        const marker = await database.get('SELECT value FROM app_metadata WHERE key = ?', [DEFAULT_BULLSHIT_RULES_MARKER]);
        if (marker && marker.value !== 'fresh') {
            return { applied: false, rulesAdded: 0, rulesEnabled: 0, needsReevaluation: marker.value === 'pending' };
        }

        const freshInstall = fresh || marker?.value === 'fresh';
        if (freshInstall) {
            // This template only belongs to the original empty-install migration.
            // Existing installations keep every rule, including their SEO rule.
            await database.run("DELETE FROM bullshit_rules WHERE name = 'SEO List' AND enabled = 0 AND field = 'title' AND operator = 'regex' AND value = ?", ['^Die \\d+']);
        }
        const existing = await database.all('SELECT id, name, enabled, field, operator, value FROM bullshit_rules');
        let rulesAdded = 0;
        let rulesEnabled = 0;
        for (const rule of defaults) {
            const found = existing.find(item => folded(item.name) === folded(rule.name) || sameExpression(item, rule));
            if (found) {
                // A fresh schema contains three disabled legacy templates. Only
                // enable those exact defaults; user preferences are never reset.
                if (freshInstall && folded(found.name) === folded(rule.name) && sameExpression(found, rule) && Boolean(found.enabled) !== rule.enabled) {
                    await database.run("UPDATE bullshit_rules SET enabled = ?, updatedAt = datetime('now') WHERE id = ?", [rule.enabled ? 1 : 0, found.id]);
                    found.enabled = rule.enabled ? 1 : 0;
                    rulesEnabled += 1;
                }
                continue;
            }

            const inserted = await database.run(
                `INSERT INTO bullshit_rules (name, enabled, field, operator, value, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
                [rule.name, rule.enabled ? 1 : 0, rule.field, rule.operator, rule.value],
            );
            existing.push({ id: inserted.lastID, ...rule });
            rulesAdded += 1;
        }

        const needsReevaluation = rulesAdded > 0 || rulesEnabled > 0;
        await database.run(
            `INSERT INTO app_metadata (key, value, updatedAt) VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
            [DEFAULT_BULLSHIT_RULES_MARKER, needsReevaluation ? 'pending' : '1'],
        );
        return { applied: true, rulesAdded, rulesEnabled, needsReevaluation };
    });

    if (result.needsReevaluation) {
        // Re-evaluation force-refreshes the rule cache and uses bounded batch
        // transactions. Keep the marker pending until all batches succeed so
        // an interrupted initial run can recover on the next launch.
        await reevaluate();
        await database.transaction(async () => {
            await database.run("UPDATE digest_periods SET dirtyAt = datetime('now'), updatedAt = datetime('now') WHERE status <> 'closed'");
            await database.run(
                "UPDATE app_metadata SET value = '1', updatedAt = datetime('now') WHERE key = ?",
                [DEFAULT_BULLSHIT_RULES_MARKER],
            );
        });
    }
    return { applied: result.applied, rulesAdded: result.rulesAdded, rulesEnabled: result.rulesEnabled };
}
