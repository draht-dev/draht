#!/usr/bin/env python3
"""Claude Code status line, in the draht foundry palette.

Renders:
  dir · model · context% · 5h limit · 7d limit · tokens today/7d/30d

Limit percentages come straight from the status-line payload on stdin
(`rate_limits.five_hour` / `rate_limits.seven_day`). Token burn is aggregated
from the transcript JSONL files under $CLAUDE_CONFIG_DIR/projects, cached
incrementally so each render only reads bytes appended since last time.

The line degrades rather than letting the terminal chop it: when the render
width is known it sheds detail in `SHED` order until it fits. Width comes from
$CLAUDE_STATUSLINE_COLS, else $COLUMNS -- the latter is inherited at launch and
goes stale on a resize, so set the former when panes get re-split often.
"""

import json
import os
import re
import sys
import time
import hashlib
import unicodedata
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Roll cache tokens into the headline burn figure. Off by default so the number
# is comparable to the Models chart in the Claude app, which charts input+output
# only; cache reads outweigh them ~100x and otherwise drown the signal. When off,
# today's cache traffic is still shown as a dim trailing "+N" segment.
COUNT_CACHE = False

# Rolling windows (days) for the burn figures after "today".
WINDOWS = (7, 30)
RETAIN_DAYS = max(WINDOWS) + 5  # how much per-day history the cache keeps

# Bumped whenever the on-disk shape changes; a mismatch forces a full rescan.
CACHE_VERSION = 2

CONFIG_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
PROJECTS_DIR = CONFIG_DIR / "projects"
CACHE_PATH = CONFIG_DIR / "statusline" / "usage-cache.json"
JUDGE_DIR = CONFIG_DIR / "judge"  # judge plugin: cards/ + heartbeat

# --------------------------------------------------------------------------- #
# draht palette
# --------------------------------------------------------------------------- #
# The foundry colours from packages/landing/DESIGN.md, emitted as 24-bit
# truecolor where the terminal advertises it and as the nearest xterm-256 slot
# everywhere else. Roles follow the design doc's terminal component: key terms
# in Solder Copper, values in Workshop Paper, labels and chrome in Foxed Page,
# success in Patina. Copper stays rare on purpose -- it marks the model and an
# unhappy limit, nothing else.
TRUECOLOR = os.environ.get("COLORTERM", "") in ("truecolor", "24bit")


def _sgr(rgb, xterm):
    if TRUECOLOR:
        r, g, b = (int(rgb[i:i + 2], 16) for i in (1, 3, 5))
        return f"\033[38;2;{r};{g};{b}m"
    return f"\033[38;5;{xterm}m"


R = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"

PAPER = _sgr("#efe7d8", 254)      # workshop paper  -- headline values
WEATHERED = _sgr("#c9bfae", 187)  # weathered paper -- secondary text
FOXED = _sgr("#8b8472", 245)      # foxed page      -- labels, metadata
COPPER = _sgr("#e8c828", 220)     # solder copper   -- key terms, warning
OXIDE = _sgr("#b89e1e", 178)      # oxidized copper -- dim accent
PATINA = _sgr("#5fa598", 72)      # patina          -- ok / headroom
RUST = _sgr("#cf4f2e", 167)       # alert: the brand carries no red, and a
                                  # spent limit has to read as alarm
RULE = _sgr("#4a4238", 238)       # rule            -- separators


# --------------------------------------------------------------------------- #
# formatting helpers
# --------------------------------------------------------------------------- #

def heat(pct):
    """Colour a percentage: patina below 50, copper below 80, rust above."""
    if pct >= 80:
        return RUST
    if pct >= 50:
        return COPPER
    return PATINA


def fmt_tokens(n):
    if n >= 1_000_000_000:
        return f"{n / 1_000_000_000:.1f}B"
    if n >= 10_000_000:
        return f"{n / 1_000_000:.0f}M"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}k"
    return str(n)


def fmt_until(epoch):
    """Compact 'time left' string for a reset timestamp."""
    if not epoch:
        return None
    secs = int(epoch - time.time())
    if secs <= 0:
        return "now"
    days, rem = divmod(secs, 86400)
    hours, rem = divmod(rem, 3600)
    if days:
        return f"{days}d"
    if hours:
        return f"{hours}h"
    return f"{rem // 60}m"


def short_dir(path):
    home = str(Path.home())
    if path == home:
        return "~"
    if path.startswith(home + "/"):
        path = "~/" + path[len(home) + 1:]
    parts = path.split("/")
    if len(parts) > 3:
        return ".../" + "/".join(parts[-2:])
    return path


def short_model(name):
    return name.replace(" (1M context)", " 1M").replace("Claude ", "")


# --------------------------------------------------------------------------- #
# transcript aggregation
# --------------------------------------------------------------------------- #

