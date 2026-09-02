---
description: Triage an external issue report — classify, bounded cause trace, dedupe against GitHub Issues, fail-closed ticket creation, one typed verdict
argument-hint: "<pasted report, issue URL, or gh issue view output>"
allowed-tools: Bash, Read, Task
---

# /triage

Classify one external issue report and end with one useful verdict. Create a tracker issue only for a clear, new bug. Do not reproduce or fix anything here — `/fix` owns that, and a `[triage:bug]` verdict is its entry ticket.

Report: $ARGUMENTS

> **Tool note**: For the bounded cause trace, use the **Task tool** with `subagent_type: "debugger"` — findings-only diagnosis (no fixes, no writes); classification and every tracker write stay with the orchestrator.

## Fail-Closed Rules

- One report, one run, one verdict. Do not narrate progress into the tracker.
- **Prefer no ticket over a guessed or duplicate ticket.**
- The `debugger` dispatch is findings-only: it diagnoses and reports; it fixes nothing, writes nothing, and never touches the tracker.
- No repository access → no cause trace: continue with a conservative classification and say in the verdict that cause tracing was unavailable.
- No confident dedupe → no ticket.
- Never create an issue that cannot link back to the source report.
- If a `gh` operation the creation gate requires is unavailable (not installed, unauthenticated, wrong repo), fail closed for that write and say so — the verdict still lands.

## 1 — Freeze the source coordinates

Pin what "the report" is before delegating or searching, and store it immutably for the rest of the run:

- A pasted report → quote its first line verbatim and record where it came from (chat, e-mail, support tool) as the user stated it.
- An issue URL or `gh issue view` output → store `owner/repo` + issue number, then read it whole: `gh issue view <n> --repo <owner/repo> --json url,title,state,body,comments`.
- Resolve the target repo for dedupe and creation: the current repo unless the report names another. Ambiguous target → ask; never guess where a ticket lands.

Every later read, search, and write uses these stored values. A reply, a cross-link, or a search hit never replaces them.

## 2 — Read the whole report

Capture before judging:

- Reporter wording, verbatim
- Product version, build, environment, platform when present
- Expected behavior vs observed behavior
- Frequency and trigger
- Error text or stack signature
- Existing issue, commit, or PR links
- Any explicit statement that someone is already fixing it

If the report references an attachment, screenshot, or recording you cannot read, say so in the verdict — do not invent what it shows.

## 3 — Trace cause before routing

A bounded source-and-history pass, before choosing a category or an owner. Dispatch the `debugger` agent with this prompt:

