#!/usr/bin/env python3
"""Hook entrypoint for the judge queue.

    python3 judge-hook.py PermissionRequest|Stop|UserPromptSubmit  (payload on stdin)

PermissionRequest  → while the judge TUI is running, park the request as a
                     card and wait for the swipe; otherwise fall through to
                     the normal permission dialog.
Stop               → deliver pending human feedback for this session (blocks
                     the stop so the session acts on it), else file a review
                     card summarising the turn that just finished.
UserPromptSubmit   → deliver pending human feedback as additional context.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import judgelib as J  # noqa: E402

POLL = 0.3


def out(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def describe_tool(name, inp):
    """Human-readable one-liner + detail for a permission card."""
    inp = inp or {}
    if name == "Bash":
        return inp.get("description") or "run shell command", inp.get("command", "")
    if name in J.EDIT_TOOLS:
        detail = ""
        if name == "Write":
            detail = (inp.get("content") or "")[:1500]
        elif name == "Edit":
            detail = f"--- old\n{inp.get('old_string', '')[:700]}\n+++ new\n{inp.get('new_string', '')[:700]}"
        return f"{name} {J.short_dir(inp.get('file_path', ''))}", detail
    if name in ("Read", "Glob", "Grep"):
        return f"{name} {inp.get('file_path') or inp.get('pattern') or ''}", json.dumps(inp, indent=1)[:800]
    if name in ("WebFetch", "WebSearch"):
        return f"{name} {inp.get('url') or inp.get('query') or ''}", json.dumps(inp, indent=1)[:800]
    return name, json.dumps(inp, indent=1)[:1500]


def permission_request(p):
    if not J.tui_alive():
        return  # judge not open → regular dialog
    name = p.get("tool_name", "?")
    headline, detail = describe_tool(name, p.get("tool_input"))
    info = J.summarise_turn(p.get("transcript_path", ""))
    card = J.new_card(
        "permission", p.get("session_id", ""), p.get("cwd", ""),
        f"{name}: {headline}"[:140],
        detail,
        tool_name=name,
        tool_input=p.get("tool_input"),
        prompt=J.pretty_prompt(info["prompt"])[:600],
        slug=info["slug"], branch=info["branch"], model=info["model"],
    )
    # Wait for the swipe. Give up (→ normal dialog) if the TUI disappears.
    while True:
        time.sleep(POLL)
        cur = J.load_card(card["id"])
        if cur is None:
            return
        if cur["status"] == "decided":
            break
        if cur["status"] == "expired":
            return
        if not J.tui_alive():
            J.expire(cur)
            return
    if cur["verdict"] == "approve":
        decision = {"behavior": "allow"}
    else:
        msg = cur.get("comment") or "Denied by the human reviewer in judge."
        decision = {"behavior": "deny", "message": f"[judge] {msg}"}
    out({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}})


def stop(p):
    sid = p.get("session_id", "")
    J.gc()
    items = J.drain_inbox(sid)
    if items:
        out({"decision": "block", "reason": J.format_feedback(items)})
        return
    info = J.summarise_turn(p.get("transcript_path", ""))
    reply = p.get("last_assistant_message") or info["reply"]
    if not J.is_substantive(info, reply):
        return
    J.supersede_open_reviews(sid)
    first_line = next((ln.strip("# ").strip() for ln in reply.splitlines() if ln.strip()), "") or "(no text reply)"
    J.new_card(
        "review", sid, p.get("cwd", ""),
        first_line[:140],
        reply[:6000],
        prompt=J.pretty_prompt(info["prompt"])[:800],
        files=info["files"],
        bash=info["bash"],
        tools=info["tools"],
        slug=info["slug"], branch=info["branch"], model=info["model"],
    )


def user_prompt_submit(p):
    items = J.drain_inbox(p.get("session_id", ""))
    if items:
        out({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                    "additionalContext": J.format_feedback(items)}})


def main():
    event = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    try:
        {"PermissionRequest": permission_request,
         "Stop": stop,
         "UserPromptSubmit": user_prompt_submit}.get(event, lambda _: None)(payload)
    except Exception as exc:  # never break a session because of the judge
        sys.stderr.write(f"judge hook error: {exc}\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