def load_cache():
    try:
        cache = json.loads(CACHE_PATH.read_text())
        if isinstance(cache, dict) and cache.get("version") == CACHE_VERSION:
            return cache
    except Exception:
        pass
    return {"version": CACHE_VERSION, "files": {}, "daily": {}, "seen": {}}


def save_cache(cache):
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(CACHE_PATH.parent), suffix=".tmp")
        with os.fdopen(fd, "w") as fh:
            json.dump(cache, fh, separators=(",", ":"))
        os.replace(tmp, CACHE_PATH)
    except Exception:
        pass


def dedupe_key(rec, msg):
    """Identity of one assistant *turn*, which spans several transcript records.

    Two things make a naive line-by-line sum wrong:

      * Resumed and forked sessions replay earlier messages into a new file.
      * A single assistant message is written out once per content block
        (thinking / text / tool_use), and the earlier records carry a partial
        `output_tokens` — only the last one holds the real total.

    So records are grouped by turn and accounted by high-water mark rather than
    first-seen; see `credit()`.
    """
    ident = msg.get("id") or ""
    req = rec.get("requestId") or ""
    if ident or req:
        raw = f"{ident}|{req}"
    else:
        raw = f"{rec.get('uuid', '')}|{rec.get('timestamp', '')}"
    return hashlib.blake2b(raw.encode(), digest_size=6).hexdigest()


def local_day(ts):
    """'2026-08-10' in local time from an ISO-8601 UTC transcript timestamp."""
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None
    return dt.astimezone().strftime("%Y-%m-%d")


def credit(cache, dk, day, io, cached):
    """Book a turn's usage as a high-water mark.

    Records for one turn arrive incrementally and may straddle a read boundary,
    so this is called repeatedly with a growing `io`. Only the increase over
    what was already booked is added, which makes re-reads and replays free.
    """
    prev = cache["seen"].get(dk)
    if prev is None:
        cache["seen"][dk] = prev = [day, 0, 0]
    day = prev[0]  # always attribute to the day the turn was first seen
    bucket = cache["daily"].setdefault(day, [0, 0])
    for slot, value in ((1, io), (2, cached)):
        if value > prev[slot]:
            bucket[slot - 1] += value - prev[slot]
            prev[slot] = value


def scan(cache):
    if not PROJECTS_DIR.is_dir():
        return
    files = cache["files"]

    for path in PROJECTS_DIR.rglob("*.jsonl"):
        key = str(path)
        try:
            size = path.stat().st_size
        except OSError:
            continue
        state = files.get(key) or {}
        offset = state.get("offset", 0)
        if offset > size:  # truncated or replaced — start over
            offset = 0
        if offset == size:
            continue

        try:
            with path.open("rb") as fh:
                fh.seek(offset)
                chunk = fh.read(size - offset)
        except OSError:
            continue

        # Only consume whole lines; a partial tail is re-read next render.
        cut = chunk.rfind(b"\n")
        if cut == -1:
            files[key] = {"offset": offset}
            continue
        consumed, chunk = offset + cut + 1, chunk[:cut]

        for line in chunk.split(b"\n"):
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get("type") != "assistant":
                continue
            msg = rec.get("message") or {}
            usage = msg.get("usage") or {}
            if not usage:
                continue
            day = local_day(rec.get("timestamp") or "")
            if not day:
                continue
            credit(
                cache,
                dedupe_key(rec, msg),
                day,
                usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
                usage.get("cache_creation_input_tokens", 0)
                + usage.get("cache_read_input_tokens", 0),
            )

        files[key] = {"offset": consumed}

    prune(cache)


def prune(cache):
    cutoff = (datetime.now().astimezone() - timedelta(days=RETAIN_DAYS)).strftime("%Y-%m-%d")
    cache["daily"] = {d: v for d, v in cache["daily"].items() if d >= cutoff}
    cache["seen"] = {k: v for k, v in cache["seen"].items() if v[0] >= cutoff}


def burn(cache):
    """((today, *WINDOWS) headline totals, today's cache traffic)."""
    now = datetime.now().astimezone()
    daily = cache["daily"]

    def total(entry):
        return entry[0] + entry[1] if COUNT_CACHE else entry[0]

    today = daily.get(now.strftime("%Y-%m-%d"), [0, 0])
    out = [total(today)]
    for days in WINDOWS:
        start = (now - timedelta(days=days - 1)).strftime("%Y-%m-%d")
        out.append(sum(total(v) for d, v in daily.items() if d >= start))
    return out, today[1]


# --------------------------------------------------------------------------- #
# render
# --------------------------------------------------------------------------- #

ANSI = re.compile(r"\033\[[0-9;]*m")

# Emoji-presentation glyphs we emit. unicodedata calls these "ambiguous", but
# terminals draw them two cells wide, so the fit check must too.
WIDE = "\u2696\u23f3\u26a1"  # scales, hourglass, bolt


