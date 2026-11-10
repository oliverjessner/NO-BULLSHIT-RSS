# Analytics

Open **Analytics** in the main navigation. The application logo opens Feed. The former Statistics dialog is replaced by this view; the existing statistics API and `no-bullshit-rss stats` command remain available.

The five tabs are **Overview**, **Trends**, **Publishers**, **Most Read** and **Topics**.

Analytics reads the application's SQLite library. Opening a section does not fetch publishers, reclassify articles, change reading state or run a database integrity check.

## Shared filters

The default period is **Last 30 days**, with **Last 7 days**, **Last 90 days** and **All time** also available. Periods are rolling UTC intervals ending at the time of the request, including their start and excluding their end. Publisher and topic selections persist when switching sections. Chart grouping supports UTC days, Monday-based weeks and calendar months. Article charts use the stored publication time, `publishedAt`.

Ranking measurements always use capture time, independently of article publication time. Reading, saving and dismissal figures describe the current stored state of the selected articles, not a historical activity log.

Charts use connected native SVG lines and visible observation points, with separate series colors and matching legends. Horizontal spacing follows actual timestamps. Lines connect stored observations; they do not add measurements on empty dates or establish continuous collection. Explicit missing ranking observations break the line.

Hover over a point, focus it with the keyboard, or touch it to show its date, series and article count. Ranking tooltips show ordinal positions such as **#1**. Use **Left/Right** to inspect earlier or later observations in the same series, **Home/End** for its first or last observation, and **Up/Down** to inspect the nearest observation in an adjacent series. **Escape** dismisses a visible tooltip; leaving an unfocused point, moving focus away or scrolling the plot also hides it. No values are estimated between observed points.

When other series have stored observations at exactly the same timestamp, the tooltip also lists their names and values, including overlapping points. Values from nearby dates are not substituted. **Escape** also dismisses a tooltip opened by hovering while keyboard focus remains elsewhere.

## Overview

Overview shows five cards: **Articles in period**, **Bullshit matches**, **Active feeds**, **Saved articles** and **Ranked articles**, plus an article-volume chart. An article matching several Bullshit rules is counted once. An article saved in several reading lists is counted once.

Topic counts use existing article-topic associations. An article can belong to several topics, so topic percentages overlap and should not be added together. Filtered metrics describe the selected population; total-library figures are identified separately from selected-period figures.

## Trends

Publication volume and selected topic series use publication time within the shared period. Topic momentum compares the current interval with the immediately preceding interval of exactly the same duration. A zero previous count has no percentage change; it is shown as a new baseline instead of infinity. All-time selections have no equal-duration previous period.

Emerging topics require at least five current articles, at least five additional articles, and at least twice the previous count when that count is positive. A zero baseline still requires five current articles and has no percentage change. This describes changes in collected coverage, not their cause. No AI interpretation or classification runs while viewing Analytics.

## Publishers

Publisher rows group feeds by the stored source ID. Comparisons show two publishers' article volume, topic coverage, Bullshit-match rate and observed ranking representation. Ranking availability follows the same supported-publisher registry as Most read. An unsupported ranking type is unavailable, not a measured zero.

Articles-per-day figures divide the selected count by the interval's elapsed days; all-time results use the stored coverage span. Topic categories can overlap.

## Most Read

The existing **Most read** article browser remains available. **Analytics → Most Read** analyzes retained observations in `most_read`. All available ranking types are included, with separate table labels and history charts.

| Ranking type | Meaning |
| --- | --- |
| `most_read` | A publisher's observed most-read ordering. |
| `most_commented` | A publisher's observed most-commented ordering. |
| `top_news` | Editorial selections such as Top-News, Top Headlines or Top Stories. These are not readership measurements. |

Rank 1 is the best position. Positions are ordinal, not pageview counts, unique readers, audience size or directly comparable traffic measurements between publishers.

Top performers retain publisher and ranking type, best and latest observed rank, first and last observation, and distinct snapshot appearances. An appearance is counted once per publisher, ranking type, capture timestamp and canonical article URL. Multiple ranking types remain separate.

New entries use the first retained observation, including history before the selected period. The oldest retained observation is not proof that the article had never appeared before collection began.

### Position changes and history

The Climbers and Decliners panels compare consecutive actual stored snapshots from the same publisher and ranking type. Only articles observed in both snapshots have a position change. A publisher with only one snapshot has no observed position change.

Choose **History** in a ranking table to open that article's ranking history in a modal dialog. Each ranking type keeps its own chart. Press **Escape** to dismiss a visible chart tooltip first; another **Escape**, or **Close ranking history**, closes the dialog and returns keyboard focus to the History button that opened it.

History plots the actual capture timestamps, with rank 1 at the top. An article's absence from a recorded snapshot is a gap, not a measured rank. There is no assumed eight-hour cadence or interpolation of missing collection runs. Different ranking types have separate series.

First-to-last observation is an **observed time span**, not uninterrupted residency in the ranking. Longest-running tables order by distinct captured appearances. The existing schema stores ranking entries and cannot distinguish an unrecorded collection run from a wholly empty successful capture; Analytics does not invent either.

Topic performance uses existing topic associations of matched local articles. Eligible denominators are restricted to comparable publisher/type coverage. Unmatched external entries have their stored title and canonical URL but cannot be assigned local topics. Large tables and histories are bounded and report their result limits.

## Topics

Inspect topic counts, coverage over time, momentum and ranking appearances. Co-occurrence counts distinct articles associated with both topics; it is not a sum of matching rules or scores. Selecting a topic intersects the other shared filters. Classification is never rerun by an analytics query.

## Library API and diagnostic indicators

The read-only `GET /api/analytics/library` endpoint remains available for stored, read, unread, saved, dismissed and unclassified article figures, classification status, feed/publisher counts and collection volume. It has no Analytics tab. Collection volume uses fetched time.

Missing local matches in ranking records can be legitimate: publisher selections may include articles outside subscribed RSS feeds. Repeated canonical URLs are **potential duplicates**, not confirmed corruption. Feed freshness uses the newest stored article fetch time and does not claim the last successful polling attempt when that information is unavailable.

## Implementation and validation

Read-only routes under `/api/analytics` provide `overview`, `trends`, `publishers`, `most-read`, `most-read/history`, `topics`, `library` and filter metadata. They use the existing local-client authentication, validated parameters, bound SQL values and SQLite aggregations. Existing article and ranking APIs remain compatible.

Run `npm test`, `npm run test:analytics` and `npm run test:analytics-ui` for analytics coverage, and `npm run test:rankings-ui` for the existing Most read browser. Browser checks use an isolated synthetic SQLite fixture and capture desktop/narrow screenshots; production data and collection settings are not changed.

With Playwright WebKit installed, `npm run test:analytics-webkit` repeats the Analytics checks in WebKit, including both window sizes, shared filters, topic multiselection, publisher comparisons, ranking histories, the shared article viewer and Save dialog. Chart checks cover connected count lines, real tooltip dates/labels/values, pointer and touch interaction, keyboard navigation and dismissal in Overview, publisher comparisons and ranking history. History checks verify native modal semantics, separate ranking charts, tooltip Escape handling, Close controls, focus restoration and narrow-window overflow before checking the article viewer and Save dialog.

`npm run benchmark:analytics` measures all analytics services against an in-memory fixture with 100,000 stored articles, 300,000 ranking records, overlapping feeds and unmatched ranking links. Optional positional arguments set the article and ranking-record counts. It reports elapsed time and payload sizes without opening the application's library. Article time series return the newest 512 calendar buckets; histories page at most 1,000 actual capture points at a time. Coverage metadata identifies bounded results.
