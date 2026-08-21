---
description: "Generate a committed project-local verify-<app> skill that drives the real app the way a user does and captures proof artifacts — proven end to end once before handover"
---

# /create-verification-skill

Every serious project needs a scripted way to drive the real app and prove behaviour: launch it, exercise a feature the way a user would, and capture evidence. This command generates that as a committed project-local skill — `.draht/skills/verify-<app>/` — tailored to the repo, so verification is a versioned repo asset instead of per-session improvisation.

## Usage
```
/create-verification-skill [app or surface]
```

Target: $ARGUMENTS (optional — when empty, the interview below picks the primary user-facing surface)

Write the generated skill for the next agent, not for a human: it will be read cold, mid-task, by an agent that has never seen the app.

## Steps

### 1 — Interview the repo, not the user

Answer these from the codebase and only ask the user what you cannot observe:

- **Surface:** what does a user actually touch? A web UI, a CLI/TUI, a desktop app, an API, a mobile app, a library? A repo can have several; pick the primary one and note the rest.
- **Run:** how does the app start locally? Prefer the repo's own documented dev command (package scripts, Makefile, README quickstart). Note ports, env vars, seed data, auth.
- **Drive:** how can an agent interact with it programmatically? Existing harnesses first — Playwright/Cypress specs, expect scripts, PTY helpers, curl-able endpoints, a debug port. Only then pick a generic recipe: a browser debug port (CDP) for web and Electron, a tmux/PTY harness for CLI and TUI, plain HTTP for services. Every recipe must run through plain shell commands — assume the runtime ships no browser-automation or app-control tooling of its own.
- **Observe:** what evidence can be captured? Screenshots, terminal transcripts, response bodies, logs, exit codes, DB state.
- **Isolate:** can two instances run side by side (ports, data dirs, profiles)? If not, say so in the generated skill: refusing to double-drive a shared instance beats corrupting the user's session.

If the checkout doesn't build or start as-is, fix that first (or report it precisely) before generating; a skill written against a broken base teaches wrong steps. When an irrelevant missing asset blocks startup (a static dir the API never serves, a sample config), the generated skill may create it, clearly marked as verification scaffolding, and remove it in cleanup.

### 2 — Generate the skill

Write `.draht/skills/verify-<app>/SKILL.md`. `.draht/skills/` is the project-level skills directory, and project skills win name collisions against installed or shipped skills — the generated skill is authoritative for its repo. (If the target project's agents discover project skills at a different path, write the identical content there instead; the skill body is host-neutral.)

Frontmatter is `name: verify-<app>` plus a `description` that names the app, the surface, and when to reach for it — without frontmatter the skill never registers. Then these six sections, each grounded in what the interview actually found (no placeholders left):

- **Launch:** the exact command that starts the app for verification, and how to tell it's ready (a log line, a port answering, a prompt). Include teardown. For a short-lived CLI or TUI there is no server to keep alive: launch means build the binary (or install deps) once, then start each drive in its own isolated PTY or tmux session.
- **Doctor:** one read-only check that answers "is this instance worth driving?" — process up, right version/build, port owned by us, auth valid. Run it before the first drive and again whenever anything looks off.
- **Drive:** the harness recipe with real selectors/commands from this repo, not examples. Prefer stable handles (ARIA labels, data attributes, prompt strings, route paths) over coordinates and tab order.
- **Evidence:** what to capture for a proof and where it goes. State the proof standards: exercise the real user path, not internal setters or test-only endpoints; capture the action and the resulting state, not just the final screen; verify side effects (files written, rows inserted, messages sent) alongside what's visible; mocks only where a production boundary already isolates the external system. When the safe path is a dry-run or test mode, verify what it actually skips by observing (files, network, git refs) rather than trusting its name: some dry-runs still touch the network or open a browser.
- **Cleanup:** how to tear down instances the run created. Never kill by process name; kill what you started. Cleanup removes instances and scratch state, never the evidence: proof artifacts survive the teardown, in a location the skill names.
- **Helpers:** any script the skill ships is executable and its invocation is shown in the skill body. A helper the reader has to reverse-engineer is not a helper.

### 3 — Seed the feature map

Create a `features/` directory inside the generated skill dir, holding `features/README.md` plus one file per user-facing feature you can identify (aim for the top 3-5 to start, from routes, commands, menus, or docs). The README carries the baseline preconditions (launch target, disposable data location, seed data, the Doctor requirement), the driving conventions (stable handles over positions, commands taken literally, restore mutated fixtures, never remove proof artifacts), the proof and skip-reporting rules (record the feature ID and entry point with every artifact; report an unreachable path with the attempted command and the unmet precondition; never report a skipped entry point as verified through a different path), and an index linking every feature file.

Each feature file starts with an H1 title and one paragraph of user-visible behaviour, then exactly four H2 sections in this order:

1. `Sub-features` — short IDs with one line per behaviour.
2. `How to get to it (user POV)` — every user entry point.
3. `Driving it with <harness>` — starts with `Preconditions:`, then labelled bullets pairing each user action with an exact command and its observable result.
4. `Gotchas` — traps that can waste or invalidate a verification run.

Keep implementation details out of the map: name only user paths, stable handles, required state, commands, and observable proof. A condensed example entry:

```markdown
# Create a note

Create note lets a user save a titled note and confirm it from a second view.

## Sub-features

- `create-save` persists a title and body.

## How to get to it (user POV)

- Choose the `New note` button in the browser toolbar.

## Driving it with the CDP harness

Preconditions:

- Notes is healthy at `http://127.0.0.1:4173` and no note is titled `Release checklist`.

- **Open editor.** Choose `New note`. Click the button with accessible name `New note`. A form named `Note editor` appears.
- **Save note.** Fill `Title` with `Release checklist`, choose `Save note`. A status named `Note saved` appears.
- **Proof.** Reopen the note from `All notes`; screenshot to `artifacts/create-note/list.png`. The list shows `Release checklist`.

## Gotchas

- A save status alone is insufficient proof. Reopen the note from the list.
```

The map is the repo's maintained verification source; a proof that drives one convenient entry point is incomplete when the map lists others.

### 4 — Prove the generated skill before handing it over

Run its own instructions end to end once: launch, doctor, drive ONE mapped feature (one is enough — the map exists so later runs can cover the rest), capture evidence, clean up. After cleanup, confirm the evidence still exists at the named location — a cleanup that eats the proof fails this step. Fix what fails, and run the generated cleanup after every failed iteration too, so broken attempts don't strand processes and ports. A generated skill that was never executed is a draft, not a deliverable.

### 5 — Commit and hand over

The generated skill versions with the app it verifies: commit `.draht/skills/verify-<app>/` (skill, feature map, helpers) to the target repo. Then tell the user two things:

- `/verify-work` picks it up: when a `verify-<app>` skill exists, the phase verifier drives one mapped feature and captures its evidence instead of stopping at the test suite.
- The map stays honest only if it changes with the app: a change that adds or reshapes a user-facing feature updates the matching feature file in the same change. A map entry the app has outgrown is worse than none — it teaches wrong steps with confidence.

## Failure Modes — STOP

Stop immediately if you catch yourself:

- Writing recipes against an app you never started — generate from observed behaviour, not from reading the code
- Trusting a dry-run or test mode by its name instead of observing what it actually skips
- Proving a feature through a test-only endpoint or internal setter instead of the real user path
- Driving an instance this run did not start
- Writing a cleanup that deletes the proof artifacts
- Handing over a skill whose own instructions were never executed end to end
