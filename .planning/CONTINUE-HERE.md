# CONTINUE HERE

> Rewritten 2026-10-31. **Phase 36 is `partial` until CI runs the foreign-uid registry case, and merged into local `main`** from branch
> `feat/phase-36-spawn-wire` (worktree `/home/nix/work/draht-p36`), not yet pushed. A phone can start a session: `session_spawn`
> on `/attach` launches the registered `draht` in the registered project, and the served console has a
> project/harness picker. Next is Phase 37 (run lanes).

## What is on the branch

Nine commits, on `main`:

1. Spawn suites runnable on hosts whose child PATH has no coreutils (NixOS).
2. The dead `command` → `SessionProcess` chain deleted; gate rule D keeps `spawn-primitive.ts` the
   only process-creating site in gateway source, enforced by `npm run check`.
3. The launcher wired into the shipped daemon: `--registry`, per-connection offer, one launcher per
   daemon, only `draht` spawnable, project-local executables refused.
4. Docs: spec §9.1, §15.2, §15.3, `geist.yaml.example`, gateway README and SPEC.
5. Class-3 suites: `spawn-acceptance`, `spawn-adversarial`, `spawn-posture` (gateway e2e).
6. Gate rule D rewritten deny-by-default.
7. The console picker and its browser e2e.
8. The session-resume and git-probe fixtures resolve `sleep`/`mv` too.
9. Decision 36.1: a session resumed from the phone starts untrusted (`--no-approve`), like a spawn.

The plan for waves 4-5 is appended to `.planning/phases/36-spawn/PLAN.md`.

## Verifying it on this NixOS box

```bash
cd /home/nix/work/draht-p36
npm run check                                   # exit 0
cd packages/gateway && nix-shell -p openssl --run "env -u DRAHT_PERMISSION_MODE bun test"
#   822 pass / 4 skip / 0 fail (reach-transport needs openssl; the skips are the foreign-uid
#   registry file case, two LAN-interface cases and one root-only guard).
LD_LIBRARY_PATH=$(cat /home/nix/work/chromium-ldpath.txt) \
  node --test --test-concurrency=1 --test-timeout=300000 scripts/geist-console-*.e2e.test.mjs   # 74/0
```

The worktree lives under `/home/nix/work`, not `/srv/work`: the spawn primitive refuses any
group-writable component of the executable path, and `/srv/work` is group-writable. geist-core has three
status-probe failures on this box at `2c0482bad` too: `GIT_CANDIDATES` in `status-probe.ts` lists no
NixOS path, so the fleet status is always `unknown` here (owner question 9 in `DECISIONS-PENDING.md`).

## Still open — needs Oskar

- **Push `main`.** Local `main` also holds the unpushed 2026-10-31 upstream sync from another session,
  so the push waits for that session. The first CI run after it is the first class-3 evidence for the
  registry-owned-by-another-uid FILE case, which needs `sudo -n` on the gateway shard (Blacksmith).
- **Mark Phase 36 `complete`** once that CI run executes the foreign-uid FILE case green (Oskar's call).
- 36.1 and 36.3 are DECIDED (2026-10-31): resume starts untrusted (`6a9f2917d`); credentials are scoped by
  environment only in v1, the `auth.json` file half waits for the Milestone 6 sandbox.
- The six reversible orchestrator calls and eleven new questions under "Phase 36 waves 4–5" in
  `DECISIONS-PENDING.md`. The ones that bite first: the installed `~/.local/bin/draht` cannot be
  declared (symlink chain), and on NixOS spawned sessions get no coreutils unless `DRAHT_RESUME_PATH`
  is set.
- Unchanged from before: 36.2, 36.4, 36.5, the Phase 35 product decisions, the hardware residuals, and
  the literal `test` token in the Mac's `~/.draht/gateway.config.json`.

## Carried forward, with owners

- A `select`/`input` carrying a `tool_permission` detail still writes the wrong decision word.
  **Owner: Phase 37 opens the wire, Phase 38 freezes it at 1.0. It must not survive the freeze.**
- `registry` answers empty for a refused registry with no error field. Due before the 1.0 freeze.
- `loadProjectContextFiles` walks cwd and every ancestor with no trust parameter (accepted bounded risk).
- Replay starvation: `pendingFor` truncates at 16 and nothing re-drives the remainder.
- Gate rule D is a text scanner: a reflective `Function` constructor and the regex/division ambiguity
  still defeat it; closing them needs an AST-based scanner (question 16).

## Runtime facts worth keeping

- **Bun 1.4's `realpathSync` rewrites `\` to `/` before the syscall**; anything deciding security from a
  path must lstat a backslash-bearing path instead. The shipped binary is `bun build --compile`.
- **windows-x64 is a shipped target** and `canonical-path.ts` is POSIX-only (junctions never resolve).
- `kill(pid, 0)` succeeds on a zombie; `ps` without `-A` hides detached children; macOS exposes no
  environment for SIP-protected binaries, so an env canary against `/bin/sh` is vacuous there.
- On NixOS the constructed child PATH (`DEFAULT_RESUME_PATH`) holds only `/bin/sh` and `/usr/bin/env`;
  a fixture calling a missing utility goes vacuous, not red (the stdout-flood test did).
- No privilege-free foreign-owned inode exists on this box (no `sudo`: no_new_privs;
  `protected_hardlinks=1`; `/tmp` is a separate mount), unlike macOS's `/private/var/db`.

## Next

Push `main` when the upstream sync is pushed, then **Phase 37** (run lanes). To restart the loop:

```
/loop /draht:resume-work with /draht:orchestrate
```
