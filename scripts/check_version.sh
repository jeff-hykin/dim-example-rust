#!/bin/sh
# Cargo.toml's version is the app's own version, so it has to be the version dimos.yaml ships: `CARGO_PKG_VERSION` is
# what a server reports of itself in its log and writes into a recording's metadata, and a release that bumps only
# dimos.yaml leaves that number behind. An app that started from this example did exactly that for thirty releases,
# stamping `app_version: 0.5.37` onto everything it recorded at 0.6.2.
#
# It's a script and not a `#[test]` because the flake builds the server from Cargo.toml, Cargo.lock and server/ alone
# (so editing dimos.yaml doesn't rebuild it) with `doCheck = false` — the build can neither read dimos.yaml nor run a
# test. `dimos-desktop app check .` reports the same drift from the outside, for any app.
set -eu
cd "$(dirname "$0")/.."
crate=$(sed -n '/^\[package\]/,/^\[/{s/^version *= *"\(.*\)"/\1/p;}' Cargo.toml | head -1)
shipped=$(sed -n 's/^version: *"\{0,1\}\([^"#]*[^"# ]\)"\{0,1\} *$/\1/p' dimos.yaml | head -1)
if [ "$crate" != "$shipped" ]; then
    echo "Cargo.toml says version $crate, dimos.yaml says $shipped: a release bumps both" >&2
    exit 1
fi
echo "Cargo.toml and dimos.yaml agree on $crate"
