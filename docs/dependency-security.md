# Dependency maintenance

Dependabot checks npm at the repository root and Cargo in `src-tauri` weekly.
Security updates remain enabled; no vulnerable dependency versions are ignored.

## GLib and the failed security update

The [Dependabot run](https://github.com/oliverjessner/NO-BULLSHIT-RSS/actions/runs/38719493227)
failed with `security_update_not_possible`: the latest resolvable GLib was 0.18.5,
while GHSA-wrw7-89jp-8q8g requires 0.20.0 or newer. Tauri's GTK3 dependencies
require GLib 0.18, so a standalone GLib minor-version upgrade cannot resolve this.

The compatibility fix is a local backport of the upstream pointer-mutability
correction, configured through `[patch.crates-io]`. Keep that patch until Tauri's
Linux dependency stack supports an upstream fixed release. Do not remove it in
response to an automated version bump without reviewing the resolved GTK stack.

Changes here take effect on GitHub only after pushing the merged commits.
Historical failed runs remain failed; retrying them against their old commit
does not validate the new dependency graph. GitHub may still flag a backported
version by its version number; review the patched source rather than dismissing
an alert as a false positive automatically.