```
Investigate this external issue report using root-cause discipline. FINDINGS ONLY: do NOT fix anything, do NOT write or edit files, do NOT create or comment on tracker issues.

Report (frozen — do not reinterpret):
<reporter wording, expected/observed, error text or stack signature, version/environment, trigger>

Bounded pass — report on each step:
1. Identify the likely code path from the reported action to the observed result (file:line anchors).
2. Check whether the visible symptom belongs to that code path or to a dependency below it.
3. If the report looks like a regression: `git log --oneline -20` and recent diffs on the affected files — name candidate commits.
4. Check whether a merged commit or open PR already addresses the same symptom.
5. Separate confirmed facts from hypotheses — label every statement observed, derived, or assumed.

Stop at diagnosis strength sufficient for routing — a complete root cause is /fix's job, not yours. Do not build a reproduction unless one command is already obvious from the report itself.

End with STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

The pass does not need a complete root cause — it must be strong enough to avoid routing a visible symptom to the wrong component. A keyword match between the report and a module name is not a trace; a visible symptom alone is not enough when cause tracing points to a dependency below it. When the report smells like a regression and design intent matters ("was this behaviour a decision or an accident?"), a bounded `/why` consult can supplement the trace — not a full archaeology run.

If the repository cannot be read, skip the dispatch, classify conservatively, and record "cause tracing unavailable" for the verdict.

## 4 — Classify

Choose exactly one:

- **Bug** — something violates intended behavior: wrong output, broken state, error, crash, hang, silent no-op, regression.
- **Performance** — measurable slowness, excess memory, jank, resource drain. Treat as a bug; preserve every measurement and profile the reporter supplied.
- **Feature request** — current behavior looks intentional; the reporter wants different behavior or a new affordance.
- **Question or feedback** — asks how something works, or expresses a preference without a concrete defect.
- **Reroute** — cause tracing shows another repo or team owns it. A route needs evidence from the report or the trace. Say where the report belongs in the verdict; never file it here.

When the bug-versus-feature line is unclear, do not file. Ask one focused question in the verdict and close with the `other` marker.

## 5 — Dedupe against GitHub Issues

GitHub Issues via `gh` is the one tracker this command speaks: search (`gh issue list --search`, `gh search issues`), read (`gh issue view`), update (`gh issue comment`), create (`gh issue create`), compensate (`gh issue close`). Preflight once: `gh auth status` and the resolved target repo.

For bug and performance reports, search open AND closed issues before creating anything:

```
gh issue list --repo <owner/repo> --state all --search "<exact error or crash signature>"
gh issue list --repo <owner/repo> --state all --search "<area> <trigger> <symptom>"
gh issue list --repo <owner/repo> --state all --search "<version or date window, suspected regression commit>"
gh search issues --repo <owner/repo> "<source URL or distinctive reporter phrase>"
```

Choose one typed outcome and name it in the verdict:

- **Confident duplicate** — same signature, or same area + trigger + symptom, or a confirmed shared cause. Add the source reference and one short recurrence note to the existing issue (`gh issue comment`); do not reopen, relabel, or reassign it. Create nothing.
- **Possibly related** — a shared cause is plausible but not proven. Link it in the verdict as uncertain. Create nothing.
- **Weak resemblance** — similarity is superficial. Record it as checked; it does not block creation.
- **No match.**

A long-closed issue is a regression lead, not automatically a live duplicate — feed it back into the cause trace instead of linking it as the answer.

## 6 — Decide whether to create

Create only when ALL of these hold:

1. The classification is bug or performance.
2. The behavior is clearly broken — a violated intent, not a preference.
3. The issue is still live: no merged commit or open PR from step 3 already addresses it.
4. Dedupe ran and found no confident duplicate and no plausibly-related live match.
5. The frozen source coordinates are in hand, so the new issue links back to where the report came from.
6. `gh` is authenticated against the resolved target repo and title/body/labels resolve — never invent labels, milestones, assignees, or priority.
7. The run can still compensate: `gh issue close` on its own creation remains possible if the verdict fails to land.

Never create for a feature request, question, feedback item, reroute, possible duplicate, confident duplicate, or already-fixed report. If a condition fails, the verdict names which one.

The new issue must be self-contained:

- Plain title naming the area and the symptom — no guessed root cause in the title
- Reporter quote
- Expected and observed behavior
- Version and environment, or `unknown`
- Trigger and frequency
- Source reference (issue URL, or where the pasted report came from)
- Short cause-trace findings with hypotheses labeled as hypotheses
- Links to any artifacts (logs, screenshots, profiles)

**Compensation**: if this run created an issue and the verdict then cannot be delivered — the run aborts, or the creation turns out wrong before the verdict lands — close the created issue with `gh issue close <n> --comment "triage compensation: verdict did not land"`. An orphaned guess in the tracker is worse than no ticket.

## 7 — One verdict

Lead with the outcome. Link the existing or new issue when there is one. Name the dedupe outcome. Mention the reroute destination or the one missing fact when needed. Keep it short — the `unslop` bar applies, and every claim follows the `epistemics` labeling the trace carried.

End the report with exactly one marker line, the last line of the response:

```text
[triage:bug]
[triage:bug] tracker=https://github.com/OWNER/REPO/issues/N
[triage:performance]
[triage:performance] tracker=https://github.com/OWNER/REPO/issues/N
[triage:other]
```

`bug` and `performance` carry `tracker=` only when this run matched or created a live issue. Everything else — feature request, question, feedback, reroute, unclear — closes with `[triage:other]`. Never emit two markers; never bury the marker mid-report. A follow-up `/fix` run takes the marker plus its tracker link as the issue input.

## Rationalization Table

| Excuse | Reality |
|---|---|
| "The report names the component, route it there" | A keyword match is not a trace. Route on a confirmed code path or signature, or say the owner is unclear. |
| "Probably a duplicate of #123" | Probably means possibly related: link it as uncertain and create nothing. |
| "Filing a ticket is harmless" | A guessed or duplicate ticket costs a maintainer two triages. Prefer no ticket. |
| "The old closed issue matches, done" | A long-closed issue is a regression lead — trace what re-broke it. |
| "No repo access, but the cause is obvious" | Reading a report yields hypotheses. Classify conservatively and say the trace was unavailable. |
| "I'll fix it while I'm here" | Triage ends at the verdict. Hand `[triage:bug]` to `/fix`. |
