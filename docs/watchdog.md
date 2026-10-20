# Watchdog

Watchdog runs after the existing RSS fetch. It searches the normalized title, teaser and stored content with literal, Unicode-normalized, case-insensitive substrings. `includeAny` requires at least one of its terms when non-empty; `includeAll` requires every term. Both conditions apply together. Any `exclude` match vetoes the article. At least one include term is required. A rule supports 100 terms per field (200 characters each) and an optional list of feed IDs. Empty feed selection means every feed. Removing a selected feed never broadens the rule to all feeds.

SQLite migration `0006_watchdogs.sql` adds `watchdogs`, `watchdog_matches`, an article cursor and initial-feed synchronization state. Existing libraries start after their current highest article ID. Each watchdog also records the article boundary at creation/edit/reactivation. Matches have a unique `(watchdogId, articleId)` key; re-fetching or changing known articles cannot replay notifications. Historical lookup is an explicit creation option and always inserts silent matches. Rules and existing matches survive restarts; deleting a watchdog deletes its matches, while preserving articles.

The app uses its existing five-minute scheduler and SSE stream; no second RSS polling loop is created. Concurrent fetch requests share the running fetch, and SQLite transactions have exclusive access to the shared connection until commit/rollback. A first successful feed synchronization is silent, including when that feed initially returns no articles. The next new articles become notification-eligible.

## Local API

All endpoints require the existing local API middleware. JSON request bodies are strictly validated.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/api/watchdogs` | Rules with per-rule and total unread, unarchived counts |
| POST | `/api/watchdogs` | Create a rule, optionally including historical matches |
| PATCH | `/api/watchdogs/:id` | Edit fields or `{ "enabled": false }` to pause |
| DELETE | `/api/watchdogs/:id` | Delete a rule and its matches |
| GET | `/api/watchdogs/matches` | Newest detected matches first; 50 rows, `hasMore` and `before` cursor |
| GET | `/api/watchdogs/export` | Filtered, unique articles using the Feed article schema, topics and Bullshit classifications; up to 250 rows per page |
| GET | `/api/watchdogs/matches/:id` | A specific match and stored article text |
| PATCH | `/api/watchdogs/matches/:id` | `{ "read": true }` and/or `{ "archived": true }`; false reverses either state |
| GET / PATCH | `/api/watchdogs/notifications` | Read/save the user's `{ "enabled": true }` preference |

Creation example:

```json
{
  "name": "AI research",
  "enabled": true,
  "includeAny": ["OpenAI", "Anthropic"],
  "includeAll": ["research"],
  "exclude": ["sponsored"],
  "feedIds": [],
  "includeHistory": false
}
```

Match query parameters: `status=all|unread|read`, optional `watchdogId`, `archived=true|false` (default false), `range=24h|7d|month|year|all` (default all), optional `asOf=<13-digit Unix milliseconds>`, and `before=<match-id>`. Time windows use the article's publication time, falling back to match time if absent. Windows end at the reference time, excluding future articles. Month and year mean a rolling calendar month/year in UTC, clamped at month-end and leap-day boundaries. Pagination keeps its original reference time. History is only available at creation, and editing rules never mutates old match state. `watchdogs.updated` SSE events refresh the inbox and badge; reconnecting refreshes current counts.

Export accepts the same filters and `asOf`, plus Feed's `limit=1..250`, `cursorPublishedAt`, and `cursorId` pagination. It uses the shared Feed article query and serializer, preserving article IDs, source names, topics, Bullshit classifications and the JSON envelope `{ exportedAt, filters, articles }`. Watchdog selection, read/archive state, range and reference time appear in `filters.watchdog`; the regular Feed filter fields and article schema are unchanged. Markdown, JSON, CSV and link-list formats share the Feed download/save behavior. The UI exports every filtered page with one reference time, deduplicating articles that match multiple rules. Dismissing an article from Feed does not remove a Watchdog match or its export.

Both Watchdog and match cards support clicking the container and Enter/Space keyboard activation; Edit, Pause, Delete, read and archive buttons keep their own actions. Filters and Watchdog selection remain stationary while the match inbox scrolls.

Read/archive actions update the affected match in place, including their SSE events. Already loaded pages, the next-page cursor and inbox scroll position are retained. A match leaves the current view only when it no longer satisfies the read/archive filter. Broader live refreshes reload the previously requested page depth rather than replacing it with the first page. Pagination also retains its requested depth if a live refresh races with Load more.

Each article card offers **Add to list**, using the same list dialog as Feed and the underlying article ID. Existing memberships are shown there; adding an article does not open it or mark its Watchdog match as read.

Migration `0007_watchdog_export_index.sql` adds the article-first match index used by shared Feed-style export queries, including existing Watchdog databases.

## Native delivery

Only an explicit action under **Settings → Notifications** in the macOS app opens the app's consent dialog and then requests real UserNotifications authorization. The Tauri notification plugin handles banner delivery and click callbacks. Its desktop permission API itself always reports granted, so a small native macOS bridge checks/requests the actual OS authorization instead. No notification permission is requested on startup.

The main reader's native capability accepts Tauri's local development origin and the production loopback origin. Article webviews remain excluded. Native IPC errors are displayed with their original message, and the notification preference is saved only after OS authorization succeeds. Denied permission or a failed save leaves notifications off.

macOS UserNotifications requires an app bundle with a bundle identifier. The unbundled executable from `npm run dev` cannot request this authorization; Watchdog explains this and disables its notification button. To test OS consent and delivery, open the built `.app` from `npm run dist:mac`. For a debug app bundle, run `npm run tauri -- build --debug --bundles app` and open `src-tauri/target/debug/bundle/macos/NO BULLSHIT RSS.app`.

Node claims pending matches transactionally before emitting bounded `NBS_DESKTOP_EVENT` JSON frames on its existing stdout pipe. Rust consumes these directly; no webview is needed to dispatch notifications. Their article text is not copied into the sidecar log. One banner per watchdog contains the article title and, for multiple matches, a count; at most three banners are emitted per fetch. Remaining matches stay visible in the inbox. Opening the unread badge does not require notification permission.

A notification tap preserves its match ID in Rust, opens/focuses the main window and hands the ID to the trusted reader view. If the window needs to load, the ID remains pending until the view consumes it. The stored match opens and becomes read, including archived or older paginated matches. Closing the main window leaves the Node sidecar and native callback running. Explicit Quit stops the process and watching.

Delivery is **at most once**: an OS failure or a crash after claiming a batch can lose a banner; it never replays old banners on restart. Matches remain persistent. macOS notification settings and Focus mode can suppress banners. App consent can be disabled under Settings → Notifications; denied OS permission can be changed in macOS System Settings.

## Verification

```sh
npm test
npm run test:watchdog-ui
cargo test --manifest-path src-tauri/Cargo.toml
npm run dist:mac
```

The browser smoke test owns an isolated temporary database/server, exercises CRUD, historical results, filters, reading/archiving, SSE updates, deep links, keyboard focus and responsive layouts, and saves screenshots to `.desktop-cache/watchdog-qa/`. It does not touch the user's database or request OS permissions. Native permission dialogs and real notification taps should additionally be checked in the installed macOS app.
