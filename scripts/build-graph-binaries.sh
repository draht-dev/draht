#!/usr/bin/env bash
#
# Build draht-graph (the Go knowledge-graph engine) for all platforms.
# Mirrors .github/workflows/build-graph-binaries.yml
#
# Usage:
#   ./scripts/build-graph-binaries.sh [--platform <platform>]
#
# Options:
#   --platform <name>   Build only for the specified platform
#                        (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64)
#
# Output (go/binaries/):
#   draht-graph-darwin-arm64.tar.gz   draht-graph-linux-x64.tar.gz
#   draht-graph-darwin-x64.tar.gz     draht-graph-linux-arm64.tar.gz
#   draht-graph-windows-x64.zip
#   SHA256SUMS           # sha256sum -c compatible, covers archives AND raw binaries
#   manifest.json        # machine-readable index consumed by the installer/resolver
#
# Env:
#   DRAHT_VERSION   Version to stamp (defaults to root package.json's "version").
#                    A leading "v" is stripped, so DRAHT_VERSION=v2026.7.30 works.
#   GO              Path to the go binary (defaults to `go` on PATH, falling back
#                    to a nix store search — see below).

set -euo pipefail

cd "$(dirname "$0")/.."

PLATFORM=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64"
            exit 1
            ;;
    esac
fi

# --- toolchain ---------------------------------------------------------
# CGO_ENABLED=0 is MANDATORY: it is what makes all five targets cross-compile
# with no C toolchain, and this repo's dev box has no cc/gcc/clang at all.
export CGO_ENABLED=0
GO="${GO:-go}"
if ! command -v "$GO" >/dev/null 2>&1; then
    for c in /nix/store/*-go-1.26*/bin/go; do
        [[ -x "$c" ]] && GO="$c" && break
    done
fi
command -v "$GO" >/dev/null 2>&1 || { echo "error: no Go toolchain; set GO=/path/to/go"; exit 1; }

VERSION="${DRAHT_VERSION:-$(node -p "require('./package.json').version")}"
VERSION="${VERSION#v}"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
GOVER="$("$GO" env GOVERSION)"

echo "==> version: $VERSION (commit $COMMIT, $GOVER)"

cd go

# --- grammar build tags: GENERATED, never hand-written (see internal/langset) ---
GRAMMAR_TAGS="$("$GO" run ./cmd/grammar-tags)"
[[ -n "$GRAMMAR_TAGS" ]] || { echo "error: grammar-tags produced an empty tag list"; exit 1; }
echo "==> grammar tags: $GRAMMAR_TAGS"

rm -rf binaries && mkdir -p binaries

if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64)
fi

goos_of() {
    case "$1" in
        darwin-*) echo darwin ;;
        linux-*) echo linux ;;
        windows-*) echo windows ;;
    esac
}
goarch_of() {
    case "$1" in
        *-x64) echo amd64 ;;
        *-arm64) echo arm64 ;;
    esac
}

for p in "${PLATFORMS[@]}"; do
    echo "Building for $p..."
    out="binaries/$p/draht-graph"
    [[ "$p" == windows-* ]] && out="$out.exe"
    mkdir -p "binaries/$p"
    GOOS="$(goos_of "$p")" GOARCH="$(goarch_of "$p")" \
        "$GO" build -trimpath \
            -ldflags "-s -w -X 'main.version=$VERSION' -X 'main.commit=$COMMIT'" \
            -tags "$GRAMMAR_TAGS" \
            -o "$out" ./cmd/draht-tools
    cp README.md ../LICENSE "binaries/$p/"
done

echo "==> Creating release archives..."

