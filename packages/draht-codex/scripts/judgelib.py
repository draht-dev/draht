"""Shared state for the judge queue: the cards, per-session inboxes,
TUI heartbeat, and transcript summarisation.

Layout under $CLAUDE_CONFIG_DIR/judge:

  cards/<id>.json        one open or decided decision card
  inbox/<session>/<id>.json   feedback waiting to be delivered to a session
  heartbeat              touched by the TUI every second while it runs

Cards:
  kind      "permission" | "review"
  status    "open" | "decided" | "expired"
  verdict   "approve" | "reject"   (once decided)
  comment   free text from the human (optional)
"""

import json
import os
import time
import uuid
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
ROOT = CONFIG_DIR / "judge"
CARDS = ROOT / "cards"
INBOX = ROOT / "inbox"
HEARTBEAT = ROOT / "heartbeat"

HEARTBEAT_STALE = 5.0        # seconds without a heartbeat → TUI considered gone
REVIEW_TTL = 24 * 3600       # review cards older than this are dropped
DECIDED_TTL = 3 * 24 * 3600  # decided cards kept this long for history


def ensure_dirs():
    for d in (CARDS, INBOX):
        d.mkdir(parents=True, exist_ok=True)


def _write_json(path, data):
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=1))
    os.replace(tmp, path)


def _read_json(path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# heartbeat
# --------------------------------------------------------------------------- #

def beat():
    ensure_dirs()
    HEARTBEAT.write_text(str(os.getpid()))


def tui_alive():
    try:
        return time.time() - HEARTBEAT.stat().st_mtime < HEARTBEAT_STALE
    except OSError:
        return False


# --------------------------------------------------------------------------- #
# cards
# --------------------------------------------------------------------------- #

def new_card(kind, session_id, cwd, title, body, **meta):
    ensure_dirs()
    card = {
        "id": uuid.uuid4().hex[:12],
        "kind": kind,
        "status": "open",
        "session_id": session_id,
        "cwd": cwd,
        "title": title,
        "body": body,
        "created": time.time(),
        "meta": meta,
    }
    _write_json(CARDS / f"{card['id']}.json", card)
    return card


def load_card(card_id):
    return _read_json(CARDS / f"{card_id}.json")


def save_card(card):
    _write_json(CARDS / f"{card['id']}.json", card)


def all_cards():
    ensure_dirs()
    cards = []
    for p in CARDS.glob("*.json"):
        c = _read_json(p)
        if c:
            cards.append(c)
    return cards


def open_cards():
    """Open cards, permissions first (they block a session), then newest reviews."""
    cards = [c for c in all_cards() if c["status"] == "open"]
    cards.sort(key=lambda c: (0 if c["kind"] == "permission" else 1,
                              c["created"] if c["kind"] == "permission" else -c["created"]))
    return cards


def decide(card, verdict, comment=""):
    card["status"] = "decided"
    card["verdict"] = verdict
    card["comment"] = comment.strip()
    card["decided_at"] = time.time()
    save_card(card)
    # Review feedback travels to the session's inbox; permission verdicts are
    # picked up directly by the waiting hook.
    if card["kind"] == "review" and (verdict == "reject" or card["comment"]):
        post_inbox(card["session_id"], {
            "card_id": card["id"],
            "verdict": verdict,
            "comment": card["comment"],
            "title": card["title"],
            "ts": card["decided_at"],
        })


def undo(card):
    """Reopen a decided card. Returns (ok, note).

    Review: pull the inbox item back if it is still waiting; if the session
    already consumed it, post a retraction so the session disregards it.
    Permission: the waiting hook already returned — cannot be taken back.
    """
    if card["status"] != "decided":
        return False, "nothing to undo"
    if card["kind"] == "permission":
        return False, "permission already answered to the session — cannot undo"
    note = "reopened"
    p = INBOX / card["session_id"] / f"{card['id']}.json"
    if card.get("verdict") == "reject" or card.get("comment"):
        if p.exists():
            p.unlink()
            note = "reopened · feedback pulled back before delivery"
        else:
            post_inbox(card["session_id"], {
                "card_id": card["id"] + "-retract",
                "verdict": "retract",
                "comment": card.get("comment", ""),
                "title": card["title"],
                "ts": time.time(),
            })
            note = "reopened · feedback was already delivered — retraction sent"
    for k in ("verdict", "comment", "decided_at"):
        card.pop(k, None)
    card["status"] = "open"
    save_card(card)
    return True, note


def expire(card):
    card["status"] = "expired"
    save_card(card)


def supersede_open_reviews(session_id):
    """A session's newer turn replaces any still-open review card for it."""
    for c in all_cards():
        if c["status"] == "open" and c["kind"] == "review" and c["session_id"] == session_id:
            expire(c)


def gc():
    now = time.time()
    for c in all_cards():
        age = now - c["created"]
        if c["status"] == "open" and c["kind"] == "review" and age > REVIEW_TTL:
            expire(c)
        elif c["status"] != "open" and age > DECIDED_TTL:
            try:
                (CARDS / f"{c['id']}.json").unlink()
            except OSError:
                pass


# --------------------------------------------------------------------------- #
# inbox
# --------------------------------------------------------------------------- #

def post_inbox(session_id, item):
    d = INBOX / session_id
    d.mkdir(parents=True, exist_ok=True)
    _write_json(d / f"{item['card_id']}.json", item)


def pending_inbox(session_id):
    d = INBOX / session_id
    if not d.is_dir():
        return []
    items = [i for i in (_read_json(p) for p in sorted(d.glob("*.json"))) if i]
    items.sort(key=lambda i: i.get("ts", 0))
    return items


def drain_inbox(session_id):
    """Return pending feedback and remove it (it is about to be delivered)."""
    items = pending_inbox(session_id)
    for i in items:
        try:
            (INBOX / session_id / f"{i['card_id']}.json").unlink()
        except OSError:
            pass
    return items


def format_feedback(items):
    lines = ["[judge] Human review feedback on your recent work (from the judge TUI):"]
    for i in items:
        if i["verdict"] == "retract":
            lines.append(f"- RETRACTED — the reviewer withdrew their earlier feedback on "
                         f"\"{i.get('title', '')}\"; disregard it (it was a mistake), undo nothing.")
            continue
        mark = "REJECTED" if i["verdict"] == "reject" else "approved, with a note"
        lines.append(f"- {mark} — re: \"{i.get('title', '')}\"")
        if i.get("comment"):
            lines.append(f"  comment: {i['comment']}")
        elif i["verdict"] == "reject":
            lines.append("  (no comment given — the reviewer was not happy with this turn; "
                         "re-examine it critically and ask what is off if unclear)")
    lines.append("Address this feedback before continuing with anything else.")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# transcript summarisation
# --------------------------------------------------------------------------- #

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}


