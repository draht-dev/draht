#!/usr/bin/env bash
# Minimal generic runner for @draht/reels: cron, other CI, or a local box.
# Drafts narrated story reels for recent releases/commits. Drafts are never
# published automatically — LLM-written reels are drafts until a human
# reviews and approves them (see README.md "Owner decision: publish gate").
# This script only drafts; it prints the review/approve commands to run next.
#
# Usage: REELS_REPO=/path/to/repo REELS_MODEL=anthropic/claude-sonnet-5 ./run-anywhere.sh
#
# Env vars:
#   REELS_PKG_DIR       path to the reels package checkout (default: script's own dir's parent)
#   REELS_REPO          git repo to narrate (default: current directory)
#   REELS_OUT           public site directory; drafts never land here (default: ./reels-site)
#   REELS_DRAFTS_DIR    drafts directory, outside REELS_OUT (default: ./reels-drafts)
#   REELS_NAME          repo display name (default: basename of REELS_REPO)
#   REELS_CONFIG        path to .reels.json (default: unset = <repo>/.reels.json, else built-in defaults)
#   REELS_MODEL         --model for the story writer (default: anthropic/claude-sonnet-5)
#   REELS_MAX_COST_USD    --max-cost-usd cap for this run (default: 5)
#   REELS_MAX_LLM_TOKENS  --max-llm-tokens cap for this run (default: 2000000)
#   REELS_MAX_TTS_CHARS   --max-tts-chars cap for this run (default: 50000)
#   REELS_SINCE         only draft commits authored since this DATE, not a ref/sha (git rev-list --since semantics; default: unset = incremental)
#   REELS_TTS           "elevenlabs" or "none" (default: elevenlabs if ELEVENLABS_API_KEY is set, else none)
#   ELEVENLABS_API_KEY  required when REELS_TTS=elevenlabs
#   ANTHROPIC_API_KEY   required for the default anthropic/claude-sonnet-5 model (or the matching key for REELS_MODEL's provider)

set -euo pipefail

PKG_DIR="${REELS_PKG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO="${REELS_REPO:-$(pwd)}"
REPO="$(cd "$REPO" && pwd)"
OUT="${REELS_OUT:-./reels-site}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
DRAFTS_DIR="${REELS_DRAFTS_DIR:-./reels-drafts}"
mkdir -p "$DRAFTS_DIR"
DRAFTS_DIR="$(cd "$DRAFTS_DIR" && pwd)"
NAME="${REELS_NAME:-$(basename "$REPO")}"
MODEL="${REELS_MODEL:-anthropic/claude-sonnet-5}"
MAX_COST_USD="${REELS_MAX_COST_USD:-5}"
MAX_LLM_TOKENS="${REELS_MAX_LLM_TOKENS:-2000000}"
MAX_TTS_CHARS="${REELS_MAX_TTS_CHARS:-50000}"
TTS="${REELS_TTS:-$([ -n "${ELEVENLABS_API_KEY:-}" ] && echo elevenlabs || echo none)}"

# Resolve REPO/OUT/DRAFTS_DIR to absolute paths above, before cd — otherwise
# relative paths would silently re-resolve against PKG_DIR instead of the
# caller's cwd.
cd "$PKG_DIR"

if [ ! -d node_modules ]; then
	bun install
fi

if [ ! -d app/dist ]; then
	npm run build:app
fi

ARGS=(
	build
	--repo "$REPO"
	--name "$NAME"
	--out "$OUT"
	--drafts-dir "$DRAFTS_DIR"
	--unit story
	--model "$MODEL"
	--max-cost-usd "$MAX_COST_USD"
	--max-llm-tokens "$MAX_LLM_TOKENS"
	--max-tts-chars "$MAX_TTS_CHARS"
	--tts "$TTS"
	--mode both
)
if [ -n "${REELS_SINCE:-}" ]; then
	ARGS+=(--since "$REELS_SINCE")
fi
if [ -n "${REELS_CONFIG:-}" ]; then
	ARGS+=(--config "$REELS_CONFIG")
fi

# `build --unit story` exits non-zero when any story failed to draft, but it
# keeps every story that did draft successfully (and was already paid for
# via ElevenLabs/the LLM). Print the review/approve instructions regardless,
# then propagate the real exit code so the caller still sees the failure.
set +e
bun run src/cli.ts "${ARGS[@]}"
build_status=$?
set -e

CLI="$PKG_DIR/src/cli.ts"
echo
echo "run-anywhere: drafted stories under $DRAFTS_DIR/$NAME (nothing published yet)"
echo "run-anywhere: review a draft:   bun run \"$CLI\" review --repo \"$REPO\" --name \"$NAME\" --drafts-dir \"$DRAFTS_DIR\" <id>"
echo "run-anywhere: approve a draft:  bun run \"$CLI\" approve --repo \"$REPO\" --name \"$NAME\" --out \"$OUT\" --drafts-dir \"$DRAFTS_DIR\" <id>"
echo "run-anywhere: after approving, publish the PWA shell once: bun run \"$CLI\" site --out \"$OUT\""
exit "$build_status"
