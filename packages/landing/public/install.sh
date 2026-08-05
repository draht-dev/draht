#!/usr/bin/env bash
set -euo pipefail

# Draht immutable release installer
#
# Pin a release with DRAHT_VERSION=2026.8.5. If omitted, the current GitHub
# `latest` redirect is resolved once and its immutable v<version> tag is used
# for every asset URL. Release provenance is verified when `gh` is installed.
# Environments without `gh` fail closed unless the operator explicitly accepts
# checksum-only verification with DRAHT_ALLOW_UNVERIFIED=1.

REPO="draht-dev/draht"
INSTALL_DIR="${DRAHT_DIR:-$HOME/.draht/runtime}"
BIN_DIR="${DRAHT_BIN:-$HOME/.local/bin}"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()    { printf "%b\n" "${CYAN}${BOLD}→${RESET} $*"; }
success() { printf "%b\n" "${GREEN}${BOLD}✓${RESET} $*"; }
error()   { printf "%b\n" "${RED}${BOLD}✗${RESET} $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || error "curl is required but not installed."
command -v jq >/dev/null 2>&1 || error "jq is required but not installed."
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || error "sha256sum or shasum is required."

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

VERSION="${DRAHT_VERSION:-}"
if [ -z "$VERSION" ]; then
  info "Resolving the latest immutable release tag..."
  latest_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" || error "Could not resolve the latest release."
  case "$latest_url" in
    "https://github.com/$REPO/releases/tag/v"*) VERSION="${latest_url##*/v}" ;;
    *) error "Latest release resolved to an unexpected URL: $latest_url" ;;
  esac
fi
VERSION="${VERSION#v}"
case "$VERSION" in
  ""|*[!0-9A-Za-z.-]*) error "DRAHT_VERSION contains unsafe characters." ;;
esac
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$' || error "DRAHT_VERSION must be a release version such as 2026.8.5."
TAG="v$VERSION"

info "Resolving immutable commit for $TAG..."
TAG_OBJECT="$(curl -fsSL \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "https://api.github.com/repos/$REPO/git/ref/tags/$TAG")" || error "Could not resolve $TAG through the GitHub API."
object_type="$(printf '%s' "$TAG_OBJECT" | jq -er '.object.type')" || error "GitHub returned malformed tag data for $TAG."
TAG_COMMIT="$(printf '%s' "$TAG_OBJECT" | jq -er '.object.sha')" || error "GitHub returned malformed tag data for $TAG."
for _ in 1 2 3 4 5; do
  [ "$object_type" = tag ] || break
  TAG_OBJECT="$(curl -fsSL \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "https://api.github.com/repos/$REPO/git/tags/$TAG_COMMIT")" || error "Could not resolve annotated tag object $TAG_COMMIT."
  object_type="$(printf '%s' "$TAG_OBJECT" | jq -er '.object.type')" || error "GitHub returned malformed annotated tag data."
  TAG_COMMIT="$(printf '%s' "$TAG_OBJECT" | jq -er '.object.sha')" || error "GitHub returned malformed annotated tag data."
done
[ "$object_type" = commit ] || error "$TAG does not resolve to a Git commit."
printf '%s' "$TAG_COMMIT" | grep -Eq '^[0-9a-f]{40}$' || error "GitHub returned a non-immutable commit digest for $TAG."

os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW*|MSYS*|CYGWIN*) os=windows ;;
  *) error "Unsupported operating system: $os" ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) error "Unsupported architecture: $arch" ;;
esac
PLATFORM="$os-$arch"
case "$PLATFORM" in
  darwin-arm64|darwin-x64|linux-arm64|linux-x64) ARCHIVE="draht-$PLATFORM.tar.gz"; BINARY_NAME=draht ;;
  windows-x64) ARCHIVE="draht-$PLATFORM.zip"; BINARY_NAME=draht.exe ;;
  *) error "No Draht release is published for $PLATFORM." ;;
esac

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/draht-install.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM
MANIFEST="$WORK_DIR/runtime-manifest.json"
CHECKSUMS="$WORK_DIR/DRAHT-SHA256SUMS"
ARCHIVE_PATH="$WORK_DIR/$ARCHIVE"
BASE="https://github.com/$REPO/releases/download/$TAG"

info "Downloading Draht $TAG for $PLATFORM..."
curl -fsSL "$BASE/runtime-manifest.json" -o "$MANIFEST"
curl -fsSL "$BASE/DRAHT-SHA256SUMS" -o "$CHECKSUMS"
curl -fsSL "$BASE/$ARCHIVE" -o "$ARCHIVE_PATH"

