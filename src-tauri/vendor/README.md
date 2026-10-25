# GLib security backport

`glib/` is the published `glib` 0.18.5 crate, licensed under MIT (see
`glib/LICENSE`). Archive SHA-256:
`233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`.
Source: https://static.crates.io/crates/glib/glib-0.18.5.crate

Only `src/variant_iter.rs` differs from the published source: the pointer in
`VariantStrIter::impl_get` is mutable and is passed as `&mut p`. This backports
https://github.com/gtk-rs/gtk-rs-core/pull/1343 for
https://rustsec.org/advisories/RUSTSEC-2024-0429.html (GHSA-wrw7-89jp-8q8g).

Tauri's GTK3 dependencies still require GLib 0.18. Updating only GLib to 0.20
would leave that dependency unfixed. The root `[patch.crates-io]` and lockfile
select this local copy for the existing graph. Remove the backport when the
entire GTK stack can use a fixed upstream release.

The bundled iterator unit tests exercise forward, backward, nth, last, and
mixed-direction traversal. Run on Linux with GLib development libraries:

```sh
cargo test --release --manifest-path src-tauri/vendor/glib/Cargo.toml --lib variant_iter
```

Tests and desktop builds have not been executed as part of this change.
