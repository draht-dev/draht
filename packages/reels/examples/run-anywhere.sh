#!/usr/bin/env bash
# Minimal generic runner for @draht/reels: cron, other CI, or a local box.
# Builds reels for new commits since the last run and publishes the PWA.
#
# Usage: REELS_REPO=/path/to/repo REELS_OUT=/path/to/site ./run-anywhere.sh
#
# Env vars:
#   REELS_PKG_DIR     path to the reels package checkout (default: script's own dir's parent)
#   REELS_REPO        git repo to narrate (default: current directory)
#   REELS_OUT         output site directory (default: ./reels-site)
#   REELS_NAME        repo display name (default: basename of REELS_REPO)
#   REELS_SINCE       only render commits authored since this DATE, not a ref/sha (git rev-list --since semantics; default: unset = incremental via feed.json)
#   REELS_TTS         "elevenlabs" or "none" (default: elevenlabs if ELEVENLABS_API_KEY is set, else none)
#   ELEVENLABS_API_KEY  required when REELS_TTS=elevenlabs

set -euo pipefail

PKG_DIR="${REELS_PKG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO="${REELS_REPO:-$(pwd)}"
REPO="$(cd "$REPO" && pwd)"
OUT="${REELS_OUT:-./reels-site}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
NAME="${REELS_NAME:-$(basename "$REPO")}"
TTS="${REELS_TTS:-$([ -n "${ELEVENLABS_API_KEY:-}" ] && echo elevenlabs || echo none)}"

# Resolve REPO/OUT to absolute paths above, before cd — otherwise relative
# paths would silently re-resolve against PKG_DIR instead of the caller's cwd.
cd "$PKG_DIR"

if [ ! -d node_modules ]; then
	bun install
fi

if [ ! -d app/dist ]; then
	npm run build:app
fi

ARGS=(build --repo "$REPO" --name "$NAME" --out "$OUT" --tts "$TTS" --mode both)
if [ -n "${REELS_SINCE:-}" ]; then
	ARGS+=(--since "$REELS_SINCE")
fi

# `build` exits non-zero when any reel failed, but it publishes every reel
# that succeeded before exiting. Run `site` regardless so a partial failure
# never discards already-rendered (already-paid-for) reels or the PWA, then
# propagate build's exit code so the caller still sees the failure.
set +e
bun run src/cli.ts "${ARGS[@]}"
build_status=$?
set -e

bun run src/cli.ts site --out "$OUT"

echo "run-anywhere: published to $OUT"
exit "$build_status"
