# CONTINUE HERE

> Rewritten 2026-08-22 after a long autonomous `/loop` run. **Phase 36 waves 1 and 2 are complete and
> committed**; wave 3 was in flight when this was written. A five-round project-trust repair also landed.
> `npm run check` is green. `npm test` still fails on exactly one test, deliberately — the tailnet
> identity tripwire from Phase 33.

## Read this first: what waves 1 and 2 do NOT close

Nothing. **Every task in both waves is evidence class 2.** The commit log reads like a working spawn
path and there isn't one:

- `AttachBridgeOptions.spawnSession` and `.registry` have **zero production callers**, so the shipped
  daemon answers `session_spawn` with `{ok:false, code:"refused"}` and `registry_resync` with two empty
  arrays. `createFleetRoutes` does not even accept the option.
- `resolveHarnessLaunch` is referenced by exactly two files: itself and its test.
- `buildSpawnArgv` likewise. Nothing anywhere starts a process from a spawn frame.

Wave 4 wires `fleet.ts`. The class-3 acceptance is wave 5. **If the phase's acceptance is read off waves
1-3 it will be read wrong.**

## The trust thread — five rounds, and why it took five

`hasTrustRequiringProjectResources` could be made to return false for a project it should gate, so a
saved "Do not trust" was silently overridden. Reachable because `SessionManager.open` takes cwd verbatim
from the session file header (`--resume`, `--session`), and — found only at the end — because
`draht-acp-agent.ts:258` passes client-supplied `params.cwd` raw into `createAgentSession`.

**Rounds 2, 3 and 4 each closed their target and left some shape worse than HEAD.** All four regressions
were found by the adversarial verifier, never the implementer. The cause was one decision: round 1
declined to touch `utils/paths.ts`, reasoning ~20 callers made a shared-helper change riskier than fixing
the one security caller. The real number was **16 call sites in 8 files, all in one package, never
exported from its index**. Every later regression landed in a different caller of that same function.

Round 5 deleted `canonicalizePath` outright so the compiler enumerates callers, and promoted the segment
walk into `src/utils/canonical-path.ts`: one core plus `realPathStrict` (the only one a trust,
containment or load decision may use), `trustKeyPath`, `comparablePath`, `realHomeDir`.

**If you touch this area, A/B against a reconstructed HEAD (`git archive HEAD | tar -x` into a clone —
never `git stash`, other agents work this tree), not only against the shape you set out to fix.**

## Runtime facts worth keeping

- **Bun 1.4's `realpathSync` (and `.native`) rewrites `\` to `/` before the syscall.** `<dir>/a\b`
  silently returns `<dir>/a/b` when that exists, aliasing two different directories. A character sweep
  found backslash is the ONLY affected byte; `existsSync`/`statSync`/`lstatSync`/`readdirSync` are correct
  and node 26 is correct. The shipped binary is `bun build --compile`, so this is production behaviour.
- **windows-x64 IS a shipped target** (`scripts/build-binaries.sh --target=bun-windows-x64`, plus the CI
  matrix). `canonical-path.ts` is POSIX-only: on win32 a native path is one segment handled by `lstat`, so
  junctions never resolve and a junction under a trusted root inherits its trust.
- `kill(pid, 0)` succeeds on a zombie. `ps` without `-A` lists only processes sharing the caller's
  controlling terminal, so a detached child reads as absent and every negative assertion goes vacuously
  green. macOS exposes a child's environment via `ps -Eww` for bun/node but **nothing** for SIP-protected
  binaries, so an env canary asserted against a `/bin/sh` grandchild is vacuously green forever.
- zsh has no `PIPESTATUS` (it is `pipestatus`, 1-indexed) — `cmd > /tmp/out 2>&1; echo $?` instead.
- `rtk` mangles `grep`/`ls`/`git diff`/`git show` through a pipe. Use `rtk proxy git ...` redirected to a
  file, or `sed -n`/`python3`.

## Process lessons that cost real time today

- **"No surviving mutations" from the agent that wrote the code is worth nothing.** All five wave-2
  implementers reported none; all five were wrong — 47 undisclosed survivors and 18 vacuous assertions.
  An author mutates where their own assumptions hold. Budget an adversarial pass per task.
- **A gate that scans nothing passes its own tests.** `scanRepo() { return []; }` left the command-gate
  suite 15/15 green with the gate printing `ok`, because every case fed it a fixture the test wrote.
- **A prose assertion matching a WORD lets the document state the opposite.** `/deliberate/i` guarding
  "there is no stop verb, and that is deliberate" passes "not deliberate — it is an oversight".
- **A comment is not a fix.** One agent's entire deliverable was 39 added lines, all comment, zero code.
  Repo baseline is 13.7% src / 5.9% tests; keep to it and put the reasoning in the commit message.

## Still open — needs Oskar

**Four spawn questions, unanswered since before wave 2 and NOT planned around:**

1. Does RESUME also get `--no-approve`, or only spawn? One-line change either way; the resume argv is in
   `spawn-primitive.ts`.
2. What is the local re-grant path for a phone-spawned session? Nothing turns a running untrusted session
   into a trusted one without restarting it.
3. `DRAHT_CODING_AGENT_DIR` crosses into the child by design and is the root for `auth.json`, which holds
   every provider's credential. Per-harness `credentialEnv` fixes the ENVIRONMENT half only.
4. Is a spawned session the daemon's child? Deciding it for resume decides it for spawn.

**Also open:** the two Phase 35 product decisions, four in `DECISIONS-PENDING.md`, and the three hardware
residuals (unchanged — see the commands in git history for the tailnet capture).

`~/.draht/gateway.config.json` still holds `host: "0.0.0.0"` with `tokens.default: "test"`. Nothing
listens on 7878 and the bind refusal prevents a wide bind, but the token is the literal string `test`.
Not modified — it is your machine config.

## Carried forward, with owners

- A `select`/`input` carrying a `tool_permission` detail still writes the wrong decision word.
  **Owner: Phase 37 opens the wire, Phase 38 freezes it at 1.0. It must not survive the freeze.**
- `loadProjectContextFiles` walks cwd and every ancestor with no trust parameter, injecting
  attacker-authored AGENTS.md/CLAUDE.md into the system prompt from a merely-opened checkout. Accepted
  bounded risk: gating it would gate essentially every repository.
- The foreign-uid busy-lock refusal and the sockets-directory uid refusal remain covered by reading only.
- Replay starvation: `pendingFor` truncates at 16 and nothing re-drives the remainder.

## Branch note

This checkout is shared with another session, which put HEAD on `upstream-sync`. `check:draht` asserts
`.planning/ unchanged vs main` by diffing the WORKING TREE, so planning docs must be committed to `main`
— do that with a temporary worktree (`git worktree add /tmp/mainwt main`), never by moving a ref. Code
commits go on the current branch with **explicit pathspecs**: the tree carries ~55 files belonging to the
other session, and `git add -A` would sweep them in.

## Next

**Phase 36 wave 3**: `SessionSpawner.launch()` sharing the whole post-spawn block with `resume()`, the
launcher composition, and the fleet-join proof. Then wave 4 wires `fleet.ts` — the first point at which
anything can be class 3.

```bash
cd /Users/exe008/draht/draht-mono
npm run check                 # expect exit 0
```

To restart the autonomous loop:

```
/loop /draht:resume-work with /draht:orchestrate ultracode workflows. they can use fable 5 advisors for difficult problems
```
