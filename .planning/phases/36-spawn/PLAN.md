# Phase 36 — Start Work From the Phone: execution plan

> Produced 2026-08-22 by workflow `wf_b65da7c8-2f3` (six read-only lenses, two Fable 5 advisors at
> max effort, one max-effort planner). Advisor corrections beat the requirements as written; each is
> recorded under Ordering constraints.

## Design

Phase 36 is roughly 55% built, but NOT along the axis the brief assumed, and two claims in the map are false at HEAD — I verified both by running.

WHAT PHASE 35 ACTUALLY SHIPPED (verified by running): the hardened spawn primitive is real. `packages/gateway/src/session/spawn-primitive.ts` resolves absolutely with no PATH branch (`canonicalize` refuses non-absolute at :306), walks every path component for uid/writability (:271-301), spawns argv-array with `shell:false` (:667) and `detached:true` (:663), builds the child env from `{}` with no `process.env` spread (:390-421), TERM→KILLs the process GROUP (:795/:801), holds a daemon-wide in-flight set (:869) hoisted to one instance per daemon (fleet.ts:562), and verifies its OWN child bound the socket by reading the lock pid (:511, :726). `bun test src/__tests__/session-resume.e2e.test.ts` → 23 pass / 0 fail / 130 expect() in 56.7s, with five real `ps` assertions. No HTTP route creates a process (sessions.ts:157 → 400, :252 → 409).

THREE R36-SPAWN.2 REFUSALS DO NOT HOLD — I ran the real exported functions: (a) a symlinked DIRECTORY component is silently FOLLOWED (`canonicalize` realpaths at :311 before asserting, so the symlink branch at :285 is dead code its own comment calls "unreachable"); `DRAHT_BIN=/tmp/.../link/draht` → ALLOWED. (b) an absolute project-local `node_modules/.bin/draht` → ALLOWED (no containment rule exists). (c) a regular file at mode 1777 → ALLOWED, the same file at 0777 → REFUSED, because the sticky exemption at :294 is applied to the leaf as well as directories.

THE REGISTRY HALF IS UNBUILT, NOT UNWIRED. `parseGeistConfig` and `ProjectRegistry` have ZERO production callers; nothing in the repo parses a geist.yaml at runtime; `yaml` is only a devDependency of geist-protocol. `AgentLaunchSpecSchema.cmd` is a bare `z.string()` and `geist.yaml.example` ships `cmd: draht-acp` — a PATH lookup. No code stats any config file for uid/symlink/mode. `session_spawn` does not exist on the wire (9 client frames, none of them a spawn). This is four separate pieces — secure loader, path validation, resolver, consumer — not "add a caller".

TWO MAP CLAIMS ARE STALE, OVERTURNED BY RUNNING: (1) the git status probe is ALREADY HARDENED — `gitExecutable()` resolves absolute from a fixed candidate list (status-probe.ts:119-131), the argv carries `-c core.fsmonitor= -c core.hooksPath=/dev/null -c uploadpack.packObjectsHook= -c diff.external= --no-optional-locks`, and `env: probeEnvironment()` is a 5-key allowlist. I built a hostile repo with `core.fsmonitor` pointing at `env > leaked-env.txt`, ran the real `GitStatusProbe.refresh()` under a canary, got `{"status":"dirty"}` and NO leaked file. There is no hardening work to do. (2) But its EVIDENCE is broken: `fleet-status-honesty.e2e.test.ts` still shims `git` by prepending a directory to PATH (:292), which the hardened probe no longer consults — I ran it: 2 pass / 6 FAIL at HEAD. That is a pre-existing red suite and the only status-probe work Phase 36 should do.

WHAT R36 STILL NEEDS: the three .2 refusals; a distinct refuse-don't-repair registry-file check (`assertSafeExecutablePath` cannot be reused — it accepts uid 0, masks only write bits, and exempts sticky paths); a harness/project resolver; the `session_spawn` wire batch with a 0.4→0.5 bump and a new conformance corpus; `SessionSpawner.launch()` sharing the whole post-spawn block with `resume()`; `--no-approve` in the spawn argv (a phone spawn currently inherits standing local trust and runs project extensions); no-follow root-contained project context (`resource-loader.ts:70-88` follows symlinks, :138-151 walks to `/`); separate spawn/handshake/first-output/stop deadlines (one 30s number today, stdout is `"ignore"`, no stop path exists); per-harness credential scoping; the console picker; a source-level no-command-field gate; and the class-3 acceptance, all of which must be proven THROUGH a spawn because nothing in the registry produces a process.

STRUCTURE: 23 tasks in 5 waves. `spawn-primitive.ts` is the collision hotspot and is owned by exactly one task per wave (W1→W2→W3). Everything else fans out: geist-protocol, coding-agent, geist-core, the console, the scripts gate and seven new acceptance files are all disjoint tracks.

## Tasks

### W1-EXEC-WALK — Close the three R36-SPAWN.2 refusals that do not hold

- **Wave** 1 · **Requirement** R36-SPAWN.2 · **Evidence class** 2 · **Depends on** nothing
- **Files** `packages/gateway/src/session/spawn-primitive.ts`
- **Test** `packages/gateway/src/__tests__/executable-path-walk.test.ts`

You are hardening the executable-path gate the daemon uses before it spawns anything. You see nothing of the conversation that produced this plan; everything you need is here.

WHAT IS ALREADY TRUE (do not rebuild): packages/gateway/src/session/spawn-primitive.ts:271-301 `assertSafeExecutablePath` walks every component of an absolute path from `/` down, requiring uid===self||0, refusing group/world-writable unless sticky, and requiring a regular file at the leaf. :305-317 `canonicalize` pairs `realpathSync` with that walk. :342-372 `resolveDrahtExecutable` never reads PATH. All of that stays.

THREE THINGS ARE BROKEN. I proved each by calling the real exported functions:
1. A SYMLINKED COMPONENT IS FOLLOWED, NOT REFUSED. `canonicalize` calls `realpathSync` at :311 and only then asserts, so the symlink branch at :285-289 is unreachable — its own comment says so. RAN: with a symlinked directory `link -> real`, `resolveDrahtExecutable({DRAHT_BIN:'/private/tmp/.../link/draht'})` returned ALLOWED, resolved to `/private/tmp/.../real/draht`.
2. A PROJECT-LOCAL ABSOLUTE BINARY PASSES. RAN: `assertSafeExecutablePath('/private/tmp/.../proj/node_modules/.bin/draht')` (mode 0755, owned by me) → ALLOWED. Nothing anywhere checks containment.
3. THE STICKY EXEMPTION IS APPLIED TO THE LEAF. RAN: a regular file at mode 1777 (verified `(statSync(f).mode & 0o7777).toString(8) === '1777'`) → ALLOWED; the same file at 0777 → REFUSED 'writable by others'. The exemption's documented justification at :258-263 ('a non-owner cannot rename or unlink our entry') is a property of DIRECTORIES only.

