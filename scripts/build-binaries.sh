#!/usr/bin/env bash
#
# Build Draht binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-deps] [--platform <platform>]
#
# Options:
#   --skip-deps         Skip installing cross-platform dependencies
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

SKIP_DEPS=false
PLATFORM=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
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

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform native bindings..."
    # Materialize every locked optional native binding without rewriting package
    # metadata or resolving ad-hoc versions during a release build.
    bun install --frozen-lockfile --linker hoisted --os='*' --cpu='*'
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

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
    # Externalize koffi to avoid embedding all 18 platform .node files (~74MB)
    # into every binary. Koffi is only used on Windows for VT input and the
    # call site has a try/catch fallback. For Windows builds, we copy the
    # appropriate .node file alongside the binary below.
    if [[ "$platform" == "windows-x64" ]]; then
        bun build --compile --external koffi --target=bun-$platform ./dist/bun/cli.js --outfile binaries/$platform/draht.exe
    else
        bun build --compile --external koffi --target=bun-$platform ./dist/bun/cli.js --outfile binaries/$platform/draht
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

    case "$platform" in
        darwin-arm64)
            clipboard_native_package="clipboard-darwin-arm64"
            clipboard_native_file="clipboard.darwin-arm64.node"
            ;;
        darwin-x64)
            clipboard_native_package="clipboard-darwin-x64"
            clipboard_native_file="clipboard.darwin-x64.node"
            ;;
        linux-x64)
            clipboard_native_package="clipboard-linux-x64-gnu"
            clipboard_native_file="clipboard.linux-x64-gnu.node"
            ;;
        linux-arm64)
            clipboard_native_package="clipboard-linux-arm64-gnu"
            clipboard_native_file="clipboard.linux-arm64-gnu.node"
            ;;
        windows-x64)
            clipboard_native_package="clipboard-win32-x64-msvc"
            clipboard_native_file="clipboard.win32-x64-msvc.node"
            ;;
        windows-arm64)
            clipboard_native_package="clipboard-win32-arm64-msvc"
            clipboard_native_file="clipboard.win32-arm64-msvc.node"
            ;;
    esac
    mkdir -p "binaries/$platform/node_modules/@mariozechner"
    cp -r ../../node_modules/@mariozechner/clipboard "binaries/$platform/node_modules/@mariozechner/"
    cp -r ../../node_modules/@mariozechner/$clipboard_native_package "binaries/$platform/node_modules/@mariozechner/"
    cp "../../node_modules/@mariozechner/$clipboard_native_package/$clipboard_native_file" \
        "binaries/$platform/node_modules/@mariozechner/clipboard/"

    # Copy terminal input native helpers next to compiled binaries.
    if [[ "$platform" == darwin-* ]]; then
        mkdir -p "binaries/$platform/native/darwin/prebuilds/$platform"
        cp ../tui/native/darwin/prebuilds/$platform/darwin-modifiers.node "binaries/$platform/native/darwin/prebuilds/$platform/"
    fi
    if [[ "$platform" == windows-* ]]; then
        if [[ "$platform" == "windows-arm64" ]]; then
            win32_arch_dir="win32-arm64"
        else
            win32_arch_dir="win32-x64"
        fi
        mkdir -p "binaries/$platform/native/win32/prebuilds/$win32_arch_dir"
        cp ../tui/native/win32/prebuilds/$win32_arch_dir/win32-console-mode.node "binaries/$platform/native/win32/prebuilds/$win32_arch_dir/"
    fi
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
