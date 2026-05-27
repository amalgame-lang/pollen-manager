#!/bin/bash
# pollen-manager/build.sh — workaround build script.
#
# The upstream `amc package add` + mosaic-build.sh only compile
# each package's facade.am into the archive, missing the classes
# defined in `sources = [...]` siblings (WebApp/Static/Session
# for amalgame-web, etc.). This script rebuilds the multi-source
# archives into ./build/ locally and re-links against them.
#
# Delete me once amc package add handles multi-source packages.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PKG_BASE="$HOME/.amalgame/packages/github.com/amalgame-lang"
AMC_RT="$HOME/.local/share/amalgame/runtime"
AMC_LIB="$HOME/.local/share/amalgame/lib/libamalgame.a"

mkdir -p build

# Gather -I dirs for every cached package (their headers cross-#include).
PKG_INCS=()
for d in "$PKG_BASE"/*/; do
    latest=$(ls -1 "$d" 2>/dev/null | sort -V | tail -1)
    [ -d "$d$latest/runtime" ] && PKG_INCS+=(-I"$d$latest/runtime")
done

# Rebuild the amalgame-web archive locally with ALL sources (the
# upstream archive only contains facade.am).
rebuild_pkg() {
    local pkg_name=$1 cls=$2 ; shift 2
    local pkg_dir=$(ls -d "$PKG_BASE/amalgame-${pkg_name}/"*/ | tail -1)
    pkg_dir=${pkg_dir%/}
    local stem="build/${cls}-multi"
    echo "→ rebuilding amalgame-${pkg_name} archive (${cls}) from $(basename "$pkg_dir")"
    (cd "$pkg_dir" && amc --lib --quiet "$@" -o "$ROOT/$stem" >/dev/null)
    gcc -O2 -I"$AMC_RT" "${PKG_INCS[@]}" \
        -I"$pkg_dir/runtime" \
        -c "$stem.c" -o "$stem.o"
    ar rcs "build/libamalgame-pkg-${cls}.a" "$stem.o"
}

# amalgame-web — 14 sources.
rebuild_pkg web Router \
    facade.am session.am web_context.am security_headers.am \
    cors.am rate_limit.am csrf.am log_config.am \
    signed_cookie_session.am redis_session.am acme_config.am \
    tls_binding_config.am static.am web_app.am

# Pick up the upstream facade-only archives for everything else
# (single-class packages don't have the multi-source problem).
get_pkg_archive() {
    local pkg=$1 cls=$2
    # sort -V + skip *_clone scratch dirs : lexical sort would pick
    # v0.1.9 over v0.1.12 ("9" > "1"), linking a stale archive.
    local d=$(ls -d "$PKG_BASE/amalgame-${pkg}/"*/ | grep -v '_clone/$' | sort -V | tail -1)
    d=${d%/}
    echo "$d/build/linux-x86_64/libamalgame-pkg-${cls}.a"
}

# Routes regen + amc → server.c.
echo "→ regenerating _routes.am"
/home/neitsab/Développement/mosaic/tools/mosaic-routes.sh app _routes.am
echo "→ amc server.am _routes.am → server.c"
amc --quiet server.am _routes.am -o server >/dev/null

# Link with our locally-rebuilt web archive first so it wins over
# the upstream incomplete one.
echo "→ link"
gcc -O2 -I"$AMC_RT" "${PKG_INCS[@]}" \
    -Wno-int-conversion -Wno-incompatible-pointer-types \
    server.c \
    -Wl,--start-group \
    build/libamalgame-pkg-Router.a \
    "$(get_pkg_archive crypto Sha256)" \
    "$(get_pkg_archive tls TlsConfig)" \
    "$(get_pkg_archive async Async)" \
    "$(get_pkg_archive net-http HttpRequest)" \
    "$(get_pkg_archive datetime DateTime)" \
    "$(get_pkg_archive random Random)" \
    "$(get_pkg_archive logging Log)" \
    "$(get_pkg_archive database-nosql-redis Redis)" \
    "$(get_pkg_archive threading Threading)" \
    "$(get_pkg_archive pollen Pollen)" \
    "$AMC_LIB" \
    -Wl,--end-group \
    -lgc -lm -lz -lcrypto -lssl -lnghttp2 -lpthread \
    -o server

echo "✓ Built ./server"
