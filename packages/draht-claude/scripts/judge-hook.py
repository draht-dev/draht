#!/usr/bin/env python3
"""Hook entrypoint for the judge queue.

    python3 judge-hook.py <event>   (payload on stdin)

PostToolUse        → remember every test file this session edits. Cheap, silent,
                     and the only way to know a gate was written.
PreToolUse         → the red gate: the session has written tests and is now
                     reaching for the implementation. Replay the test against
                     the code as it stands, card the result, and hold the edit
                     until the human swipes. A test that passes without the
                     implementation is denied without asking anyone.
Stop               → deliver pending human feedback (blocks the stop so the
                     session acts on it); run the mutation pass on gates whose
                     implementation has since landed; card any test written
                     without a following implementation edit; otherwise file a
                     review card for the turn.
UserPromptSubmit   → deliver pending human feedback as additional context.
PermissionRequest  → while the judge TUI is running, park the request as a card
                     and wait for the swipe; otherwise fall through to the
                     normal permission dialog.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import judgegates as G  # noqa: E402
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


# --------------------------------------------------------------------------- #
# gates
# --------------------------------------------------------------------------- #

RED_HEADLINE = {
    "real-red": "fails on an assertion — a real red",
    "weak-red": "fails on an import or compile error, not on behaviour",
    "not-a-gate": "PASSES without the implementation — this is not a gate",
    "already-green": "passes against committed code — it checks behaviour that already exists",
    "timeout": "the run timed out",
    "unrunnable": "no runnable test command for this repo",
}

GREEN_HEADLINE = {
    "bites": "every mutation was caught",
    "partial": "some mutations survived",
    "rubber-stamp": "every mutation survived — the test does not bite",
    "unverified": "could not be scored",
}


def wait_for_swipe(card):
    """Block until the human decides, the card expires, or the TUI disappears.

    Returns the decided card, or None when nobody is going to answer — in which
    case the caller must fall through and let the session proceed.
    """
    while True:
        time.sleep(POLL)
        current = J.load_card(card["id"])
        if current is None:
            return None
        if current["status"] == "decided":
            return current
        if current["status"] == "expired":
            return None
        if not J.tui_alive():
            J.expire(current)
            return None


def gate_title(stage, claims, files, conclusion):
    claim = claims[0] if claims else J.short_dir(files[0]) if files else "test change"
    verdict = (RED_HEADLINE if stage == "red" else GREEN_HEADLINE).get(conclusion, conclusion)
    return f"{claim} — {verdict}"[:140]


def file_gate_card(p, repo, stage, test_files, source_files, verify, extra=None):
    info = J.summarise_turn(p.get("transcript_path", ""))
    claims = G.added_test_names(repo, test_files)
    body = G.added_lines_text(repo, test_files)
    meta = {
        "stage": stage,
        "files": test_files,
        "sources": source_files,
        "claims": claims,
        "smells": G.smells(body),
        "verify": verify,
        "prompt": J.pretty_prompt(info["prompt"])[:600],
        "slug": info["slug"], "branch": info["branch"], "model": info["model"],
    }
    meta.update(extra or {})
    return J.new_card("gate", p.get("session_id", ""), p.get("cwd", ""),
                      gate_title(stage, claims, test_files, verify.get("conclusion", "")),
                      body, **meta)


def deny(reason):
    out({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                "permissionDecision": "deny",
                                "permissionDecisionReason": reason}})


def gate_feedback(card, stage, verify):
    """What the session is told when a gate is rejected."""
    lines = [f"[judge] The human reviewed the gate you just wrote and rejected it ({stage} stage)."]
    conclusion = verify.get("conclusion", "")
    if stage == "red":
        lines.append(f"- mechanical result: {RED_HEADLINE.get(conclusion, conclusion)}")
    else:
        lines.append(f"- mutation result: {verify.get('killed', 0)}/{verify.get('scored', 0)} caught"
                     f" — {GREEN_HEADLINE.get(conclusion, conclusion)}")
        for mutant in verify.get("mutants", []):
            if not mutant.get("killed") and not mutant.get("invalid"):
                lines.append(f"  survived: {mutant['file']}:{mutant['line']} {mutant['op']} — "
                             f"the suite still passed with `{mutant['after']}`")
    for smell in card["meta"].get("smells", []):
        lines.append(f"- smell: {smell['code']} — {smell['note']}")
    if card.get("comment"):
        lines.append(f"- the human's comment: {card['comment']}")
    else:
        lines.append("- no comment given: work out from the evidence above why this gate is too weak,"
                     " and say what you think was wrong before changing it")
    lines.append("Strengthen the test — assert the behaviour that would actually break, not that the code"
                 " was called — and do not write the implementation until the gate would catch a wrong one.")
    return "\n".join(lines)


def pre_tool_use(p):
    """The red gate. Runs only when tests are pending and the TUI is up."""
    if p.get("tool_name") not in J.EDIT_TOOLS:
        return
    path = (p.get("tool_input") or {}).get("file_path") or ""
    if not path or not G.is_gateable_source(path):
        return
    sid = p.get("session_id", "")
    if not G.load_session(sid)["pending"]:
        return
    if not J.tui_alive():
        return  # judge not open → never gate anything

    cwd = p.get("cwd", "")
    repo = G.repo_root(cwd)
    cfg = G.config(repo)
    if not cfg["enabled"] or not repo:
        return

    pending = G.take_pending(sid)
    tests = [rel for rel in (G.rel_in_repo(repo, f) for f in pending if os.path.exists(f)) if rel]
    if not tests:
        return
    sources = [f for f in G.changed_files(repo) if G.is_gateable_source(f)]

    # The card appears before the replay finishes so the human can start reading
    # the test while the machine works out whether it fails for a good reason.
    card = file_gate_card(p, repo, "red", tests, sources,
                          {"stage": "red", "status": "running"},
                          {"next_edit": G.rel_in_repo(repo, path) or path})
    verify = G.verify_red(repo, cfg, tests, sources)
    if verify.get("conclusion") == "passes":
        # An implementation is one edit away. A test that already passes cannot
        # fail when that implementation is wrong, whatever it turns out to be.
        verify["conclusion"] = "not-a-gate"
    card = J.load_card(card["id"]) or card
    card["meta"]["verify"] = verify
    card["title"] = gate_title("red", card["meta"]["claims"], tests, verify.get("conclusion", ""))
    J.save_card(card)

    # A test that passes with the implementation reverted is not a gate. That is
    # a fact, not a judgement call, so it does not wait for a human.
    if verify.get("conclusion") == "not-a-gate":
        card["meta"]["auto"] = True
        J.decide(card, "reject", "auto: the test passes with the implementation reverted")
        G.append_ledger(J.load_card(card["id"]) or card)
        deny(gate_feedback(J.load_card(card["id"]) or card, "red", verify))
        return

    decided = wait_for_swipe(card)
    if decided is None:
        return  # nobody answered → do not hold the session up
    G.append_ledger(decided)
    if decided.get("verdict") == "reject":
        deny(gate_feedback(decided, "red", verify))
        return
    G.remember_gate(sid, decided["id"], tests, "red")


def green_pass(p, sid, repo, cfg):
    """Mutate the implementation behind an approved gate. Returns a block reason."""
    awaiting = G.awaiting_green(sid)
    if not awaiting:
        return None
    sources = [f for f in G.changed_files(repo) if G.is_gateable_source(f)]
    if not sources:
        return None  # implementation not written yet — try again next turn

    card_id, gate = sorted(awaiting.items(), key=lambda kv: kv[1]["ts"])[0]
    tests = [f for f in gate["files"] if os.path.exists(os.path.join(repo, f))]
    if not tests:
        G.mark_green_done(sid, card_id)
        return None

    verify = G.verify_green(repo, cfg, tests, sources)
    if verify.get("baseline") != "pass":
        return None  # still red — the implementation is not finished
    G.mark_green_done(sid, card_id)
    if verify.get("conclusion") in ("bites", "unverified"):
        return None  # nothing for a human to look at

    card = file_gate_card(p, repo, "green", tests, sources, verify, {"parent": card_id})
    decided = wait_for_swipe(card)
    if decided is None:
        return None
    G.append_ledger(decided)
    if decided.get("verdict") == "reject":
        return gate_feedback(decided, "green", verify)
    return None


def unfollowed_tests(p, sid, repo, cfg):
    """Tests written with no implementation edit after them — card them at Stop."""
    pending = G.load_session(sid)["pending"]
    if not pending:
        return None
    taken = G.take_pending(sid)
    tests = [rel for rel in (G.rel_in_repo(repo, f) for f in taken if os.path.exists(f)) if rel]
    if not tests:
        return None
    sources = [f for f in G.changed_files(repo) if G.is_gateable_source(f)]
    verify = G.verify_red(repo, cfg, tests, sources)
    if verify.get("conclusion") == "passes":
        # No implementation is coming, so this test pins behaviour that already
        # works. Expected, and not something to hold a session over.
        verify["conclusion"] = "already-green"
    card = file_gate_card(p, repo, "red", tests, sources, verify, {"trigger": "stop"})
    if verify.get("conclusion") == "already-green":
        # Nothing was taken away, so the replay proves nothing and there is no
        # red to hold. The card stands as a record; the session moves on.
        G.remember_gate(sid, card["id"], tests, "red")
        return None
    decided = wait_for_swipe(card)
    if decided is None:
        return None
    G.append_ledger(decided)
    if decided.get("verdict") == "reject":
        return gate_feedback(decided, "red", verify)
    G.remember_gate(sid, decided["id"], tests, "red")
    return None


def gates_at_stop(p):
    """Gate work owed at the end of a turn. Returns a block reason, or None."""
    sid = p.get("session_id", "")
    if not J.tui_alive():
        return None
    repo = G.repo_root(p.get("cwd", ""))
    cfg = G.config(repo)
    if not repo or not cfg["enabled"]:
        return None
    return green_pass(p, sid, repo, cfg) or unfollowed_tests(p, sid, repo, cfg)


def post_tool_use(p):
    """Remember test edits. Silent, and never blocks anything."""
    if p.get("tool_name") not in J.EDIT_TOOLS:
        return
    path = (p.get("tool_input") or {}).get("file_path") or ""
    if path and G.is_test_file(path):
        G.record_test_edit(p.get("session_id", ""), path)


def stop(p):
    sid = p.get("session_id", "")
    J.gc()
    items = J.drain_inbox(sid)
    if items:
        out({"decision": "block", "reason": J.format_feedback(items)})
        return
    blocked = gates_at_stop(p)
    if blocked:
        out({"decision": "block", "reason": blocked})
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
         "PreToolUse": pre_tool_use,
         "PostToolUse": post_tool_use,
         "Stop": stop,
         "UserPromptSubmit": user_prompt_submit}.get(event, lambda _: None)(payload)
    except Exception as exc:  # never break a session because of the judge
        sys.stderr.write(f"judge hook error: {exc}\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