sha256_of() { # macOS ships shasum, Linux ships sha256sum
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

cd binaries
: > SHA256SUMS
ARTIFACTS_JSON=""
for p in "${PLATFORMS[@]}"; do
    binname="draht-graph"
    [[ "$p" == windows-* ]] && binname="draht-graph.exe"
    bsha="$(sha256_of "$p/$binname")"
    bbytes="$(wc -c < "$p/$binname" | tr -d ' ')"

    mv "$p" draht-graph
    if [[ "$p" == windows-x64 ]]; then
        archive="draht-graph-$p.zip"
        echo "Creating $archive..."
        zip -q -9 -r "$archive" draht-graph
    else
        archive="draht-graph-$p.tar.gz"
        echo "Creating $archive..."
        # Reproducible tar when GNU tar is available (it is on ubuntu-latest);
        # bsdtar (macOS) silently falls back to a non-normalised archive.
        if tar --version 2>/dev/null | grep -q GNU; then
            tar --sort=name --owner=0 --group=0 --numeric-owner \
                --mtime="@${SOURCE_DATE_EPOCH:-0}" -czf "$archive" draht-graph
        else
            tar -czf "$archive" draht-graph
        fi
    fi
    mv draht-graph "$p"

    asha="$(sha256_of "$archive")"
    abytes="$(wc -c < "$archive" | tr -d ' ')"
    printf '%s  %s\n' "$asha" "$archive" >> SHA256SUMS
    printf '%s  %s\n' "$bsha" "$p/$binname" >> SHA256SUMS
    ARTIFACTS_JSON="$ARTIFACTS_JSON{\"platform\":\"$p\",\"goos\":\"$(goos_of "$p")\",\"goarch\":\"$(goarch_of "$p")\",\"archive\":\"$archive\",\"archiveSha256\":\"$asha\",\"archiveBytes\":$abytes,\"binary\":\"$binname\",\"binarySha256\":\"$bsha\",\"binaryBytes\":$bbytes},"
done
ARTIFACTS_JSON="${ARTIFACTS_JSON%,}"

# --- manifest.json -------------------------------------------------------
# Schema contract: the installer (fetch step) and the resolver's checksum
# check (query-path stamp comparison) both read this. Keep schemaVersion
# and bump it on any field rename.
BUILD_TAGS_JSON="$(printf '%s' "$GRAMMAR_TAGS" | tr ' ' '\n' | sed 's/.*/"&"/' | paste -sd, -)"
# "languages" is derived from the SAME generated tag list (no separate
# source of truth): strip "grammar_subset_" and drop the bare
# "grammar_subset" master switch.
LANGUAGES_JSON="$(printf '%s' "$GRAMMAR_TAGS" | tr ' ' '\n' | grep '^grammar_subset_' | sed -e 's/^grammar_subset_//' -e 's/.*/"&"/' | paste -sd, -)"
cat > manifest.json <<EOF
{
  "schemaVersion": 1,
  "name": "draht-graph",
  "version": "$VERSION",
  "tag": "v$VERSION",
  "gitCommit": "$COMMIT",
  "goVersion": "$GOVER",
  "buildTags": [$BUILD_TAGS_JSON],
  "languages": [$LANGUAGES_JSON],
  "artifacts": [$ARTIFACTS_JSON]
}
EOF

# --- extract archives for easy local testing ------------------------------
# Both archive formats wrap a draht-graph/ directory (see the archive step
# above), so both extraction paths unpack into ./draht-graph and then rename
# it to $p — giving the SAME flat binaries/<platform>/draht-graph[.exe]
# layout regardless of format.
echo "==> Extracting archives for testing..."
for p in "${PLATFORMS[@]}"; do
    rm -rf "$p"
    if [[ "$p" == windows-x64 ]]; then
        unzip -q "draht-graph-$p.zip" && mv draht-graph "$p"
    else
        tar -xzf "draht-graph-$p.tar.gz" && mv draht-graph "$p"
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in go/binaries/"
ls -lh ./*.tar.gz ./*.zip 2>/dev/null || true
echo ""
echo "Checksums:"
cat SHA256SUMS
echo ""
echo "Extracted directories for testing:"
for p in "${PLATFORMS[@]}"; do
    binname="draht-graph"
    [[ "$p" == windows-* ]] && binname="draht-graph.exe"
    echo "  binaries/$p/$binname"
done
