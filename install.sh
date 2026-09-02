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

# ~/.draht is Draht's home directory: this installer, the `@draht/install`
# engine and the plugin marketplaces all write underneath it. The installer
# may only write there when Draht owns the directory, so a pre-existing
# ~/.draht that belongs to something else is refused instead of written into.
#
# Ownership is decided by two layout-independent signals only — the marker
# file written by `claim_draht_home`, and the `.git` directory left by the
# legacy install.sh clone. Nothing here inspects the subdirectories Draht
# creates inside ~/.draht, because that layout changes between releases.
DRAHT_HOME_DIR="$HOME/.draht"
DRAHT_HOME_MARKER="$DRAHT_HOME_DIR/.draht-home"

# True when this run will write inside ~/.draht at all. DRAHT_DIR pointing
# somewhere else means ~/.draht is none of the installer's business.
draht_home_is_install_target() {
  case "$INSTALL_DIR" in
    "$DRAHT_HOME_DIR"|"$DRAHT_HOME_DIR"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Every ~/.draht created before the ownership marker existed has neither the
# marker nor a legacy .git clone, so the two signals above would refuse an
# ordinary upgrade for existing users. Adopt those by recognising entries only
# Draht creates. This deliberately inspects the layout, which the signals above
# avoid on purpose — it is used ONLY to adopt a home Draht already owns, never
# to reject one, so a future layout change can at worst fall back to requiring
# the explicit marker rather than wrongly refusing anybody.
draht_home_has_legacy_layout() {
  for entry in agent claude-marketplace codex-marketplace plans policies bastion.toml; do
    if [ -e "$DRAHT_HOME_DIR/$entry" ]; then
      return 0
    fi
  done
  return 1
}

draht_home_is_owned() {
  [ -e "$DRAHT_HOME_MARKER" ] || [ -e "$DRAHT_HOME_DIR/.git" ] || draht_home_has_legacy_layout
}

# Read-only refusal, run before any download so an unowned ~/.draht costs
# nothing and leaves nothing behind.
check_draht_home() {
  draht_home_is_install_target || return 0
  { [ -e "$DRAHT_HOME_DIR" ] || [ -L "$DRAHT_HOME_DIR" ]; } || return 0
  [ -d "$DRAHT_HOME_DIR" ] || error "$DRAHT_HOME_DIR exists and is not a directory.\n  Move it aside, or set DRAHT_DIR to install Draht somewhere else:\n      DRAHT_DIR=\"\$HOME/.local/share/draht\" curl -fsSL https://draht.dev/install.sh | bash"
  [ -n "$(ls -A "$DRAHT_HOME_DIR" 2>/dev/null || true)" ] || return 0
  draht_home_is_owned && return 0
  error "$DRAHT_HOME_DIR already exists, is not empty, and was not created by Draht.\n  Refusing to install into a directory Draht does not own.\n\n  Move that directory aside:\n      mv \"$DRAHT_HOME_DIR\" \"$DRAHT_HOME_DIR.bak\"\n  or install Draht somewhere else with DRAHT_DIR:\n      DRAHT_DIR=\"\$HOME/.local/share/draht\" curl -fsSL https://draht.dev/install.sh | bash"
}

# Creates ~/.draht and stamps the ownership marker. Called only once the
# release is fully verified, so a failed install never leaves the marker
# behind claiming a directory the installer never populated.
claim_draht_home() {
  draht_home_is_install_target || return 0
  mkdir -p "$DRAHT_HOME_DIR" || error "Could not create $DRAHT_HOME_DIR."
  [ ! -e "$DRAHT_HOME_MARKER" ] || return 0
  printf '%s\n' \
    "This directory is managed by Draht (https://draht.dev)." \
    "Created by install.sh. Delete it only when removing Draht's local state." \
    > "$DRAHT_HOME_MARKER" || error "Could not write $DRAHT_HOME_MARKER."
}

check_draht_home

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

MAX_MANIFEST_BYTES=$((2 * 1024 * 1024))
MAX_CHECKSUM_BYTES=$((2 * 1024 * 1024))
MAX_ARCHIVE_BYTES=$((256 * 1024 * 1024))
MAX_DOWNLOAD_BYTES=$((260 * 1024 * 1024))
downloaded_bytes=0

bounded_download() {
  url="$1"; destination="$2"; limit="$3"; label="$4"
  [ "$limit" -gt 0 ] || error "$label has a non-positive byte limit."
  remaining=$((MAX_DOWNLOAD_BYTES - downloaded_bytes))
  [ "$remaining" -gt 0 ] || error "Draht release downloads exceed the aggregate byte limit."
  [ "$limit" -le "$remaining" ] || limit="$remaining"
  rm -f "$destination"
  curl -fsSL --max-filesize "$limit" "$url" -o "$destination" || error "$label download failed or exceeded its $limit byte limit."
  size="$(wc -c < "$destination" | tr -d '[:space:]')"
  [ "$size" -gt 0 ] || error "$label download is empty."
  [ "$size" -le "$limit" ] || error "$label download exceeds its $limit byte limit."
  downloaded_bytes=$((downloaded_bytes + size))
  [ "$downloaded_bytes" -le "$MAX_DOWNLOAD_BYTES" ] || error "Draht release downloads exceed the aggregate byte limit."
}

info "Downloading Draht $TAG for $PLATFORM..."
bounded_download "$BASE/runtime-manifest.json" "$MANIFEST" "$MAX_MANIFEST_BYTES" "runtime-manifest.json"
bounded_download "$BASE/DRAHT-SHA256SUMS" "$CHECKSUMS" "$MAX_CHECKSUM_BYTES" "DRAHT-SHA256SUMS"

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
    (.binarySha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.files | type == "array" and length > 0 and
      all(.[]; type == "string" and test("^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$") and endswith("/") | not) and
      (length == (unique | length)) and any(.[]; . == (if $platform == "windows-x64" then $binary else "draht/" + $binary end))))