WHAT TO BUILD, all inside this one file:
(a) Gate the sticky exemption at :294-297 on `stats.isDirectory()`. One line.
(b) Beside the `isFile()` assertion at :299, refuse a leaf carrying setuid or setgid (`mode & 0o6000`).
(c) In `canonicalize`, lstat-walk the SUPPLIED path BEFORE `realpathSync` and refuse a symbolic link at any component — that makes the existing test at packages/gateway/src/__tests__/session-resume.e2e.test.ts:1145 a test of production behaviour instead of a bypassed assertion. CRITICAL EXEMPTION: this must apply to the declared harness executable ONLY, never to the interpreter resolution at :359-362. `process.execPath` under a version manager is routinely a symlink (the file's own comment at :349-352 says so) and macOS homes under /var and /tmp are symlinked. Give `canonicalize` an explicit `followSymlinks: boolean` (or a separate entry point) so the interpreter path keeps today's realpath-first behaviour and the declared path does not. If you get this wrong, Phase 36 lands and nothing starts.
(d) Add an `approvedRoots: readonly string[]` and a `forbiddenRoots: readonly string[]` parameter to `canonicalize`, and refuse a canonical result that is not contained under some approved root, or that IS contained under a forbidden root. Containment must be canonical-path containment with a separator boundary — `startsWith(root)` alone matches `/Users/me/projects-evil` against `/Users/me/projects`, which is exactly the defect in the daemon's existing `isPathAllowed` (packages/gateway/src/config/config.ts:429-438). Both lists default to empty and empty means 'no constraint', so `resolveDrahtExecutable`'s existing behaviour is unchanged.
(e) EXPORT `canonicalize`. A later task resolves harness executables through it from a different file.
(f) Keep the monorepo dev checkout working: `resolveDrahtExecutable`'s candidate list at :344-347 is `packages/coding-agent/dist/cli.js` relative to this source file. It must keep resolving with no approved roots configured, or every developer's daemon stops resuming.

TEST FILE: packages/gateway/src/__tests__/executable-path-walk.test.ts (new). Cover, against real files in a `mkdtemp` under /private/tmp: sticky directory still allowed; sticky REGULAR FILE refused; setuid leaf refused; symlinked component refused THROUGH `resolveDrahtExecutable` (not by calling the assertion directly — that is the bug); an interpreter path that IS a symlink still resolves; project-local binary refused when a forbidden root covers it and allowed when no roots are configured; the separator-boundary case (`/x/projects-evil` must not count as inside `/x/projects`). Do not edit session-resume.e2e.test.ts — another task owns the acceptance.

TRAPS (each has cost hours here): `rtk` wraps `grep`/`ls` and MANGLES their output — line numbers and content from them are NOT trustworthy; use `sed -n`, `python3` or Read for anything load-bearing. `npx tsc --noEmit -p packages/gateway` prints 'TypeScript: No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the repo root. `npx biome` fails; use `./node_modules/.bin/biome`. This shell exports DRAHT_PERMISSION_MODE=auto — prefix every spawn with `env -u DRAHT_PERMISSION_MODE`. A unix socket path over ~104 bytes fails to bind with EINVAL; agent dirs go directly under /tmp with a SHORT name (see `shortTempDir`, session-resume.e2e.test.ts:122). Run `bun run build` in packages/coding-agent before anything spawns dist/cli.js. NEVER run a whole-package suite — they flake under parallel load; run only your file: `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/executable-path-walk.test.ts`.

MUTATION TEST, in an isolated rsync copy and NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-exec
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does NOT isolate this monorepo: node_modules/@draht/* are relative symlinks into the shared tree (verified: node_modules/@draht/coding-agent -> ../../packages/coding-agent), so a worktree edit is visible to the supposedly isolated run. Do NOT exclude and do NOT symlink packages/*/dist — suites run a build in beforeAll and tsc follows a dist symlink back into the real tree; `rsync -a` copies dist as a real directory, which is what you want. ~3 GB, a few minutes; keep the copy and re-sync with `rsync -a --delete`. SANITY-CHECK ISOLATION FIRST with a mutation known to fail: in $DST only, revert (a) so the sticky exemption again applies to every component; run your test in $DST and confirm the sticky-regular-file case FAILS; then run the same test in $SRC and confirm it still passes. Only after that does a passing mutation result mean anything.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/gateway/src/session/spawn-primitive.ts packages/gateway/src/__tests__/executable-path-walk.test.ts

### W1-REGISTRY-LOADER — A user-owned registry file that is checked on every load and REFUSES

- **Wave** 1 · **Requirement** R36-SPAWN.3 · **Evidence class** 2 · **Depends on** nothing
- **Files** `packages/geist-protocol/src/config.ts`, `packages/geist-protocol/src/config-load.ts`, `packages/geist-protocol/src/index.ts`, `packages/geist-protocol/package.json`, `geist.yaml.example`, `packages/geist/src/index.ts`
- **Test** `packages/geist-protocol/test/config-load.test.ts`

You are building the secure loader for the user-owned harness/project registry. You see nothing of the conversation that produced this plan.

WHAT EXISTS: packages/geist-protocol/src/config.ts declares `AgentLaunchSpecSchema {cmd, args?}` (:7-10), `ProjectConfigSchema {root, name?}` (:20-23), `GeistConfigSchema {harness:{default,agents}, projects?, workspaceRoots?}` (:50-57) and `parseGeistConfig` (:65). `geist.yaml.example` at the repo root is the committed example. 46 unit tests are green.

WHAT IS FALSE ABOUT IT: NOTHING in this repo loads a geist.yaml at runtime — `parseGeistConfig` has zero non-test callers, and `yaml` is only a devDependency of this package (used by packages/geist-protocol/test/config.test.ts). The schema validates shape only: it accepts `cmd: './node_modules/.bin/pwn'`, `root: '../../etc'` and `workspaceRoots: ['/']`. `geist.yaml.example` itself ships `draht: { cmd: draht-acp }` — a bare PATH name, exactly what this phase forbids. And packages/geist/src/index.ts:28-41 `resolveConfigPath` prefers `<cwd>/geist.yaml` over `~/.geist/config.yaml`, i.e. a checked-out repo's own config outranks the user's.

BUILD:
1. NEW packages/geist-protocol/src/config-load.ts exporting `loadGeistConfigFile(path: string): GeistConfig` and `resolveUserRegistryPath(opts?): string`.
   `resolveUserRegistryPath` returns `--config`/explicit if given, else `~/.geist/config.yaml`. IT MUST NEVER CONSIDER cwd. That is the whole of R36-SPAWN.3's second clause in v1: the daemon reads no project-supplied config at all, so 'project-supplied config may reference only approved harness ids and canonical approved roots' is satisfied vacuously — and that fact gets written into docs by a sibling task, so do not silently widen it.
   `loadGeistConfigFile` runs ITS OWN security check on EVERY call, before reading a byte, and REFUSES rather than repairs:
     • lstat-walk the SUPPLIED path before any realpath. If you realpath first you will silently FOLLOW a symlinked registry path or a symlinked parent, and the two fixtures that exist to catch exactly that will pass vacuously.
     • the file and its parent directory must be `stats.uid === process.getuid()` — STRICTLY current-uid. Do NOT accept uid 0.
     • neither may be a symbolic link.
     • the file must satisfy `(mode & 0o077) === 0` — not group/world ACCESSIBLE, which is strictly stronger than 'not writable'. The parent must not be group/world writable.
     • throw a typed error naming which rule failed and which path. Never chmod anything.
   DO NOT reuse packages/gateway/src/session/spawn-primitive.ts:271 `assertSafeExecutablePath` for this and do not copy packages/gateway/src/config/config.ts:184 `ensureConfigPrivate`. The first accepts uid 0 (:293), masks only write bits (0o022) and exempts sticky paths — three quiet weakenings for a file that names executables. The second REPAIRS by chmod and never reads uid, which is the correct posture for the gateway token and the wrong one here. If both shapes end up looking alike, a future reader will 'unify' them and silently downgrade this one — say so in the module comment.
   Then parse YAML and delegate to `parseGeistConfig`. Promote `yaml` from devDependencies to dependencies in packages/geist-protocol/package.json (`^2.9.0`, already the pinned version).
2. In config.ts, add the two fields the rest of the phase needs and land them TOGETHER so the schema is touched once: `AgentLaunchSpecSchema.cmd` gains an absolute-path refinement (`.refine(p => isAbsolute(p))`), and `AgentLaunchSpecSchema` gains `credentialEnv?: string[]` — the env names THIS harness is allowed to receive, so a later task can stop handing every provider key to every harness. Also add `approvedRoots?: string[]` to `GeistConfigSchema`. Keep the module's stated posture: the schema is shape validation, and the refinement is a convenience, NOT the enforcement — a schema cannot know approved roots and validation is not race-safe. The resolver refuses at load AND the path walk re-verifies at launch.
3. Export the new surface from packages/geist-protocol/src/index.ts as explicitly named exports (a name reachable only via `export *` is treated as not exported by scripts/check-geist-mirrors.mjs and fails loudly).
4. Fix geist.yaml.example to absolute `cmd` values and add an `approvedRoots` example.
5. In packages/geist/src/index.ts, leave `resolveConfigPath` working but add a doc paragraph stating it is the CLI's cwd-preferring resolver and must never be used by the daemon, pointing at `resolveUserRegistryPath`. Do not change its behaviour.

TEST FILE: packages/geist-protocol/test/config-load.test.ts (new). Against real files in a `mkdtemp` under /private/tmp, cover: a clean 0600 file under a 0700 parent loads; mode 0644 refuses; a symlinked file path refuses; a symlinked PARENT refuses; a foreign-uid file refuses (see below); a relative `cmd` fails schema; an absolute `cmd` passes; `resolveUserRegistryPath` never returns a cwd path. FOREIGN-UID FIXTURE: you cannot `chown` without sudo. The only route on this machine is hardlinking a foreign-uid inode on the same device — `/private/var/db/mtrecorder.enable` (uid 0, mode 0644) hardlinks into a /private/tmp dir successfully; some others give EPERM. Probe-then-`test.skip` is the existing pattern (packages/gateway/src/__tests__/socket-ownership-hygiene.e2e.test.ts:351-392) — BUT a skipped security fixture is not evidence: if no hardlinkable inode exists, FAIL loudly with a message saying so rather than skipping quietly.

TRAPS: `rtk` mangles `grep`/`ls` output — use `sed -n`/`python3`/Read for anything load-bearing. `npx tsc --noEmit -p packages/<pkg>` prints 'No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the repo root. `npx biome` fails; use `./node_modules/.bin/biome`. Prefix spawns with `env -u DRAHT_PERMISSION_MODE`. Never run a whole-package suite; run `cd packages/geist-protocol && env -u DRAHT_PERMISSION_MODE bun test test/config-load.test.ts`.

MUTATION TEST, isolated rsync copy, NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-reg
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does not isolate this monorepo — node_modules/@draht/* are relative symlinks into the shared tree (node_modules/@draht/coding-agent -> ../../packages/coding-agent). Do NOT exclude or symlink packages/*/dist; suites build in beforeAll and tsc follows a dist symlink back into the real tree. ~3 GB, a few minutes. SANITY-CHECK ISOLATION FIRST with a mutation known to fail: in $DST only, change the mode check from `(mode & 0o077) === 0` to `(mode & 0o022) === 0`; run your test in $DST and confirm the 0644 case FAILS; run it in $SRC and confirm it still passes.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/geist-protocol/src/config.ts packages/geist-protocol/src/config-load.ts packages/geist-protocol/src/index.ts packages/geist-protocol/test/config-load.test.ts packages/geist/src/index.ts

### W1-CONTEXT-ROOT — Project context is a no-follow regular file inside an approved root

- **Wave** 1 · **Requirement** R36-SPAWN.6 · **Evidence class** 2 · **Depends on** nothing
- **Files** `packages/coding-agent/src/core/resource-loader.ts`, `packages/coding-agent/src/cli/args.ts`, `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/extensions/stub-provider/provider.ts`
- **Test** `packages/coding-agent/test/context-root-containment.test.ts`

You are closing GSEC-13 for automatically-read project context, and building the one recording seam its acceptance can use. You see nothing of the conversation that produced this plan.

WHAT IS BROKEN, proven by running the real code path: packages/coding-agent/src/core/resource-loader.ts:70-88 `loadContextFileFromDir` uses `existsSync` + `statSync(...).isFile()` + `readFileSync`. `statSync` FOLLOWS symlinks, so an `AGENTS.md` that is a symlink to a file outside the repo is read and returned, and those bytes reach `buildSystemPrompt` (system-prompt.ts:145) and therefore `Context.systemPrompt`. Separately, `loadProjectContextFiles` (:118-155) walks `dirname` in a `while(true)` up to `/` (:138-151), so an AGENTS.md two directories ABOVE the project root is loaded unconditionally. Both were verified by running the real functions with canary files.

WHAT IS ALREADY CORRECT — keep it: the `statSync(...).isFile()` check already refuses special files. A fifo at `<cwd>/AGENTS.md`, a symlink to /dev/zero, and a directory named AGENTS.md are all already skipped with no hang. Do not regress that.

BUILD:
1. `loadContextFileFromDir` takes the no-follow half: `lstatSync` FIRST and refuse a symbolic link outright; then `realpathSync` and assert canonical containment under a passed-in approved root (canonical containment with a separator boundary — `startsWith(root)` alone matches `/x/projects-evil` against `/x/projects`). Keep the existing `isFile()` special-file guard.
2. `loadProjectContextFiles` gains an optional `contextRoot?: string`. When set, the ancestor walk STOPS at that root instead of running to `/`. When unset, behaviour is byte-identical to today — discovered sessions must not change.
   CARVE-OUT: the agent-dir global context file loaded at :128 is a USER resource, not a project one, and stays exempt. Same shape as the `~/.agents/skills` exemption in trust-manager.ts.
   BOUNDARY CHOICE: the root is the PROJECT ROOT, not the session cwd. draht-mono itself has an AGENTS.md at the repo root that subdirectory sessions currently inherit; picking cwd would silently break that.
3. Plumb a `--context-root <absolute path>` flag through the existing three-file path, which is short and clean: packages/coding-agent/src/cli/args.ts (parse beside `--no-context-files` at :190; refuse a non-absolute value), packages/coding-agent/src/main.ts:840 (where `noContextFiles: parsed.noContextFiles` is passed), and `DefaultResourceLoaderOptions` in resource-loader.ts:158-172 → the field read at :272 → the call at :515-519.
4. THE RECORDING SEAM. packages/coding-agent/src/extensions/stub-provider/provider.ts:158 is `const respond: FauxResponseFactory = (context) => {`. Add an env-gated first-call-only dump of `context.systemPrompt` to a path named by a new `DRAHT_STUB_RECORD_CONTEXT` env constant, declared beside `STUB_PROVIDER_TOOL_CALLS_ENV` at :45. First call ONLY, and never throw out of the factory.
   DO NOT try to use the `before_provider_request` extension event for this. It NEVER FIRES under the stub provider: sdk.ts:338 wires it to the api layer's `onPayload`, every real adapter calls `onPayload`, and packages/ai/src/providers/faux.ts never does — proven by running a recorder extension that logged its own load and factory execution but never its payload. Anyone who reaches for that event will lose hours.

TEST FILE: packages/coding-agent/test/context-root-containment.test.ts (new). Against real fixtures under a /private/tmp mkdtemp: a symlinked AGENTS.md pointing outside is REFUSED (assert the canary content is absent from the returned array); an AGENTS.md above the contextRoot is not loaded; an AGENTS.md inside the root IS loaded (POSITIVE CONTROL — without it the test passes when the loader returns nothing at all); a fifo / directory / symlink-to-device is still skipped with no hang; with `contextRoot` unset the ancestor walk still reaches `/` exactly as before; the stub recorder writes `context.systemPrompt` once and only once when its env var is set, and writes nothing when it is not. Do not touch packages/coding-agent/test/resource-loader.test.ts — its worktree-dedup cases (around :950-1110) must keep passing untouched, and you should run it once locally to prove you did not break dedup, without editing it.

TRAPS: `rtk` mangles `grep`/`ls` output — use `sed -n`/`python3`/Read. `npx tsc --noEmit -p packages/coding-agent` prints 'No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the repo root. `npx biome` fails; use `./node_modules/.bin/biome`. Prefix spawns with `env -u DRAHT_PERMISSION_MODE`. Run `bun run build` in packages/coding-agent before anything spawns dist/cli.js. Never run a whole-package suite; run `cd packages/coding-agent && env -u DRAHT_PERMISSION_MODE bun test test/context-root-containment.test.ts`.

MUTATION TEST, isolated rsync copy, NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-ctx
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A worktree does not isolate this monorepo (node_modules/@draht/* are relative symlinks into the shared tree). Do NOT exclude or symlink packages/*/dist — suites run `npm run build` in beforeAll and tsc follows a dist symlink back into the real tree. SANITY-CHECK ISOLATION FIRST with a mutation known to fail: in $DST only, swap the new `lstatSync` back to `statSync`; run your test in $DST and confirm the symlink case FAILS; run it in $SRC and confirm it still passes.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/coding-agent/src/core/resource-loader.ts packages/coding-agent/src/cli/args.ts packages/coding-agent/src/main.ts packages/coding-agent/src/extensions/stub-provider/provider.ts packages/coding-agent/test/context-root-containment.test.ts

### W1-PROC-HELPERS — Process-table and attach-journey helpers the whole acceptance rides on

- **Wave** 1 · **Requirement** R36-SPAWN.8 · **Evidence class** 3 · **Depends on** nothing
- **Files** `packages/gateway/src/__tests__/helpers/process-table.ts`, `packages/gateway/src/__tests__/helpers/attach-journey.ts`
- **Test** `packages/gateway/src/__tests__/helpers-process-table.test.ts`

You are building the two shared test helpers that seven later acceptance suites import. Getting these right is what stops the 1541-line session-resume e2e from becoming the serialization point for every requirement in this phase. You see nothing of the conversation that produced this plan.

TODAY packages/gateway/src/__tests__/helpers/ contains only listening-sockets.ts. Everything below currently lives inline in packages/gateway/src/__tests__/session-resume.e2e.test.ts, which you must READ but MUST NOT EDIT (another task owns it; it is 23 pass / 0 fail / 56.7s today and must stay that way).

BUILD helpers/process-table.ts, exporting at least:
• `psRows()` → parsed rows from `ps -Awwo pid=,ppid=,pgid=,stat=,command=`. `-A` IS MANDATORY: without it, processes with no controlling terminal — which is every daemon-spawned child under test — are silently omitted. I verified this: a live bun child found by `-p <pid>` was reported absent by `ps -Eww -o pid=,command=` and present by `ps -AEww -o pid=,command=`.
• `liveGroupMembers(pgid)` → rows with that pgid whose `stat` does NOT contain `Z`. THE ZOMBIE TRAP: right after `killpg(SIGKILL)` the group leader stays in the table as `Z <defunct>` until its parent reaps it, so a naive 'no rows carry this pgid' assertion is false for a window whose length is the daemon's own reaping — in-process state by the back door. I verified both halves: unfiltered → `[(88229,88227,88229,'<defunct>')]`, Z-filtered → `[]`.
• `descendantsOf(pid)` → transitive children by walking ppid. `detached:true` does NOT reparent on darwin: the child gets its own session and pgid==pid but keeps ppid=spawner. That makes 'descendants of the daemon pid' a sound, race-free scope for a negative, instead of scanning a box that already carries ~1100 processes.
• `envOf(pid)` → the child's environment from `ps -Eww -o command= -p <pid>`, WITH A DOCUMENTED GUARD. macOS exposes a child's full environment for non-platform binaries (node, bun, homebrew python all leaked a planted canary) and NOTHING for SIP platform binaries — `/bin/sh`, `/bin/bash`, `/bin/sleep` return argv only, zero env bytes; I confirmed the mechanism independently through KERN_PROCARGS2. So `envOf` must either return a discriminated 'no environment visible for this binary' result or throw — it must never return an empty map that a caller can read as 'the canary is absent'. Give it a companion `assertEnvAbsent(pid, canaries, positiveControl)` that REQUIRES a positive control: a name the harness DID declare must be visible in the same ps output before any absence is asserted. An oracle that cannot see a present variable cannot prove one absent, and without this rule the grandchild canary passes forever while proving nothing.
• `deadlineIsNotAliveHelper`: do NOT reproduce `alive()` (session-resume.e2e.test.ts:188). `kill(pid, 0)` SUCCEEDS on a zombie — verified — so that helper reports a dead process as alive. Read `stat=` instead.
• `reapPgids(pgids)` for afterAll. NEVER `pkill -f` a generic pattern: parallel agents run draht e2es on this box and a generic pattern kills their sessions. Reap only recorded pgids with `try { process.kill(-pgid,'SIGKILL') } catch {}`.
• `uniqueMarker(label)` → a string embedding `${process.pid}-${Date.now()}` plus randomness, because every machine-wide scan needs a marker no sibling agent can collide with.
Also note in the module doc: SIP blocks dtrace on this machine (`csrutil status` → enabled; dtrace refuses to initialise), so there is NO exec oracle — 'no process was created' cannot be proven by any scan, since a process that execs and exits between the refusal and the sample is invisible. A tripwire FILE is the only race-immune negative.

BUILD helpers/attach-journey.ts, exporting `attachJourney(opts)` — the journey that packages/gateway/src/__tests__/fleet-attach.e2e.test.ts (around :329) and session-resume.e2e.test.ts (around :739) currently run as two hand-written, differently-worded copies: handshake → fleet snapshot → find the row → assert its shape → `attach` → send `input` → receive streamed assistant text → optionally answer a `permission_request` → `detach`. It must take the session id and a base/token and NOTHING that says which origin it is. Export a FROZEN_ROW_KEYS list — `id, cwd, pid, startedAt, origin, attachable, resumable, status, statusAt` — and assert the row's KEY SET equals it exactly, so a spawn-only extra field fails loudly. Read wire.ts's `AttachableSessionSchema` to confirm the list before freezing it.

TEST FILE: packages/gateway/src/__tests__/helpers-process-table.test.ts (new) — a self-test of the helpers against real processes you spawn and kill: `-A` finds a tty-less child that the non-`-A` form misses; a killed group leaves only a `Z` row and `liveGroupMembers` returns empty; `envOf` on a bun child shows a planted canary AND the positive control; `envOf` on `/bin/sh` reports 'not visible' rather than an empty map; `descendantsOf` finds a grandchild. Do not exercise `attachJourney` here — the suites that own an origin will.

CLASS-3 HYGIENE (this task is the source of it for everyone else, so live by it): assert against the OS process table, never in-process state; `-A` always; Z-filtered liveness; positive control on every env assertion; unique markers; pgid-scoped reaping from the first test.

TRAPS: `rtk` mangles `grep`/`ls` output — use `sed -n`/`python3`/Read. `npx tsc --noEmit -p packages/gateway` prints 'No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the repo root. `npx biome` fails; use `./node_modules/.bin/biome`. Prefix spawns with `env -u DRAHT_PERMISSION_MODE`. Unix socket paths over ~104 bytes fail to bind with EINVAL — short /tmp names only. Never run a whole-package suite; run `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/helpers-process-table.test.ts`.

MUTATION TEST, isolated rsync copy, NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-help
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A worktree does not isolate this monorepo (node_modules/@draht/* are relative symlinks into the shared tree). Do NOT exclude or symlink packages/*/dist. SANITY-CHECK ISOLATION FIRST with a mutation known to fail: in $DST only, drop the `Z` filter from `liveGroupMembers`; confirm the zombie test FAILS in $DST and still passes in $SRC.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/gateway/src/__tests__/helpers/process-table.ts packages/gateway/src/__tests__/helpers/attach-journey.ts packages/gateway/src/__tests__/helpers-process-table.test.ts

### W1-DOCS — Write the two statements the requirements say must be in the docs

- **Wave** 1 · **Requirement** R36-SPAWN.4 · **Evidence class** 2 · **Depends on** nothing
- **Files** `docs/geist/spec.md`
- **Test** `packages/gateway/src/__tests__/spawn-docs-contract.test.ts`

Two requirements in this phase demand something be 'stated in the docs', and neither statement exists anywhere in docs/. You see nothing of the conversation that produced this plan.

VERIFIED ABSENT: docs/ contains only releasing.md, tui-testing.md, adding-a-provider.md and geist/spec.md, and spec.md contains no occurrence of 'environment' or 'inherit'. The reasoning currently lives in .planning/phases/35-default-on/PLAN.md:708 and in the module comment at packages/gateway/src/session/spawn-primitive.ts:29-36. A planning file is not the docs.

WRITE, into docs/geist/spec.md, a new section on spawning that states:
1. THE ENVIRONMENT EXEMPTION (R36-SPAWN.4). Sessions geist SPAWNS receive an allowlist-BUILT environment — an absolute trusted PATH, runtime/locale/temp names, and only the harness's own declared auth — constructed from `{}` with no inheritance. Sessions geist merely DISCOVERS were started from Oskar's own shell and carry his environment by construction; geist cannot and does not filter them, and they are explicitly out of scope. Move the reasoning from .planning/phases/35-default-on/PLAN.md:708 rather than re-deriving it; cite the implementation at packages/gateway/src/session/spawn-primitive.ts:390 (`buildChildEnvironment`), its allowlist at :168 and :134, and its unconditional blocklist at :177-196 (which beats any operator declaration).
2. THE REGISTRY SCOPE (R36-SPAWN.3). The daemon resolves harness ids and project ids against a USER-OWNED registry only — `~/.geist/config.yaml` or an explicit `--registry` path — and reads NO project-supplied config. State plainly that packages/geist/src/index.ts:28-41 `resolveConfigPath`, which prefers `<cwd>/geist.yaml`, is the CLI's resolver and is deliberately not on the daemon path; and that the registry file and its parent are re-checked for current-uid ownership, non-symlink and non-group/world-accessibility on EVERY load, refusing rather than repairing.
Write both as product statements a reader can act on, not as changelog entries. Match the surrounding voice of spec.md.

TEST FILE: packages/gateway/src/__tests__/spawn-docs-contract.test.ts (new). Read docs/geist/spec.md from disk and assert both statements are present by anchoring on stable phrases you introduce (e.g. a heading id or a distinctive clause), not by matching prose you might later reword. Precedent for asserting on human-facing text lives in packages/gateway/src/__tests__/operator-refusal-text.test.ts. The point of this test is that the requirement's 'stated in the docs' clause has a failing mode; keep it narrow enough that ordinary editing does not break it and specific enough that deleting the statement does.

TRAPS: `rtk` mangles `grep`/`ls` output — use `sed -n`/`python3`/Read for anything load-bearing. `npx biome` fails; use `./node_modules/.bin/biome`. Prefix any spawn with `env -u DRAHT_PERMISSION_MODE`. Never run a whole-package suite; run `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/spawn-docs-contract.test.ts`.

MUTATION TEST, isolated rsync copy, NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-docs
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A worktree does not isolate this monorepo (node_modules/@draht/* are relative symlinks into the shared tree). Do NOT exclude or symlink packages/*/dist. SANITY-CHECK ISOLATION FIRST with a mutation known to fail: in $DST only, delete the environment-exemption paragraph from docs/geist/spec.md; confirm your test FAILS in $DST and still passes in $SRC.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/gateway/src/__tests__/spawn-docs-contract.test.ts

### W1-PROBE-EVIDENCE — Repair the RED status-honesty suite — the probe is hardened, its evidence is not

- **Wave** 1 · **Requirement** R36-SPAWN.4 · **Evidence class** 3 · **Depends on** nothing
- **Files** `packages/geist-core/src/attach/status-probe.ts`, `packages/gateway/src/__tests__/fleet-status-honesty.e2e.test.ts`
- **Test** `packages/gateway/src/__tests__/fleet-status-honesty.e2e.test.ts`

This task exists because a suite is RED at HEAD and its subject is the daemon's second process-creating surface. You see nothing of the conversation that produced this plan.

WHAT IS TRUE, and it is the opposite of what you may have been told: the git status probe is ALREADY HARDENED. packages/geist-core/src/attach/status-probe.ts:119-131 `gitExecutable()` resolves an ABSOLUTE path from a fixed candidate list (`/usr/bin/git`, `/bin/git`, `/usr/local/bin/git`, `/opt/homebrew/bin/git`) and never consults PATH except as a last-resort bare-name fallback; the argv at :299-322 carries `-c core.fsmonitor= -c core.hooksPath=/dev/null -c uploadpack.packObjectsHook= -c diff.external= --no-optional-locks`; and the child env is `probeEnvironment()` (:88-103), a five-key allowlist (PATH=/usr/bin:/bin:/usr/sbin:/sbin, GIT_TERMINAL_PROMPT, GIT_ASKPASS, SSH_ASKPASS, LC_ALL). I PROVED this by running it: a repo whose `.git/config` set `core.fsmonitor` to a script doing `env > leaked-env.txt`, probed through the real `GitStatusProbe.refresh()` under a planted `DAEMON_CANARY_ZULU`, returned `{"status":"dirty"}` and created NO leaked file. DO NOT re-harden this. There is nothing to fix in the probe's security posture.

WHAT IS BROKEN: the acceptance for it. packages/gateway/src/__tests__/fleet-status-honesty.e2e.test.ts still installs its fixture git by prepending a shim directory to the daemon's PATH (:288-292, :490), and its module doc at :12-24 asserts as MEASURED that 'every git call site in this repo spawns the bare string git ... with no absolute path, no GIT_BIN override'. That is stale — the hardening removed the lookup the shim depended on. I RAN the suite: 2 pass, 6 FAIL. So R35-ALWAYS.8's honesty guarantees (probe failure and probe timeout yield `unknown`, never `clean`, never a terminal value) are currently unproven, and this phase's canary work would sit next to a red suite.

BUILD:
1. Give the probe a single, explicitly-operator-scoped absolute-path seam so a fixture git can be installed without PATH: read one env name (e.g. `GEIST_GIT_BIN`) BEFORE the candidate list in `gitExecutable()`. It must be treated exactly like the daemon's `DRAHT_BIN`: absolute-only, and canonicalized + ownership-walked before use, so the seam is not a new way to choose what executes. `probeEnvironment()` must NOT gain the name — the probe child has no business seeing it. Document at the call site that this is an operator declaration, never a remote or repository-supplied value, and that a declared path that does not resolve is an ERROR and never a reason to fall back to the candidate list.
2. Rewrite the suite's shim mechanism to use that seam instead of PATH, and update the stale module doc at :12-24 to say what is now true: git is resolved absolutely, the repository's own config cannot choose the binary or run a hook, and the fixture is installed by declaration. Keep every existing assertion's INTENT — three shims, three daemon runs, and the reason the third is not redundant — do not weaken an assertion to make it pass. If an assertion's subject no longer exists, delete it and say so in the commit body rather than turning it into a tautology.
3. Add ONE new assertion while you are here, because it is the cheapest place it will ever be: a repo whose `.git/config` sets `core.fsmonitor` to a script that writes a tripwire file is probed, the fleet row comes back with a real status, and the tripwire file does NOT exist. That is the regression test the hardening never got.

TEST FILE: packages/gateway/src/__tests__/fleet-status-honesty.e2e.test.ts (the file you are repairing). Target: 8 pass / 0 fail.

CLASS-3 EVIDENCE RULES: assert against the OS process table, never in-process state. `ps -Awwo pid=,ppid=,pgid=,stat=,command=` — `-A` is MANDATORY or tty-less children are invisible. `kill(pid,0)` SUCCEEDS on a zombie, so never poll it for liveness; read `stat=` and treat a row containing `Z` as dead. `ps -Eww` shows a bun/node child's full env and NOTHING for SIP platform binaries (/bin/sh, /bin/bash) — any env assertion needs a POSITIVE CONTROL in the same output first. SIP blocks dtrace, so 'nothing ran' must be proven with a tripwire FILE, not a scan. Markers must embed `${process.pid}-${Date.now()}`. Reap by recorded pgid in afterAll; never `pkill -f` a generic pattern.

TRAPS: `rtk` mangles `grep`/`ls` output — use `sed -n`/`python3`/Read. `npx tsc --noEmit -p packages/<pkg>` prints 'No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the repo root. `npx biome` fails; use `./node_modules/.bin/biome`. Prefix spawns with `env -u DRAHT_PERMISSION_MODE`. Short /tmp paths only (unix sockets die past ~104 bytes). Run `bun run build` in packages/coding-agent first. Never run a whole-package suite; run `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/fleet-status-honesty.e2e.test.ts`.

MUTATION TEST, isolated rsync copy, NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-probe
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A worktree does not isolate this monorepo (node_modules/@draht/* are relative symlinks into the shared tree). Do NOT exclude or symlink packages/*/dist — this suite builds in beforeAll and tsc follows a dist symlink back into the real tree. SANITY-CHECK ISOLATION FIRST with a mutation known to fail: in $DST only, replace `env: probeEnvironment()` with `env: {...process.env}`; confirm your new fsmonitor-tripwire assertion FAILS in $DST and still passes in $SRC.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/geist-core/src/attach/status-probe.ts packages/gateway/src/__tests__/fleet-status-honesty.e2e.test.ts

## Shared files — orchestrator only

- package.json (root) — the `check:no-free-text-command` entry in the `check` script and the `scripts/geist-console-spawn-picker.e2e.test.mjs` entry in `test:scripts:serial`. No task may edit this file; the integrator wires both lines once, after W2-COMMAND-GATE and W5-CONSOLE-PICKER land.
- packages/geist-protocol/test/wire-0.4-fields.test.ts:79 — `expect(GEIST_PROTOCOL_VERSION).toBe("0.4")`. Shared line; must move to "0.5" with the wire batch. Integrator applies it, not W2-WIRE-BATCH.
- packages/geist-protocol/test/wire-auth-frames.test.ts:103 — same pinned literal, same rule.
- packages/gateway/src/__tests__/permission-frame-wire.e2e.test.ts:288 — same pinned literal, same rule.
- packages/gateway/src/__tests__/socket-ownership-hygiene.e2e.test.ts:249 — a hardcoded `version: "0.4"` inside a hello frame. Same rule. (These four are the COMPLETE set: I enumerated every literal "0.4" in .ts/.js/.mjs/.kt outside conformance/ and there are exactly five including wire.ts:49 itself.)
- packages/gateway/src/__tests__/session-resume.e2e.test.ts — READ-ONLY for the whole phase. 1541 lines, 23 pass / 0 fail / 56.7s at HEAD, with five real `ps` assertions and describes already labelled R36-SPAWN.1/.2/.4/.5/.7. Every task reads it as prior art; NO task edits it. The parameterised origin journey goes in a new file so this one is not the serialization point for the phase.
- packages/gateway/src/__tests__/fleet-attach.e2e.test.ts — READ-ONLY. It is the discovered-origin journey the shared helper is extracted from; leaving it untouched is what makes 'the identical script passes against both origins' a claim about the new file rather than a rewrite of this one.
- .planning/STATE.md, .planning/execution-log.jsonl, .planning/ROADMAP.md — orchestrator-owned.

## Ordering constraints

- I OVERRODE BOTH THE MAP AND ADVISOR 1 ON THE GIT STATUS PROBE, ON EVIDENCE I RAN. The map and Advisor 1 call the fleet status probe a live GSEC-03 hole ('the most consequential real finding') that executes a hostile repo's `.git/config core.fsmonitor` with the daemon's full environment. That is STALE at HEAD. packages/geist-core/src/attach/status-probe.ts:119-131 resolves git absolutely from a fixed candidate list; :299-322 passes `-c core.fsmonitor= -c core.hooksPath=/dev/null -c uploadpack.packObjectsHook= -c diff.external= --no-optional-locks`; :88-103 `probeEnvironment()` is a five-key allowlist. I built the hostile fixture, ran the real `GitStatusProbe.refresh()` under a planted canary, and got `{"status":"dirty"}` with NO leaked env file. NO HARDENING TASK IS PLANNED. Running code beats both the map and the advisor.
- WHAT I FOUND INSTEAD, ALSO BY RUNNING: packages/gateway/src/__tests__/fleet-status-honesty.e2e.test.ts is RED at HEAD — 2 pass / 6 FAIL — because it still installs its fixture git by prepending a shim dir to PATH (:288-292), which the hardened probe no longer consults. R35-ALWAYS.8's honesty guarantees are currently unproven. The brief's own rule ('if a requirement is satisfied, plan only its EVIDENCE if the evidence is missing') puts this squarely in scope, so W1-PROBE-EVIDENCE repairs the suite via a canonicalized operator-only `GEIST_GIT_BIN` seam. Advisor 2's warning to keep this out of the .1 wiring commit is honoured: it is its own task, its own wave-1 slot, its own commit.
- ADVISOR OVERRIDE — R36-SPAWN.5 NAMES THE WRONG FILE. The requirement says the spawn 'never bypasses coding-agent/src/cli/project-trust.ts'. That file is a ~60-line UI-context factory that returns undefined/false for every prompt outside interactive mode. The real decision function is `resolveProjectTrusted` in packages/coding-agent/src/core/project-trust.ts:46 over `ProjectTrustStore` in core/trust-manager.ts:208. The gateway calls NEITHER — it hand-mirrors the store in `projectExplicitlyUntrusted` (spawn-primitive.ts:460), which the file documents as deliberate. Planned per the advisors: keep the mirror as a pre-spawn veto AND pass `--no-approve` in the spawn argv, which is the reachable half.
- ADVISOR OVERRIDE — 'STARTS UNTRUSTED' IS NOT SATISFIED TODAY AND IS THE MOST LIKELY REQUIREMENT TO BE DECLARED DONE WHILE BROKEN. The existing explicit-`false` veto already passes, so the requirement looks green. But the map RAN the built CLI: with `trust.json` recording `true` for the project, or `defaultProjectTrust: "always"` globally, a spawned session loads the project's own `.draht/extensions`. `--no-approve` (args.ts:203-204 → main.ts:794-800) defeats both, verified by running. W2-SPAWN-POSTURE builds it, W3-LAUNCH puts it in the argv, W5-TRUST-TRIPWIRE proves it with an extension that touches a tripwire file.
- ADVISOR OVERRIDE — FIXTURE 1 (a raw `command` array) IS UNEXPRESSIBLE ON THE SPAWN PATH. `session_spawn` carries two opaque ids by construction, so there is no field to reject. It stays exactly where it already passes — the legacy HTTP regression at packages/gateway/src/__tests__/sessions-create-command.test.ts (10 pass, seven distinct malformed shapes) — plus the new source-level gate. It is NOT re-tested as a spawn refusal.
- ADVISOR OVERRIDE — FIXTURE 3 (a PATH-shadowing binary) IS NOT A REFUSAL. The resolver never consults PATH, so there is nothing to refuse; the honest assertion is a POSITIVE one: the shim's marker file is never written. That is also the only race-immune negative available, because SIP blocks dtrace and no exec oracle exists.
- ADVISOR OVERRIDE — R36-SPAWN.5's 'a trust grant delivered as a renderer or model answer is rejected' HAS NO SEAM AND IS NOT TESTED AS WRITTEN. There is no trust field on the wire, no tool writes trust.json, trust resolves at session startup before any provider turn, and `loadProjectTrustExtensions` forces `setProjectTrusted(false)` before the pre-trust pass so project extensions cannot answer. Replaced with two things that can fail: a source-level proof that packages/gateway and packages/geist* contain zero trust WRITERS, and the reachable 'untrusted despite a standing local grant' tripwire.
- ADVISOR OVERRIDE — THE GRANDCHILD ENV CANARY MUST NOT BE READ VIA `ps` ON A SHELL. I confirmed macOS exposes a child's full environment through `ps -Eww` for bun/node and NOTHING for SIP platform binaries (/bin/sh, /bin/bash, /bin/sleep). A canary assertion against a shell grandchild is vacuously green forever. Force a bun/node grandchild (the `subagent` tool spawns `bun dist/cli.js` and is readable), and require a POSITIVE CONTROL in the same ps output before any absence claim.
- ADVISOR OVERRIDE — THE REGISTRY FILE CHECK MUST BE A DISTINCT FUNCTION. `assertSafeExecutablePath` accepts uid 0 (spawn-primitive.ts:293), masks only write bits (0o022), and exempts sticky paths so a registry under /tmp would pass. `ensureConfigPrivate` (gateway/src/config/config.ts:184) repairs by chmod and never reads uid. Reusing or copying either is a silent security downgrade for a file that names executables. W1-REGISTRY-LOADER writes its own, and its module comment must say why unifying them later would be a regression.
- ADVISOR OVERRIDE — THE REGISTRY LOADER MUST lstat-WALK THE SUPPLIED PATH BEFORE realpath. If it copies the executable pattern (realpath first), the symlinked-registry and symlinked-parent fixtures are silently FOLLOWED and pass vacuously. This is the same defect I confirmed by running against the executable walk: `DRAHT_BIN` pointing through a symlinked directory resolved ALLOWED.
- ADVISOR OVERRIDE (v1 SCOPE CUT) — THE DAEMON READS NO PROJECT-SUPPLIED CONFIG. `resolveConfigPath` (packages/geist/src/index.ts:28-41) prefers `<cwd>/geist.yaml` over `~/.geist/config.yaml`, which is R36-SPAWN.3 inverted. The daemon gets its own `resolveUserRegistryPath` that never considers cwd. R36-SPAWN.3's second clause is therefore satisfied VACUOUSLY, which is only legitimate because it is stated in docs (W1-DOCS) and proven positively (W5-ADVERSARIAL-REGISTRY asserts a project-local geist.yaml is IGNORED, not that it is refused).
- ADVISOR OVERRIDE — FIXTURE 9 (a project config naming an unregistered harness) IS REFRAMED for the same reason: with no project config on the daemon path it tests an unexpressible input. It becomes the positive 'only the user registry resolves' assertion plus a genuine 'an unregistered harness id on the wire is refused with a typed code and no process' case.
- ADVISOR OVERRIDE — v1 REGISTRY EXCLUDES workspaceRoots DISCOVERY AND recents FROM THE SPAWN-SELECTING PATH. `discoverWorkspaceProjects` (workspace-discovery.ts:31,37) uses `existsSync`, which follows symlinks, with no ownership check; `FileRecentsStore.load()` (recents-store.ts:70-79) degrades a corrupt or attacker-written file to `[]` silently and `save()` mkdirs with no mode. Spawn resolution uses explicit `projects` + `harness.agents` only. They may feed a picker later.
- ADVISOR OVERRIDE — NO 'pending'/'starting' FLEET ROW. It would be an artifact only spawned sessions carry, which breaks the frozen row shape R36-SPAWN.8 depends on. The phone rides the synchronous `session_spawned` response, exactly as resume already does, bounded by the spawn deadline.
- ADVISOR OVERRIDE — ALL WIRE CHANGES LAND IN ONE BATCH, BEFORE PHASE 38 FREEZES geist/1.0. That batch is `session_spawn`/`session_spawned` AND the registry-listing pair the picker cannot exist without. DECIDED, because Advisor 2 flagged it as a decision that gates the batch: `registry_resync` (client) → `registry` (server), mirroring `fleet_resync`→`fleet`. ALSO DECIDED: NO stop frame. R36-SPAWN.7's stop deadline attaches to a daemon-internal `stop()`; putting a stop on the wire before the freeze is a bigger commitment than the requirement asks for.
- THE VERSION BUMP IS REAL AND ITS RIPPLE IS EXACTLY FIVE LINES. Adding a frame type requires 0.4 → 0.5, a `## geist/0.5` section in packages/geist-protocol/conformance/MIGRATIONS.md, and a new conformance corpus directory (0.1–0.4 already exist, generated by `npm run generate:geist-conformance` against scripts/geist-conformance/reference-daemon.mjs and record.mjs). I enumerated every literal "0.4" outside conformance/: wire.ts:49 plus four test pins, all listed in sharedFiles.
- CLASS-3 MEANS THE REGISTRY CANNOT BE VERIFIED ON ITS OWN. Nothing in the registry produces a process, so every R36-SPAWN.3 claim is proven THROUGH a spawn. Registry CODE lands in wave 1–2; its ACCEPTANCE is a wave-5 suite that drives the emitted daemon. A plan that sequenced 'registry suite first, spawn suite later' would have an unverifiable first half.
- EXACTLY ONE SPAWNER INSTANCE PER DAEMON. fleet.ts:562 constructs the single `SessionResumer`, hoisted out of the per-frame closure for a reason its own comment at :549-561 records: a per-frame instance gives each frame its own empty in-flight set, i.e. the per-connection guard that bounded nothing. W4-DAEMON-WIRING reuses that instance for spawns and extends `#inFlight` keying to cover both the minted session id and the `project:harness` pair — a freshly minted uuid is unique by construction and bounds nothing on its own.
- THE REGISTRY IS A PROVIDER ASKED PER FRAME, NOT A VALUE CAPTURED AT CONSTRUCTION. R36-SPAWN.3 says 'on every load'. fleet.ts:170-185 records the identical lesson for the device store: reading it once while routes were built froze the answer and made first-ever pairing require a restart.
- THE SPAWNED SESSION'S ID IS MINTED BY THE DAEMON AND PASSED AS `--session-id`, which is what lets the existing readiness machinery work for a session with no history row. Two frictions to design around, both verified in source: main.ts:486-492 prints `Warning: No project session found with id '<uuid>'; creating a new session with that id.` to stderr on EVERY fresh spawn, so the 2 KB stderr prefix the spawner retains (spawn-primitive.ts:557) starts non-empty and a `spawn_failed` message will quote it; and `validateSessionIdFlags` (main.ts:361-373) exits 1 if `--session-id` is combined with `--session`/`--continue`/`--resume`, so spawn and resume stay two argvs sharing one post-spawn block.
- THE POST-SPAWN BLOCK IS SHARED, NEVER COPIED. Everything from spawn-primitive.ts:672 down — listeners-attached-before-any-early-return, the bounded stderr drain that must never close the read end (SIGPIPE kills the session), the lock-owner-pid readiness poll at :709-726, the deadline, `#release`, `#teardown` — is origin-agnostic. Sharing it is most of what makes R36-SPAWN.8 true for free; duplicating it is how the two origins drift apart.
- spawn-primitive.ts IS THE COLLISION HOTSPOT AND IS OWNED BY EXACTLY ONE TASK PER WAVE: W1-EXEC-WALK (wave 1, the path walk), W2-DEADLINES-STOP (wave 2, deadlines/stdout/stop), W3-LAUNCH (wave 3, `launch()` + registry resolution + argv + credentialEnv plumb). This is the single reason the gateway track cannot fan out, and it is why the helper extraction (W1-PROC-HELPERS) happens in wave 1 — otherwise every requirement queues on the 1541-line e2e as well.
- `before_provider_request` IS DEAD UNDER THE STUB PROVIDER AND MUST NOT BE USED AS THE R36-SPAWN.6 RECORDING SEAM. sdk.ts:338 wires it to the api layer's `onPayload`; every real adapter calls `onPayload` and packages/ai/src/providers/faux.ts never does. A recorder extension loads and its factory runs, but the payload hook never fires. The seam is the stub factory itself (packages/coding-agent/src/extensions/stub-provider/provider.ts:158), env-gated and first-call-only, carried into a spawned child through `DRAHT_RESUME_ENV_ALLOW` exactly as `DRAHT_STUB_TOOL_CALLS` already is.
- EVERY ENV ASSERTION PAIRS AN ABSENCE WITH A POSITIVE CONTROL, and every containment assertion pairs 'the out-of-root canary is absent' with 'the in-root canary IS present'. Without the positive half, a loader that returns nothing and an oracle that can see nothing both pass forever.
- `alive()` (session-resume.e2e.test.ts:188) IS NOT A LIVENESS ORACLE. `kill(pid,0)` succeeds on a zombie — verified on this box — so any `until(() => !alive(pid))` loop is waiting on the daemon's own libuv reaping, which is the in-process state this acceptance explicitly excludes. Read `stat=` from `ps` and treat `Z` as dead. `-A` is mandatory on every scan or tty-less children are invisible.
- DELETE THE `command` PARAMETER RATHER THAN ARGUE ABOUT IT. Both advisors call this a must: `SessionProcess` still wraps `Bun.spawn(command, …)` (session-process.ts:79) reachable from `Session.create` (session.ts:64-72) and `SessionManager.create` (session-manager.ts:51). The one production callsite passes `undefined` unconditionally (sessions.ts:185); every other caller is a test. W4-COMMAND-SURFACE removes the parameter chain so R36-SPAWN.1's 'only spawn path' is SHOWN. Its blast radius is real and named in the task: tests whose only subject is a command-created process must be deleted, not weakened into tautologies.
- BUILD packages/coding-agent ONCE PER WAVE, not per suite. Wave 5 has seven e2e files that would otherwise each run a build in `beforeAll` and contend on packages/coding-agent/dist. Session-resume's own beforeAll (:497-500) takes ~56s for the whole file today; wave 5 will be the slowest part of this phase by a wide margin.
- BASELINE, MEASURED AT THE START OF THIS PHASE so a later regression is attributable: `bun test src/__tests__/session-resume.e2e.test.ts` → 23 pass / 0 fail / 130 expect() / 56.7s. `bun test src/__tests__/fleet-status-honesty.e2e.test.ts` → 2 pass / 6 FAIL (pre-existing, W1-PROBE-EVIDENCE owns it). Any task that reduces the first number has broken something.

## Open for Oskar

- Does RESUME also get `--no-approve`, or only SPAWN? Advisor 2 flagged this as a decision that must be explicit. Giving it to both means sessions resumed from the phone stop loading `.draht/extensions`, `.draht/settings.json`, `SYSTEM.md` and `.agents/skills` even for repos you trust on the Mac — the first phone session that behaves differently from the terminal will read as a bug. Giving it only to spawn means two postures on one wire.
- What is the LOCAL re-grant path for a phone-spawned session? R36-SPAWN.5 requires trust to be granted only through the local machine, but there is no flow today that turns a running untrusted spawned session into a trusted one without restarting it. Advisor 1: this must be designed in the same change, not after.
- `DRAHT_CODING_AGENT_DIR` crosses into the child by design (spawn-primitive.ts:409), and that directory is the root for `auth.json` (auth-storage.ts:31,181,263), which holds EVERY provider's credential. Per-harness `credentialEnv` scoping fixes the ENVIRONMENT half of 'only that harness's declared auth' and does nothing about the FILE half. Is env-only scoping acceptable for v1?
- Is a spawned session the daemon's child? `detached:true` (spawn-primitive.ts:663) is documented as a deliberate open decision ('a resumed session is a session, not a daemon worker') and .planning/CONTINUE-HERE.md already lists it as unresolved. Deciding it for resume decides it for spawn: a daemon restart mid-spawn leaves a process the new daemon did not start and cannot TERM→KILL by handle.
- Confirm the wire batch contents before it is written, because Phase 38 freezes geist/1.0 one phase later: `session_spawn`/`session_spawned` plus `registry_resync`/`registry` (I decided yes — the picker cannot exist without it and a second wire change after this phase is exactly what the freeze forbids), and NO stop frame (I decided no — stop stays daemon-internal). Both are reversible now and expensive later.
- Excluding workspaceRoots discovery and recents from the spawn-selecting registry means the phone's project picker shows only what you wrote in `~/.geist/config.yaml`'s `projects` map. That is a smaller list than the registry was designed to produce. Acceptable for v1?
- packages/gateway/src/__tests__/fleet-status-honesty.e2e.test.ts is RED at HEAD (2 pass / 6 fail) because the probe was hardened and its test's PATH-shim mechanism was not updated. I have planned the repair into this phase — say if you would rather it be its own fix outside Phase 36.
- packages/geist-acp/src/acp-harness-session.ts:462 spawns `launchSpec.cmd` by bare PATH lookup with NO `env` option, so the child inherits the daemon's entire environment — I confirmed this is DORMANT (no production caller; only tests). This phase does not touch it, on the grounds that Phase 36's registry-driven path is the one that ships. But Phase 38's `runGeist()` composition root is where it becomes reachable from a phone. Do you want a structural gate now, or a note on Phase 38?

---

# Wave 2 — execution plan
> Produced 2026-08-22 by workflow `wf_342f2968-f3f` (max-effort planner) after wave 1 landed.

## Wave 2 design

WAVE 2 IS A BUILD WAVE AND CLOSES NOTHING — say so out loud. All six tasks are evidence class 2. Nothing in wave 2 can be class 3, because no spawn reaches the wire until W4 wires `session_spawn` into fleet.ts, and the daemon's only process-creating surface today is `resume()`. Wave 2 builds the six surfaces wave 5's class-3 suites drive, and every brief says explicitly which requirement it does NOT close.

WHAT WAVE 1 LEFT DANGLING, verified at HEAD (147e78929), and where wave 2 puts each one:
(1) `canonicalize(candidate, uid, what, {followSymlinks, approvedRoots, forbiddenRoots})` is exported from spawn-primitive.ts:425 and has ZERO production callers passing roots — the daemon still accepts an absolute project-local `node_modules/.bin/draht` named by `DRAHT_BIN`. W2-HARNESS-RESOLVE is its first caller.
(2) `resolveUserRegistryPath`/`loadGeistConfigFile`/`assertPrivateRegistryFile` (packages/geist-protocol/src/config-load.ts) have ZERO production callers. W2-HARNESS-RESOLVE is their first.
(3) A THIRD zero-caller the brief did not name: `--context-root` (args.ts:200-212 → main.ts contextRoot) is parsed and plumbed and nothing passes it. W2-SPAWN-ARGV is its first caller.
(4) The stub recorder `DRAHT_STUB_RECORD_CONTEXT` (`STUB_PROVIDER_RECORD_CONTEXT_ENV`, provider.ts:65) is witnessed but unused by any spawn-shaped test. W2-SPAWN-ARGV uses it as the assertion surface for both halves of GSEC-13.

THE WIRE BATCH IS ONE TASK AND ITS CONTRACT IS FROZEN HERE so five other tasks can be written against it without depending on it. Frozen verbatim, and no task may vary it: client `session_spawn {harnessId, projectId}` (two registry ids, nothing else — no path, no cwd, no argv, no env), client `registry_resync {}` (no fields, mirroring `fleet_resync`), server `session_spawned {sessionId?, ok, code, message}` with `SessionSpawnCodeSchema = ["spawned","unknown_harness","unknown_project","refused","spawn_failed","timeout"]`, server `registry {harnesses[], projects[]}` where a harness row is `{id, isDefault}` and NEVER its `cmd`, and a project row is `{id, name, root}`. `sessionId` is optional because the daemon MINTS it and a refusal has none to name — that is the one shape difference from `session_resumed`, whose id the client supplied. Capabilities `"session-spawn"` and `"registry"`, advertised only when the port exists, exactly as `SESSION_RESUME_CAPABILITY` is at attach-bridge.ts:804.

THE FOUR VERSION PINS MOVE WITH THE BATCH — I am overriding the wave-1 plan's "orchestrator only" assignment for them. I re-enumerated every literal `"0.4"` in .ts/.js/.mjs/.kt/.swift outside conformance/ at HEAD and there are exactly five, unchanged since wave 1: wire.ts:49 plus wire-0.4-fields.test.ts:79, wire-auth-frames.test.ts:103, permission-frame-wire.e2e.test.ts:288 and socket-ownership-hygiene.e2e.test.ts:249. No other wave-2 task touches any of those four files, so the collision the orchestrator-only rule existed to prevent cannot occur, and splitting a version bump from the pins that assert it leaves the tree red between two commits for no gain. Wave 1's `attach-journey.ts` correctly uses `GEIST_PROTOCOL_VERSION` and is unaffected.

spawn-primitive.ts IS STILL THE HOTSPOT AND HAS EXACTLY ONE WAVE-2 OWNER: W2-DEADLINES-STOP. Two sibling tasks IMPORT from it (`canonicalize`, `SpawnRefusedError`, `resolveDrahtExecutable`, `ResolvedExecutable`) and must not edit it; the owner is forbidden from changing those four signatures for the same reason.

THE DEADLINE DESIGN, defaults chosen so today's behaviour is byte-identical: `spawnDeadlineMs` (2 000, pid must exist), `handshakeDeadlineMs` (30 000 — today's `DEFAULT_RESUME_DEADLINE_MS`, so session-resume.e2e stays 23/0 at 56.7 s), `firstOutputDeadlineMs` (30 000, i.e. OFF by default and non-fatal by construction — lowering it can only shorten a wait that was already going to end in `timeout`, so it can never kill a session that binds), `stopDeadlineMs` (2 000 — today's `teardownGraceMs`). The last commit on this branch is "keep a silent /attach alive": silence must never be fatal, and this design is built so it cannot become fatal by accident.

THE `stdout: "ignore"` QUESTION IS SETTLED BY MEASUREMENT, NOT BY ME. Piping it costs the daemon a wakeup per chunk forever (you cannot un-pipe: `pause()` deadlocks the child on a full 64 KB pipe, `destroy()` gives it SIGPIPE and kills the session). Whether that cost is zero depends on whether an rpc-mode session with an idle stdin ever writes to stdout, which I did not measure. The brief requires the implementer to measure it across a real attached turn and record the number either way.

THE REGISTRY RESOLVER IS MECHANISM-ONLY AND READS `projects` + `harness.agents` ONLY. `ProjectRegistry` (geist-core/src/registry/project-registry.ts) merges yaml ∪ workspaceRoots-discovery ∪ recents and is deliberately NOT used: discovery is `existsSync` with no ownership check and recents degrades a corrupt file to `[]` silently. The resolver declares its own three-member refusal union and W4 maps it to the wire codes with an exhaustive switch, so the resolver needs no dependency on geist-protocol's wire half and drift fails at compile time in W4 rather than silently on the wire.

ONE NEW OPEN QUESTION SURFACED WHILE PLANNING, and I did not plan around an answer: R36-SPAWN.8 requires a spawned session to be indistinguishable from a discovered one, which only a harness that publishes an attachable socket can satisfy. A registry entry like `codex: {cmd: /usr/local/bin/codex-acp}` would spawn, publish nothing, and time out after 30 s. The resolver therefore takes an optional `spawnableHarnessIds` and W4's call site decides in one line.

## Wave 2 ordering constraints

- THE WIRE BATCH IS ONE TASK. W2-WIRE-BATCH owns wire.ts, geist-protocol/src/index.ts, MIGRATIONS.md, the regenerated conformance/geist-0.5 corpus, the two conformance harness files, attach-bridge.ts's new cases and capability strings, AND the four pinned `"0.4"` literals. Splitting any of it across commits leaves the daemon refusing or silently dropping its own frames: an undeclared type is `unknown_type` + close 1008, and a declared type with no bridge case is a frame the phone waits on forever.

- I OVERRODE THE WAVE-1 PLAN'S "Shared files — orchestrator only" RULE FOR THE FOUR VERSION PINS. wire-0.4-fields.test.ts:79, wire-auth-frames.test.ts:103, permission-frame-wire.e2e.test.ts:288 and socket-ownership-hygiene.e2e.test.ts:249 are edited by W2-WIRE-BATCH itself. Re-enumerated at HEAD: exactly five literal "0.4" occurrences outside conformance/, the same five wave 1 recorded. No other wave-2 task opens any of those files. The integrator's remaining root package.json duties are unchanged.

- spawn-primitive.ts HAS EXACTLY ONE WAVE-2 OWNER: W2-DEADLINES-STOP. W2-HARNESS-RESOLVE and W2-SPAWN-ARGV import `canonicalize`, `SpawnRefusedError`, `SpawnRefusalCode`, `resolveDrahtExecutable` and `ResolvedExecutable` from it and MUST NOT edit the file; W2-DEADLINES-STOP MUST NOT change those five exported signatures. W3-LAUNCH owns the file in wave 3.

- W2-COMMAND-GATE LEAVES scripts/root-test-script-parity.test.mjs RED BY CONSTRUCTION, and that is expected. That gate fails when a `scripts/*.test.mjs` exists that `npm test` never reaches. The integrator closes it in the wave-integration commit with exactly two edits to root package.json: append ` && npm run check:no-free-text-command` to the `check` script, add `"check:no-free-text-command": "node scripts/check-no-free-text-command.mjs"`, and append ` scripts/check-no-free-text-command.test.mjs` to `test:scripts`. No task may edit root package.json.

- W2-SPEC-FRAMES IS THE WAVE'S ONLY SEQUENCED TASK: its contract test asserts the new frame symbols exist in wire.ts, so it must run AFTER W2-WIRE-BATCH has landed in the tree. If the symbols are absent the test fails — WAIT or rebase; do not weaken the assertion into a spell-check.

- docs/geist/spec.md CITES IMPLEMENTATION BY SYMBOL, NEVER BY `file.ts:390`. spawn-docs-contract.test.ts enforces this with `assertNoLineCitations`, because three tasks edit spawn-primitive.ts across this phase and a line number written into a public spec is wrong before the phase lands.

- packages/gateway/src/__tests__/session-resume.e2e.test.ts AND fleet-attach.e2e.test.ts STAY READ-ONLY FOR THE WHOLE PHASE. Baseline to protect: session-resume is 23 pass / 0 fail / 130 expect() / 56.7 s. Any task that lowers that number has broken something. Every wave-2 task reads them as prior art; none edits them.

- DEADLINE DEFAULTS MUST PRESERVE TODAY'S BEHAVIOUR EXACTLY. handshakeDeadlineMs defaults to 30 000 (today's DEFAULT_RESUME_DEADLINE_MS) and stopDeadlineMs to 2 000 (today's DEFAULT_TEARDOWN_GRACE_MS). `SessionSpawnerOptions.deadlineMs` and `.teardownGraceMs` keep working as aliases — fleet.ts and four e2e suites construct SessionSpawner and SessionResumer today.

- THE FIRST-OUTPUT DEADLINE IS NON-FATAL BY CONSTRUCTION. It defaults equal to the handshake deadline, so it can only ever shorten a wait that was already ending in `timeout`, and it can never kill a session that binds. HEAD's most recent commit is `fix(gateway): keep a silent /attach alive` — a silent healthy session must stay alive, and this default is what guarantees a later knob-turner cannot make silence fatal.

- `stop()` MUST NOT ASSUME pgid == pid. `detached: true` (spawn-primitive.ts:811) is a documented open decision. With detached, pgid == pid and `kill(-pid)` reaches the tree; WITHOUT it the child sits in the DAEMON'S process group and `kill(-pid)` is ESRCH — or worse, a naive `-pgid` would signal the daemon and every session. Record group-signallability from the spawn options at spawn time; flipping `detached` then stays a ONE-LINE change at spawn-primitive.ts:811.

- THE RESOLVER USES `projects` + `harness.agents` ONLY — NOT `ProjectRegistry`. workspaceRoots discovery uses `existsSync` (follows symlinks, no ownership check) and `FileRecentsStore.load()` degrades a corrupt or attacker-written file to `[]` silently. They may feed a picker later; they never select what is spawned.

- THE REGISTRY IS A PROVIDER ASKED PER FRAME, NOT A VALUE CAPTURED AT CONSTRUCTION. R36-SPAWN.3 says "on every load". fleet.ts:170-185 records the identical lesson for the device store: reading it once while routes were built froze the answer and made first-ever pairing require a restart.

- NO STOP FRAME ON THE WIRE, decided in wave 1 and unchanged: R36-SPAWN.7's stop deadline attaches to a daemon-internal `stop()`. Phase 38 freezes geist/1.0 one phase later and a stop verb is a bigger commitment than the requirement asks for.

- THE RESOLVER'S REFUSAL CODES ARE A LOCAL UNION, NOT AN IMPORT FROM geist-protocol. `HarnessResolutionCode = "unknown_harness" | "unknown_project" | "refused"` is a strict subset of the frozen `SessionSpawnCode`; W4 maps it with an exhaustive switch so drift is a compile error there, and the resolver stays independent of the wire batch so the two can land in either order.

- WAVE 3 INHERITS: `SessionSpawner.launch()` sharing the whole post-spawn block (spawn-primitive.ts:820-910 — listeners-before-any-early-return, the bounded stderr drain that must never close the read end, the lock-owner-pid readiness poll, `#release`, `#teardown`) with `resume()`; the argv from W2-SPAWN-ARGV going into it; per-harness `credentialEnv` narrowing `DECLARED_CREDENTIAL_ENV` (spawn-primitive.ts:134) using the list W2-HARNESS-RESOLVE already returns.

- WAVE 4 INHERITS: fleet.ts wiring — reuse the ONE `SessionResumer` at fleet.ts:562 rather than constructing per frame, extend `#inFlight` keying to cover both the minted session id and the `project:harness` pair, mint the session id as a uuid, pass the registry as a per-frame provider, add a `--registry` flag (docs/geist/spec.md §15.2 already CLAIMS one exists, so the flag is owed), decide `spawnableHarnessIds` in one line, and W4-COMMAND-SURFACE deleting the `command` parameter chain through session-process.ts:79 / session.ts / session-manager.ts.

- WAVE 5 INHERITS: seven class-3 acceptance files driving the emitted daemon, built on wave 1's helpers/process-table.ts and helpers/attach-journey.ts (FROZEN_ROW_KEYS must still equal the fleet row's key set after the wire batch — the wire batch adds NO field to AttachableSessionSchema, and that is deliberate: a spawn-only extra field would break R36-SPAWN.8's frozen row shape). Build packages/coding-agent ONCE for the whole wave, not per suite.

## Wave 2 collision hotspots

- packages/gateway/src/session/spawn-primitive.ts — W2-DEADLINES-STOP is the ONLY wave-2 task that may edit it. W2-HARNESS-RESOLVE and W2-SPAWN-ARGV import from it read-only. The owner must not change the signatures of `canonicalize`, `SpawnRefusedError`, `SpawnRefusalCode`, `resolveDrahtExecutable`, `ResolvedExecutable`.

- packages/geist-protocol/src/index.ts — W2-WIRE-BATCH only. Named exports are mandatory: scripts/check-geist-mirrors.mjs treats a name reachable only via `export *` as not exported and fails loudly.

- packages/geist-protocol/src/wire.ts — W2-WIRE-BATCH only. Any field-level change requires the version bump, the migration note and a regenerated corpus in the SAME commit or `bun scripts/check-geist-protocol.mjs` fails.

- The four pinned "0.4" literals (packages/geist-protocol/test/wire-0.4-fields.test.ts:79, packages/geist-protocol/test/wire-auth-frames.test.ts:103, packages/gateway/src/__tests__/permission-frame-wire.e2e.test.ts:288, packages/gateway/src/__tests__/socket-ownership-hygiene.e2e.test.ts:249) — W2-WIRE-BATCH only, overriding the wave-1 orchestrator-only rule.

- packages/geist-core/src/attach/attach-bridge.ts — W2-WIRE-BATCH only. It is the daemon's decoder and its capability advertiser; a frame declared in the schema with no case here is silently dropped.

- package.json (root) — ORCHESTRATOR ONLY, no task may edit it. Two lines are owed after W2-COMMAND-GATE lands (the `check:no-free-text-command` script + its `check` chain entry, and `scripts/check-no-free-text-command.test.mjs` in `test:scripts`), and one more after W5-CONSOLE-PICKER (`scripts/geist-console-spawn-picker.e2e.test.mjs` in `test:scripts:serial`).

- scripts/root-test-script-parity.test.mjs — nobody edits it, and it goes RED the moment W2-COMMAND-GATE's `scripts/*.test.mjs` lands and stays red until the integrator wires root package.json. Expected, pre-announced, and the only wave-2 red.

- docs/geist/spec.md and packages/gateway/src/__tests__/spawn-docs-contract.test.ts — W2-SPEC-FRAMES only. Wave 1 wrote §15.1/§15.2 and the two-layer contract test; wave 2 adds §15.3 to the same files.

- packages/gateway/src/__tests__/session-resume.e2e.test.ts and packages/gateway/src/__tests__/fleet-attach.e2e.test.ts — READ-ONLY for the whole phase, by every task, in every wave.

- packages/geist-protocol/src/config.ts — NOT edited in wave 2 by anyone. Wave 1 landed `cmd`'s absolute refinement, `credentialEnv` and `approvedRoots`; the resolver consumes them and adds no field.

- packages/coding-agent/dist — four gateway suites run a build in `beforeAll`. W2-SPAWN-ARGV is the only wave-2 task that needs it; run `bun run build` in packages/coding-agent once, yourself, before the suite.

## Wave 2 tasks

### W2-WIRE-BATCH — The whole geist/0.5 wire batch, in one commit: session_spawn, registry_resync, and the corpus

- **Wave** 2 · **Requirement** R36-SPAWN.1 · **Evidence class** 2 · **Depends on** nothing
- **Files** `packages/geist-protocol/src/wire.ts`, `packages/geist-protocol/src/index.ts`, `packages/geist-protocol/conformance/MIGRATIONS.md`, `packages/geist-protocol/conformance/geist-0.5/`, `packages/geist-protocol/test/wire-spawn-frames.test.ts`, `packages/geist-protocol/test/wire-0.4-fields.test.ts`, `packages/geist-protocol/test/wire-auth-frames.test.ts`, `packages/gateway/src/__tests__/permission-frame-wire.e2e.test.ts`, `packages/gateway/src/__tests__/socket-ownership-hygiene.e2e.test.ts`, `packages/geist-core/src/attach/attach-bridge.ts`, `packages/geist-core/test/attach/attach-bridge-spawn.test.ts`, `scripts/geist-conformance/record.mjs`, `scripts/geist-conformance/reference-daemon.mjs`
- **Test** `packages/geist-protocol/test/wire-spawn-frames.test.ts`

You are adding two frame PAIRS to the geist attach wire and bumping it 0.4 → 0.5, as ONE atomic commit. You see nothing of the conversation that produced this plan; everything you need is here.

WHY IT IS ONE COMMIT AND CANNOT BE SPLIT. `AttachBridge.receive()` (packages/geist-core/src/attach/attach-bridge.ts:568) decodes every frame against the schema union and answers an undeclared type with `protocol_error unknown_type` AND CLOSE 1008 — the connection dies. A frame that IS in the union but has no `case` in the switch at :600 is silently dropped and the phone waits forever. And `bun scripts/check-geist-protocol.mjs` fails unless the version, the migration note and the regenerated corpus all move together. Any split leaves the daemon refusing or ignoring its own frames between commits.

WHAT EXISTS (read it; it is the model for everything below). packages/geist-protocol/src/wire.ts declares every frame once as a zod schema. `GEIST_PROTOCOL_VERSION = "0.4"` at :49. The 0.4 additions live at the END of the file under a `// geist/0.4 — resync and resume` banner (:749-835): `FleetResyncFrameSchema` (no fields), `SessionResumeFrameSchema` ({type, sessionId} and NOTHING else), `SessionResumeCodeSchema` (a closed enum), `SessionResumedFrameSchema` ({type, sessionId, ok, code, message}). Members are listed in `ClientFrameSchema`/`ServerFrameSchema` at :840/:853, and `CLIENT_FRAME_TYPES`/`SERVER_FRAME_TYPES` are DERIVED from those unions. `safeText(n)` (:641) is a predicate — never a transform, so decode → encode stays byte-identical and the goldens keep comparing — and it is only in scope BELOW its definition, which is another reason the new frames go at the end of the file.

BUILD, and the contract below is FROZEN — five sibling tasks in this wave are written against these exact names, fields and code strings. Do not rename, do not add a field, do not drop one.

1. IN wire.ts, under a new `// geist/0.5 — spawn and registry` banner after the 0.4 block:
```ts
export const RegistryIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const SessionSpawnFrameSchema = z.object({
  type: z.literal("session_spawn"),
  harnessId: RegistryIdSchema,
  projectId: RegistryIdSchema,
});

export const RegistryResyncFrameSchema = z.object({ type: z.literal("registry_resync") });

export const SessionSpawnCodeSchema = z.enum([
  "spawned", "unknown_harness", "unknown_project", "refused", "spawn_failed", "timeout",
]);

export const SessionSpawnedFrameSchema = z.object({
  type: z.literal("session_spawned"),
  sessionId: z.string().min(1).max(128).optional(),
  ok: z.boolean(),
  code: SessionSpawnCodeSchema,
  message: safeText(512),
});

export const RegistryHarnessSchema = z.object({ id: RegistryIdSchema, isDefault: z.boolean() });
export const RegistryProjectSchema = z.object({ id: RegistryIdSchema, name: safeText(200), root: safeText(1024) });
export const RegistryFrameSchema = z.object({
  type: z.literal("registry"),
  harnesses: z.array(RegistryHarnessSchema).max(64),
  projects: z.array(RegistryProjectSchema).max(256),
});
```
Document, in the schema comments, the four decisions a reader will otherwise undo:
  • TWO OPAQUE IDS AND NOTHING ELSE, for the same reason `session_resume` carries one: the daemon resolves both against ITS OWN user-owned registry and constructs the argv itself, so the worst a caller can name is an entry that exists or one that does not. A `path`, `cwd`, `argv` or `env` field here — even a validated one — makes the renderer a party to what executes, and this frame reaches a phone.
  • `sessionId` IS OPTIONAL, and that is the one shape difference from `session_resumed`. The daemon MINTS the id, so a refusal has no id to name; inventing one would be worse. Present iff a process was started.
  • A HARNESS ROW CARRIES NO `cmd`. A project `root` does cross — the fleet row already carries `cwd` and the picker must disambiguate two projects with the same name — but an executable path tells a client what to attack and buys the picker nothing. Same reasoning as `AttachableSessionSchema`'s deliberately absent socket path (:299).
  • `RegistryIdSchema` IS CHARACTER-CONSTRAINED so a registry key can never be a path fragment or prose.
Add all new names to `ClientFrameSchema`/`ServerFrameSchema` and export every one of them from packages/geist-protocol/src/index.ts as EXPLICITLY NAMED exports — scripts/check-geist-mirrors.mjs treats a name reachable only via `export *` as not exported and fails loudly. Do NOT add any of these to `MIRRORED_FRAMES` in scripts/check-geist-protocol.mjs: none of the four is relayed to a draht session's Unix socket, exactly like the 0.4 four.

2. BUMP `GEIST_PROTOCOL_VERSION` to `"0.5"` and move the four pinned literals — packages/geist-protocol/test/wire-0.4-fields.test.ts:79, packages/geist-protocol/test/wire-auth-frames.test.ts:103, packages/gateway/src/__tests__/permission-frame-wire.e2e.test.ts:288 (all three `expect(GEIST_PROTOCOL_VERSION).toBe("0.4")`) and packages/gateway/src/__tests__/socket-ownership-hygiene.e2e.test.ts:249 (a hardcoded `version: "0.4"` inside a hello frame). Those four ARE YOURS in this commit. Add a one-line comment at each: the assertion is "the current version", not "0.4 forever". I re-enumerated every literal "0.4" outside conformance/ at HEAD and there are exactly five including wire.ts:49; if you find a sixth, it appeared after this plan and you own it too.

3. IN packages/geist-core/src/attach/attach-bridge.ts: add `SESSION_SPAWN_CAPABILITY = "session-spawn"` and `REGISTRY_CAPABILITY = "registry"` beside `FLEET_DELTA_CAPABILITY` (:97) and `SESSION_RESUME_CAPABILITY` (:109); add two optional ports to `AttachBridgeOptions` beside `resumeSession?: ResumeSessionPort` (:393) — `spawnSession?: SpawnSessionPort` and `registry?: RegistryPort` — and push each capability in `#capabilities()` (:795) ONLY when its port is non-null. What is advertised is what this daemon WILL ANSWER, never what a later task intends to; the existing comment at :625-631 says exactly that and it is the rule. Add two `case`s in the switch at :600, both below the post-authentication gate at :581 and both ANSWERING AND RETURNING (never closing the connection):
  • `registry_resync` → emit one `registry` frame from the port, or, with no port, a `protocol_error unsupported`… NO: with no port, emit `registry` with two empty arrays is WRONG (it is a lie). With no port, refuse exactly as `#resumeSession` does with no port — a typed answer on the same connection. Mirror `#resumeSession`'s shape (:832) precisely; read it before you write yours.
  • `session_spawn` → `#spawnSession(frame)`, modelled line-for-line on `#resumeSession` (:832-858): with no port, `{ok:false, code:"refused", message:"this daemon cannot spawn sessions"}`; ONE IN FLIGHT PER CONNECTION with its own `#spawnInFlight` flag answered `refused` (a double-tapping user is a user, not an attacker — dropping the socket would cost them the session they are watching), and copy the `#resumeInFlight` doc comment's warning: this flag is PER CONNECTION and is NOT the guard against two spawns of one project — that guard is daemon-wide and lives behind the port. A port that throws is reported `spawn_failed` and the connection survives.
Write the bridge tests in packages/geist-core/test/attach/attach-bridge-spawn.test.ts (new): capability absent without a port and present with one; `session_spawn` before authentication is refused `not_authenticated`; with no port it is answered, not dropped and not closed; two in flight get the second refused; a throwing port yields `spawn_failed` and the connection stays open; `registry_resync` answers `registry`. Model the file on packages/geist-core/test/attach/attach-bridge.test.ts.

4. THE CORPUS. `packages/geist-protocol/conformance/geist-0.5/` does not exist and `missingGoldens()` (scripts/generate-geist-conformance.mjs:159) demands one golden per declared type per direction, derived from the unions — so the reference daemon must actually SEND `session_spawned` and `registry`, and the recorder must actually SEND `session_spawn` and `registry_resync`. In scripts/geist-conformance/reference-daemon.mjs, add both cases beside the `session_resume` case at :539: this daemon has no spawn surface by construction (its header says so at :77), so it MODELS the answer — a `session_spawn` for an unknown project is answered `{ok:false, code:"unknown_project"}`, and `registry_resync` is answered with one fixed harness and one fixed project. In scripts/geist-conformance/record.mjs, add the exchanges beside step 9b (:609-635), and ALSO add a REJECTED_FRAMES fixture beside `session-resume-before-auth` (:293-300) that sends `{type:"session_spawn", harnessId:"draht", projectId:"fr3n", command:["/bin/sh","-c","touch $CANARY"]}` and expects `not_authenticated` — a RECORDED proof that argv-shaped fields are dropped by the decoder before the auth gate is even reached. Then run `npm run generate:geist-conformance` and commit what it writes.

5. MIGRATIONS.md gets a `## geist/0.5` section ABOVE `## geist/0.4` (:21). `hasMigrationNote()` matches `^##\s+geist/0\.5\s*$` exactly. Match the 0.4 section's voice and cover: the four added types and their fields; that none is relayed so none has a `MIRRORED_FRAMES` row; THE CLIFF stated plainly (`ProtocolVersionSchema` is a `z.literal`, so a 0.5 daemon refuses a cached 0.4 renderer at `hello` with `version_mismatch` and closes 1008 — the fix is a page reload); and what a renderer must do (read `server_hello.capabilities` before sending either new verb, because probing for an undeclared type costs the connection).

TEST FILE: packages/geist-protocol/test/wire-spawn-frames.test.ts (new). Cover: every new schema round-trips decode → encode byte-identically; `session_spawn` with an extra `command`/`cwd`/`env` key is REFUSED (zod strips or rejects — assert the frame the decoder yields carries no such key, and that a frame whose only difference is the extra key does not survive re-encoding unchanged); a `harnessId` with a `/` or a space is refused; `session_spawned` with no `sessionId` decodes; `message` with a control character is refused by `safeText`; `CLIENT_FRAME_TYPES` and `SERVER_FRAME_TYPES` contain the four new names; `GEIST_PROTOCOL_VERSION` is `"0.5"`.

TRAPS (each has cost hours here): `rtk` wraps `grep`/`ls` and MANGLES their output — line numbers and content from them are NOT trustworthy; use `sed -n`, `python3` or Read for anything load-bearing. `npx tsc --noEmit -p packages/<pkg>` prints 'TypeScript: No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the REPO ROOT, and note that packages/gateway has its OWN typecheck over `src/__tests__/` which the root tsconfig EXCLUDES: run `npm --prefix packages/gateway run typecheck` too, because you edit two gateway test files. `npx biome` fails; use `./node_modules/.bin/biome`. This shell exports DRAHT_PERMISSION_MODE=auto — prefix every spawn with `env -u DRAHT_PERMISSION_MODE`. A unix socket path over ~104 bytes fails to bind with EINVAL; agent dirs go directly under /tmp with a SHORT name. NEVER run a whole-package suite — they flake under parallel load. Run only your files: `cd packages/geist-protocol && env -u DRAHT_PERMISSION_MODE bun test test/wire-spawn-frames.test.ts`, `cd packages/geist-core && env -u DRAHT_PERMISSION_MODE bun test test/attach/attach-bridge-spawn.test.ts`, and from the root `env -u DRAHT_PERMISSION_MODE bun scripts/check-geist-protocol.mjs`.

MUTATION TEST, in an isolated rsync copy and NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-wire
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does NOT isolate this monorepo: packages/<x>/node_modules/@draht/<y> are RELATIVE symlinks resolved against the target's REAL path (node_modules/@draht/coding-agent -> ../../packages/coding-agent), so a worktree edit is visible to the supposedly isolated run. Do NOT exclude and do NOT symlink packages/*/dist — suites run a build in beforeAll and tsc follows a dist symlink back into the real tree; `rsync -a` copies dist as real content, which is what you want. ~3 GB, a few minutes; re-sync with `rsync -a --delete`. SANITY-CHECK ISOLATION FIRST with a mutation you KNOW must fail: in $DST only, delete the `## geist/0.5` heading line from conformance/MIGRATIONS.md; run `bun scripts/check-geist-protocol.mjs` in $DST and confirm it FAILS on the missing migration note; run the same command in $SRC and confirm it still passes. Only after that does a passing mutation result mean anything. Restore by copying pristine bytes, never by retyping.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/geist-protocol/src/wire.ts packages/geist-protocol/src/index.ts packages/geist-protocol/test/wire-spawn-frames.test.ts packages/geist-core/src/attach/attach-bridge.ts packages/geist-core/test/attach/attach-bridge-spawn.test.ts scripts/geist-conformance/record.mjs scripts/geist-conformance/reference-daemon.mjs

WHAT THIS DOES NOT CLOSE, and say so in the commit body: this is evidence class 2. It declares the verbs; no daemon answers `session_spawn` with a process until wave 4 wires the port, and the class-3 acceptance that drives the emitted binary is wave 5.

### W2-DEADLINES-STOP — Four named deadlines and a stop path that signals the right thing

- **Wave** 2 · **Requirement** R36-SPAWN.7 · **Evidence class** 2 · **Depends on** nothing
- **Files** `packages/gateway/src/session/spawn-primitive.ts`
- **Test** `packages/gateway/src/__tests__/spawn-deadlines-stop.test.ts`

You own the daemon's spawn primitive for this wave. You see nothing of the conversation that produced this plan; everything you need is here.

YOU ARE THE ONLY TASK IN THIS WAVE ALLOWED TO EDIT packages/gateway/src/session/spawn-primitive.ts. Two sibling tasks IMPORT from it while you work, so these five exported signatures are FROZEN: `canonicalize(candidate, uid, what, constraints)`, `SpawnRefusedError`, `SpawnRefusalCode`, `resolveDrahtExecutable(env, uid, roots)` and `ResolvedExecutable`. Change anything else you need; change none of those.

WHAT IS TRUE AT HEAD, verified by reading it. `DEFAULT_RESUME_DEADLINE_MS = 30_000` (:114) and `DEFAULT_TEARDOWN_GRACE_MS = 2_000` (:117) are the ONLY two numbers in the file. `SessionSpawner.resume()` (:781) spawns at :803 with `detached: true` (:811), `stdio: ["pipe", "ignore", "pipe"]` (:812), `shell: false` (:813). Every listener is attached on the line after the spawn and NOTHING between there and the wait may return or throw first (:820-850) — an `error` event with no listener is an uncaught exception that takes the whole daemon down; this was measured, not assumed. stderr is drained forever while retaining only a 2 KB prefix (:835), because closing the read end gives the child EPIPE on stderr and the default disposition of SIGPIPE is to terminate — a "cleanup" that kills the session you just started. The readiness loop (:858-902) polls the lock owner pid every 100 ms until `this.#deadlineMs`. `#release` (:922) unrefs the stderr and stdin pipes AND the child handle — a pipe is its own libuv handle and an unref'd child with a ref'd pipe still holds the event loop open, which would make the daemon un-exitable after one resume. `#teardown` (:941) is PRIVATE, TERMs the process GROUP (`-pid`), sleeps `#teardownGraceMs`, then KILLs the group unconditionally — unconditional because a child that traps TERM is exactly the case a deadline exists for (a measured `trap '' TERM; sleep 3600` survives TERM for as long as you care to wait).

BUILD, all inside this one file:

(a) FOUR NAMED DEADLINES replacing the one number, each its own exported constant and its own `SessionSpawnerOptions` field, with defaults that make today's behaviour byte-identical:
  • `DEFAULT_SPAWN_DEADLINE_MS = 2_000` — from `spawn()` to a live pid. In the happy path node hands you the pid synchronously and this resolves immediately; what it bounds is the pathological case where neither a pid nor an `error` event has arrived. Fatal → `spawn_failed`.
  • `DEFAULT_HANDSHAKE_DEADLINE_MS = 30_000` — pid to "our own child owns the lock AND the socket exists". This is today's 30 s and MUST STAY 30 s: packages/gateway/src/__tests__/session-resume.e2e.test.ts is 23 pass / 0 fail / 56.7 s at HEAD and any change that lowers that has broken something. Fatal → `timeout`.
  • `DEFAULT_FIRST_OUTPUT_DEADLINE_MS = 30_000` — pid to the first byte the daemon reads from the child. DEFAULTED EQUAL TO THE HANDSHAKE DEADLINE ON PURPOSE, so it is OFF by default and NON-FATAL BY CONSTRUCTION: it can only ever end a wait that was already going to end in `timeout`, and it can never kill a session that binds, because binding ends the wait first. Write that invariant into the comment as a rule for the next editor. The most recent commit on this branch is `fix(gateway): keep a silent /attach alive` — a healthy silent session must stay alive, and this default is what stops a later knob-turner making silence fatal. When it does fire, the refusal is still `timeout`, with a message that distinguishes "published no socket and never said a word" from "published no socket after printing …" using the retained prefix.
  • `DEFAULT_STOP_DEADLINE_MS = 2_000` — TERM to KILL. This is today's `teardownGraceMs` renamed.
  KEEP `deadlineMs` AND `teardownGraceMs` WORKING as aliases for the handshake and stop deadlines: fleet.ts:562 and four e2e suites construct `SessionSpawner`/`SessionResumer` with them today, and a rename that silently drops an option is a deadline that stops being enforced.

(b) A PUBLIC `async stop(pid: number): Promise<void>` — R36-SPAWN.7 asks for a stop path and there is none. Move `#teardown`'s body into it, keep `#teardown` as a private caller, make it idempotent and never throwing.
  IT MUST NOT ASSUME pgid === pid. `detached: true` (:811) is a DOCUMENTED OPEN DECISION that may be flipped. With it, the child gets its own session and pgid === pid and `kill(-pid)` reaches the whole tree. WITHOUT it the child sits in the DAEMON'S OWN process group: `kill(-pid)` is then ESRCH and silently reaps nothing, and any "fix" that reached for the real pgid would signal the daemon and every session it owns. So record group-signallability AT SPAWN TIME from the options you passed (`detached === true`), carry it with the pid, and signal the group only when it is true and the bare pid otherwise. That keeps flipping `detached` a ONE-LINE change at spawn-primitive.ts:811 and makes the wrong outcome impossible rather than unlikely.
  NEVER use `kill(pid, 0)` as a liveness oracle anywhere in this file or its test: it SUCCEEDS on a zombie — verified on this box — so a `until(() => !alive(pid))` loop waits on the daemon's own libuv reaping, which is in-process state by the back door. Read `stat=` from `ps` and treat a row containing `Z` as dead.

(c) THE STDOUT DECISION, WHICH YOU MUST MEASURE RATHER THAN GUESS. `stdio[1]` is `"ignore"` today, so a child that dies printing to stdout leaves no diagnostic. Piping it is not free and is NOT REVERSIBLE ONCE CHOSEN: you cannot un-pipe a live child — `pause()` lets the 64 KB pipe fill and DEADLOCKS the child on its next write, and `destroy()` gives it SIGPIPE and kills the session — so a pipe means the daemon reads and discards every byte that session ever writes to stdout, for the daemon's whole life. Whether that is zero or the entire session output stream depends on whether an rpc-mode session whose stdin is an open-but-never-written pipe writes to stdout at all, and I DID NOT MEASURE IT. You must: start a session with the production argv, attach to its socket, drive one full turn through it with the stub provider, and count the bytes that arrive on the child's stdout. If it is ~0, pipe it (bounded 2 KB retain, UNBOUNDED drain that never stops reading, an `error` listener, and an `unref` in `#release` alongside the two that are already there — omit that unref and the daemon becomes un-exitable after one spawn). If it is the output stream, keep `"ignore"`, define first-output on stderr alone, and say so. EITHER outcome is acceptable; recording the measured number in the module comment is not optional.

TEST FILE: packages/gateway/src/__tests__/spawn-deadlines-stop.test.ts (new). Use wave 1's helpers at packages/gateway/src/__tests__/helpers/process-table.ts — `psRows`, `liveGroupMembers`, `descendantsOf`, `isProcessAlive`, `waitForGroupGone`, `reapPgids`, `uniqueMarker` — do not hand-roll ps parsing. Cover, against real processes you spawn and kill: `stop()` on a detached leader kills the WHOLE GROUP including a grandchild (`descendantsOf` finds the grandchild first — a positive control — then `liveGroupMembers` is empty after); a child that traps TERM is still gone after the stop deadline and is NOT gone before it (assert both halves, or you have tested nothing about the deadline); `stop()` twice is a no-op and throws nothing; `stop()` on a pid that is already gone throws nothing; a `SessionSpawner` built with a tiny handshake deadline against a binary that binds nothing refuses `timeout` and leaves NO live process behind; the alias options still take effect; and, if you piped stdout, that a successful spawn does not hold the event loop open. THE ZOMBIE TRAP: right after `killpg(SIGKILL)` the group leader stays in the table as `Z <defunct>` until its parent reaps it, so a naive "no rows carry this pgid" assertion is false for a window whose length is the daemon's own reaping — use `liveGroupMembers`, which filters `Z`, and never `groupMembers`. `-A` is mandatory on every ps scan or tty-less children are invisible; the helper already does this. Reap by recorded pgid in `afterAll` and NEVER `pkill -f` a generic pattern: parallel agents run draht e2es on this box and a generic pattern kills their sessions. Do NOT edit packages/gateway/src/__tests__/session-resume.e2e.test.ts — it is READ-ONLY for the whole phase; read it as prior art for how a spawner is constructed in a test.

TRAPS (each has cost hours here): `rtk` wraps `grep`/`ls` and MANGLES their output — line numbers and content from them are NOT trustworthy; use `sed -n`, `python3` or Read for anything load-bearing. `npx tsc --noEmit -p packages/gateway` prints 'TypeScript: No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the REPO ROOT, and packages/gateway has its OWN typecheck over `src/__tests__/` which the root tsconfig EXCLUDES: run `npm --prefix packages/gateway run typecheck` too. `npx biome` fails; use `./node_modules/.bin/biome`. This shell exports DRAHT_PERMISSION_MODE=auto — prefix every spawn with `env -u DRAHT_PERMISSION_MODE`. A unix socket path over ~104 bytes fails to bind with EINVAL; agent dirs go directly under /tmp with a SHORT name. Run `bun run build` in packages/coding-agent before anything spawns dist/cli.js. NEVER run a whole-package suite — they flake under parallel load; run only your file: `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/spawn-deadlines-stop.test.ts`. SIP blocks dtrace on this machine (`csrutil status` → enabled), so there is NO exec oracle — "no process was created" cannot be proven by any scan; a tripwire FILE is the only race-immune negative.

MUTATION TEST, in an isolated rsync copy and NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-dl
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does NOT isolate this monorepo: packages/<x>/node_modules/@draht/<y> are RELATIVE symlinks resolved against the target's REAL path (node_modules/@draht/coding-agent -> ../../packages/coding-agent), so a worktree edit is visible to the supposedly isolated run. Do NOT exclude and do NOT symlink packages/*/dist — suites run a build in beforeAll and tsc follows a dist symlink back into the real tree; `rsync -a` copies dist as real content. ~3 GB, a few minutes; re-sync with `rsync -a --delete`. SANITY-CHECK ISOLATION FIRST with a mutation you KNOW must fail: in $DST only, change `stop()` to `process.kill(pid, "SIGKILL")` — the bare pid instead of the group; run your test in $DST and confirm the grandchild case FAILS; run it in $SRC and confirm it still passes. Only after that does a passing mutation result mean anything. Restore by copying pristine bytes, never by retyping.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/gateway/src/session/spawn-primitive.ts packages/gateway/src/__tests__/spawn-deadlines-stop.test.ts

WHAT THIS DOES NOT CLOSE: this is evidence class 2. R36-SPAWN.7 also says "a wedged child never wedges the daemon", and proving THAT needs a wedged child under a real daemon over the real protocol — wave 5's class-3 job, not yours.

### W2-HARNESS-RESOLVE — The harness/project resolver — the first production caller of both wave-1 halves

- **Wave** 2 · **Requirement** R36-SPAWN.2 · **Evidence class** 2 · **Depends on** nothing
- **Files** `packages/gateway/src/session/harness-resolver.ts`
- **Test** `packages/gateway/src/__tests__/harness-resolver.test.ts`

You are building the function that turns two opaque ids from a phone into a canonical executable and a canonical directory. You see nothing of the conversation that produced this plan; everything you need is here.

WHY THIS TASK EXISTS. Two hardening surfaces shipped last wave with ZERO production callers, which means neither is enforced anywhere today:
  • `canonicalize(candidate, uid, what, {followSymlinks, approvedRoots, forbiddenRoots})` — exported from packages/gateway/src/session/spawn-primitive.ts:425. It pairs `realpathSync` with an ownership walk of every path component, refuses a symlinked component when `followSymlinks: false`, and enforces canonical containment WITH a separator boundary (`isInsideRoot`, :409 — `startsWith(root)` alone matches `/x/projects-evil` against `/x/projects`, which is the live defect in the daemon's own `isPathAllowed` at packages/gateway/src/config/config.ts:429-438; do not copy that). Both root lists default to empty and empty means "no constraint", so nothing configures them today: an absolute project-local `node_modules/.bin/draht` named by `DRAHT_BIN` is still ALLOWED. You are the caller that configures them.
  • `loadGeistConfigFile(path)`, `assertPrivateRegistryFile(path)` and `resolveUserRegistryPath(opts)` — exported from packages/geist-protocol/src/config-load.ts. The loader lstat-walks the SUPPLIED path before any realpath, requires strict current-uid ownership on the file and its parent (never uid 0), refuses a symlink at either, requires `(mode & 0o077) === 0` on the file, and REFUSES rather than repairing, throwing `RegistryFileRefusedError`. `resolveUserRegistryPath` returns the explicit path if given, else `~/.geist/config.yaml`, and NEVER considers cwd. Nothing calls any of it.

WHAT THE REGISTRY LOOKS LIKE (packages/geist-protocol/src/config.ts, already landed): `GeistConfigSchema = { harness: { default: string, agents: Record<string, AgentLaunchSpec> }, projects?: Record<string, {root: string, name?: string}>, workspaceRoots?: string[], approvedRoots?: string[] }` and `AgentLaunchSpec = { cmd: string /* refined absolute */, args?: string[], credentialEnv?: string[] }`. geist.yaml.example at the repo root is the committed example. DO NOT EDIT ANY FILE IN packages/geist-protocol — a sibling task in this wave owns its index and its wire half.

BUILD, entirely inside ONE NEW FILE packages/gateway/src/session/harness-resolver.ts:

```ts
export type HarnessResolutionCode = "unknown_harness" | "unknown_project" | "refused";
export class HarnessResolutionError extends Error { readonly code: HarnessResolutionCode; readonly … }

export interface ResolvedHarnessLaunch {
  harnessId: string;
  projectId: string;
  /** Canonical absolute executable, ownership-walked and root-contained. */
  executable: string;
  /** Args that belong to the executable itself (an interpreter's script path, then the spec's own `args`). */
  leadingArgs: string[];
  /** Canonical absolute project root; the spawn's cwd AND its `--context-root`. */
  projectRoot: string;
  /** Exactly the env names this harness may receive. Empty means none beyond the built-in minimum. */
  credentialEnv: readonly string[];
}

export interface HarnessResolverOptions {
  /** Asked on EVERY call. Not a value captured at construction. */
  registry: () => GeistConfig;
  uid?: number;
  /** Roots a spawn may never enter, whatever the registry says. */
  forbiddenRoots?: readonly string[];
  /** When set, only these harness ids may be spawned. Empty/absent means every declared id. */
  spawnableHarnessIds?: readonly string[];
}
export function resolveHarnessLaunch(harnessId: string, projectId: string, options: HarnessResolverOptions): ResolvedHarnessLaunch;
export function registryProjection(config: GeistConfig): { harnesses: {id: string; isDefault: boolean}[]; projects: {id: string; name: string; root: string}[] };
```

RULES, each of which has a reason you must keep in the comments:
1. THE REGISTRY IS A PROVIDER ASKED PER CALL. R36-SPAWN.3 says the file is checked "on every load", and packages/gateway/src/gateway/routes/fleet.ts:170-185 records the identical lesson for the device store: reading it once while routes were built froze the answer and made first-ever pairing require a restart. Your caller supplies a thunk that reads and re-checks the file; you call it every time.
2. RESOLVE `harnessId` AGAINST `config.harness.agents` ONLY, and `projectId` AGAINST `config.projects` ONLY. Do NOT use `ProjectRegistry` (packages/geist-core/src/registry/project-registry.ts): it merges yaml ∪ workspaceRoots discovery ∪ recents, `discoverWorkspaceProjects` uses `existsSync` (which follows symlinks) with no ownership check, and `FileRecentsStore.load()` degrades a corrupt or attacker-written file to `[]` silently. Those two sources may feed a picker later; they never select what is spawned. An id that is absent is `unknown_harness` / `unknown_project` — never a fallback, never a fuzzy match.
3. RESOLVE THE EXECUTABLE THROUGH `canonicalize` AND NOTHING ELSE: one gate, one set of refusals. Pass `followSymlinks: false` (the operator's declaration names a FILE; a link decides at exec time, not check time, which file that is), `approvedRoots: config.approvedRoots ?? []` and your own `forbiddenRoots`. When `config.approvedRoots` is absent, containment is unconstrained and that is the operator's choice — but you must still pass the array through so the constraint exists the moment they write one. A `SpawnRefusedError` from `canonicalize` becomes a `HarnessResolutionError` with code `refused`, its message preserved.
4. A SCRIPT NEEDS AN INTERPRETER. `resolveDrahtExecutable` (spawn-primitive.ts:476) already solves this for the daemon's own binary: a `.js`/`.ts` target runs as `process.execPath <script>`, and `process.execPath` under a version manager is routinely a user-owned symlink so the INTERPRETER keeps today's realpath-first behaviour (`followSymlinks` defaults to true) while the DECLARED path does not. Reuse the same shape for a declared `cmd` that is a script; get this backwards and every developer's daemon stops starting. Then append the spec's own `args` after the script path.
5. RESOLVE THE PROJECT ROOT with the same canonical-containment rule: realpath it, require a directory, and require it inside `config.approvedRoots` when that list is non-empty. Refuse a root that is a symlink at any component for the same reason as the executable.
6. `credentialEnv` IS RETURNED, NOT APPLIED. Wave 3 narrows `DECLARED_CREDENTIAL_ENV` (spawn-primitive.ts:134) with it. An absent list means an EMPTY list — the safe direction; never "all".
7. `spawnableHarnessIds` EXISTS FOR AN UNANSWERED QUESTION and defaults to "every declared id". R36-SPAWN.8 requires a spawned session to be indistinguishable from a discovered one, which only a harness that publishes an attachable socket can be; a registry entry like `codex: {cmd: /usr/local/bin/codex-acp}` would spawn, publish nothing and time out. Whether v1 restricts the set is the caller's one-line decision in wave 4. Document that, and refuse a non-spawnable id with `unknown_harness` and a message that says why.
8. YOUR CODE SET IS A LOCAL UNION, NOT AN IMPORT. `HarnessResolutionCode` is a strict subset of the wire's spawn codes (`spawned | unknown_harness | unknown_project | refused | spawn_failed | timeout`); wave 4 maps yours to those with an exhaustive switch, so drift is a compile error there and you need no dependency on the protocol package's wire half.

DO NOT EDIT packages/gateway/src/session/spawn-primitive.ts — another task in this wave owns it. You import `canonicalize`, `SpawnRefusedError` and, if you reuse it, the interpreter logic; if you need something that is not exported, COPY THE SMALL PIECE with a comment naming where it came from rather than editing that file.

TEST FILE: packages/gateway/src/__tests__/harness-resolver.test.ts (new). Against real files in a `mkdtemp` under /private/tmp (macOS /tmp and /var are root-owned symlinks, which `canonicalize` exempts by design — use /private/tmp so you are testing your rule and not that exemption): a clean registry resolves a harness and a project; an unknown harness id is `unknown_harness`; an unknown project id is `unknown_project`; an executable outside every `approvedRoots` entry is REFUSED and the same executable with no approvedRoots is ALLOWED (the pair is the test — one alone proves nothing); the separator-boundary case, `/x/projects-evil` must not count as inside `/x/projects`; a symlinked executable component is refused; a project root that is a symlink is refused; a `.js` target resolves to interpreter + script with the spec's `args` after it; `credentialEnv` absent yields `[]`; the registry thunk is called on EVERY resolve (count the calls — a resolver that cached would pass every other assertion here); `registryProjection` marks exactly the `harness.default` id `isDefault`, falls back to the id when a project has no `name`, and NEVER emits a `cmd`. Do not test `loadGeistConfigFile`'s own refusals — packages/geist-protocol/test/config-load.test.ts owns those and duplicating them buys nothing.

TRAPS (each has cost hours here): `rtk` wraps `grep`/`ls` and MANGLES their output — line numbers and content from them are NOT trustworthy; use `sed -n`, `python3` or Read for anything load-bearing. `npx tsc --noEmit -p packages/gateway` prints 'TypeScript: No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the REPO ROOT, and packages/gateway has its OWN typecheck over `src/__tests__/` which the root tsconfig EXCLUDES: run `npm --prefix packages/gateway run typecheck` too. `npx biome` fails; use `./node_modules/.bin/biome`. This shell exports DRAHT_PERMISSION_MODE=auto — prefix every spawn with `env -u DRAHT_PERMISSION_MODE`. A unix socket path over ~104 bytes fails to bind with EINVAL; agent dirs go directly under /tmp with a SHORT name. NEVER run a whole-package suite — they flake under parallel load; run only your file: `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/harness-resolver.test.ts`.

MUTATION TEST, in an isolated rsync copy and NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-res
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does NOT isolate this monorepo: packages/<x>/node_modules/@draht/<y> are RELATIVE symlinks resolved against the target's REAL path (node_modules/@draht/coding-agent -> ../../packages/coding-agent), so a worktree edit is visible to the supposedly isolated run. Do NOT exclude and do NOT symlink packages/*/dist — suites run a build in beforeAll and tsc follows a dist symlink back into the real tree. ~3 GB, a few minutes. SANITY-CHECK ISOLATION FIRST with a mutation you KNOW must fail: in $DST only, drop `approvedRoots` from your `canonicalize` call; run your test in $DST and confirm the out-of-root case FAILS; run it in $SRC and confirm it still passes. Only after that does a passing mutation result mean anything. Restore by copying pristine bytes, never by retyping.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/gateway/src/session/harness-resolver.ts packages/gateway/src/__tests__/harness-resolver.test.ts

WHAT THIS DOES NOT CLOSE: this is evidence class 2. Nothing in the registry produces a process, so every R36-SPAWN.2/.3 claim is proven THROUGH a spawn — wave 5's class-3 suites drive the emitted daemon against an adversarial registry. Your job is that the mechanism exists and refuses.

### W2-SPAWN-ARGV — The spawn argv, and proof that a phone spawn ignores a standing local trust grant

- **Wave** 2 · **Requirement** R36-SPAWN.5 · **Evidence class** 2 · **Depends on** nothing
- **Files** `packages/gateway/src/session/spawn-argv.ts`
- **Test** `packages/gateway/src/__tests__/spawn-argv-posture.e2e.test.ts`

You are building the argv a phone-initiated session is started with, and proving through the emitted binary that its two posture flags actually do what the requirement needs. You see nothing of the conversation that produced this plan; everything you need is here.

THE DEFECT YOU ARE CLOSING, and it is the requirement in this phase most likely to be declared done while broken. R36-SPAWN.5 says a remotely spawned session starts UNTRUSTED with project-controlled executable resources disabled. The daemon has a pre-spawn veto today — `projectExplicitlyUntrusted` (packages/gateway/src/session/spawn-primitive.ts:608) reads `<agentDir>/trust.json` and refuses a project recorded as `false` — so the requirement LOOKS green. It is not: with `trust.json` recording `true` for the project, or `defaultProjectTrust: "always"` globally, a started session loads the project's own `.draht/extensions`, `.draht/settings.json`, `.draht/SYSTEM.md`, `.draht/skills` and `.agents/skills`. That was verified by running the built CLI. `--no-approve` defeats both: packages/coding-agent/src/cli/args.ts:225-226 sets `projectTrustOverride = false`, and packages/coding-agent/src/main.ts:795-800 makes `projectTrusted` false regardless of the store or the global default.

WHAT ELSE IS UNWIRED. Wave 1 added `--context-root <absolute path>` (args.ts:200-212 → main.ts `contextRoot` → resource-loader), which stops the AGENTS.md ancestor walk at the project root instead of running to `/`. NOTHING PASSES IT. Wave 1 also added a recording seam: `STUB_PROVIDER_RECORD_CONTEXT_ENV = "DRAHT_STUB_RECORD_CONTEXT"` (packages/coding-agent/src/extensions/stub-provider/provider.ts:65) — set it to an absolute path and the stub provider writes the `systemPrompt` of the FIRST provider request, and only the first, to that file. That file is your entire assertion surface.

BUILD ONE NEW FILE, packages/gateway/src/session/spawn-argv.ts:
```ts
export interface SpawnArgvInput {
  /** Minted by the daemon, never supplied by a client. */
  sessionId: string;
  /** Canonical absolute project root: the session's cwd AND the context boundary. */
  projectRoot: string;
  /** From the resolved executable — an interpreter's script path and the harness's own args. */
  leadingArgs: readonly string[];
}
export function buildSpawnArgv(input: SpawnArgvInput): string[];
```
returning EXACTLY, and this array is frozen because wave 3 asserts it:
```
[...leadingArgs, "--session-id", sessionId, "--attachable", "--mode", "rpc", "--no-approve", "--context-root", projectRoot]
```
Each element earns its place and the comment must say so:
  • `--session-id <uuid>` is what lets the existing readiness machinery work for a session with no history row. Two frictions, both verified in source: main.ts:490 prints `Warning: No project session found with id '<uuid>'; creating a new session with that id.` to STDERR on every fresh spawn, so the 2 KB stderr prefix the spawner retains starts non-empty and a `spawn_failed` message will quote it; and `validateSessionIdFlags` (main.ts:362-377) EXITS 1 if `--session-id` is combined with `--session`, `--continue` or `--resume` — which is why spawn and resume are two argvs sharing one post-spawn block, and never one argv with a branch.
  • `--attachable` explicit, so a bind failure is FATAL to the child rather than a silent degrade: a spawned session that is not on the fleet is a spawn that did not happen.
  • `--mode rpc` required: with no TTY, `resolveAppMode` falls through to print mode, the process answers once and exits, and the socket appears and vanishes.
  • `--no-approve` for the reason above.
  • `--context-root <projectRoot>` so automatically-read project context cannot come from above the project.
VALIDATE THE INPUTS AND REFUSE, do not repair: `sessionId` must match a strict id pattern (uuid-shaped; a hostile id must be unable to look like a flag or a path — reject anything outside `[A-Za-z0-9-]` and anything starting with `-`), `projectRoot` must be absolute. There is no caller-supplied free text anywhere in this function and the module comment must say that is the point. DO NOT add a dependency on `@draht/coding-agent`: packages/gateway depends on geist-console, geist-core, geist-protocol and hono only. Re-implement the id check locally in ten lines.
NOTE IN THE MODULE COMMENT, because it is an open decision awaiting an answer: whether RESUME also gets `--no-approve` is undecided. If the answer is yes, the ONE-LINE change is adding `"--no-approve"` to the resume argv array at packages/gateway/src/session/spawn-primitive.ts:802. Do not make that change and do not edit that file — another task in this wave owns it.

TEST FILE: packages/gateway/src/__tests__/spawn-argv-posture.e2e.test.ts (new). Two halves.
HALF ONE, pure: `buildSpawnArgv` returns the exact frozen array; a relative `projectRoot` is refused; a `sessionId` containing a `/`, a space or a leading `-` is refused.
HALF TWO, behavioural, through the EMITTED binary. Run `bun run build` in packages/coding-agent in `beforeAll` (packages/gateway/src/__tests__/fleet-attach.e2e.test.ts:254 is the precedent) and drive `node packages/coding-agent/dist/cli.js` directly. Use the POSTURE SUBSET of the argv — `--session-id <uuid> --no-approve --context-root <root> --provider draht-stub --model stub-1 -p "hi"` — NOT the full argv: `--mode rpc`/`--attachable` need a socket and a driver, and the full argv through a real daemon is wave 5's class-3 job. Say that in the file header so nobody reads this as the acceptance.
FIXTURE, under a SHORT /tmp dir: a project root containing `.draht/SYSTEM.md` with a canary string; `.draht/extensions/tripwire.ts` (or .js — copy the shape from an existing extensions fixture in packages/coding-agent/test) whose module body writes a tripwire FILE when it loads; an `AGENTS.md` INSIDE the root with a second canary; an `AGENTS.md` in the PARENT directory with a third canary. An agent dir (`DRAHT_CODING_AGENT_DIR`) whose `trust.json` records this project as `true` — that standing grant is the whole point. Env: `DRAHT_STUB_PROVIDER=1`, `DRAHT_STUB_RECORD_CONTEXT=<abs path>`, `HOME` and `TMPDIR` inside your temp dir so nothing reads your real home.
ASSERT, and every absence needs its positive control or it is vacuous: the recorded systemPrompt file EXISTS (without this the next three assertions pass when nothing ran at all); the in-root AGENTS.md canary IS PRESENT in it; the parent AGENTS.md canary is ABSENT; the `.draht/SYSTEM.md` canary is ABSENT; the extension tripwire file DOES NOT EXIST. VERIFY THE POSITIVE CONTROL EMPIRICALLY FIRST: run once with NO flags and confirm the in-root AGENTS.md canary really does appear in the recording. If it does not — if AGENTS.md turns out to be trust-gated too — pick a different positive control (any fixed substring of the system prompt) and say in a comment which one and why. Do not proceed on an assumption about it.
SIP blocks dtrace on this machine (`csrutil status` → enabled), so there is NO exec oracle — "the extension never ran" cannot be proven by any scan; the tripwire FILE is the only race-immune negative, which is why it is a file and not a process assertion.

TRAPS (each has cost hours here): `rtk` wraps `grep`/`ls` and MANGLES their output — line numbers and content from them are NOT trustworthy; use `sed -n`, `python3` or Read for anything load-bearing. `npx tsc --noEmit -p packages/gateway` prints 'TypeScript: No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the REPO ROOT, and packages/gateway has its OWN typecheck over `src/__tests__/` which the root tsconfig EXCLUDES: run `npm --prefix packages/gateway run typecheck` too. `npx biome` fails; use `./node_modules/.bin/biome`. This shell exports DRAHT_PERMISSION_MODE=auto — prefix every spawn with `env -u DRAHT_PERMISSION_MODE`, or the child inherits an auto-approving permission mode and your tripwire proves nothing. A unix socket path over ~104 bytes fails to bind with EINVAL; agent dirs go directly under /tmp with a SHORT name. Run `bun run build` in packages/coding-agent before anything spawns dist/cli.js. NEVER run a whole-package suite — they flake under parallel load; run only your file: `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/spawn-argv-posture.e2e.test.ts`. Do NOT use the `before_provider_request` extension event as a recording seam — it NEVER FIRES under the stub provider (sdk.ts:338 wires it to the api layer's `onPayload`; every real adapter calls `onPayload` and packages/ai/src/providers/faux.ts never does), and anyone who reaches for it loses hours to a vacuously green test.

MUTATION TEST, in an isolated rsync copy and NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-argv
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does NOT isolate this monorepo: packages/<x>/node_modules/@draht/<y> are RELATIVE symlinks resolved against the target's REAL path (node_modules/@draht/coding-agent -> ../../packages/coding-agent), so a worktree edit is visible to the supposedly isolated run. Do NOT exclude and do NOT symlink packages/*/dist — this suite builds in beforeAll and tsc follows a dist symlink back into the real tree. ~3 GB, a few minutes. SANITY-CHECK ISOLATION FIRST with a mutation you KNOW must fail: in $DST only, delete `"--no-approve"` from the argv your behavioural half runs; rebuild coding-agent in $DST; run your test in $DST and confirm the extension-tripwire and SYSTEM.md cases FAIL; run it in $SRC and confirm they still pass. Only after that does a passing mutation result mean anything. Restore by copying pristine bytes, never by retyping.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/gateway/src/session/spawn-argv.ts packages/gateway/src/__tests__/spawn-argv-posture.e2e.test.ts

WHAT THIS DOES NOT CLOSE: this is evidence class 2 and does NOT close R36-SPAWN.5 or R36-SPAWN.6. It proves the flags work when passed; that the daemon passes them on a real phone spawn is wave 5's class-3 tripwire suite. Say so in the commit body.

### W2-COMMAND-GATE — A source-level gate: no free-text command field, and no trust writers in the daemon

- **Wave** 2 · **Requirement** R36-SPAWN.8 · **Evidence class** 2 · **Depends on** nothing
- **Files** `scripts/check-no-free-text-command.mjs`
- **Test** `scripts/check-no-free-text-command.test.mjs`

You are building the gate that keeps two properties true after this phase ships. You see nothing of the conversation that produced this plan; everything you need is here.

WHY A SOURCE-LEVEL GATE AND NOT A TEST. R36-SPAWN.8 ends with "no free-text command field exists ANYWHERE in the client" — a claim about the absence of a surface, which no runtime test can make, because a test can only exercise surfaces that exist. And R36-SPAWN.5's clause "trust is granted only through the local machine, never by a remote or model answer" has NO SEAM to test: there is no trust field on the wire, no tool writes trust.json, trust resolves at session startup before any provider turn, and `loadProjectTrustExtensions` forces `setProjectTrusted(false)` before the pre-trust pass so project extensions cannot answer. Both were replaced with a scan that can fail.

WHAT IS TRUE AT HEAD, which I verified by reading every match, so your gate must be GREEN on this tree the moment you write it (minus the two frames a sibling task adds this wave, which it must also be green on):
  • No client→server frame in packages/geist-protocol/src/wire.ts carries a command-shaped field. `attach` is {sessionId, clientId, mode, capabilities?}; `input` is {data, clientId}; `detach` is {clientId}; `permission_response` is {clientId, requestId, optionId}; `fleet_resync` and `session_resume` are {} and {sessionId}. A sibling task is adding `session_spawn` {harnessId, projectId} and `registry_resync` {} this wave.
  • `POST /sessions` already refuses a body carrying `command` with 400 (packages/gateway/src/gateway/routes/sessions.ts:157, `COMMAND_REJECTED` at :41). packages/gateway/src/__tests__/sessions-create-command.test.ts is the 10-case regression over seven malformed shapes.
  • `packages/gateway/src/session/session-process.ts:79` still wraps `Bun.spawn(command, …)`. THIS IS DELIBERATE AND STILL PRESENT: a wave-4 task removes the parameter chain. YOUR GATE MUST NOT FAIL ON IT — it is not a wire field and not a client surface. Scope your rules so this is out of them, and say in the header that wave 4 removes it.
  • packages/gateway and packages/geist* contain ZERO writers of project trust: no `setProjectTrusted`, no write to `trust.json`, no `ProjectTrustStore` mutation. The only mentions are reads and comments (spawn-primitive.ts:576-620 hand-mirrors the store for a pre-spawn veto, which the file documents as deliberate).

BUILD scripts/check-no-free-text-command.mjs, exit 1 with a precise message per violation, and structure it as EXPORTED PURE FUNCTIONS over file contents plus a thin `main()` — so your test drives the functions over fixture strings and does not have to mutate the repo.
RULE A — NO COMMAND-SHAPED FIELD ON ANY CLIENT→SERVER FRAME. Parse packages/geist-protocol/src/wire.ts, find every schema that is a member of `ClientFrameSchema`, and fail if any declares a field named (case-insensitively) command, cmd, argv, args, exec, executable, shell, entrypoint, interpreter, path, cwd, dir, env or environment. WRITE THE RULE AS A RULE, NOT AS A LIST OF FRAME NAMES — a gate that enumerates today's frames is silent about tomorrow's, and tomorrow's is the one that will carry the field. EXPLICITLY EXEMPT `input.data`, and say why in the code: it is keystrokes to an already-running session whose existence the local machine already authorised; it is not a choice of what to execute. Server→client frames are NOT in scope — `permission_request` legitimately carries `command`, `path` and `cwd`, because describing what a tool is about to do is the entire point of a permission ask.
RULE B — NO SPAWN-SELECTING FIELD ON THE HTTP SURFACE. Fail if any route under packages/gateway/src/gateway/routes/ reads a `command`/`argv`/`cmd` key out of a request body, EXCEPT to refuse it. The existing `if ("command" in bodyObj) return c.json({ error: COMMAND_REJECTED }, 400)` at sessions.ts:157 must pass, and a version that passed it onward must fail. Implement it as: a body-key read of those names is a violation unless the same statement's block reaches a 4xx.
RULE C — NO TRUST WRITERS IN THE DAEMON. Scan packages/gateway/src and every packages/geist*/src and fail on a call to `setProjectTrusted`, `setMany`, a `writeFileSync`/`writeFile` whose target expression mentions `trust.json`, or an import of `ProjectTrustStore` used for anything but a read. Comments and strings must not trigger it — strip comments first (scripts/geist-conformance/schema-shape.mjs:133 has a `stripComments` you can copy the shape of; do not import it, it is a conformance helper).
EACH RULE PRINTS THE FILE, THE LINE AND WHAT WOULD HAVE TO CHANGE. A gate that says "violation found" and not where has cost somebody an afternoon.
MODEL THE FILE ON scripts/check-geist-boundary.mjs and scripts/check-geist-mirrors.mjs: same header style (what it enforces, why, and the incident that motivated it), same `walk`/`SKIP_DIRS` shape, same `node scripts/<name>.mjs` usage line.

TEST FILE: scripts/check-no-free-text-command.test.mjs (new), `node --test` style — copy the shape of scripts/check-bun-serve-hostname.test.mjs. Drive your exported functions over fixture STRINGS: a client frame carrying `command` fails; the same field on a server frame passes; `input.data` passes; a route that reads `body.command` and refuses with 400 passes while one that passes it to a spawner fails; a `setProjectTrusted(` call in a gateway source fails while the same text inside a comment or a string literal passes. THEN run the real gate over the real repo and assert it exits 0 — the gate must be green on this tree, and a gate that has never been run against reality is a gate nobody knows the shape of.

YOUR COMMIT LEAVES ONE TEST RED BY CONSTRUCTION, AND THAT IS EXPECTED. scripts/root-test-script-parity.test.mjs fails when a `scripts/*.test.mjs` exists that `npm test` never reaches, and root package.json is ORCHESTRATOR-OWNED — you may not edit it. Run `node --test scripts/root-test-script-parity.test.mjs`, confirm it fails naming YOUR file and nothing else, and paste that exact message into your commit body along with the three edits the integrator owes: add `"check:no-free-text-command": "node scripts/check-no-free-text-command.mjs"` to `scripts`, append ` && npm run check:no-free-text-command` to the `check` script, and append ` scripts/check-no-free-text-command.test.mjs` to `test:scripts`. Do not work around this by renaming your test file out of the pattern; the pattern is what makes the wiring gate work.

TRAPS (each has cost hours here): `rtk` wraps `grep`/`ls` and MANGLES their output — line numbers and content from them are NOT trustworthy; use `sed -n`, `python3` or Read for anything load-bearing, and do not build this gate on `grep` output. `npx tsc --noEmit -p packages/<pkg>` prints 'TypeScript: No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the REPO ROOT; packages/gateway has its OWN typecheck over `src/__tests__/` which the root tsconfig EXCLUDES, so run `npm --prefix packages/gateway run typecheck` too if you touch a gateway test. `npx biome` fails; use `./node_modules/.bin/biome`. This shell exports DRAHT_PERMISSION_MODE=auto — prefix every spawn with `env -u DRAHT_PERMISSION_MODE`. NEVER run a whole-package suite — they flake under parallel load; run only your file: `env -u DRAHT_PERMISSION_MODE node --test scripts/check-no-free-text-command.test.mjs`.

MUTATION TEST, in an isolated rsync copy and NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-gate
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does NOT isolate this monorepo: packages/<x>/node_modules/@draht/<y> are RELATIVE symlinks resolved against the target's REAL path (node_modules/@draht/coding-agent -> ../../packages/coding-agent), so a worktree edit is visible to the supposedly isolated run. Do NOT exclude and do NOT symlink packages/*/dist. ~3 GB, a few minutes. SANITY-CHECK ISOLATION FIRST with a mutation you KNOW must fail: in $DST only, add `command: z.array(z.string()).optional(),` to `SessionResumeFrameSchema` in packages/geist-protocol/src/wire.ts; run your gate in $DST and confirm it EXITS 1 naming that field; run it in $SRC and confirm it still exits 0. Only after that does a passing mutation result mean anything. Restore by copying pristine bytes, never by retyping.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings scripts/check-no-free-text-command.mjs scripts/check-no-free-text-command.test.mjs

WHAT THIS DOES NOT CLOSE: this is evidence class 2 and it is a WIRING GATE — it closes no acceptance clause on its own. It exists so that the surface the class-3 suites assume absent stays absent.

### W2-SPEC-FRAMES — docs/geist/spec.md §15.3 — the spawn verb, written down before 1.0 freezes it

- **Wave** 2 · **Requirement** R36-SPAWN.1 · **Evidence class** 2 · **Depends on** W2-WIRE-BATCH
- **Files** `docs/geist/spec.md`
- **Test** `packages/gateway/src/__tests__/spawn-docs-contract.test.ts`

You are documenting the two frame pairs that were just added to the geist wire, and extending the contract test that keeps the document honest. You see nothing of the conversation that produced this plan; everything you need is here.

YOU MUST RUN AFTER THE WIRE BATCH. Your contract test asserts that the symbols you cite exist in packages/geist-protocol/src/wire.ts. If `SessionSpawnFrameSchema` is not there yet, the wire-batch task has not landed in this tree — WAIT or rebase. Do NOT weaken the assertion into a spell-check to make it pass; layer 2 is the only thing that stops this file from being one.

WHY NOW AND NOT LATER. Phase 38 freezes the protocol as `geist/1.0` one phase after this, and R38-ONE.5 requires a headless journey client depending only on geist-protocol to execute every journey the renderers claim — including spawn. A verb that is not written down is a verb that gets frozen with its semantics living only in a zod schema.

WHAT EXISTS. docs/geist/spec.md is 275 lines. `## 9.2 WS protocol — r5 plus` is the protocol section; `## 15. Security & privacy` carries `### 15.1 Spawned sessions get a built environment; discovered sessions keep yours` and `### 15.2 The registry is user-owned, and is the only thing that names what may be launched`, both written last wave. packages/gateway/src/__tests__/spawn-docs-contract.test.ts guards them in TWO LAYERS, and you extend both: (1) each section is located by its heading and asserted on its OWN body, so a phrase appearing elsewhere in a 275-line spec cannot stand in for a deleted section; (2) the symbols the section cites are asserted to still exist in the source it describes, because a claim nobody re-checks decays into a lie that reads authoritatively. It also enforces `assertNoLineCitations`: the doc cites implementation BY SYMBOL, never as `file.ts:390`, because three tasks edit spawn-primitive.ts across this phase and a line number written into a public spec is wrong before the phase lands — a wrong citation is worse than none because it sends a reader to unrelated code. Read the whole file before you touch it; its header explains every choice you are inheriting.

WRITE `### 15.3 Starting work from the phone: two ids, and nothing else` into docs/geist/spec.md, in the voice of the surrounding sections — product statements a reader can act on, not changelog entries. It must state:
1. THE VERB AND ITS SHAPE. A client asks to start work with `session_spawn`, carrying a harness id and a project id and NOTHING ELSE — no path, no cwd, no argv, no environment. The daemon resolves both against its own user-owned registry and constructs what runs itself, so the worst a caller can name is an entry that exists or one that does not. Say plainly that a `path` field here — even a validated one — would make the renderer a party to what executes, and that this frame reaches a phone. Cite `SessionSpawnFrameSchema` and `SessionResumeFrameSchema` by symbol as the two frames built on the same rule.
2. THE ANSWER AND ITS CLOSED CODE SET. Exactly one `session_spawned` answers exactly one `session_spawn`, and it is sent when the answer is TRUE — not optimistically on receipt, because the failure that would then have to be reported has no frame left to arrive in. List the six codes (`spawned`, `unknown_harness`, `unknown_project`, `refused`, `spawn_failed`, `timeout`) and say what each means to a person. State that `sessionId` is present only on success because the DAEMON mints the id, which is the one shape difference from `session_resumed`.
3. THE PICKER'S DATA. `registry_resync` → `registry` lists the harness ids and the projects the operator declared, and NEVER an executable path: a project root is where your work is and already crosses the wire as a fleet row's `cwd`, whereas an executable path tells a client what to attack and buys the picker nothing. Say that discovery-by-scanning and the recents list are deliberately NOT part of what the phone can spawn into in v1, so the picker shows exactly what is written in `~/.geist/config.yaml`'s `projects` map.
4. CAPABILITIES, NOT PROBING. A renderer reads `server_hello.capabilities` for `session-spawn` and `registry` before sending either verb; an undeclared type is refused and the connection is CLOSED, so probing for a verb costs the connection. A capability says a frame will be understood, never that the connection sending it has earned anything.
5. WHAT IS DELIBERATELY ABSENT: there is no stop verb on the wire. Stopping a session is the daemon's own lifecycle concern with its own deadline, and putting a stop on the wire one phase before the 1.0 freeze is a bigger commitment than the product needs.
Also add one sentence to `## 9.2 WS protocol` pointing at §15.3, if and only if that section already enumerates verbs — read it first and match what it does.

EXTEND packages/gateway/src/__tests__/spawn-docs-contract.test.ts with a §15.3 describe that mirrors the existing two: LAYER 1 anchors on the requirement's own load-bearing words that you introduce ("nothing else", "never an executable path", "no stop verb"), asserted on §15.3's OWN body via the existing `section()` helper — never on the whole spec — and not on prose ordinary editing would touch. LAYER 2 asserts the symbols §15.3 cites still exist in packages/geist-protocol/src/wire.ts: `SessionSpawnFrameSchema`, `SessionSpawnedFrameSchema`, `SessionSpawnCodeSchema`, `RegistryResyncFrameSchema`, `RegistryFrameSchema`; that `SessionSpawnFrameSchema`'s declared body mentions no field named path/cwd/argv/command/env — the doc's central claim, re-checked against the code that has to keep it true; and that `RegistryHarnessSchema`'s body does NOT mention `cmd`. Keep `assertNoLineCitations` passing over your new prose.

TRAPS (each has cost hours here): `rtk` wraps `grep`/`ls` and MANGLES their output — line numbers and content from them are NOT trustworthy; use `sed -n`, `python3` or Read for anything load-bearing. `npx tsc --noEmit -p packages/gateway` prints 'TypeScript: No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the REPO ROOT, and packages/gateway has its OWN typecheck over `src/__tests__/` which the root tsconfig EXCLUDES: run `npm --prefix packages/gateway run typecheck` too, because you edit a gateway test. `npx biome` fails; use `./node_modules/.bin/biome`. This shell exports DRAHT_PERMISSION_MODE=auto — prefix every spawn with `env -u DRAHT_PERMISSION_MODE`. NEVER run a whole-package suite — they flake under parallel load; run only your file: `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/spawn-docs-contract.test.ts`.

MUTATION TEST, in an isolated rsync copy and NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-spec
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does NOT isolate this monorepo: packages/<x>/node_modules/@draht/<y> are RELATIVE symlinks resolved against the target's REAL path (node_modules/@draht/coding-agent -> ../../packages/coding-agent), so a worktree edit is visible to the supposedly isolated run. Do NOT exclude and do NOT symlink packages/*/dist. ~3 GB, a few minutes. SANITY-CHECK ISOLATION FIRST with two mutations you KNOW must fail, one per layer: in $DST only, (a) delete the "never an executable path" sentence from §15.3 and confirm your test FAILS; (b) restore it, then rename `RegistryFrameSchema` in $DST's wire.ts and confirm your layer-2 assertion FAILS. Run both in $SRC and confirm they still pass. Only after that does a passing mutation result mean anything. Restore by copying pristine bytes, never by retyping.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/gateway/src/__tests__/spawn-docs-contract.test.ts

WHAT THIS DOES NOT CLOSE: this is evidence class 2. This file reads files off disk and spawns nothing. What is proven here is only that the documents say it; that the daemon does it is wave 5's class-3 job.

## Wave 2 open questions

- NEW, raised by planning the resolver: does v1 `session_spawn` accept ANY declared harness id, or only harnesses that publish an attachable socket? R36-SPAWN.8 requires a spawned session to be indistinguishable from a discovered one — same id space, same attach path — which only the draht CLI satisfies today. A registry entry like `codex: {cmd: /usr/local/bin/codex-acp}` would resolve, spawn, publish nothing, and be refused `timeout` after 30 s. W2-HARNESS-RESOLVE takes an optional `spawnableHarnessIds` defaulting to 'every declared id'; the answer is ONE LINE at W4's call site in fleet.ts. Oskar's own `~/.geist/config.yaml` names four harnesses, three of which cannot work in v1.

- NEW: docs/geist/spec.md §15.2 — written last wave — already CLAIMS the daemon reads `~/.geist/config.yaml` 'or an explicit --registry path'. No such flag exists on packages/gateway/src/cli.ts. Either wave 4 adds it (planned as inherited work) or the sentence is false the day it ships. Wave 5's adversarial-registry suite also needs a way to point the daemon at a fixture registry; overriding HOME works today (four gateway e2es already do it) but is not what the spec promises.

- NEW: the `stdout: "ignore"` decision is delegated to W2-DEADLINES-STOP as a MEASUREMENT, not decided here. If an rpc-mode session with an unwritten stdin turns out to stream its output over stdout, the daemon cannot pipe it — you cannot un-pipe a live child without deadlocking it or killing it with SIGPIPE — and the first-output deadline becomes a first-STDERR deadline. That outcome is acceptable; it must be recorded with the measured number rather than assumed.

- STILL OPEN, escalated before this wave and NOT planned around: does resume also get `--no-approve`, or only spawn? W2-SPAWN-ARGV pins the one-line answer — adding `"--no-approve"` to the resume argv array at spawn-primitive.ts:802 — and does not make it.

- STILL OPEN: what is the local re-grant path for a phone-spawned session? Nothing in wave 2 turns a running untrusted session into a trusted one, and nothing in wave 2 assumes an answer.

- STILL OPEN: `DRAHT_CODING_AGENT_DIR` crosses into the child by design (spawn-primitive.ts:409) and that directory is the root for `auth.json`, which holds every provider's credential. The `credentialEnv` list W2-HARNESS-RESOLVE returns fixes only the ENVIRONMENT half; the FILE half is untouched by anything in wave 2.

- STILL OPEN: is a spawned session the daemon's child? W2-DEADLINES-STOP is written so the answer stays a one-line change at spawn-primitive.ts:811, and so that flipping it cannot turn `stop()` into a signal against the daemon's own process group.

- WAVE 2 CLOSES NO REQUIREMENT — every task is evidence class 2 and each brief says so in its own commit body. If the phase's acceptance is read off wave 2, it will be read wrong: the class-3 suites that drive the emitted daemon are wave 5, and until they exist the only proven claims are that the mechanisms exist and refuse.

---

# Wave 3 — execution plan

> Produced 2026-08-22 at HEAD 2965a99bc. **ORCHESTRATOR CORRECTION:** the plan states W2-SPAWN-ARGV
> never landed. That was TRUE at its planning HEAD and is now STALE — `spawn-argv.ts` and
> `spawn-argv-posture.e2e.test.ts` landed in 041a2cdeb, after planning began. **W3-ARGV and W3-POSTURE
> are therefore ALREADY DONE; do not re-run them.** The shipped argv matches this plan's spec exactly.
> Wave 3 is W3-LAUNCH, W3-LAUNCHER and W3-FLEET-JOIN.

## Wave 3 design

Repo root: /Users/exe008/draht/draht-mono. HEAD at planning time: 2965a99bc. Waves 1 and 2 are committed.

WAVE 2 SHIPPED FIVE OF ITS SIX TASKS, NOT SIX — I verified this by looking, not by reading the status line. `packages/gateway/src/session/spawn-argv.ts` DOES NOT EXIST, `spawn-argv-posture.e2e.test.ts` does not exist, and `buildSpawnArgv` has zero occurrences anywhere in the tree outside PLAN.md. STATE.md says "waves 1 and 2 complete and committed (11 tasks, 11 commits)" — 6 + 5, and W2-SPAWN-ARGV is the missing one. So wave 3 owns THREE things, not two: the argv wave 2 dropped, `SessionSpawner.launch()`, and the composition that turns two registry ids into a running session.

WHAT WAVE 3 BUILDS. (1) `spawn-argv.ts` — the frozen argv `[...leadingArgs, "--session-id", id, "--attachable", "--mode", "rpc", "--no-approve", "--context-root", root]`, validated and refusing, with no caller-supplied free text anywhere in it. (2) `SessionSpawner.launch()` in spawn-primitive.ts, sharing the ENTIRE post-spawn block with `resume()` — listeners-before-any-early-return, the bounded stderr drain that must never close the read end, the lock-owner-pid readiness poll, the deadlines, `#release`, `#teardown` — extracted into ONE origin-agnostic private method that both callers reach, plus per-harness `credentialEnv` narrowing `DECLARED_CREDENTIAL_ENV`. (3) `session-launcher.ts` — the registry provider asked per call, `resolveHarnessLaunch`, the minted session id, the daemon-wide in-flight guard keyed on `project:harness`, and the two exhaustive code mappings onto the wire's `SessionSpawnCode`. (4) The behavioural proof that `--no-approve` and `--context-root` actually do what R36-SPAWN.5/.6 need, through the emitted coding-agent binary. (5) The proof that a launched process is a real fleet member: a real child, a real socket, a real `attachJourney` over the public protocol against the emitted daemon.

WAVE 3 IS STILL EVIDENCE CLASS 2, AND I AM SAYING SO LOUDLY. Every one of the five tasks is class 2. Nothing in wave 3 closes a requirement. The reason is one wiring: `AttachBridgeOptions.spawnSession` and `.registry` still have zero production callers, so the shipped daemon answers `session_spawn` with `{ok:false, code:"refused"}` and `registry_resync` with two empty arrays, and `createFleetRoutes` does not even accept a `spawnSession` option. Until wave 4 edits `packages/gateway/src/gateway/routes/fleet.ts`, no spawn can be driven over the public protocol, and "class 3 = production e2e through the emitted binary or public protocol" is unreachable for the spawn origin by construction. W3-FLEET-JOIN gets as close as is honestly possible — the emitted daemon, a real WebSocket, a real attach journey, a real detached child in its own process group — but the SPAWN itself is an in-process library call in that file, not a `session_spawn` frame, and its brief says so in the file header. I deliberately did NOT pull fleet.ts forward to manufacture a class 3; that is wave 4's file and stealing it would leave wave 4 with nothing but a rename.

ONE THING I MOVED FORWARD FROM WAVE 4, WITH A REASON. Wave 2's plan assigned the `HarnessResolutionCode` -> `SessionSpawnCode` exhaustive switch to wave 4, on the grounds that the resolver and the wire batch had to be able to land in either order. Both have now landed, so that rationale is spent, and a mapping with no consumer is a mapping nobody can test. It goes in W3-LAUNCHER next to the composition that produces both halves. Wave 4's remaining job is genuinely wiring: construct one launcher in fleet.ts, hand `spawnSession` and `registry` to the bridge, add `--registry` to the gateway CLI, decide `spawnableHarnessIds` in one line, and delete the `command` parameter chain.

ONE THING I OVERRODE. Wave 2's inherit list says wave 4 should "extend `#inFlight` keying to cover both the minted session id and the `project:harness` pair". The same plan says, two constraints later, that "a freshly minted uuid is unique by construction and bounds nothing on its own". Both cannot be right. The guard is keyed on `project:harness` ONLY, and W3-LAUNCHER's brief says why in one line.

THE FOUR QUESTIONS STILL OPEN WITH THE HUMAN ARE NOT PRESUMED, and each has a named one-line landing site so the answer stays cheap. (a) Does resume also get `--no-approve`? One line: the `const argv = [...resolved.leadingArgs, "--session", session.path, "--attachable", "--mode", "rpc"]` array inside `SessionSpawner.resume()` (spawn-primitive.ts:823 at HEAD). W3-ARGV names it and W3-LAUNCH is forbidden to change it. (b) The local re-grant path for a phone-spawned session: nothing in wave 3 turns a running untrusted session into a trusted one, and no task assumes such a path exists. (c) `DRAHT_CODING_AGENT_DIR` crossing into the child and exposing `auth.json`: W3-LAUNCH fixes only the ENVIRONMENT half via `credentialEnv`; the FILE half is one line, `child.DRAHT_CODING_AGENT_DIR = options.agentDir` (spawn-primitive.ts:565), and `agentDir` is already an explicit option so a per-harness directory is a one-line caller change. (d) Is a spawned session the daemon's child? `detached: this.#detached` (spawn-primitive.ts:836) — because `launch()` goes through the SAME shared block, flipping that one line flips both origins at once, and `stop()` already records group-signallability from the spawn options so the flip cannot turn a teardown into a signal against the daemon's own group.

OUTSTANDING WAVE-2 INTEGRATOR DEBT, WHICH WILL BITE THE WAVE-3 ORCHESTRATOR. `scripts/check-no-free-text-command.mjs` and `scripts/check-no-free-text-command.test.mjs` both exist and root package.json references NEITHER. `scripts/root-test-script-parity.test.mjs` is therefore RED at HEAD, exactly as wave 2 pre-announced. Wave 2's plan names the fix precisely: append ` && npm run check:no-free-text-command` to the `check` script, add `"check:no-free-text-command": "node scripts/check-no-free-text-command.mjs"`, and append ` scripts/check-no-free-text-command.test.mjs` to `test:scripts`. Root package.json is orchestrator-only; no wave-3 task may touch it. Do not let a wave-3 implementer report that red as theirs.

## Wave 3 ordering constraints

- W3-ARGV LANDS FIRST AND TWO TASKS IMPORT IT. `buildSpawnArgv` is a compile-time dependency of W3-LAUNCH (which calls it inside `launch()`) and an assertion target of W3-POSTURE (which proves the flags it emits actually work). Neither may declare a local copy of the frozen array; a second copy is exactly how the argv the daemon builds and the argv anybody proved anything about drift apart.

- packages/gateway/src/session/spawn-primitive.ts HAS EXACTLY ONE WAVE-3 OWNER: W3-LAUNCH. This is the same rule wave 1 (W1-EXEC-WALK) and wave 2 (W2-DEADLINES-STOP) ran under and it is the single reason the gateway track cannot fan out. W3-LAUNCHER and W3-FLEET-JOIN import `SessionSpawner`, `SpawnRefusedError` and `SpawnRefusalCode` from it and MUST NOT edit it.

- NO IMPORT CYCLE. `packages/gateway/src/session/harness-resolver.ts` already imports `canonicalize`, `SpawnRefusedError` and `ExecutableRoots` FROM spawn-primitive.ts. spawn-primitive.ts must therefore NEVER import from harness-resolver.ts. `launch()` declares its own structural input interface with the fields it needs (`sessionId`, `executable`, `leadingArgs`, `projectRoot`, `credentialEnv`); `ResolvedHarnessLaunch` is structurally compatible and W3-LAUNCHER passes one straight in. spawn-primitive.ts -> spawn-argv.ts is a clean one-way edge and is the only new import allowed into that file.

- THE POST-SPAWN BLOCK IS SHARED, NEVER COPIED. Everything from the `spawn(...)` call through the final `timeout` throw is origin-agnostic: listeners-attached-before-any-early-return (an `error` event with no listener is an uncaught exception that takes the whole daemon down — measured, not assumed), the stderr drain that retains a bounded prefix and must never close the read end (EPIPE on stderr, and the default disposition of SIGPIPE is to terminate — a cleanup that kills the session you just started), the lock-owner-pid readiness poll, the spawn/handshake/first-output deadlines, `#release`'s unref of BOTH pipes and the child handle, and the teardown. Sharing it is most of what makes R36-SPAWN.8 true for free; duplicating it is how the two origins drift apart. W3-LAUNCH's own test file carries a source-level assertion that the copy does not exist, because no runtime test can see one.

- DEADLINE AND ENVIRONMENT DEFAULTS MUST KEEP RESUME BYTE-IDENTICAL. `handshakeDeadlineMs` stays 30 000, `stopDeadlineMs` 2 000, `spawnDeadlineMs` 2 000, `firstOutputDeadlineMs` equal to the handshake deadline, and the `deadlineMs`/`teardownGraceMs` aliases keep working. The first-output deadline is non-fatal BY CONSTRUCTION — it defaults equal to the handshake deadline so it can only shorten a wait that was already ending in `timeout` and can never kill a session that binds. HEAD's recent history includes `fix(gateway): keep a silent /attach alive`; a silent healthy session must stay alive.

- `credentialEnv` IS TRI-STATE AND THE THIRD STATE IS THE POINT. On `ChildEnvironmentOptions`: `undefined` means `DECLARED_CREDENTIAL_ENV` (today's resume behaviour, unchanged, so session-resume.e2e's 'a declared credential crosses' test still passes); an EMPTY array means NONE; a non-empty array means EXACTLY those. `isForbiddenEnvName` still beats every declaration. On `launch()`'s input the field is REQUIRED, not optional — a fail-open default reached by forgetting an argument would hand a phone-spawned harness every provider key the daemon holds, and making it required turns that mistake into a compile error. `geist.yaml.example` already documents 'omitting it means none beyond the built-in minimum', so absent-means-none is the shipped contract.

- `DRAHT_RESUME_ENV_ALLOW` STILL APPLIES TO A LAUNCH. It is the daemon operator's own declaration about the daemon's own environment, not a per-harness one, and it is how `DRAHT_STUB_PROVIDER` / `DRAHT_STUB_TOOL_CALLS` / `DRAHT_STUB_RECORD_CONTEXT` reach a spawned child at all. A launch with `credentialEnv: []` and a populated allow-list is the normal test shape; say so in the brief or the implementer will conclude the stub cannot work.

- THE IN-FLIGHT GUARD IS DAEMON-WIDE AND KEYED ON `project:harness` ONLY. I am overriding wave 2's inherit text, which asked for both the minted session id and the pair: a freshly minted uuid is unique by construction and bounds nothing, which the same plan says two constraints later. The claim is taken SYNCHRONOUSLY before the first `await` anywhere below it, released in a `finally`, and the loser is answered `refused` with something true — never `spawned`. fleet.ts:562 records the identical lesson for `SessionResumer`: a per-frame instance gives each frame its own empty set, i.e. the per-connection guard that bounded nothing. Exactly ONE launcher per daemon; wave 4 constructs it.

- THE REGISTRY IS A PROVIDER ASKED PER CALL, NOT A VALUE CAPTURED AT CONSTRUCTION. R36-SPAWN.3 says 'on every load'. `userRegistryProvider` already exists in harness-resolver.ts and re-reads and re-checks the file on every call; W3-LAUNCHER holds the thunk and calls it on every launch and every snapshot. fleet.ts:170-185 records the identical lesson for the device store: reading it once while routes were built froze the answer and made first-ever pairing require a restart.

- THE TWO CODE MAPPINGS ARE EXHAUSTIVE SWITCHES WITH A `never` DEFAULT, moved forward from wave 4 because both halves have now landed and a mapping with no consumer cannot be tested. `HarnessResolutionCode` -> `SessionSpawnCode` is identity on all three members. `SpawnRefusalCode` -> `SessionSpawnCode` collapses `cwd_missing` and `already_live` onto `refused` (the wire's spawn vocabulary has neither) and passes `refused`, `spawn_failed`, `timeout` through. Adding a member to either union must be a compile error at that switch.

- `sessionId` CROSSES ONLY WHEN A PROCESS WAS STARTED. `SessionSpawnedFrameSchema.sessionId` is optional precisely because the daemon mints it and a refusal has none to name. W3-LAUNCHER must not return a minted id alongside a refusal even though the bridge would drop it: a renderer handed an id for a session that does not exist will try to attach to it.

- packages/gateway/src/__tests__/session-resume.e2e.test.ts AND fleet-attach.e2e.test.ts ARE READ-ONLY FOR THE WHOLE PHASE, by every task, in every wave. Baseline to protect and to re-measure after the extraction: session-resume is 23 pass / 0 fail / 130 expect() / 56.7 s. Any task that lowers that number has broken something.

- packages/gateway/src/__tests__/spawn-deadlines-stop.test.ts IS NOT READ-ONLY BUT ITS 16 TESTS MUST PASS UNCHANGED. It injects `resolveExecutable` and drives `spawner.resume(...)` fourteen times; it is the closest thing wave 3 has to a regression harness for the extraction. It asserts message SUFFIXES only ('did not publish its socket within N ms', 'published no socket and never said a word within N ms'), never the 'the resumed session' prefix — so parameterising that prefix is safe, and if an implementer finds themselves editing an assertion there they have changed behaviour and must say so loudly rather than adjust the expectation.

- BUILD packages/coding-agent ONCE, BEFORE DISPATCH, NOT PER SUITE. `bun run build` in packages/coding-agent takes roughly a minute and two wave-3 suites drive `dist/cli.js`. Two concurrent builds contend on the same output directory. The orchestrator runs it once before dispatching wave 3; W3-POSTURE and W3-FLEET-JOIN assert `packages/coding-agent/dist/cli.js` exists and rebuild only if it does not.

- ROOT package.json IS ORCHESTRATOR-ONLY AND CARRIES OUTSTANDING WAVE-2 DEBT. `scripts/check-no-free-text-command.mjs` and its `.test.mjs` exist and root package.json references neither, so `scripts/root-test-script-parity.test.mjs` is RED at HEAD — pre-announced by wave 2, not caused by wave 3. The integrator closes it with three edits: `"check:no-free-text-command": "node scripts/check-no-free-text-command.mjs"`, ` && npm run check:no-free-text-command` appended to `check`, and ` scripts/check-no-free-text-command.test.mjs` appended to `test:scripts`. No wave-3 task may edit that file.

- W3-FLEET-JOIN'S NEGATIVE ASSERTION IS A DELIBERATE WAVE-4 TRIPWIRE. It asserts that `server_hello` does NOT advertise `session-spawn` and that a `session_spawn` frame is answered `{ok:false, code:"refused"}` — because nothing wires the port yet. That assertion is expected to be INVERTED by wave 4, and the file must carry a comment saying so. It is how the gap between 'the mechanism exists' and 'the daemon does it' is recorded as a failing test rather than as prose nobody re-reads.

- WAVE 3 CLOSES NO REQUIREMENT. All five tasks are evidence class 2 and every commit body must say so. If the phase's acceptance is read off wave 3 it will be read wrong: the class-3 suites that drive the emitted daemon over a real `session_spawn` frame are wave 5.

## Wave 3 collision hotspots

- packages/gateway/src/session/spawn-primitive.ts — W3-LAUNCH is the ONLY wave-3 task that may edit it. W3-LAUNCHER and W3-FLEET-JOIN import `SessionSpawner`, `SpawnRefusedError`, `SpawnRefusalCode` and `buildChildEnvironment` from it read-only. These symbols have live importers OUTSIDE this file (harness-resolver.ts imports `canonicalize`, `SpawnRefusedError`, `ExecutableRoots`; session-resume.e2e imports `assertSafeExecutablePath`, `buildChildEnvironment`, `SpawnRefusedError`; spawn-deadlines-stop imports `SessionSpawner`) — the owner may add to them but must not change their existing shapes, except the one additive optional `credentialEnv` field on `ChildEnvironmentOptions`.

- packages/gateway/src/session/spawn-argv.ts — W3-ARGV only, and it is a NEW file. W3-LAUNCH imports `buildSpawnArgv` from it and must not redefine the array. W3-POSTURE imports it to prove the flags it drives are the ones the daemon will build.

- packages/gateway/src/session/harness-resolver.ts — NOBODY EDITS IT IN WAVE 3. It landed complete in wave 2 (`resolveHarnessLaunch`, `registryProjection`, `userRegistryProvider`, `HarnessResolutionError`) with 30 passing tests. W3-LAUNCHER and W3-FLEET-JOIN import from it. If it appears to be missing something, say so in your report rather than editing it — it is the file another wave already reviewed.

- packages/gateway/src/gateway/routes/fleet.ts — NOBODY EDITS IT IN WAVE 3. It is wave 4's file: the `spawnSession`/`registry` ports, the one-launcher-per-daemon construction, and the `--registry` flag all land there. A wave-3 task that edits it steals wave 4's only content and puts two owners on the daemon's composition root.

- packages/geist-core/src/attach/attach-bridge.ts and packages/geist-protocol/src/* — NOBODY EDITS THEM IN WAVE 3. The geist/0.5 wire, `SpawnSessionPort`, `RegistryPort`, `SessionSpawnOutcome`, `RegistrySnapshot` and the capability strings all landed in wave 2. Wave 3 fills those ports; it does not reshape them.

- packages/coding-agent/dist — W3-POSTURE and W3-FLEET-JOIN both drive `dist/cli.js` and both would otherwise run `bun run build` in `beforeAll`. Two concurrent builds contend on one output directory and a half-written `cli.js` fails in ways that look like a spawn bug. The orchestrator builds ONCE before dispatching the wave; both tasks check for `dist/cli.js` and only build if it is absent.

- packages/gateway/src/__tests__/session-resume.e2e.test.ts and fleet-attach.e2e.test.ts — READ-ONLY for the whole phase, by every task. They are the prior art every wave-3 task should read (the daemon harness, the `until` helper, the short-temp-dir rule, the detached-child reaping in `afterAll`) and the baseline the extraction must not move.

- packages/gateway/src/__tests__/helpers/{process-table,attach-journey,listening-sockets}.ts — wave-1 helpers, shared and NOT edited by wave 3. `FROZEN_ROW_KEYS` and `assertFrozenRowShape` are what R36-SPAWN.8 is asserted against; W3-FLEET-JOIN consumes them. If a helper is missing something, add a local function in your own test file and say why in your report.

- package.json (root) — ORCHESTRATOR ONLY. It already owes three lines from wave 2 (see ordering constraints); no wave-3 task may open it, and no wave-3 task should add a `scripts/*.test.mjs` that would owe it a fourth.

## Wave 3 tasks

### W3-ARGV — The spawn argv: nine elements, no free text, and the flag combination that would exit 1  [ALREADY LANDED IN 041a2cdeb — DO NOT RE-RUN]

- **Wave** 3 · **Requirement** R36-SPAWN.5 · **Evidence class** 2 · **Depends on** nothing
- **Files** `packages/gateway/src/session/spawn-argv.ts`
- **Test** `packages/gateway/src/__tests__/spawn-argv.test.ts`

Repo root: /Users/exe008/draht/draht-mono. You are building the argv a phone-initiated session is started with. You see nothing of the conversation that produced this plan; everything you need is here.

WHY THIS EXISTS AND WHY IT IS NOT ALREADY DONE. This task was planned for the previous wave and never landed — `packages/gateway/src/session/spawn-argv.ts` does not exist and `buildSpawnArgv` has zero occurrences anywhere in the tree. Two tasks in this wave import it. It is the first thing that must land.

BUILD ONE NEW FILE, packages/gateway/src/session/spawn-argv.ts:

```ts
export interface SpawnArgvInput {
	/** Minted by the daemon, never supplied by a client. */
	sessionId: string;
	/** Canonical absolute project root: the session's cwd AND the context boundary. */
	projectRoot: string;
	/** From the resolved executable — an interpreter's script path and the harness's own args. */
	leadingArgs: readonly string[];
}
export function buildSpawnArgv(input: SpawnArgvInput): string[];
```

returning EXACTLY this, and the array is FROZEN because two other tasks assert it element for element:

```
[...leadingArgs, "--session-id", sessionId, "--attachable", "--mode", "rpc", "--no-approve", "--context-root", projectRoot]
```

EACH ELEMENT EARNS ITS PLACE AND THE COMMENT MUST SAY SO — one short line each, no essays:
  • `--session-id <uuid>` is what lets the existing readiness machinery work for a session with NO history row. Two frictions, both verified in source at HEAD: `main.ts` prints `Warning: No project session found with id '<uuid>'; creating a new session with that id.` to STDERR on every fresh spawn (packages/coding-agent/src/main.ts, the `--session-id` branch of the session-manager factory), so the 2 KB stderr prefix the spawner retains starts NON-EMPTY and a `spawn_failed` message will quote it; and `validateSessionIdFlags` (same file) EXITS 1 if `--session-id` is combined with `--session`, `--continue` or `--resume`. That second one is why spawn and resume are TWO argvs sharing ONE post-spawn block and never one argv with a branch.
  • `--attachable` explicit, so a bind failure is FATAL to the child rather than a silent degrade: a spawned session that is not on the fleet is a spawn that did not happen.
  • `--mode rpc` required: with no TTY, `resolveAppMode` falls through to print mode, the process answers once and exits, and the socket appears and vanishes.
  • `--no-approve` because a remotely spawned session must start UNTRUSTED. `packages/coding-agent/src/cli/args.ts` maps `--no-approve`/`-na` to `projectTrustOverride = false`, and `main.ts` then computes `projectTrusted` as false regardless of `<agentDir>/trust.json` recording `true` for the project or a global `defaultProjectTrust: "always"`. Both were verified by running the built CLI.
  • `--context-root <projectRoot>` so automatically-read project context (AGENTS.md / CLAUDE.md ancestor discovery in `packages/coding-agent/src/core/resource-loader.ts`) cannot come from ABOVE the project.

VALIDATE THE INPUTS AND REFUSE — DO NOT REPAIR:
  • `sessionId` must match `^[A-Za-z0-9][A-Za-z0-9-]*$`. A hostile id must be unable to look like a flag or a path, so reject anything outside `[A-Za-z0-9-]`, anything empty, and anything starting with `-`. This is deliberately a STRICT SUBSET of `assertValidSessionId` in packages/coding-agent/src/core/session-manager.ts (`^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`) — cite that by SYMBOL in your comment, never by line number. Being a subset is the property: everything this accepts, the child also accepts.
  • `projectRoot` must be absolute.
  • no element of `leadingArgs` may be the empty string. An empty argv element silently shifts nothing visible and is the kind of thing that turns `--mode rpc` into `--mode` with a missing value.
  • `leadingArgs` otherwise pass through UNMODIFIED. They are the interpreter's script path and the operator's own `args` from a uid-checked, 0600, user-owned registry file — an operator declaration, not client text. A leading `-` is legitimate there (`gemini: { args: [--experimental-acp] }` is in geist.yaml.example).

THE MODULE COMMENT MUST SAY, IN ONE OR TWO LINES, THAT THERE IS NO CALLER-SUPPLIED FREE TEXT ANYWHERE IN THIS FUNCTION AND THAT THIS IS THE POINT. The wire's `session_spawn` frame carries two `RegistryIdSchema` ids and nothing else — no path, no cwd, no argv, no env — and this function is where that guarantee turns into a process.

DO NOT ADD A DEPENDENCY ON `@draht/coding-agent`. packages/gateway depends on @draht/geist-console, @draht/geist-core, @draht/geist-protocol and hono, and nothing else. Re-implement the id check locally in about ten lines.

NOTE IN THE MODULE COMMENT, BECAUSE IT IS AN OPEN DECISION AWAITING AN ANSWER: whether RESUME also gets `--no-approve` is UNDECIDED. If the answer turns out to be yes, the ONE-LINE change is adding `"--no-approve"` to the resume argv array inside `SessionSpawner.resume()` in packages/gateway/src/session/spawn-primitive.ts (the `const argv = [...resolved.leadingArgs, "--session", session.path, "--attachable", "--mode", "rpc"]` line, :823 at HEAD 2965a99bc). DO NOT MAKE THAT CHANGE and DO NOT EDIT THAT FILE — another task in this wave owns it.

TEST FILE: packages/gateway/src/__tests__/spawn-argv.test.ts (new). Pure, fast, no processes:
  • a canonical input returns the exact nine-plus-leadingArgs array, element for element, in order
  • `leadingArgs` come FIRST and unmodified — use a realistic pair (`["/abs/path/cli.js", "--experimental-acp"]`) so a mutation that sorts, dedupes or filters them is caught
  • a real `crypto.randomUUID()` is ACCEPTED. This is the positive control and it is not optional: a pattern so strict that nothing passes makes every refusal test vacuous
  • refused: a relative `projectRoot`; a `sessionId` containing `/`, a space, a `.`, a leading `-`, or empty; an empty string in `leadingArgs`
  • the argv contains NONE of `--session`, `--continue`, `--resume`. This is the cross-package assertion that matters most: `validateSessionIdFlags` exits 1 on that combination, so a spawn built with any of them would produce a child that dies before it binds, and the daemon would report `spawn_failed` quoting a message about flags
  • `--context-root`'s value is EXACTLY `projectRoot`, and `--mode`'s value is exactly `"rpc"`

COMMENT BUDGET — HARD CONSTRAINT. Repo baseline is 13.7% in src and 5.9% in tests. Default to NO comment; make the code say it. One line only where a non-obvious runtime constraint would otherwise invite deleting a load-bearing line. No file-header essays, no prose in test names. Your reasoning goes in your REPORT, not the source.

TRAPS (each has cost hours here): `rtk` wraps `grep`/`ls`/`git diff` and MANGLES their output — line numbers and content from them are NOT trustworthy; use `sed -n`, `python3` or Read for anything load-bearing, and `rtk proxy git ...` redirected to a file for git. `npx tsc --noEmit -p packages/gateway` prints 'TypeScript: No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the REPO ROOT, and packages/gateway has its OWN typecheck over `src/__tests__/` which the root tsconfig EXCLUDES: run `npm --prefix packages/gateway run typecheck` too. `npx biome` fails; use `./node_modules/.bin/biome`. This shell exports DRAHT_PERMISSION_MODE=auto — prefix every spawn with `env -u DRAHT_PERMISSION_MODE`. A unix socket path over ~104 bytes fails to bind with EINVAL; agent dirs go directly under /tmp with a SHORT name. zsh has no PIPESTATUS — use `cmd > /tmp/out 2>&1; echo $?`. A `cd` in a compound Bash call persists into the NEXT call; run SRC and DST checks in separate calls. NEVER run a whole-package suite — they flake under parallel load; run only your own file: `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/spawn-argv.test.ts`. NO GIT WRITES: no commit/add/stash/checkout/branch/reset/merge/rebase, and never move a branch ref. Read-only git is fine. Leave your work uncommitted; the orchestrator commits.

MUTATION TEST, in an isolated rsync copy and NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-argv
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does NOT isolate this monorepo: packages/<x>/node_modules/@draht/<y> are RELATIVE symlinks resolved against the target's REAL path, so a worktree edit is visible to the supposedly isolated run. Do NOT exclude and do NOT symlink packages/*/dist. ~3 GB, a few minutes. SANITY-CHECK ISOLATION FIRST with a mutation you KNOW must fail: in $DST only, delete `"--no-approve"` from the returned array; run your test in $DST and confirm it FAILS; run it in $SRC and confirm it still passes. Only after that does a passing mutation result mean anything. Then mutate the id validator to accept a leading `-`, and the `--context-root` value to be the cwd rather than the root, and confirm each is caught. Restore by copying pristine bytes, never by retyping. Every implementer in the previous phase who reported 'no surviving mutations' was wrong — 47 in one wave alone. DISCLOSE SURVIVORS.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/gateway/src/session/spawn-argv.ts packages/gateway/src/__tests__/spawn-argv.test.ts

WHAT THIS DOES NOT CLOSE: this is EVIDENCE CLASS 2 and it closes NOTHING. It proves the array is what it says it is. That the flags in it actually defeat a standing trust grant is a sibling task in this wave, and that the daemon passes them on a real `session_spawn` frame is wave 5's class-3 acceptance. Say so in your commit body.

### W3-LAUNCH — SessionSpawner.launch(): one post-spawn block, two origins, and credentials scoped per harness

- **Wave** 3 · **Requirement** R36-SPAWN.1 · **Evidence class** 2 · **Depends on** W3-ARGV
- **Files** `packages/gateway/src/session/spawn-primitive.ts`
- **Test** `packages/gateway/src/__tests__/spawn-launch.test.ts`

Repo root: /Users/exe008/draht/draht-mono. You own the daemon's spawn primitive for this wave. You see nothing of the conversation that produced this plan; everything you need is here.

YOU ARE THE ONLY TASK IN THIS WAVE ALLOWED TO EDIT packages/gateway/src/session/spawn-primitive.ts. Two sibling tasks import `SessionSpawner`, `SpawnRefusedError` and `SpawnRefusalCode` from it while you work, and three files OUTSIDE this wave already import `canonicalize`, `SpawnRefusedError`, `ExecutableRoots`, `assertSafeExecutablePath` and `buildChildEnvironment` from it (packages/gateway/src/session/harness-resolver.ts, packages/gateway/src/__tests__/session-resume.e2e.test.ts, packages/gateway/src/__tests__/executable-path-walk.test.ts). Add what you need; change none of those existing shapes, with exactly ONE exception named below.

WHAT IS TRUE AT HEAD (2965a99bc), verified by reading it. `SessionSpawner.resume()` starts at :806. Its pre-flight is :812-829 (a `cwd_missing` check, a `projectExplicitlyUntrusted` veto, `this.#resolveExecutable()`, the argv, `buildChildEnvironment`). The spawn is :831-843. EVERYTHING FROM :831 DOWN TO THE FINAL `timeout` THROW AT :953-957 IS ORIGIN-AGNOSTIC AND IS WHAT YOU ARE EXTRACTING. Line numbers drift — three tasks have edited this file this phase — so navigate by symbol and re-read before you touch anything.

WHY EACH PIECE OF THAT BLOCK EXISTS. You must not lose any of it and you must not reorder it:
  • LISTENERS FIRST, BEFORE ANY EARLY RETURN. `spawn` reports a failure it could not detect synchronously — a cwd that vanished between the check and the call, an unreadable binary, EMFILE — as an ASYNCHRONOUS `error` EVENT, and an `error` event with no listener is an uncaught exception that takes the WHOLE DAEMON down. This was MEASURED: with the pre-spawn cwd check removed, a `session_resume` for a moved project killed the gateway and every subsequent request was refused at the socket. Nothing between the spawn and the wait may return or throw first. The stdio pipes are the same: a child that dies with our write end open surfaces as EPIPE on `stdin`, also an unhandled `error` event.
  • THE STDERR DRAIN IS FOREVER AND RETAINS ONLY A 2 KB PREFIX. Closing the read end instead gives the child EPIPE on stderr, and the default disposition of SIGPIPE is to TERMINATE — a 'cleanup' that kills the session you just started.
  • THE READINESS POLL READS THE LOCK OWNER PID, NOT MERELY THAT A SOCKET EXISTS. A socket that exists is not this spawn's success: two connections can ask for one id inside the 3-6 s a bind takes, and the loser's poll would otherwise see the WINNER's socket, return the loser's own pid, and report success for a child that started nothing and then died. Only OUR OWN child's pid in the lock counts. It is ONE stat and ONE small read of TWO known names — not a readdir, and therefore not a second reaper racing the fleet observer.
  • `#release` unrefs the stderr pipe, the stdin pipe AND the child handle. A pipe is its own libuv handle and an unref'd child with a ref'd pipe still holds the event loop open, which would make the daemon un-exitable after one spawn.
  • THE `catch` TEARS DOWN AND RETHROWS; the fall-through after the loop tears down and throws `timeout`.

BUILD THREE THINGS.

(1) EXTRACT THE SHARED BLOCK into ONE private method — suggested `#startAndAwaitSocket` — taking `{ sessionId, executable, argv, cwd, env, what }` and returning `Promise<SpawnOutcome>`. `resume()` keeps ONLY its own pre-flight and then calls it. `what` is a FIXED DAEMON-SIDE LITERAL used in three messages and nothing else: `"the resumed session"` for resume, `"the spawned session"` for launch. It is never free text and never anything a client supplied. THE OTHER MESSAGES ARE ALREADY ORIGIN-NEUTRAL — leave them exactly as they are. packages/gateway/src/__tests__/spawn-deadlines-stop.test.ts asserts message SUFFIXES only (`did not publish its socket within N ms`, `published no socket and never said a word within N ms`, `and never said a word`), never the prefix, so parameterising the prefix is safe.

SHARED, NEVER COPIED. Duplicating this block is how the two origins drift apart, and it is most of what makes 'a spawned session is indistinguishable from a discovered one' true for free. Your own test file carries a source-level assertion that the copy does not exist, because no runtime test can see one.

(2) ADD `launch()`:

```ts
export interface SessionLaunchRequest {
	/** Minted by the daemon. Never supplied by a client. */
	sessionId: string;
	/** Canonical absolute, already ownership-walked and root-contained by the resolver. */
	executable: string;
	leadingArgs: readonly string[];
	/** Canonical absolute. The spawn's cwd AND its `--context-root`. */
	projectRoot: string;
	/** REQUIRED, not optional. See below. */
	credentialEnv: readonly string[];
}
async launch(request: SessionLaunchRequest): Promise<SpawnOutcome>;
```

It builds the argv with `buildSpawnArgv` from packages/gateway/src/session/spawn-argv.ts (a sibling task in this wave landed it — import it, do NOT re-declare the array), builds the env with `buildChildEnvironment({ env: this.#env, agentDir: this.#agentDir, cwd: request.projectRoot, credentialEnv: request.credentialEnv })`, and calls the shared method with `cwd: request.projectRoot` and `what: "the spawned session"`.

IT DOES NOT CALL `this.#resolveExecutable()`. That seam resolves the DAEMON'S OWN draht binary and is resume's; a launch's executable comes from the per-harness registry and arrives in the request.

DECLARE `SessionLaunchRequest` IN THIS FILE. DO NOT IMPORT `ResolvedHarnessLaunch` FROM harness-resolver.ts — that file already imports FROM you (`canonicalize`, `SpawnRefusedError`, `ExecutableRoots`) and the import would be a CYCLE. A structural interface is all that is needed; the caller passes a `ResolvedHarnessLaunch` straight in and TypeScript accepts it.

SHOULD `launch()` KEEP THE `projectExplicitlyUntrusted` PRE-SPAWN VETO? YES. It is the one thing the argv cannot do: `--no-approve` makes the child untrusted, but re-entering a directory the operator has already said NO to is a different refusal and belongs before any process exists. Keep it, and keep the `cwd_missing` existence check too — the resolver realpath'd the root microseconds earlier, but the check is one syscall and 'checked before the spawn, not translated from a dead child afterwards' is the property.

(3) NARROW THE CREDENTIALS. Add ONE optional field to `ChildEnvironmentOptions` — this is the single exception to 'change no existing shape':

```ts
	/** Per-harness scoping. `undefined` = every declared credential (resume, unchanged). `[]` = NONE. */
	credentialEnv?: readonly string[];
```

THE TRI-STATE IS THE WHOLE DESIGN AND YOU MUST GET IT EXACTLY RIGHT:
  • `undefined` -> `DECLARED_CREDENTIAL_ENV`, i.e. today's behaviour, byte-identical. This is what `resume()` passes (by not passing it) and it is what keeps session-resume.e2e's 'a declared credential crosses, an undeclared name does not' test green.
  • `[]` -> NONE. The resolver returns `[...(spec.credentialEnv ?? [])]`, so a harness with no `credentialEnv` in the registry yields an empty array, and geist.yaml.example already documents that as 'none beyond the built-in minimum'.
  • `[...]` -> EXACTLY those names.
  • `isForbiddenEnvName` still beats every declaration, in all three states. A registry that declares `LD_PRELOAD` or `DYLD_INSERT_LIBRARIES` gets nothing.
  • `DRAHT_RESUME_ENV_ALLOW` (the `extra` list) is UNAFFECTED and still applies to both origins. It is the daemon OPERATOR's declaration about the daemon's OWN environment, not a per-harness one, and it is how the stub provider reaches a spawned child at all.

`SessionLaunchRequest.credentialEnv` IS REQUIRED, NOT OPTIONAL. A fail-open default reached by forgetting an argument would hand a phone-spawned harness every provider key the daemon holds; making it required turns that mistake into a compile error. One line of comment says exactly that.

DO NOT CHANGE THE DEADLINES OR THEIR DEFAULTS. `spawnDeadlineMs` 2 000, `handshakeDeadlineMs` 30 000, `firstOutputDeadlineMs` equal to the handshake deadline, `stopDeadlineMs` 2 000, and the `deadlineMs`/`teardownGraceMs` aliases keep working. The first-output deadline is non-fatal BY CONSTRUCTION and must stay that way: HEAD's recent history includes `fix(gateway): keep a silent /attach alive`, and a healthy session is silent for the 3-6 s it takes to bind.

DO NOT CHANGE `detached`. `detached: this.#detached` is a documented OPEN DECISION and the answer is not yours to make. Because `launch()` goes through the SAME shared block, flipping that one line later flips both origins at once — that is a feature, and your extraction is what makes it true. `stop()` already records group-signallability from the spawn options at spawn time, so the flip cannot turn a teardown into a signal against the daemon's own process group.

TEST FILE: packages/gateway/src/__tests__/spawn-launch.test.ts (new). READ packages/gateway/src/__tests__/spawn-deadlines-stop.test.ts FIRST — it is your prior art for the fixture shape (an injected `resolveExecutable`, a fake executable script that binds a socket and writes a lock, `refusalOf`, short temp dirs) and its 16 tests are your regression harness.

Real child processes, a real socket directory under a SHORT /tmp path:
  • a launch whose child binds `<sessionId>.sock` and writes its own pid into `<sessionId>.lock` returns THAT pid
  • THE ARGV THE CHILD ACTUALLY RECEIVED equals `buildSpawnArgv({sessionId, projectRoot, leadingArgs})` exactly — have the fake executable dump `process.argv` to a file and compare element for element. This is the assertion that binds the argv module to the spawn; without it the two can drift silently
  • the child's cwd is `projectRoot`
  • a child that never binds is refused `timeout` after the handshake deadline, the message names 'the spawned session', and NOTHING is left alive — read `stat=` from `ps -A` and treat `Z` as dead; `kill(pid, 0)` succeeds on a zombie and is NOT a liveness oracle
  • a child that exits immediately is refused `spawn_failed` and the message quotes its stderr
  • `credentialEnv: []` with two real credential names populated in the spawner's env: NEITHER crosses, and `PATH` and `HOME` DO. The positive control is not optional — without it a `buildChildEnvironment` that returned `{}` would pass
  • `credentialEnv: ["ANTHROPIC_API_KEY"]` with both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` populated: exactly one crosses, the other does not
  • `credentialEnv: ["LD_PRELOAD"]` with `LD_PRELOAD` populated: it does NOT cross, because the blocklist beats the declaration
  • `resume()` with no `credentialEnv` STILL receives the full `DECLARED_CREDENTIAL_ENV` — the byte-identical guarantee, asserted directly
  • `stop(pid)` on a launched detached child reaches its whole GROUP, grandchild included (the same shape spawn-deadlines-stop.test.ts already uses)
  • THE ANTI-DUPLICATION ASSERTION, source-level, in this same file: read spawn-primitive.ts as text and assert exactly ONE occurrence of the `stdio:` option literal and exactly ONE `detached:` option literal in the whole file. Those are the two lines whose duplication IS the defect, and they are the two lines the open decisions pin. Pick robust anchors, name them in a one-line comment, and prove the assertion is not vacuous by checking the count is 1 and not 0.

RUN BOTH REGRESSION SUITES AND REPORT THEIR NUMBERS: `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/spawn-deadlines-stop.test.ts` (16 tests, all must pass UNCHANGED — if you find yourself editing an assertion there you have changed behaviour and must say so loudly) and `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/session-resume.e2e.test.ts` (BASELINE: 23 pass / 0 fail / 130 expect() / 56.7 s — that file is READ-ONLY for the whole phase and any number below the baseline means you broke something). Both numbers go in your report whether or not they moved.

COMMENT BUDGET — HARD CONSTRAINT. Repo baseline is 13.7% in src and 5.9% in tests. This file is already heavily commented and the existing comments are load-bearing — PRESERVE them through the extraction, do not add a new essay, and do not re-explain what a moved comment already says. Default to NO comment; make the code say it. Your reasoning goes in your REPORT.

TRAPS (each has cost hours here): `rtk` wraps `grep`/`ls`/`git diff` and MANGLES their output — line numbers and content from them are NOT trustworthy; use `sed -n`, `python3` or Read for anything load-bearing, and `rtk proxy git ...` redirected to a file for git. `npx tsc --noEmit -p packages/gateway` prints 'TypeScript: No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the REPO ROOT, and packages/gateway has its OWN typecheck over `src/__tests__/` which the root tsconfig EXCLUDES: run `npm --prefix packages/gateway run typecheck` too. `npx biome` fails; use `./node_modules/.bin/biome`. This shell exports DRAHT_PERMISSION_MODE=auto — prefix every spawn with `env -u DRAHT_PERMISSION_MODE`. A unix socket path over ~104 bytes fails to bind with EINVAL; agent dirs go directly under /tmp with a SHORT name. zsh has no PIPESTATUS — use `cmd > /tmp/out 2>&1; echo $?`. A `cd` in a compound Bash call persists into the NEXT call; run SRC and DST checks in separate calls. `-A` is mandatory on every `ps` scan or tty-less children are invisible. NEVER run a whole-package suite — they flake under parallel load; run only the three files named above. `packages/geist-core/test/attach/{attach-bridge,socket-sessions}.test.ts` have 3 PRE-EXISTING failures that are not yours. NO GIT WRITES: no commit/add/stash/checkout/branch/reset/merge/rebase, and never move a branch ref. Leave your work uncommitted; the orchestrator commits.

MUTATION TEST, in an isolated rsync copy and NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-lnch
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does NOT isolate this monorepo: packages/<x>/node_modules/@draht/<y> are RELATIVE symlinks resolved against the target's REAL path, so a worktree edit is visible to the supposedly isolated run. Do NOT exclude and do NOT symlink packages/*/dist — suites run a build in beforeAll and tsc follows a dist symlink back into the real tree. ~3 GB, a few minutes. SANITY-CHECK ISOLATION FIRST with a mutation you KNOW must fail: in $DST only, make `credentialEnv: []` fall back to `DECLARED_CREDENTIAL_ENV`; run your test in $DST and confirm the empty-list case FAILS; run it in $SRC and confirm it still passes. Only after that does a passing mutation result mean anything. Then mutate, one at a time: delete the stderr `data` listener; move the `error` listener to AFTER the pid wait; make the readiness poll accept any lock owner rather than only your own pid; drop the `unref` of the stderr pipe from `#release`. Each must be caught by something. Restore by copying pristine bytes, never by retyping. FOUR CONSECUTIVE ROUNDS in the previous phase each introduced a new hole with a different fix, and the fifth broke the streak only by HUNTING for one. Hunt for the hole you just created before declaring done, and DISCLOSE SURVIVORS.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/gateway/src/session/spawn-primitive.ts packages/gateway/src/__tests__/spawn-launch.test.ts

WHAT THIS DOES NOT CLOSE: this is EVIDENCE CLASS 2 and it closes NOTHING. `launch()` has no production caller when you are done — `AttachBridgeOptions.spawnSession` still has zero callers and the shipped daemon still answers `session_spawn` with `{ok:false, code:"refused"}`. Wave 4 wires it; wave 5's class-3 suites drive it over the wire. Say so in your commit body.

### W3-POSTURE — Through the emitted binary: --no-approve beats a standing trust grant, --context-root beats the parent directory  [ALREADY LANDED IN 041a2cdeb — DO NOT RE-RUN]

- **Wave** 3 · **Requirement** R36-SPAWN.5 · **Evidence class** 2 · **Depends on** W3-ARGV
- **Files** `packages/gateway/src/__tests__/spawn-argv-posture.e2e.test.ts`
- **Test** `packages/gateway/src/__tests__/spawn-argv-posture.e2e.test.ts`

Repo root: /Users/exe008/draht/draht-mono. You are proving, through the emitted binary, that the two posture flags in the spawn argv actually do what the requirement needs. This is a TEST-ONLY task: you add one file and edit no source. You see nothing of the conversation that produced this plan; everything you need is here.

THE DEFECT YOU ARE CLOSING, and it is the requirement in this phase MOST LIKELY TO BE DECLARED DONE WHILE BROKEN. R36-SPAWN.5 says a remotely spawned session starts UNTRUSTED with project-controlled executable resources disabled. The daemon has a pre-spawn veto today — `projectExplicitlyUntrusted` in packages/gateway/src/session/spawn-primitive.ts reads `<agentDir>/trust.json` and refuses a project recorded as `false` — so the requirement LOOKS green. IT IS NOT. With `trust.json` recording `true` for the project, or a global `defaultProjectTrust: "always"` in `<agentDir>/settings.json`, a started session loads the project's own `.draht/extensions`, `.draht/settings.json`, `.draht/SYSTEM.md`, `.draht/skills` and `.agents/skills`. That was verified by running the built CLI. `--no-approve` defeats both: packages/coding-agent/src/cli/args.ts maps it to `projectTrustOverride = false`, and packages/coding-agent/src/main.ts then computes `projectTrusted` as false regardless of the store or the global default. Separately, `--context-root <abs>` confines AGENTS.md/CLAUDE.md ancestor discovery (packages/coding-agent/src/core/resource-loader.ts) so project context cannot come from ABOVE the project.

WHAT ALREADY EXISTS AND WHAT YOU BUILD ON. A sibling task in this wave landed packages/gateway/src/session/spawn-argv.ts, exporting `buildSpawnArgv({sessionId, projectRoot, leadingArgs})`. IMPORT IT and derive the flags you drive from it — do not hardcode a second copy of the flag list, because the whole point is that the flags the daemon will build are the flags you proved.

TEST FILE: packages/gateway/src/__tests__/spawn-argv-posture.e2e.test.ts (new). Drive `node packages/coding-agent/dist/cli.js` DIRECTLY. Precedent for the harness shape: packages/gateway/src/__tests__/session-resume.e2e.test.ts (its `beforeAll`, its short-temp-dir helper, its child reaping in `afterAll`) — READ IT, it is READ-ONLY for the whole phase and you must not edit it.

USE THE POSTURE SUBSET OF THE ARGV, NOT THE FULL ARGV: `--session-id <uuid> --no-approve --context-root <root> --provider draht-stub --model stub-1 -p "hi"`. `--mode rpc` and `--attachable` need a socket and a driver, and the full argv through a real daemon is wave 5's class-3 job. SAY THAT IN THE FILE HEADER so nobody reads this file as the acceptance. Assert that the subset you drive is a SUBSET of `buildSpawnArgv`'s output, so the two cannot drift.

THE BUILD. packages/coding-agent/dist/cli.js is built ONCE by the orchestrator before this wave is dispatched. In `beforeAll`, check `existsSync(dist/cli.js)` and run `npm run build` in packages/coding-agent ONLY if it is absent — a sibling task in this wave also drives that binary, and two concurrent builds contend on one output directory.

FIXTURE, under a SHORT /tmp directory (a unix socket path over ~104 bytes fails to bind with EINVAL, and the same short-name discipline keeps every path predictable):
  • a project root containing `.draht/SYSTEM.md` with a canary string
  • `.draht/extensions/tripwire.ts` (or .js — copy the module shape from an existing extensions fixture under packages/coding-agent/test) whose MODULE BODY writes a tripwire FILE when it loads
  • an `AGENTS.md` INSIDE the root with a second canary
  • an `AGENTS.md` in the PARENT directory with a third canary
  • an agent dir (`DRAHT_CODING_AGENT_DIR`) whose `trust.json` records this project as `true`, AND whose `settings.json` sets `{"defaultProjectTrust": "always"}`. Both standing grants are the whole point: `defaultProjectTrust` is a GLOBAL-only setting read from `<agentDir>/settings.json`, so both paths to 'trusted' are live and both must lose.
  • env: `DRAHT_STUB_PROVIDER=1`, `DRAHT_STUB_RECORD_CONTEXT=<abs path>`, and `HOME` and `TMPDIR` inside your temp dir so nothing reads the real home

THE RECORDING SEAM is `DRAHT_STUB_RECORD_CONTEXT` (`STUB_PROVIDER_RECORD_CONTEXT_ENV`, packages/coding-agent/src/extensions/stub-provider/provider.ts). Set to an absolute path, the stub writes the `systemPrompt` of the FIRST provider request — and only the first — to that file. That file is your entire assertion surface.

DO NOT USE THE `before_provider_request` EXTENSION EVENT AS A RECORDING SEAM. It NEVER FIRES under the stub provider: sdk.ts wires it to the api layer's `onPayload`, every real adapter calls `onPayload`, and packages/ai/src/providers/faux.ts never does. A recorder extension loads and its factory runs, but the payload hook stays silent. Anyone who reaches for it loses hours to a vacuously green test.

ASSERT, AND EVERY ABSENCE NEEDS ITS POSITIVE CONTROL OR IT IS VACUOUS:
  • the recorded systemPrompt file EXISTS. Without this the next three assertions all pass when nothing ran at all.
  • the IN-ROOT AGENTS.md canary IS PRESENT in it
  • the PARENT AGENTS.md canary is ABSENT
  • the `.draht/SYSTEM.md` canary is ABSENT
  • the extension tripwire file DOES NOT EXIST

VERIFY THE POSITIVE CONTROL EMPIRICALLY FIRST, BEFORE WRITING THE ASSERTIONS. Run the fixture ONCE with NO flags at all and confirm the in-root AGENTS.md canary really does appear in the recording. If it does not — if AGENTS.md turns out to be trust-gated too — pick a different positive control (any fixed substring of the system prompt that is present in both runs) and say IN A COMMENT which one and why. Do not proceed on an assumption about it. Note that the trust-requiring resource list in packages/coding-agent/src/core/trust-manager.ts is `settings.json, permissions.yml, extensions, skills, prompts, themes, SYSTEM.md, APPEND_SYSTEM.md` under the config dir, plus `.agents/skills` and `<config dir>/agents` from every ancestor — AGENTS.md is not on it, which is why it should work, but CONFIRM rather than assume.

RUN THE SAME FIXTURE TWICE AND COMPARE, because a one-run test cannot tell 'the flag worked' from 'the fixture never loaded': once WITHOUT `--no-approve`/`--context-root` (the tripwire file SHOULD appear, the SYSTEM.md canary SHOULD be present, the parent AGENTS.md canary SHOULD be present) and once WITH them (none of the three). The negative run is what makes the positive run mean something, and it is also how you find out on day one if the fixture is inert.

SIP BLOCKS DTRACE ON THIS MACHINE (`csrutil status` -> enabled), so there is NO exec oracle: 'the extension never ran' cannot be proven by any process scan. The tripwire FILE is the only race-immune negative available, which is why it is a file and not a process assertion.

COMMENT BUDGET — HARD CONSTRAINT. Repo baseline is 5.9% in tests. No prose in test names, no file-header essay beyond the two things the header must say (what this file is not, and which positive control you empirically confirmed). Your reasoning goes in your REPORT.

TRAPS (each has cost hours here): `rtk` wraps `grep`/`ls`/`git diff` and MANGLES their output — line numbers and content from them are NOT trustworthy; use `sed -n`, `python3` or Read for anything load-bearing, and `rtk proxy git ...` redirected to a file for git. `npx tsc --noEmit -p packages/gateway` prints 'TypeScript: No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the REPO ROOT, and packages/gateway has its OWN typecheck over `src/__tests__/` which the root tsconfig EXCLUDES: run `npm --prefix packages/gateway run typecheck` too. `npx biome` fails; use `./node_modules/.bin/biome`. THIS SHELL EXPORTS DRAHT_PERMISSION_MODE=auto — prefix every spawn with `env -u DRAHT_PERMISSION_MODE`, or the child inherits an auto-approving permission mode and your tripwire proves nothing. Build the child's env from scratch rather than spreading `process.env`. A unix socket path over ~104 bytes fails to bind with EINVAL; agent dirs go directly under /tmp with a SHORT name. zsh has no PIPESTATUS — use `cmd > /tmp/out 2>&1; echo $?`. A `cd` in a compound Bash call persists into the NEXT call; run SRC and DST checks in separate calls. NEVER run a whole-package suite — they flake under parallel load; run only your file: `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/spawn-argv-posture.e2e.test.ts`. NO GIT WRITES: no commit/add/stash/checkout/branch/reset/merge/rebase, and never move a branch ref. Leave your work uncommitted; the orchestrator commits.

MUTATION TEST, in an isolated rsync copy and NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-post
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does NOT isolate this monorepo: packages/<x>/node_modules/@draht/<y> are RELATIVE symlinks resolved against the target's REAL path, so a worktree edit is visible to the supposedly isolated run. Do NOT exclude and do NOT symlink packages/*/dist — this suite drives dist/cli.js and tsc follows a dist symlink back into the real tree. ~3 GB, a few minutes. SANITY-CHECK ISOLATION FIRST with a mutation you KNOW must fail: in $DST only, delete `"--no-approve"` from `buildSpawnArgv`'s returned array, REBUILD coding-agent in $DST, run your test in $DST and confirm the extension-tripwire and SYSTEM.md cases FAIL; run it in $SRC and confirm they still pass. Then do the same for `--context-root` and confirm the parent-AGENTS.md case fails. Only after that does a passing mutation result mean anything. Restore by copying pristine bytes, never by retyping. DISCLOSE SURVIVORS — every implementer in the previous phase who reported none was wrong.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/gateway/src/__tests__/spawn-argv-posture.e2e.test.ts

WHAT THIS DOES NOT CLOSE: this is EVIDENCE CLASS 2 and it does NOT close R36-SPAWN.5 or R36-SPAWN.6. It proves the flags work WHEN PASSED, through the emitted coding-agent binary. That the DAEMON passes them on a real `session_spawn` frame is wave 5's class-3 tripwire suite, and nothing in the shipped daemon spawns from a spawn frame yet. Say so in your commit body.

### W3-LAUNCHER — Two registry ids in, one running session out: the composition, the guard, and the exhaustive code mapping

- **Wave** 3 · **Requirement** R36-SPAWN.1 · **Evidence class** 2 · **Depends on** W3-LAUNCH
- **Files** `packages/gateway/src/session/session-launcher.ts`
- **Test** `packages/gateway/src/__tests__/session-launcher.test.ts`

Repo root: /Users/exe008/draht/draht-mono. You are building the object that turns two opaque ids from a phone into a running session, in exactly the shape the attach bridge's spawn port expects. You see nothing of the conversation that produced this plan; everything you need is here.

WHAT ALREADY EXISTS — read all four before writing anything:
  • packages/gateway/src/session/harness-resolver.ts — `resolveHarnessLaunch(harnessId, projectId, options)` returns `{harnessId, projectId, executable, leadingArgs, projectRoot, credentialEnv}` or throws `HarnessResolutionError` with `code: "unknown_harness" | "unknown_project" | "refused"`. `registryProjection(config, spawnable?)` returns `{harnesses: {id, isDefault}[], projects: {id, name, root}[]}` and NEVER a `cmd`. `userRegistryProvider(opts)` returns a thunk that re-reads and re-CHECKS the user's `~/.geist/config.yaml` on every call.
  • packages/gateway/src/session/spawn-primitive.ts — a sibling task in this wave added `SessionSpawner.launch(request)` taking `{sessionId, executable, leadingArgs, projectRoot, credentialEnv}` and returning `Promise<{pid: number}>`, throwing `SpawnRefusedError` with `code: SpawnRefusalCode = "refused" | "already_live" | "cwd_missing" | "spawn_failed" | "timeout"`.
  • packages/geist-core/src/attach/attach-bridge.ts — `SpawnSessionPort = (request: {harnessId, projectId}) => Promise<SessionSpawnOutcome>` where `SessionSpawnOutcome = {code: SessionSpawnCode; sessionId?: string; message?: string}`, and `RegistryPort = () => RegistrySnapshot` where `RegistrySnapshot = {harnesses: readonly RegistryHarness[]; projects: readonly RegistryProject[]}`.
  • packages/geist-protocol/src/wire.ts — `SessionSpawnCode = "spawned" | "unknown_harness" | "unknown_project" | "refused" | "spawn_failed" | "timeout"`.

BUILD ONE NEW FILE, packages/gateway/src/session/session-launcher.ts:

```ts
export interface SessionLauncherOptions {
	/** THE DAEMON'S ONE SPAWNER, injected. Never constructed here. */
	spawner: SessionSpawner;
	/** Asked on EVERY call. Not a value captured at construction. */
	registry: RegistryProvider;
	uid?: number;
	forbiddenRoots?: readonly string[];
	spawnableHarnessIds?: readonly string[];
	/** Test seam. Defaults to `randomUUID`. */
	mintSessionId?: () => string;
}
export class SessionLauncher {
	launch(harnessId: string, projectId: string): Promise<SessionSpawnOutcome>;
	snapshot(): RegistrySnapshot;
}
```

RULES, EACH OF WHICH HAS A REASON THAT MUST SURVIVE IN THE CODE AS AT MOST ONE LINE:

1. THE IN-FLIGHT GUARD IS DAEMON-WIDE AND KEYED ON THE `project:harness` PAIR ONLY. Not on the minted session id: a freshly minted uuid is unique by construction and bounds nothing. Use a separator that a `RegistryIdSchema` id (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) cannot contain, so `a`+`b.c` and `a.b`+`c` cannot collide. THE CLAIM IS TAKEN SYNCHRONOUSLY, before the FIRST `await` anywhere below it, so two frames arriving in one turn of the event loop cannot both pass it; it is released in a `finally`, so a throw from any depth cannot leave a pair permanently unlaunchable. The loser is told `refused` with something TRUE ('a spawn for this project and harness is already in flight; wait for it to finish before asking again') — never `spawned`. The lesson is recorded at packages/gateway/src/gateway/routes/fleet.ts:562 for `SessionResumer`: it used to be built inside the port closure so every frame got a fresh instance with its own empty set, i.e. exactly the per-connection guard that bounded nothing. MEASURED on the shipped daemon: two connections 200 ms apart produced TWO live processes on one session JSONL. EXACTLY ONE LAUNCHER PER DAEMON — say so in the class comment, because the object that holds the guard is the object there must be one of.

2. THE REGISTRY IS A PROVIDER ASKED PER CALL. Call `options.registry()` on every `launch()` and on every `snapshot()`. R36-SPAWN.3 says the file is checked 'on every load', and fleet.ts:170-185 records the identical lesson for the device store: reading it once while routes were built froze the answer and made first-ever pairing require a restart. Do NOT memoise, do NOT hold the parsed config in a field.

3. TWO EXHAUSTIVE SWITCHES, EACH WITH A `never` DEFAULT so adding a member to either union is a COMPILE ERROR here rather than a silent wrong code on the wire:
   `HarnessResolutionCode` -> `SessionSpawnCode`: `unknown_harness`, `unknown_project`, `refused` map to themselves.
   `SpawnRefusalCode` -> `SessionSpawnCode`: `refused`->`refused`, `spawn_failed`->`spawn_failed`, `timeout`->`timeout`, `cwd_missing`->`refused` (the project root was canonicalised and stat'd as a directory microseconds earlier; if it is gone now, that is a refusal, and the wire's spawn vocabulary has no `cwd_missing`), `already_live`->`refused` (a minted uuid cannot collide in practice, and the wire's spawn vocabulary has no `already_live` — but the type says it is reachable, so it is mapped rather than defaulted). One line of reason on each of the last two.

4. `sessionId` CROSSES ONLY WHEN A PROCESS WAS STARTED. On EVERY refusal the outcome carries NO `sessionId`, even though the bridge would drop it anyway. A renderer handed an id for a session that does not exist will try to attach to it, and the frame schema makes `sessionId` optional precisely because a refusal has none to name.

5. MINTING. `randomUUID()` by default. The minted id must pass `buildSpawnArgv`'s validator (`^[A-Za-z0-9][A-Za-z0-9-]*$`) AND coding-agent's `assertValidSessionId`; a uuid does. An INJECTED minter that returns something invalid must be REFUSED, not repaired: `buildSpawnArgv` throws, and that becomes `refused` — NOT `spawn_failed`, because nothing was spawned.

6. ORDER OF OPERATIONS, and it matters for the guard: claim the pair, then resolve, then mint, then launch, then release. Resolving before minting means a refused resolve burns no id. Claiming before resolving means a slow registry read cannot be raced.

7. THE MESSAGE. Pass the underlying error's message through. The bridge already runs it through `neutralized()` before it reaches the wire, so do NOT sanitise it a second time here — one owner per property.

8. `snapshot()` RETURNS `registryProjection(this.#registry(), this.#spawnableHarnessIds)`. Filter the offered harnesses by the same `spawnableHarnessIds` the resolver enforces: a phone must not be offered an id its own resolver would refuse. A registry file that cannot be read THROWS out of `snapshot()`; the bridge's `#registrySnapshot()` already catches and answers with two empty arrays, and duplicating that here would put two owners on one behaviour.

DO NOT EDIT packages/gateway/src/session/spawn-primitive.ts (another task in this wave owns it), packages/gateway/src/session/harness-resolver.ts (it landed complete last wave with 30 passing tests), or packages/gateway/src/gateway/routes/fleet.ts (wave 4's file — constructing the launcher and handing it to the bridge is wave 4's entire job, and taking it leaves that wave with nothing).

TEST FILE: packages/gateway/src/__tests__/session-launcher.test.ts (new). Inject a SPAWNER DOUBLE — a `SessionSpawner`-shaped object whose `launch` records its request and returns a pid, or throws a `SpawnRefusedError` you choose. No real processes; this file must be fast. Real files only where the resolver needs them (a `mkdtemp` under /private/tmp — macOS `/tmp` and `/var` are root-owned symlinks that `canonicalize` exempts by design, so use `/private/tmp` and you are testing your rule rather than that exemption).
  • an unknown harness id -> `unknown_harness`, NO `sessionId`, and the spawner double was NEVER called
  • an unknown project id -> `unknown_project`, nothing spawned
  • a resolver refusal (an executable outside every `approvedRoots` entry) -> `refused`, nothing spawned
  • a successful launch -> `code: "spawned"` with `sessionId` equal to the MINTED id, and the spawner received THAT id
  • the spawner received the resolver's `executable`, `leadingArgs`, `projectRoot` and `credentialEnv` unchanged — `credentialEnv` especially, because it is the only thing standing between a phone-spawned harness and every provider key the daemon holds
  • a table test over EVERY `SpawnRefusalCode`, asserting the documented `SessionSpawnCode` for each. This is where the exhaustive switch earns its keep and it is the assertion that fails the day somebody adds a code
  • a second `launch()` for the SAME pair while the first is still in flight -> `refused`, and the spawner was called ONCE. A DIFFERENT pair concurrently is NOT refused. Both halves, or the guard could be 'refuse everything'
  • the guard is RELEASED after a failure: launch, let it throw, launch the same pair again, and the second one is ATTEMPTED
  • the registry thunk is called on EVERY launch and EVERY snapshot — COUNT the calls. A launcher that cached would pass every other assertion in this file. Change the registry between two launches and assert the second sees the change
  • an injected minter returning `"../etc"` or `"-rf"` -> `refused`, nothing spawned
  • `snapshot()` marks exactly the `harness.default` id, falls back to the id when a project has no `name`, never emits a `cmd`, and omits a harness excluded by `spawnableHarnessIds`

COMMENT BUDGET — HARD CONSTRAINT. Repo baseline is 13.7% in src and 5.9% in tests. Default to NO comment; make the code say it. One line only where a non-obvious runtime constraint would otherwise invite deleting a load-bearing line — the synchronous claim, the `never` defaults, and the one-per-daemon rule are the three that earn one. No file-header essays, no prose in test names. Your reasoning goes in your REPORT.

TRAPS (each has cost hours here): `rtk` wraps `grep`/`ls`/`git diff` and MANGLES their output — line numbers and content from them are NOT trustworthy; use `sed -n`, `python3` or Read for anything load-bearing, and `rtk proxy git ...` redirected to a file for git. `npx tsc --noEmit -p packages/gateway` prints 'TypeScript: No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the REPO ROOT, and packages/gateway has its OWN typecheck over `src/__tests__/` which the root tsconfig EXCLUDES: run `npm --prefix packages/gateway run typecheck` too. That second typecheck is where a non-exhaustive switch will actually surface. `npx biome` fails; use `./node_modules/.bin/biome`. This shell exports DRAHT_PERMISSION_MODE=auto — prefix every spawn with `env -u DRAHT_PERMISSION_MODE`. A unix socket path over ~104 bytes fails to bind with EINVAL; temp dirs go directly under /private/tmp with a SHORT name. zsh has no PIPESTATUS — use `cmd > /tmp/out 2>&1; echo $?`. A `cd` in a compound Bash call persists into the NEXT call; run SRC and DST checks in separate calls. NEVER run a whole-package suite — they flake under parallel load; run only your file: `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/session-launcher.test.ts`. NO GIT WRITES: no commit/add/stash/checkout/branch/reset/merge/rebase, and never move a branch ref. Leave your work uncommitted; the orchestrator commits.

MUTATION TEST, in an isolated rsync copy and NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-lchr
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does NOT isolate this monorepo: packages/<x>/node_modules/@draht/<y> are RELATIVE symlinks resolved against the target's REAL path, so a worktree edit is visible to the supposedly isolated run. Do NOT exclude and do NOT symlink packages/*/dist. ~3 GB, a few minutes. SANITY-CHECK ISOLATION FIRST with a mutation you KNOW must fail: in $DST only, move the in-flight claim to AFTER the first `await` (i.e. after the resolve); run your test in $DST and confirm the concurrency case FAILS; run it in $SRC and confirm it still passes. If the concurrency test does NOT fail on that mutation, your test is not actually concurrent — fix the test, not the mutation. Then mutate, one at a time: hoist the registry call into the constructor; return the minted `sessionId` alongside a refusal; map `cwd_missing` to `spawn_failed`; drop the `finally` that releases the guard. Each must be caught. Restore by copying pristine bytes, never by retyping. DISCLOSE SURVIVORS — every implementer in the previous phase who reported none was wrong, 47 in one wave alone.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/gateway/src/session/session-launcher.ts packages/gateway/src/__tests__/session-launcher.test.ts

WHAT THIS DOES NOT CLOSE: this is EVIDENCE CLASS 2 and it closes NOTHING. When you are done, `SessionLauncher` still has ZERO production callers: `createFleetRoutes` does not accept a `spawnSession` option, `AttachBridgeOptions.spawnSession` and `.registry` are still unfilled, and the shipped daemon still answers `session_spawn` with `{ok:false, code:"refused"}` and `registry_resync` with two empty arrays. Wave 4 constructs exactly one of these in fleet.ts and hands it to the bridge; wave 5 drives it over a real wire. Say so in your commit body.

### W3-FLEET-JOIN — A launched process is a real fleet member: the emitted daemon, a real socket, the frozen row, and the gap that is still there

- **Wave** 3 · **Requirement** R36-SPAWN.8 · **Evidence class** 2 · **Depends on** W3-LAUNCH
- **Files** `packages/gateway/src/__tests__/spawn-fleet-join.e2e.test.ts`
- **Test** `packages/gateway/src/__tests__/spawn-fleet-join.e2e.test.ts`

Repo root: /Users/exe008/draht/draht-mono. You are proving that a process started by `SessionSpawner.launch()` joins the fleet as an ordinary session — same id space, same attach path, same row shape — and you are recording, as a failing-when-fixed assertion, exactly which link is still missing. This is a TEST-ONLY task: you add one file and edit no source. You see nothing of the conversation that produced this plan; everything you need is here.

WHAT THE REQUIREMENT SAYS. R36-SPAWN.8: a session started from the phone must be INDISTINGUISHABLE from one the daemon discovered — it appears on the fleet, it attaches, it streams, it takes input, and its row carries no field a discovered session's row does not. The frozen row key set lives at packages/gateway/src/__tests__/helpers/attach-journey.ts as `FROZEN_ROW_KEYS` (`id, cwd, pid, startedAt, origin, attachable, resumable, status, statusAt`), asserted by `assertFrozenRowShape`. It is a LITERAL rather than a derivation from `AttachableSessionSchema`, on purpose: adding a key to the schema fails there until a human edits the list. The geist/0.5 wire batch deliberately added NO field to that schema.

WHAT YOU BUILD ON — read all three before writing anything:
  • packages/gateway/src/session/spawn-primitive.ts — a sibling task in this wave added `SessionSpawner.launch({sessionId, executable, leadingArgs, projectRoot, credentialEnv})`.
  • packages/gateway/src/session/harness-resolver.ts — `resolveHarnessLaunch(harnessId, projectId, {registry, uid, forbiddenRoots})` turns a `GeistConfig` and two ids into exactly that request's fields.
  • packages/gateway/src/__tests__/helpers/attach-journey.ts and helpers/process-table.ts — wave-1 helpers. `attachJourney({wsBase, token, sessionId, prompt, expectOutput, ...})` runs ONE renderer journey (handshake, fleet row, attach, input, output, detach) over a session whose ORIGIN is deliberately not an option. `psRows`, `rowFor`, `isZombie`, `groupMembers`, `liveGroupMembers`, `descendantsOf`, `waitForGroupGone`, `reapPgids`, `uniqueMarker`.
  • packages/gateway/src/__tests__/session-resume.e2e.test.ts — READ IT for the harness shape and DO NOT EDIT IT; it is READ-ONLY for the whole phase. It shows how to start the daemon (`Bun.spawn(["bun", <repo>/packages/gateway/src/cli.ts, "--port", <port>, "--auth", <token>], {env: {...}})`, waiting on `"draht-gateway listening"` in its stderr), how to pick a free loopback port, its `until` helper, its short-temp-dir rule, and how it reaps DETACHED children in `afterAll` (killing the daemon does NOT kill them).

TEST FILE: packages/gateway/src/__tests__/spawn-fleet-join.e2e.test.ts (new).

THE SHAPE. Start the emitted daemon as its own PROCESS with `DRAHT_CODING_AGENT_DIR=<agentDir>` so it watches `<agentDir>/sockets`. Then, IN THE TEST PROCESS, construct a `SessionSpawner` over the SAME `socketDir` and `agentDir`, resolve a fixture registry through `resolveHarnessLaunch`, mint a `randomUUID()`, and `launch()`. The child publishes `<uuid>.sock` into the directory the daemon is watching, and the daemon picks it up exactly as it picks up any other session.

THE FIXTURE REGISTRY: a `GeistConfig` object (you may build it in memory and hand `resolveHarnessLaunch` a thunk returning it — you do not need a real yaml file, that is packages/geist-protocol/test/config-load.test.ts's job) whose one harness points `cmd` at `<repo>/packages/coding-agent/dist/cli.js`. That is a `.js` target, so the resolver returns `process.execPath` as the executable and `[<abs script path>]` as `leadingArgs` — which is exactly how the daemon's own `resolveDrahtExecutable` already runs it today. Declare one project whose `root` is a short temp directory, and `approvedRoots` covering both.

THE CHILD'S ENVIRONMENT, and this is the thing that will confuse you if it is not said: the harness declares NO `credentialEnv`, so `credentialEnv` is `[]` and NO provider credential crosses. The stub provider does not come through `credentialEnv` — it comes through `DRAHT_RESUME_ENV_ALLOW`, the daemon OPERATOR's declaration about the daemon's OWN environment. Give the `SessionSpawner` an `env` object carrying `DRAHT_STUB_PROVIDER: "1"` and `DRAHT_RESUME_ENV_ALLOW: "DRAHT_STUB_PROVIDER"` (plus `HOME` and `TMPDIR` inside your temp dir), and the child can answer with no API key.

THE BUILD. packages/coding-agent/dist/cli.js is built ONCE by the orchestrator before this wave is dispatched. In `beforeAll`, check `existsSync(dist/cli.js)` and run `npm run build` in packages/coding-agent ONLY if it is absent — a sibling task in this wave also drives that binary and two concurrent builds contend on one output directory.

ASSERT:
  • `launch()` returns a pid, and `ps -A` shows that pid alive and NOT a zombie. `kill(pid, 0)` succeeds on a zombie — verified on this box — so it is NOT a liveness oracle: read `stat=` from `ps` and treat `Z` as dead. `-A` is mandatory on every scan or tty-less children are invisible.
  • the child is in its OWN process group (`detached: true` today), i.e. its pgid equals its pid, and `groupMembers(pid)` contains it
  • `GET /fleet` on the daemon carries the minted id with `origin: "socket"`, `attachable: true`, and the pid `launch()` returned
  • `assertFrozenRowShape` passes on the RAW row (before any schema stripped anything) — no extra key, no missing key. This is the R36-SPAWN.8 assertion and it is why the raw row matters: a schema-parsed row would silently drop an added field.
  • `attachJourney({wsBase, token, sessionId: <minted>, prompt, expectOutput})` completes: hello, the fleet row, attach, input, streamed output, detach. Use the SAME call shape a discovered session would use, with no spawn-specific option, because 'the identical script passes' is the claim.
  • `stop(pid)` on the spawner takes the WHOLE GROUP down (`waitForGroupGone`) and the id leaves the fleet
  • the daemon is still answering afterwards (`GET /health` -> 200). Assert this after EVERY refusal path you exercise: `spawn` reports a failure it could not detect synchronously as an ASYNCHRONOUS `error` event, and an `error` event with no listener is an uncaught exception that takes the whole daemon down. That is a defect this repo's suites have ACTUALLY CAUGHT, as `ConnectionRefused` on the next request.

  • THE NEGATIVE, AND IT IS THE MOST IMPORTANT ASSERTION IN THIS FILE: on the same `/attach` connection, `server_hello` does NOT advertise the `session-spawn` capability, and a `session_spawn` frame is answered `{ok: false, code: "refused"}` with no `sessionId`. That is TRUE at HEAD — `AttachBridgeOptions.spawnSession` has zero production callers and `createFleetRoutes` does not even accept the option — and it is the honest record of the gap between 'the mechanism exists' and 'the daemon does it'. PUT A COMMENT ON IT SAYING IT IS EXPECTED TO BE INVERTED BY THE WAVE THAT WIRES fleet.ts. It is a tripwire, deliberately, so that the wiring cannot land without somebody editing this file and noticing what changed.

WHAT THIS FILE IS NOT — SAY IT IN THE HEADER. The ATTACH half is the real public protocol against the emitted daemon. The SPAWN half is an in-process library call in the test, NOT a `session_spawn` frame, because nothing in the shipped daemon starts a process from a spawn frame yet. This file is EVIDENCE CLASS 2. The class-3 acceptance — the identical journey driven over a real `session_spawn` against an adversarial registry — is a later wave's, and reading this file as the acceptance would be reading it wrong.

CLEAN UP THE DETACHED CHILD. It is in its own process group and killing the daemon does not kill it. Reap by pgid in `afterAll` (`reapPgids`), and also `pkill -f` on a `uniqueMarker` you put in the argv or the project path, for whatever went wrong before you got there.

COMMENT BUDGET — HARD CONSTRAINT. Repo baseline is 5.9% in tests. No prose in test names. The header says the two things above and stops; the tripwire assertion gets one line. Your reasoning goes in your REPORT.

TRAPS (each has cost hours here): `rtk` wraps `grep`/`ls`/`git diff` and MANGLES their output — line numbers and content from them are NOT trustworthy; use `sed -n`, `python3` or Read for anything load-bearing, and `rtk proxy git ...` redirected to a file for git. `npx tsc --noEmit -p packages/gateway` prints 'TypeScript: No errors found' and exits 0 for a run that died with TS5081 — typecheck with `rtk proxy npx tsc --noEmit -p tsconfig.json` from the REPO ROOT, and packages/gateway has its OWN typecheck over `src/__tests__/` which the root tsconfig EXCLUDES: run `npm --prefix packages/gateway run typecheck` too. `npx biome` fails; use `./node_modules/.bin/biome`. THIS SHELL EXPORTS DRAHT_PERMISSION_MODE=auto — prefix every spawn with `env -u DRAHT_PERMISSION_MODE`, and build the daemon's and the child's env from scratch rather than spreading `process.env`. A unix socket path over ~104 bytes fails to bind with EINVAL; the agent dir goes DIRECTLY under /tmp with a SHORT name — this is the single most common way this kind of file fails, because the sockets live at `<agentDir>/sockets/<uuid>.sock` and a uuid is 36 bytes on its own. zsh has no PIPESTATUS — use `cmd > /tmp/out 2>&1; echo $?`. A `cd` in a compound Bash call persists into the NEXT call; run SRC and DST checks in separate calls. A cold `draht --attachable --mode rpc` takes 3-6 s to publish its socket: model discovery and extension loading happen before the bind, so budget your waits generously and never assert on a fixed sleep. NEVER run a whole-package suite — they flake under parallel load; run only your file: `cd packages/gateway && env -u DRAHT_PERMISSION_MODE bun test src/__tests__/spawn-fleet-join.e2e.test.ts`. `packages/geist-core/test/attach/{attach-bridge,socket-sessions}.test.ts` have 3 PRE-EXISTING failures that are not yours. NO GIT WRITES: no commit/add/stash/checkout/branch/reset/merge/rebase, and never move a branch ref. Leave your work uncommitted; the orchestrator commits.

MUTATION TEST, in an isolated rsync copy and NOT a git worktree:
  SRC=/Users/exe008/draht/draht-mono; DST=/tmp/m36-join
  rm -rf "$DST" && mkdir -p "$DST" && rsync -a --exclude '.git' "$SRC/" "$DST/"
A git worktree does NOT isolate this monorepo: packages/<x>/node_modules/@draht/<y> are RELATIVE symlinks resolved against the target's REAL path, so a worktree edit is visible to the supposedly isolated run. Do NOT exclude and do NOT symlink packages/*/dist — this suite drives dist/cli.js and tsc follows a dist symlink back into the real tree. ~3 GB, a few minutes. SANITY-CHECK ISOLATION FIRST with a mutation you KNOW must fail: in $DST only, remove `"--attachable"` from `buildSpawnArgv`'s returned array; run your test in $DST and confirm the fleet-row and attach-journey cases FAIL; run it in $SRC and confirm they still pass. Only after that does a passing mutation result mean anything. Then mutate, one at a time: add a key to `AttachableSessionSchema` and confirm `assertFrozenRowShape` catches it; make `launch()` return a pid other than the child's and confirm the pid assertion catches it; make the readiness poll accept any lock owner and confirm something notices. Restore by copying pristine bytes, never by retyping. THE PREVIOUS PHASE HAD NINE SUITES PASS WHILE THE THING THEY NAMED WAS BROKEN — including one that passed 6/6 with `fleet_resync` returning an EMPTY payload, because the assertion waited long enough for the delta stream to repair the view. Watch for that exact shape here: a fleet assertion that polls until the row appears will also pass if something else put it there. DISCLOSE SURVIVORS.

FINISH WITH: ./node_modules/.bin/biome check --write --error-on-warnings packages/gateway/src/__tests__/spawn-fleet-join.e2e.test.ts

WHAT THIS DOES NOT CLOSE: this is EVIDENCE CLASS 2 and it closes NOTHING. It is the strongest evidence available before fleet.ts is wired — a real child, a real socket, a real fleet row, a real attach journey over the public protocol — and the one link it cannot supply is the one the requirement is actually about: a `session_spawn` frame causing all of it. Its own tripwire assertion says so. Say so in your commit body too.

## Wave 3 open questions

- STILL OPEN, ESCALATED BEFORE WAVE 2 AND NOT PLANNED AROUND: does RESUME also get `--no-approve`, or only SPAWN? Giving it to both means sessions resumed from the phone stop loading `.draht/extensions`, `.draht/settings.json`, `.draht/SYSTEM.md` and `.agents/skills` even for repos you trust on the Mac — the first phone session that behaves differently from the terminal will read as a bug. Giving it only to spawn means two postures on one wire. W3-ARGV pins the one-line answer and does not make it: add `"--no-approve"` to the argv array in `SessionSpawner.resume()` (spawn-primitive.ts:823 at HEAD, cited by symbol in the code because three tasks have moved that line this phase).

- STILL OPEN: what is the LOCAL re-grant path for a phone-spawned session? R36-SPAWN.5 requires trust to be granted only through the local machine, and nothing today turns a running untrusted spawned session into a trusted one without restarting it. No wave-3 task builds one and no wave-3 task assumes one exists. If the answer is 'restart it locally', that is already the behaviour and only needs writing down; if it is anything else, it is a new surface and wants its own task.

- STILL OPEN: `DRAHT_CODING_AGENT_DIR` crosses into the child by design (spawn-primitive.ts:565) and that directory is the root for `auth.json`, which holds EVERY provider's credential. Per-harness `credentialEnv` — which W3-LAUNCH now applies — fixes the ENVIRONMENT half of R36-SPAWN.4's 'only that harness's declared auth' and does nothing about the FILE half. Is env-only scoping acceptable for v1? The one-line landing site is `child.DRAHT_CODING_AGENT_DIR = options.agentDir` in `buildChildEnvironment`; `agentDir` is already an explicit option, so a per-harness directory is a change at the caller, not a redesign.

- STILL OPEN: is a spawned session the daemon's child? `detached: this.#detached` (spawn-primitive.ts:836) is a documented open decision and `.planning/CONTINUE-HERE.md` still lists it unresolved for resume. Deciding it for resume decides it for spawn, because W3-LAUNCH routes both through one shared block — which is the point: a daemon restart mid-spawn currently leaves a process the new daemon did not start and cannot TERM->KILL by handle. `stop()` already records group-signallability from the spawn options, so flipping the flag cannot turn a teardown into a signal against the daemon's own process group.

- NEW, RAISED BY PLANNING WAVE 3: wave 2 shipped five of its six tasks. W2-SPAWN-ARGV never landed and nothing in STATE.md or the commit log says it was cut. Wave 3 picks it up (W3-ARGV + W3-POSTURE), but the process question stands: a task can vanish between planning and integration without anything going red, because a file that was never created breaks no test. If the orchestrator does not already diff planned task ids against landed commits, this is the second phase in a row where that would have caught something.

- NEW: does v1 `session_spawn` accept ANY declared harness id, or only harnesses that publish an attachable socket? Unchanged from wave 2 and still unanswered. `resolveHarnessLaunch` takes `spawnableHarnessIds` defaulting to 'every declared id', W3-LAUNCHER passes it straight through, and the answer is ONE LINE at wave 4's construction site in fleet.ts. Oskar's own `~/.geist/config.yaml` names four harnesses and three of them cannot work in v1 — `codex`, `claude` and `gemini` would resolve, spawn, publish nothing and be refused `timeout` after 30 s.

- NEW: `credentialEnv` absent means NO provider credentials at all, which is the safe direction the plan and `geist.yaml.example` both commit to — and it means that a registry written from the example file spawns sessions that start fine and cannot answer. That failure is loud rather than silent, but it will be the first thing that happens on a real phone spawn. Worth deciding whether the daemon should refuse a harness with no `credentialEnv` at resolve time instead, which would be a one-line rule in `resolveHarnessLaunch`.

- OUTSTANDING INTEGRATOR DEBT FROM WAVE 2, not a question but it needs a human to notice: `scripts/check-no-free-text-command.mjs` and `scripts/check-no-free-text-command.test.mjs` exist and root package.json references neither, so `scripts/root-test-script-parity.test.mjs` is RED at HEAD. Wave 2 pre-announced this and named the exact three edits. It is not a wave-3 implementer's failure and should not be reported as one.
