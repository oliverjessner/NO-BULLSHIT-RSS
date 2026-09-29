# Frontend architecture and performance

This document records the architecture introduced by the native ES-module refactor and the browser measurements taken against the same local database before and after the change.

## Architecture

The frontend keeps its existing HTML, CSS, browser APIs, and Electron runtime. No framework, bundler, or runtime dependency was added.

```text
public/app.js                 bootstrap, view orchestration, live-update routing
public/js/api/client.js       the only HTTP API boundary
public/js/state/store.js      shared state and indexed reference data
public/js/views/              Feed, Digest, and Settings lifecycles
public/js/components/         article cards, digest clusters, and chips
public/js/services/           shared viewer, layout, and server-sent events
public/js/ui/                 cached DOM, navigation, modal, and toast controllers
public/js/utils/              DOM, formatting, and data helpers
```

The startup path initializes only shared services and Feed. Digest and Settings use dynamic imports and initialize on their first activation. Each view binds its events once and aborts requests that are no longer useful when appropriate.

`public/app.js` changed from 3,838 lines / 132,394 bytes to 152 lines / 5,370 bytes. All non-test frontend JavaScript is 1,422 lines / 85,985 bytes, a 35.1% source-size reduction from the former monolith.

## Reuse and boundaries

- `article-card.js`, `digest-cluster.js`, and `chips.js` build external RSS data with DOM nodes and `textContent`; no untrusted feed value is inserted through `innerHTML`.
- `article-viewer.js` is the one viewer controller used by Feed and Digest.
- `modal.js` and `toast.js` own the shared interaction surfaces and accessibility state.
- `dom.js` caches static document references once.
- `client.js` owns every endpoint, response check, query-string conversion, and request option. Views do not call `fetch()` directly.
- Data helpers centralize ID normalization, request/render fingerprints, safe HTTP(S) URLs, and search normalization. Formatting helpers centralize date and count presentation.

## Performance measurements

Measurements were taken in Chromium against the same local application data. SSE is excluded from API request counts because it is a persistent connection.

| Measurement | Before | After | Change |
| --- | ---: | ---: | ---: |
| `app.js` source | 132,394 B | 5,370 B | -95.9% |
| Total frontend JS source | 132,394 B | 85,985 B | -35.1% |
| Initial API requests | 10 | 5 | -50.0% |
| Initial DOM nodes | 28,510 | 1,085 | -96.2% |
| Digest clusters rendered at startup | 926 | 0 | lazy |

The previous implementation rendered the hidden Digest during startup. The new Digest is loaded on demand and renders at most 60 clusters per batch through an `IntersectionObserver`. In a Week run containing 934 clusters and 1,061 source articles, the initial Digest DOM contained 60 clusters rather than all 934.

A trustworthy before/after time-to-visible number was not available from the original runtime, so no synthetic timing claim is made. The reductions above measure the actual startup work that dominated that path: half as many initial API calls and 96.2% fewer initial nodes.

Native modules add several small static-file requests on first load. This is an intentional tradeoff for direct ES modules without a build step; Digest and Settings code remains outside the initial static module graph.

## Runtime optimizations

- Delegated actions for Feed cards, Digest items, chips, and Settings lists.
- Cached static DOM references and batched `DocumentFragment` writes.
- Lazy initialization and dynamic imports for Digest and Settings.
- `AbortController` plus monotonically increasing request IDs prevent stale Feed and Digest responses from winning races.
- Search input is debounced by 200 ms.
- Feed append renders only new, de-duplicated IDs; entity lookup uses `Map` and `Set` indexes.
- Dismiss and digest actions update the relevant UI immediately where rollback is reliable; failures restore state and use the shared toast surface.
- Large Feed and Digest cards use `content-visibility: auto` with an intrinsic size fallback.
- View deactivation aborts obsolete work, while listeners are registered only once.
- The Digest range switch clears stale range content, exposes a range-specific loading state, disables the switch during the request, and rejects a response for a range other than the current selection.

## Verification

- Node test suite: 32 passing tests, including five focused frontend utility tests.
- Syntax checks pass for every frontend module.
- `git diff --check` passes.
- Browser regression paths covered Feed search/filter clearing, Cards/Compact layout, dark-theme startup, Load More de-duplication, keyboard focus, lazy Digest and Settings activation, modal/viewer behavior, and Digest source/topic navigation.
- Day-to-Week was verified with the Week button pressed and `Week · 934 stories · 1,061 sources` rendered.
- Electron launches with its local backend healthy at `/api/health`.

## Remaining technical debt

- The Month Digest can still be expensive because its backend payload and clustering work are large. Server-side pagination or a compact Digest projection would improve this more than further DOM tuning.
- Digest batch rendering bounds DOM creation but is not a full windowed virtual list; very long scrolling sessions can still accumulate nodes.
- Native ES modules favor maintainability over the minimum possible static request count. A production bundling step should only be considered after packaging/startup profiling demonstrates a meaningful benefit.
- Destructive mutation paths were covered by existing API tests and code review, but a future lightweight browser smoke suite with an isolated fixture database would make full CRUD regression testing repeatable.
