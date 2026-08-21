---
name: blast-radius
description: Impact analysis beyond the diff — find what a change could break somewhere else before it ships, reduce the safety argument to the one falsifiable fact it rests on, and prove that fact by running real code, saying for every fact which rung of the evidence ladder it stopped at. Use for "what could this break", "blast radius of this change", or reviewing a small diff you don't trust yet. Not the uncertainty × blast-radius ordering heuristic in draht's planning commands — that phrase ranks risks for scheduling; this skill is the impact investigation itself.
---

# Blast Radius

Find what a change breaks somewhere else, before it ships. Use for "what could this break", "blast radius of this change", or reviewing a small diff you don't trust yet.

Companion to `why`: `why` reconstructs why the code is shaped the way it is; blast radius works forward from a change to what it breaks elsewhere.

Listing the callers is not the job — grep finds those in a second. The job is the breakage grep won't show you.

## Don't Trust Your Own Writeup

A blast-radius writeup that sounds right is worthless. It reads as convincing whether or not it's true, and that is the trap. So don't hand back the writeup. Find the one or two facts the whole thing depends on and prove them by running code. Words are where you start, not what you ship.

## The Evidence Ladder

For each fact the change's safety depends on, get it as far down this ladder as is cheap, and **say where it stopped**:

1. **You said so.** Worthless on its own.
2. **You pointed at the line.** A real `file:line`, or the library's own source.
3. **You walked the failure.** You traced the bad case step by step and it doesn't reach.
4. **You ran it.** A script or test that calls the real code and fails loud if you're wrong.
5. **You reproduced it in the running app.**

Any safety fact you can't get to rung 4, say so out loud — don't write it up as settled. Rung 4 is usually one small script that imports the same library the app ships and calls the exact function you're worried about.

## Steps

1. **Read the change.** The diff, the symbols it adds, changes, and deletes, and what it now does differently — including the part the diff doesn't spell out. Pull the history behind it: `git log --follow` and `git log -S` on the touched files, `gh pr view` / `gh pr diff` for the PR that landed the code you're changing.
2. **Find the one fact it's safe because of.** Most changes that look scary are safe because of a single fact, like "this call only drops already-dead cache entries and does nothing else". Find that fact. If it holds, most of the scary cases die at once. Spend your time here, not on a long list of maybes.
3. **Look where grep stops.** Read the source of the library you call, at its pinned version, including any local patch. Work out when things run: microtasks, unmount and teardown, framework scheduling differences. Follow what a symbol search misses: the JSON an API returns, a DB column, a wire format, another language reading the same bytes, a feature flag, code three hops downstream.
4. **Be honest about each risk.** Give it a real chance of happening and a real cost if it does. Keep the risks you confirmed; list the ones you checked and cleared separately. Cite a real `file:line`; a search that finds nothing is still an answer; never invent a caller or an API.
5. **Prove the one fact.** Write a script or test that runs the real code, run it, and paste what happened. If you can't prove it cheaply, mark it unproven. Don't round up.
6. **For a big or wide change**, dispatch the `reviewer` and `security-auditor` subagents in parallel via `/review` and merge their findings with your own — different readers catch different real breakage.

## What to Hand Back

- **What it does.** What changed, including the part that isn't obvious.
- **The one fact it's safe because of.** State it, say which rung it reached, and show the proof. If you couldn't prove it, write unproven.
- **Risks.** Only the real ones. Each names how it breaks, the `file:line`, how likely and how bad, and how to check. Paste the proof for the ones that matter.
- **Cleared.** What you checked and why it's fine.
- **Before you merge.** The cheapest test or repro that catches the real bug, including the script you wrote.

Write it through `unslop`, cite real code, and strip anything private before it goes anywhere public.

**Reply:** the writeup above, with the one safety fact either proven or marked unproven.

## Relationship to Sibling Skills

- `verification-gate` demands evidence before claiming "done" or "safe" via the standard commands (tests, typecheck, lint). Rung 4 is that same iron rule applied to a single safety fact — a bespoke probe against the real code, because no standard command exercises the exact case you're worried about.
- `epistemics` calibrates claims about historical intent that nothing can run; blast radius governs claims about present breakage that something *can* run — so run it.
- draht-tools `graph-impact` walks the static import graph and is step-3's starting point, never its end: everything in "look where grep stops" is exactly what a static import walk cannot see.
