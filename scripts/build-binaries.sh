#!/usr/bin/env bash
#
# Build Draht binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--platform <platform>]
#
# Options:
#   --platform <name>   Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64)
#
# Output:
#   packages/coding-agent/binaries/
#     draht-darwin-arm64.tar.gz
#     draht-darwin-x64.tar.gz
#     draht-linux-x64.tar.gz
#     draht-linux-arm64.tar.gz
#     draht-windows-x64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

EXPECTED_BUN_REVISION="$(node -p "require('./package.json').drahtReleaseBunRevision")"
ACTUAL_BUN_REVISION="$(bun --revision)"
if [[ "$ACTUAL_BUN_REVISION" != "$EXPECTED_BUN_REVISION" ]]; then
    echo "Bun revision $ACTUAL_BUN_REVISION does not match required $EXPECTED_BUN_REVISION" >&2
    exit 1
fi

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

# Validate platform if specified
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

echo "==> Installing dependencies..."
# Packaging below intentionally reads native assets from the root node_modules.
# Request that layout explicitly instead of depending on Bun's evolving default
# workspace linker, and fail closed if the reproducible install cannot finish.
bun install --frozen-lockfile --linker hoisted

echo "==> Building all packages..."
bun run build

echo "==> Building binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf binaries
mkdir -p binaries/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    bun_target="bun-$platform"
    if [[ "$platform" == *-x64 ]]; then
        bun_target="${bun_target}-baseline"
    fi

    # Externalize koffi to avoid embedding all 18 platform .node files (~74MB)
    # into every binary. Koffi is only used on Windows for VT input and the
    # call site has a try/catch fallback. For Windows builds, we copy the
    # appropriate .node file alongside the binary below.
    #
    # Bun compiled executables only embed worker scripts when they are passed as
    # explicit build entrypoints. Bun places them at their path relative to the
    # common directory of all entrypoints, so the main entry must stay in dist/
    # for the worker specifiers in the runtime to resolve.
    #
    # Disable cwd bunfig.toml autoload so project preload scripts cannot crash the
    # standalone binary before draht starts (see #7684).
    if [[ "$platform" == "windows-x64" ]]; then
        bun build --compile --external koffi --no-compile-autoload-bunfig --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile binaries/$platform/draht.exe
    else
        bun build --compile --external koffi --no-compile-autoload-bunfig --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile binaries/$platform/draht
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json binaries/$platform/
    cp README.md binaries/$platform/
    cp CHANGELOG.md binaries/$platform/
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm binaries/$platform/
    mkdir -p binaries/$platform/theme
    cp dist/modes/interactive/theme/*.json binaries/$platform/theme/
    mkdir -p binaries/$platform/assets
    cp dist/modes/interactive/assets/* binaries/$platform/assets/ 2>/dev/null || echo "  (warning: no dist/modes/interactive/assets to copy)"
    cp -r dist/core/export-html binaries/$platform/
    cp -r docs binaries/$platform/
    mkdir -p binaries/$platform/examples
    (cd examples && tar --exclude='node_modules' -cf - .) | (cd binaries/$platform/examples && tar -xf -)

    # Copy the selected architecture's native platform helpers next to the executable.
    native_platform="${platform/windows-/win32-}"
    native_path="native/${native_platform%-*}/prebuilds"
    mkdir -p "binaries/$platform/$native_path"
    cp -R "../tui/$native_path/$native_platform" "binaries/$platform/$native_path/"
done

# Create archives
cd binaries

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
: > DRAHT-SHA256SUMS

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == "windows-x64" ]]; then
        # Windows (zip)
        echo "Creating draht-$platform.zip..."
        (cd $platform && zip -r ../draht-$platform.zip .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating draht-$platform.tar.gz..."
        mv $platform draht && tar -czf draht-$platform.tar.gz draht && mv draht $platform
    fi

    if [[ "$platform" == "windows-x64" ]]; then
        archive="draht-$platform.zip"
        binary="draht.exe"
    else
        archive="draht-$platform.tar.gz"
        binary="draht"
    fi
    archive_sha="$(sha256_of "$archive")"
    archive_bytes="$(wc -c < "$archive" | tr -d ' ')"
    binary_sha="$(sha256_of "$platform/$binary")"
    binary_bytes="$(wc -c < "$platform/$binary" | tr -d ' ')"
    printf '%s  %s\n' "$archive_sha" "$archive" >> DRAHT-SHA256SUMS
done
node ../../../scripts/build-runtime-manifest.mjs "${PLATFORMS[@]}"

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf $platform
    if [[ "$platform" == "windows-x64" ]]; then
        mkdir -p $platform && (cd $platform && unzip -q ../draht-$platform.zip)
    else
        tar -xzf draht-$platform.tar.gz && mv draht $platform
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in packages/coding-agent/binaries/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == "windows-x64" ]]; then
        echo "  binaries/$platform/draht.exe"
    else
        echo "  binaries/$platform/draht"
    fi
done