if command -v gh >/dev/null 2>&1; then
  info "Verifying GitHub build provenance..."
  verify_provenance() {
    asset="$1"
    label="$2"
    output="$WORK_DIR/$label.attestation.json"
    digest="$(sha256_file "$asset")"
    gh attestation verify "$asset" \
      --repo "$REPO" \
      --source-digest "$TAG_COMMIT" \
      --source-ref "refs/tags/$TAG" \
      --signer-workflow "$REPO/.github/workflows/build-binaries.yml" \
      --format json > "$output" || error "Provenance verification failed for $label."
    jq -e \
      --arg digest "$digest" \
      --arg commit "$TAG_COMMIT" \
      --arg repository "https://github.com/$REPO" \
      --arg source "git+https://github.com/$REPO@refs/tags/$TAG" \
      --arg ref "refs/tags/$TAG" \
      --arg builder "https://github.com/$REPO/.github/workflows/build-binaries.yml@refs/tags/$TAG" '
        type == "array" and any(.[];
          .verificationResult.statement as $s |
          $s._type == "https://in-toto.io/Statement/v1" and
          $s.predicateType == "https://slsa.dev/provenance/v1" and
          $s.predicate.buildDefinition.buildType == "https://actions.github.io/buildtypes/workflow/v1" and
          any($s.subject[]?; .digest.sha256 == $digest) and
          $s.predicate.buildDefinition.externalParameters.workflow.repository == $repository and
          $s.predicate.buildDefinition.externalParameters.workflow.ref == $ref and
          $s.predicate.buildDefinition.externalParameters.workflow.path == ".github/workflows/build-binaries.yml" and
          any($s.predicate.buildDefinition.resolvedDependencies[]?; .uri == $source and .digest.gitCommit == $commit) and
          $s.predicate.runDetails.builder.id == $builder
        )
      ' "$output" >/dev/null || error "Provenance for $label is not structurally bound to $REPO commit $TAG_COMMIT and the release workflow."
  }
  verify_provenance "$MANIFEST" runtime-manifest.json
  verify_provenance "$CHECKSUMS" DRAHT-SHA256SUMS
  verify_provenance "$ARCHIVE_PATH" "$ARCHIVE"
elif [ "${DRAHT_ALLOW_UNVERIFIED:-0}" = "1" ]; then
  info "WARNING: gh is unavailable; DRAHT_ALLOW_UNVERIFIED=1 enables checksum-only verification."
else
  error "GitHub CLI (gh) is required for provenance verification. Install gh, or explicitly opt out with DRAHT_ALLOW_UNVERIFIED=1."
fi

jq -e --arg version "$VERSION" --arg tag "$TAG" --arg commit "$TAG_COMMIT" --arg platform "$PLATFORM" --arg archive "$ARCHIVE" --arg binary "$BINARY_NAME" '
  .schemaVersion == 1 and .name == "draht" and
  .version == $version and .tag == $tag and .gitCommit == $commit and
  ([.artifacts[] | select(.platform == $platform)] | length == 1) and
  ([.artifacts[] | select(.platform == $platform)][0] |
    .archive == $archive and .binary == $binary and
    (.archiveBytes | type == "number" and . > 0 and floor == .) and
    (.archiveSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.binaryBytes | type == "number" and . > 0 and floor == .) and
    (.binarySha256 | type == "string" and test("^[0-9a-f]{64}$")))
' "$MANIFEST" >/dev/null || error "runtime-manifest.json does not bind $TAG, release commit $TAG_COMMIT, $PLATFORM and $ARCHIVE."