def _text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for block in content or []:
        if isinstance(block, dict) and block.get("type") == "text":
            out.append(block.get("text", ""))
    return "\n".join(out)


def _is_human(rec):
    if rec.get("type") != "user" or rec.get("isMeta"):
        return False
    content = (rec.get("message") or {}).get("content")
    text = _text_of(content).lstrip()
    if not text:
        return False
    # harness-injected "user" turns are not the human typing
    return not text.startswith(("<task-notification", "<system-reminder", "<local-command",
                                "<command-name", "<bash-input", "<bash-stdout"))


def tail_records(path, max_bytes=2_000_000):
    """Parse the last `max_bytes` of a transcript into records."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > max_bytes:
                fh.seek(size - max_bytes)
                fh.readline()  # drop partial line
            raw = fh.read()
    except OSError:
        return []
    recs = []
    for line in raw.splitlines():
        try:
            recs.append(json.loads(line))
        except Exception:
            continue
    return recs


def summarise_turn(transcript_path):
    """What happened since the last human message.

    Returns dict(prompt, reply, files, bash, tools, slug, branch, model).
    """
    recs = tail_records(transcript_path)
    slug = branch = model = ""
    for r in reversed(recs):
        slug = slug or r.get("slug", "")
        branch = branch or r.get("gitBranch", "")
        if not model and r.get("type") == "assistant":
            m = (r.get("message") or {}).get("model", "")
            if m and not m.startswith("<"):
                model = m
        if slug and branch and model:
            break

    start = 0
    for i in range(len(recs) - 1, -1, -1):
        if _is_human(recs[i]):
            start = i
            break

    prompt = _text_of((recs[start].get("message") or {}).get("content")) if recs and _is_human(recs[start]) else ""
    reply = ""
    files, bash, tools = [], [], {}
    for r in recs[start:]:
        if r.get("type") != "assistant" or r.get("isApiErrorMessage"):
            continue
        for block in (r.get("message") or {}).get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and block.get("text", "").strip():
                reply = block["text"]
            elif block.get("type") == "tool_use":
                name = block.get("name", "?")
                tools[name] = tools.get(name, 0) + 1
                inp = block.get("input") or {}
                if name in EDIT_TOOLS and inp.get("file_path"):
                    if inp["file_path"] not in files:
                        files.append(inp["file_path"])
                elif name == "Bash" and inp.get("command"):
                    bash.append(inp["command"].strip().splitlines()[0][:120])
    return {
        "prompt": prompt.strip(),
        "reply": reply.strip(),
        "files": files,
        "bash": bash[-8:],
        "tools": tools,
        "slug": slug,
        "branch": branch,
        "model": model,
    }


# Turns below this bar are not worth a human's attention.
MIN_REPLY_CHARS = 700
MIN_TOOL_CALLS = 4
SLASH_MARK = "<command-message>"


def is_substantive(info, reply):
    """Did this turn do anything a reviewer should look at?"""
    if info["prompt"].startswith(SLASH_MARK) and not info["files"]:
        return False  # slash-command bookkeeping turn
    if info["files"]:
        return True
    if sum(info["tools"].values()) >= MIN_TOOL_CALLS:
        return True
    return len(reply) >= MIN_REPLY_CHARS


def pretty_prompt(prompt):
    """'<command-message>judge:judge</command-message>…' → '/judge:judge'."""
    if prompt.startswith(SLASH_MARK):
        end = prompt.find("</command-message>")
        if end > 0:
            return "/" + prompt[len(SLASH_MARK):end].strip()
    return prompt


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
