# Analytics

Open **Analytics** in the main navigation. The application logo opens Feed. The former Statistics dialog is replaced by this view; the existing statistics API and `no-bullshit-rss stats` command remain available.

Analytics reads the application's SQLite library. Opening a section does not fetch publishers, reclassify articles, change reading state or run a database integrity check.

## Shared filters

The default period is **Last 30 days**, with **Last 7 days**, **Last 90 days** and **All time** also available. Periods are rolling UTC intervals ending at the time of the request, including their start and excluding their end. Publisher and topic selections persist when switching sections. Chart grouping supports UTC days, Monday-based weeks and calendar months. Article charts default to publication time; switching to fetched time uses the stored `fetchedAt` value.

Ranking measurements always use capture time. This is independent of the article chart's date basis. Reading, saving and dismissal figures describe the current stored state of the selected articles, not a historical activity log.

## Overview

The dashboard contains article, selected-period, Bullshit-match, configured-feed, saved, read and ranked-article figures, an article-volume chart, and top-ten feed/topic tables. An article matching several Bullshit rules is counted once. An article saved in several reading lists is counted once.

Topic counts use existing article-topic associations. An article can belong to several topics, so topic percentages overlap and should not be added together. Filtered metrics describe the selected population; total-library figures are identified separately from selected-period figures.

## Trends

Publication volume and selected topic series use the shared period and date basis. Topic momentum compares the current interval with the immediately preceding interval of exactly the same duration. A zero previous count has no percentage change; it is shown as a new baseline instead of infinity. All-time selections have no equal-duration previous period.

Emerging topics require at least five current articles, at least five additional articles, and at least twice the previous count when that count is positive. A zero baseline still requires five current articles and has no percentage change. This describes changes in collected coverage, not their cause. No AI interpretation or classification runs while viewing Analytics.

## Publishers

Publisher rows group feeds by the stored source ID. Feed rows retain each RSS feed's identity. Comparisons show two publishers' article volume, topic coverage, Bullshit-match rate and observed ranking representation. Ranking availability follows the same supported-publisher registry as Most read. An unsupported ranking type is unavailable, not a measured zero.

Articles-per-day figures divide the selected count by the interval's elapsed days; all-time results use the stored coverage span. Topic categories can overlap.

## Most Read

The existing **Most read** article browser remains available. **Analytics → Most Read** analyzes retained observations in `most_read`.

| Ranking type | Meaning |
| --- | --- |
| `most_read` | A publisher's observed most-read ordering. |
| `most_commented` | A publisher's observed most-commented ordering. |
| `top_news` | Editorial selections such as Top-News, Top Headlines or Top Stories. These are not readership measurements. |

Rank 1 is the best position. Positions are ordinal, not pageview counts, unique readers, audience size or directly comparable traffic measurements between publishers.

Top performers retain publisher and ranking type, best and latest observed rank, first and last observation, and distinct snapshot appearances. An appearance is counted once per publisher, ranking type, capture timestamp and canonical article URL. Multiple ranking types remain separate.

New entries use the first retained observation, including history before the selected period. The oldest retained observation is not proof that the article had never appeared before collection began.

### Position changes and history

Climbers, decliners, unchanged articles, new entries and dropped articles compare consecutive actual stored snapshots from the same publisher and ranking type. A new article has no artificial previous rank; a dropped article has no artificial current rank. A publisher with only one snapshot has no observed position change.

History plots the actual capture timestamps, with rank 1 at the top. An article's absence from a recorded snapshot is a gap, not a measured rank. There is no assumed eight-hour cadence or interpolation of missing collection runs. Different ranking types have separate series.

First-to-last observation is an **observed time span**, not uninterrupted residency in the ranking. Longest-running tables order by distinct captured appearances. The existing schema stores ranking entries and cannot distinguish an unrecorded collection run from a wholly empty successful capture; Analytics does not invent either.

Topic performance uses existing topic associations of matched local articles. Eligible denominators are restricted to comparable publisher/type coverage. Unmatched external entries have their stored title and canonical URL but cannot be assigned local topics. Large tables and histories are bounded and report their result limits.

## Topics

Inspect topic counts, publisher distribution, coverage over time, momentum and ranking appearances. Co-occurrence counts distinct articles associated with both topics; it is not a sum of matching rules or scores. Selecting a topic intersects the other shared filters. Classification is never rerun by an analytics query.

## Library and diagnostic indicators

Library figures include stored, read, unread, saved, dismissed and unclassified articles, classification status, feed/publisher counts and collection volume. Collection volume uses fetched time.

Missing local matches in ranking records can be legitimate: publisher selections may include articles outside subscribed RSS feeds. Repeated canonical URLs are **potential duplicates**, not confirmed corruption. Feed freshness uses the newest stored article fetch time and does not claim the last successful polling attempt when that information is unavailable.

## Implementation and validation

Read-only routes under `/api/analytics` provide `overview`, `trends`, `publishers`, `most-read`, `most-read/history`, `topics`, `library` and filter metadata. They use the existing local-client authentication, validated parameters, bound SQL values and SQLite aggregations. Existing article and ranking APIs remain compatible.

Run `npm test`, `npm run test:analytics` and `npm run test:analytics-ui` for analytics coverage, and `npm run test:rankings-ui` for the existing Most read browser. Browser checks use an isolated synthetic SQLite fixture and capture desktop/narrow screenshots; production data and collection settings are not changed.

With Playwright WebKit installed, `npm run test:analytics-webkit` repeats the Analytics checks in WebKit, including both window sizes, shared filters, topic multiselection, publisher comparisons, ranking histories, the shared article viewer and Save dialog.

`npm run benchmark:analytics` measures all sections against an in-memory fixture with 100,000 stored articles, 300,000 ranking records, overlapping feeds and unmatched ranking links. Optional positional arguments set the article and ranking-record counts. It reports elapsed time and payload sizes without opening the application's library. Article time series return the newest 512 calendar buckets; histories page at most 1,000 actual capture points at a time. Coverage metadata identifies bounded results.
