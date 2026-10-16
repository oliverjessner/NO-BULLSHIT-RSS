## Build and publish

Build requirements: Node.js 26 or newer, Rust 1.93 or newer, and Apple's Command
Line Tools on macOS Apple Silicon.

Build the macOS ARM64 DMG:

```bash
npm run dist:mac
```

Desktop preparation assembles and verifies the runtime in a staging directory
before replacing the generated resources. Preparation and Cargo's resource copy
share a filesystem lock, so they cannot read and replace the tree simultaneously.
If preparation fails, the previous complete runtime remains available.

Release builds leave build dependencies and procedural macros unstripped to avoid
the [LINKEDIT alignment issue on macOS 27](https://github.com/rust-lang/rust/issues/157750).
The shipped application binary still uses the release profile's stripping setting.

The release DMG is written to `dist/NO.BULLSHIT.RSS-<version>-arm64.dmg`.
Tauri's app bundle and original DMG are under `src-tauri/target/aarch64-apple-darwin/release/bundle/`.
The local build uses ad-hoc signing with JIT and native-module entitlements for
Node/V8 and SQLite. It checks the sealed app signature, runs a SQLite query using
the signed bundled runtime and checks the bundled CLI version before copying the
release DMG into `dist/`. Distribution notarization requires your Apple
signing credentials. Check the resolved release without making changes:

```bash
npm run publish -- --dry-run
```

Regenerate all five screenshots and publish the GitHub release and Homebrew cask in one command. The screenshot server starts automatically when needed:

```bash
npm run publish
```

> [!IMPORTANT]
> Publishing regenerates the screenshots, stages and commits pending changes, pushes the current branch, builds the DMG, creates and pushes the version tag, creates the GitHub release, and commits and pushes the cask update to `oliverjessner/homebrew-tap`.

The Homebrew step uses the existing local `../homebrew-tap` checkout (`../../homebrew-tap` relative to `scripts/`). It requires `brew`, `git`, and an authenticated `gh` account with push access to the tap. The checkout must be clean and on its default branch, with `origin` pointing to `oliverjessner/homebrew-tap`. The script fetches and fast-forwards it, downloads the uploaded release DMG, computes SHA-256, checks the GitHub asset digest when available, and validates the generated cask with `brew style`. It updates and commits only `Casks/no-bullshit-rss.rb` and the tap README. Dry-run validates in a temporary directory without changing the local tap.

Override the checkout location with `HOMEBREW_TAP_DIR=/path/to/homebrew-tap npm run publish`, or use `npm run publish:brew -- --tap-path /path/to/homebrew-tap` for the separate Homebrew step.

Preview the cask for an already published release without committing or pushing:

```bash
npm run publish:brew -- --dry-run
# To preview a specific published version:
npm run publish:brew -- --dry-run --version 1.1.2
```

Publish or retry the Homebrew step for the current `package.json` version after its GitHub release is available:

```bash
npm run publish:brew
```

If the tap update fails after the GitHub release succeeds, retry `publish:brew` instead of rerunning the entire release. The command skips the commit when the cask and README are already up to date.