def visible_len(line):
    return sum(
        2 if ch in WIDE or unicodedata.east_asian_width(ch) in "WF" else 1
        for ch in ANSI.sub("", line)
    )


def term_width():
    """Best-effort render width, or None when nothing is knowable.

    The status line is spawned with pipes on stdin/stdout and no controlling
    tty, so an ioctl gets us nothing — the environment is the only signal.
    COLUMNS is inherited from the launching shell and goes stale as soon as the
    pane is resized or re-split, so CLAUDE_STATUSLINE_COLS overrides it.
    """
    for name in ("CLAUDE_STATUSLINE_COLS", "COLUMNS"):
        try:
            width = int(os.environ[name])
        except (KeyError, ValueError):
            continue
        if width > 20:
            return width
    return None


def limit_segment(label, info, resets=True):
    if not isinstance(info, dict):
        return None
    pct = info.get("used_percentage")
    if pct is None:
        return None
    seg = f"{FOXED}{label}{R} {heat(pct)}{pct:.0f}%{R}"
    left = fmt_until(info.get("resets_at")) if resets else None
    if left:
        seg += f"{FOXED}{DIM}·{left}{R}"
    return seg


def judge_segment():
    """'⚖ N' open judge cards; rust when a permission card is blocking a
    session, foxed when the judge TUI is not running. Hidden when empty."""
    cards_dir = JUDGE_DIR / "cards"
    if not cards_dir.is_dir():
        return None
    open_n = blocking = 0
    for path in cards_dir.glob("*.json"):
        try:
            card = json.loads(path.read_text())
        except Exception:
            continue
        if card.get("status") != "open":
            continue
        open_n += 1
        if card.get("kind") == "permission":
            blocking += 1
    if not open_n:
        return None
    try:
        alive = time.time() - (JUDGE_DIR / "heartbeat").stat().st_mtime < 5
    except OSError:
        alive = False
    colour = RUST if blocking else (COPPER if alive else FOXED)
    seg = f"{colour}⚖ {open_n}{R}"
    if blocking:
        seg += f"{RUST}{DIM}·{blocking}⏳{R}"
    return seg


# Detail is shed in this order when the line will not fit, least informative
# first. The dir·model·ctx·limits·today spine always survives; the tail that
# used to get silently chopped mid-token-segment is now dropped deliberately.
SHED = ("cache", "cost", "month", "resets", "week", "dir")


def compose(data, burned, cached, judge, drop=()):
    parts = []

    cwd = (data.get("workspace") or {}).get("current_dir") or data.get("cwd") or ""
    if cwd:
        name = short_dir(cwd)
        if "dir" in drop:
            name = name.rsplit("/", 1)[-1]
        parts.append(f"{WEATHERED}{name}{R}")

    model = (data.get("model") or {}).get("display_name")
    if model:
        tag = f"{COPPER}{short_model(model)}{R}"
        if data.get("fast_mode"):
            tag += f"{OXIDE}⚡{R}"
        parts.append(tag)

    ctx = data.get("context_window") or {}
    if ctx.get("used_percentage") is not None:
        pct = ctx["used_percentage"]
        parts.append(f"{FOXED}ctx{R} {heat(pct)}{pct:.0f}%{R}")

    limits = data.get("rate_limits") or {}
    for label, key in (("5h", "five_hour"), ("7d", "seven_day")):
        seg = limit_segment(label, limits.get(key), resets="resets" not in drop)
        if seg:
            parts.append(seg)

    today, week, month = burned
    seg = f"{FOXED}tok{R} {PAPER}{BOLD}{fmt_tokens(today)}{R}"
    if "week" not in drop:
        seg += f"{RULE}/{R}{WEATHERED}{fmt_tokens(week)}{R}"
    if "month" not in drop:
        seg += f"{RULE}/{R}{WEATHERED}{fmt_tokens(month)}{R}"
    if cached and "cache" not in drop:
        seg += f" {FOXED}{DIM}+{fmt_tokens(cached)}{R}"
    parts.append(seg)

    if judge:
        parts.append(judge)

    cost = (data.get("cost") or {}).get("total_cost_usd")
    if cost and "cost" not in drop:
        parts.append(f"{FOXED}${cost:.2f}{R}")

    return f" {RULE}│{R} ".join(parts)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}

    cache = load_cache()
    try:
        scan(cache)
        save_cache(cache)
    except Exception:
        pass
    burned, cached = burn(cache)
    if COUNT_CACHE:
        cached = 0

    judge = judge_segment()
    line = compose(data, burned, cached, judge)

    width = term_width()
    if width:
        drop = []
        for item in SHED:
            if visible_len(line) <= width:
                break
            drop.append(item)
            line = compose(data, burned, cached, judge, tuple(drop))

    sys.stdout.write(line)


if __name__ == "__main__":
    main()