' "$MANIFEST" >/dev/null || error "runtime-manifest.json does not bind $TAG, release commit $TAG_COMMIT, $PLATFORM and $ARCHIVE."

manifest_size="$(jq -r --arg platform "$PLATFORM" '.artifacts[] | select(.platform == $platform) | .archiveBytes' "$MANIFEST")"
manifest_hash="$(jq -r --arg platform "$PLATFORM" '.artifacts[] | select(.platform == $platform) | .archiveSha256' "$MANIFEST")"
manifest_binary_size="$(jq -r --arg platform "$PLATFORM" '.artifacts[] | select(.platform == $platform) | .binaryBytes' "$MANIFEST")"
manifest_binary_hash="$(jq -r --arg platform "$PLATFORM" '.artifacts[] | select(.platform == $platform) | .binarySha256' "$MANIFEST")"
expected_files="$WORK_DIR/expected-files"
jq -r --arg platform "$PLATFORM" '.artifacts[] | select(.platform == $platform) | .files[]' "$MANIFEST" | LC_ALL=C sort > "$expected_files"
[ "$manifest_size" -le "$MAX_ARCHIVE_BYTES" ] || error "runtime-manifest.json archive size exceeds the archive byte limit."
[ $((downloaded_bytes + manifest_size)) -le "$MAX_DOWNLOAD_BYTES" ] || error "Declared Draht release downloads exceed the aggregate byte limit."
bounded_download "$BASE/$ARCHIVE" "$ARCHIVE_PATH" "$manifest_size" "$ARCHIVE"
if command -v gh >/dev/null 2>&1; then
  verify_provenance "$ARCHIVE_PATH" "$ARCHIVE"
