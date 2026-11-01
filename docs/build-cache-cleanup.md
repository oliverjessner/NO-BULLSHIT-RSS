# Build cache cleanup

`publish.sh` cleans regenerable build caches after the branch and tag have been
pushed, the GitHub release and DMG upload have succeeded, and the Homebrew cask
publication has completed. Failed publication steps keep all build caches for
diagnosis and retry.

Preview the same cleanup without changing files:

```sh
npm run cleanup:build-cache
# Equivalent explicit preview:
npm run cleanup:build-cache -- --dry-run
```

To remove the listed caches explicitly:

```sh
npm run cleanup:build-cache -- --apply
```

The allowlist contains `src-tauri/target`, numeric version directories under
`.desktop-cache` containing downloaded Node runtimes, and recognized temporary
`runtime-*` staging directories. Cleanup acquires the same resource lock as
desktop preparation and preserves the lock file itself. It refuses symlinks in
target paths and does not follow nested symlinks to their destinations.

Release DMGs in `dist`, dependencies in `node_modules`, generated runtime inputs
in `src-tauri/resources/runtime` and `src-tauri/binaries`, source code, assets,
databases, publisher sessions, unrelated cache/recovery directories, and the
installed app are preserved. Configured database, session, topic-rule and release
output paths are also protected when located inside a cache directory.

If a process is running from a Tauri target directory or a Rust/Tauri build is
active, cleanup keeps the caches, including during compilation before an app
binary exists. Let the build finish or close the target process and rerun the
preview before applying cleanup. A busy resource lock or an unsafe target also
prevents deletion. If cleanup fails after
publication, the script reports that the release already succeeded; retry the
cleanup command rather than publishing the same version again.
