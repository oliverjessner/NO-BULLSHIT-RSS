# Cleanup after publishing

After the GitHub upload and Homebrew publication both succeed, `publish.sh` runs the cleanup automatically. Failed publishes and `publish --dry-run` retain generated files for inspection and retries. A cleanup failure is reported separately from the successful publication; rerun cleanup without publishing again.

Preview the removal plan, file-content sizes and reasons for retaining releases:

```sh
npm run cleanup:build-cache
```

The default is a dry-run. To remove the eligible files:

```sh
npm run cleanup:build-cache -- --apply
```

The following paths are disposable. Keep personal files outside these directories:

| Path | Generated contents |
| --- | --- |
| `src-tauri/target/` | Rust builds and intermediate app/DMG bundles |
| `src-tauri/resources/runtime/` | Prepared application sources, Node licenses and production dependencies |
| `src-tauri/binaries/rss-node-aarch64-apple-darwin` and its `.tmp` file | Prepared Node sidecar |
| `src-tauri/gen/` | Generated Tauri schemas |
| `src-tauri/vendor/glib/target/` | Vendored GLib test/build output |
| `src-tauri/vendor/glib/Cargo.lock` | Generated lockfile for testing the vendored library separately |
| `.desktop-cache/X.Y.Z/` | Downloaded and extracted Node distributions |
| `.desktop-cache/runtime-XXXXXX/` and matching `.previous` directories | Temporary staged runtimes |
| `.desktop-cache/watchdog-qa/` | Generated Watchdog QA screenshots |
| `coverage/`, `test-results/`, `playwright-report/` | Generated test reports, traces and coverage |

Only the listed paths and recognized cache names are eligible. Other files in `src-tauri/resources/`, `src-tauri/binaries/` and `.desktop-cache/` are retained, including recovery directories and the resource lock. Build and desktop preparation recreate the generated runtime, schemas and sidecar; the next build may need to download Node again. Use `npm run dev` or `npm run dist:mac` for preparation and building together.

## Older DMGs

In `dist/` (or `RELEASE_OUTPUT_DIR`), cleanup considers only regular files named `NO.BULLSHIT.RSS-X.Y.Z-arm64.dmg` with a stable version numerically older than `package.json.version`. The current version, newer versions, unrecognized filenames, directories and unrelated files remain untouched.

An older DMG is removed only if its local SHA-256 equals the asset digest reported by the published GitHub release in `oliverjessner/NO-BULLSHIT-RSS`. The release must have the matching tag, be published and not be a draft or prerelease; the named asset must be fully uploaded. Tags default to `vX.Y.Z`; `TAG_PREFIX` supports the same override as publishing. No new manifest is required for existing DMGs.

Verification uses the installed `gh` CLI and its authentication. Missing releases/assets, absent or different digests, changed local DMGs, unavailable authentication and network failures preserve the DMGs and report a reason. Disposable caches can still be removed when GitHub is unavailable. Dry-runs perform the same read-only verification. Cleanup never modifies GitHub releases or assets.

Custom release output must be inside the checkout. Outside paths are retained. If release output is inside an otherwise disposable directory, that parent directory is retained; independently verified older DMGs inside it can still be removed. Release symlinks and symlinked output directories cause cleanup to refuse deletion.

## Protection and verification

Cleanup checks the package name, Cargo package and Git checkout root. Before deleting anything, it rejects Git-versioned files in its removal list and symlinks at any target or parent. Symlinks inside a disposable directory are unlinked without following their destinations. Removal plans are rebuilt under the same resource lock used by desktop preparation and `build.rs`; paths and Git state are checked again before deletion. Verified DMGs are hashed again immediately before removal.

Active Rust/Tauri builds, binaries running from this checkout's `src-tauri/target/` and the checkout's Node sidecar cause cleanup to skip removal. The report identifies the blocking process by PID and executable path. Target and sidecar checks use the executable field reported by `ps`, so path mentions in search commands, editor arguments or inline source do not block cleanup. The installed app and binaries from other checkouts are outside the target/sidecar check. Databases, rules, publisher sessions, backups, `.env`, source, icons, product screenshots and the checkout's `node_modules` are retained. Configured `DB_PATH`, `TOPIC_RULES_FILE_PATH`, `NBS_RANKING_SESSION_DIR`, `RSS_DATA_DIR` and `SERVER_LOG_PATH` protect overlapping targets, even if configured inside generated output. Global Cargo, npm, Homebrew and system caches are untouched.

The tests use disposable Git fixtures and mocked GitHub responses; they do not contact GitHub or remove project build output:

```sh
node --test scripts/cleanup-build-cache.test.js scripts/publish.test.js
```