fi
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
expanded_limit=$((manifest_binary_size + 2 * 1024 * 1024))
if [ "$os" = windows ]; then
  command -v unzip >/dev/null 2>&1 || error "unzip is required for Windows archives."
  zip_listing="$WORK_DIR/zip-listing"
  unzip -Z -l "$ARCHIVE_PATH" > "$zip_listing" || error "Could not inspect ZIP archive."
  awk '$1 ~ /^[dlcbps-]/ { print $NF }' "$zip_listing" | sed '/\/$/d' | LC_ALL=C sort > "$WORK_DIR/archive-files"
  [ "$(uniq -d "$WORK_DIR/archive-files" | wc -l | tr -d '[:space:]')" = 0 ] || error "ZIP archive contains duplicate members."
  if awk '$1 ~ /^[lcbps]/ { found=1 } END { exit !found }' "$zip_listing"; then error "Unsafe ZIP link or special member type."; fi
  cmp -s "$expected_files" "$WORK_DIR/archive-files" || error "ZIP archive members do not exactly match runtime-manifest.json files."
  unzip -Z1 "$ARCHIVE_PATH" | validate_paths
  total=0
  while IFS= read -r entry; do
    remaining=$((expanded_limit - total))
    [ "$remaining" -ge 0 ] || error "ZIP archive uncompressed data exceeds the expanded byte limit."
    set +o pipefail
    entry_size="$(unzip -p "$ARCHIVE_PATH" "$entry" | head -c $((remaining + 1)) | wc -c | tr -d '[:space:]')"
    set -o pipefail
    [ "$entry_size" -le "$remaining" ] || error "ZIP archive uncompressed data exceeds the expanded byte limit."
    total=$((total + entry_size))
  done < "$expected_files"
  total=0
  while IFS= read -r entry; do
    destination="$EXTRACT_DIR/$entry"
    mkdir -p "$(dirname "$destination")"
    remaining=$((expanded_limit - total))
    set +o pipefail
    unzip -p "$ARCHIVE_PATH" "$entry" | head -c $((remaining + 1)) > "$destination"
    set -o pipefail
    entry_size="$(wc -c < "$destination" | tr -d '[:space:]')"
    [ "$entry_size" -le "$remaining" ] || error "ZIP extraction exceeds the expanded byte limit."
    total=$((total + entry_size))
  done < "$expected_files"
  PAYLOAD_DIR="$EXTRACT_DIR"
else
  command -v tar >/dev/null 2>&1 || error "tar is required for release archives."
  command -v gzip >/dev/null 2>&1 || error "gzip is required for release archives."
  bounded_tar="$WORK_DIR/archive.tar"
  tar_stream_limit=$((expanded_limit + 128 * 1024 + 1))
  set +o pipefail
  gzip -dc "$ARCHIVE_PATH" | head -c "$tar_stream_limit" > "$bounded_tar"
  set -o pipefail
  tar_stream_size="$(wc -c < "$bounded_tar" | tr -d '[:space:]')"
  [ "$tar_stream_size" -lt "$tar_stream_limit" ] || error "Archive decompressed data exceeds the expanded byte limit."
  tar -tf "$bounded_tar" | validate_paths
  tar -tvf "$bounded_tar" > "$WORK_DIR/tar-listing" || error "Could not inspect tar archive."
  tar -tf "$bounded_tar" | sed '/\/$/d' | LC_ALL=C sort > "$WORK_DIR/archive-files"
  [ "$(uniq -d "$WORK_DIR/archive-files" | wc -l | tr -d '[:space:]')" = 0 ] || error "Tar archive contains duplicate members."
  if grep -Eq '^[^d-]' "$WORK_DIR/tar-listing"; then error "Unsafe archive entry type or special member."; fi
  cmp -s "$expected_files" "$WORK_DIR/archive-files" || error "Tar archive members do not exactly match runtime-manifest.json files."
  total=0
  while IFS= read -r entry; do
    entry_size="$(tar -xOf "$bounded_tar" "$entry" | wc -c | tr -d '[:space:]')" || error "Could not inspect tar member $entry."
    total=$((total + entry_size))
    [ "$total" -le "$expanded_limit" ] || error "Tar archive uncompressed data exceeds the expanded byte limit."
  done < "$expected_files"
  tar -xf "$bounded_tar" -C "$EXTRACT_DIR"
  PAYLOAD_DIR="$EXTRACT_DIR/draht"
fi
if find "$EXTRACT_DIR" -type l -print -quit | grep -q .; then error "Unsafe archive link entry."; fi
[ -f "$PAYLOAD_DIR/$BINARY_NAME" ] || error "Verified archive does not contain $BINARY_NAME at the expected path."
actual_binary_size="$(wc -c < "$PAYLOAD_DIR/$BINARY_NAME" | tr -d '[:space:]')"
[ "$actual_binary_size" = "$manifest_binary_size" ] || error "Extracted binary size does not match runtime-manifest.json."
actual_binary_hash="$(sha256_file "$PAYLOAD_DIR/$BINARY_NAME")"
[ "$actual_binary_hash" = "$manifest_binary_hash" ] || error "Extracted binary SHA-256 does not match runtime-manifest.json."
chmod +x "$PAYLOAD_DIR/$BINARY_NAME"

claim_draht_home
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