manifest_size="$(jq -r --arg platform "$PLATFORM" '.artifacts[] | select(.platform == $platform) | .archiveBytes' "$MANIFEST")"
manifest_hash="$(jq -r --arg platform "$PLATFORM" '.artifacts[] | select(.platform == $platform) | .archiveSha256' "$MANIFEST")"
manifest_binary_size="$(jq -r --arg platform "$PLATFORM" '.artifacts[] | select(.platform == $platform) | .binaryBytes' "$MANIFEST")"
manifest_binary_hash="$(jq -r --arg platform "$PLATFORM" '.artifacts[] | select(.platform == $platform) | .binarySha256' "$MANIFEST")"
checksum_hash="$(awk -v name="$ARCHIVE" '$2 == name { print $1 }' "$CHECKSUMS")"
printf '%s' "$checksum_hash" | grep -Eq '^[0-9a-f]{64}$' || error "DRAHT-SHA256SUMS has no unique valid checksum for $ARCHIVE."
[ "$(awk -v name="$ARCHIVE" '$2 == name { n++ } END { print n+0 }' "$CHECKSUMS")" = 1 ] || error "DRAHT-SHA256SUMS has duplicate entries for $ARCHIVE."
actual_size="$(wc -c < "$ARCHIVE_PATH" | tr -d '[:space:]')"
[ "$actual_size" -gt 0 ] || error "Downloaded archive is empty."
[ "$actual_size" = "$manifest_size" ] || error "Archive size does not match runtime-manifest.json."
actual_hash="$(sha256_file "$ARCHIVE_PATH")"
[ "$actual_hash" = "$manifest_hash" ] || error "Archive SHA-256 does not match runtime-manifest.json."
[ "$actual_hash" = "$checksum_hash" ] || error "Archive SHA-256 does not match DRAHT-SHA256SUMS."

validate_paths() {
  while IFS= read -r entry; do
    entry="${entry%/}"
    [ -n "$entry" ] || continue
    case "$entry" in
      /*|../*|*/../*|*/..|*\\*|[A-Za-z]:*) error "Unsafe archive path: $entry" ;;
    esac
  done
}

EXTRACT_DIR="$WORK_DIR/extracted"
mkdir -p "$EXTRACT_DIR"
if [ "$os" = windows ]; then
  command -v unzip >/dev/null 2>&1 || error "unzip is required for Windows archives."
  unzip -Z1 "$ARCHIVE_PATH" | validate_paths
  unzip -q "$ARCHIVE_PATH" -d "$EXTRACT_DIR"
  PAYLOAD_DIR="$EXTRACT_DIR"
else
  command -v tar >/dev/null 2>&1 || error "tar is required for release archives."
  tar -tzf "$ARCHIVE_PATH" | validate_paths
  # Reject link entries as well as lexical traversal: links can escape after extraction.
  if tar -tvzf "$ARCHIVE_PATH" | grep -Eq '^[^d-]'; then error "Unsafe archive entry type."; fi
  tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"
  PAYLOAD_DIR="$EXTRACT_DIR/draht"
fi
if find "$EXTRACT_DIR" -type l -print -quit | grep -q .; then error "Unsafe archive link entry."; fi
[ -f "$PAYLOAD_DIR/$BINARY_NAME" ] || error "Verified archive does not contain $BINARY_NAME at the expected path."
actual_binary_size="$(wc -c < "$PAYLOAD_DIR/$BINARY_NAME" | tr -d '[:space:]')"
[ "$actual_binary_size" = "$manifest_binary_size" ] || error "Extracted binary size does not match runtime-manifest.json."
actual_binary_hash="$(sha256_file "$PAYLOAD_DIR/$BINARY_NAME")"
[ "$actual_binary_hash" = "$manifest_binary_hash" ] || error "Extracted binary SHA-256 does not match runtime-manifest.json."
chmod +x "$PAYLOAD_DIR/$BINARY_NAME"

mkdir -p "$INSTALL_DIR/releases" "$BIN_DIR"
release_tmp="$INSTALL_DIR/releases/.${VERSION}.$$"
release_dir="$INSTALL_DIR/releases/${VERSION}-$$-$(date +%s)"
rm -rf "$release_tmp"
mkdir -p "$release_tmp"
cp -R "$PAYLOAD_DIR"/. "$release_tmp"/
mv "$release_tmp" "$release_dir"
target="$BIN_DIR/$BINARY_NAME"
target_tmp="$BIN_DIR/.${BINARY_NAME}.$$"
[ ! -e "$target" ] || [ -f "$target" ] || [ -L "$target" ] || error "$target exists and is not a file or symlink."
if [ "$os" = windows ]; then
  cp "$release_dir/$BINARY_NAME" "$target_tmp"
  chmod +x "$target_tmp"
else
  current_tmp="$INSTALL_DIR/.current.$$"
  [ ! -e "$INSTALL_DIR/current" ] || [ -L "$INSTALL_DIR/current" ] || error "$INSTALL_DIR/current exists and is not a symlink."
  ln -s "$release_dir" "$current_tmp"
  mv -f "$current_tmp" "$INSTALL_DIR/current"
  ln -s "$INSTALL_DIR/current/$BINARY_NAME" "$target_tmp"
fi
mv -f "$target_tmp" "$target"

printf '\n'
success "Draht $TAG installed atomically at $target"
printf '  Docs: https://draht.dev\n\n'
