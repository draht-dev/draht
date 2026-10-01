# Decisions Pending Oskar

> Generated 2026-08-20 by three Fable 5 advisors at max effort (workflow `wf_009fd829-6b8`).
> Each carries a recommendation. Approving means: reply with the decision number and `approve`,
> or name the alternative you want instead. None of these blocks Phase 33.
>
> **Status 2026-08-21:** the Phase 34 seam question is **resolved from the spec** and no longer blocks —
> rev-8 §4 already answered it. Four decisions remain open for Oskar: Phase 42 batching, GSEC-04/05
> amendment sign-off, and the Phase 44 threat model.
>
> **Status 2026-08-22:** four MORE are open, from Phase 36 (spawn) — added below. They were escalated
> before wave 2 and lived only inside `phases/36-spawn/PLAN.md`, where nobody would find them. None
> blocks waves 1-3, which are all evidence class 2; **36.1 and 36.3 must be answered before wave 5's
> class-3 acceptance can mean anything**, because that suite asserts the posture they decide.

## Phase 34 — which seam relays a permission ask to the phone (RESOLVED 2026-08-21, see below)

> **RESOLVED — the attach wire.** Not by a fresh product call: `.planning/specs/2026-08-18-geist-remote-control-rev8.md`
> §4 already settles it. *"A session appears because it is **running**, not because it was started by
> geist. This is the whole point."* An ACP-seam relay covers only geist-**spawned** headless sessions,
> so it contradicts §4 outright, and §5.2 makes the relay the mobile app's reason to exist. That is the
> same answer the Fable 5 advisor gave and the same one recorded as `Recommended` below.
>
> **Reversible.** If geist-owned ACP sessions become the product's future, this flips — but the shipped
> spec says otherwise today. Oskar's sign-off is welcome, not required, and nothing was built on the
> rejected seam.
>
> The seam **within** the attach wire was then mapped and adjudicated (workflow `wf_08536a00-ffc`:
> six read-only lenses, two Fable 5 advisors at max effort, both `high` confidence, both running their
> own probes). Design of record — see `.planning/ROADMAP.md` under Phase 34 for the full note:
>
> - **The decorator goes at `agent-session.ts:2360`** (`_applyExtensionBindings` → `runner.setUIContext`),
>   verified by scan to be the **only** production `setUIContext` call site, reached by all four modes and
>   re-run on reload — so it survives `/new`, `/resume`, `/fork`, `/import`. **Not** at `main.ts:916`: a wrap
>   installed at the attach seam is overwritten when interactive or rpc later binds its own context.
> - **The pending registry does NOT live in the decorator.** `_buildRuntime` builds a new `ExtensionRunner`
>   on every reload and so recreates the decorator; entries would be orphaned. It lives on the relay object
>   in `makeSessionAttachable`'s bind closure, which is also the only place the socket attach/disconnect
>   handlers can reach for PERM.6 replay.
> - **`hasUI()` must become surface-aware in the same commit as the decorator.** It is an identity check
>   against `noOpUIContext` (`runner.ts:464-466`), so any decorator flips it true — which for an
>   `--attachable` session with zero clients turns today's loud fail-closed block into either an eternal
>   hang or the wrapped noOp's instant `false`, reported as **"User denied approval"**: a fabricated user
>   action in the transcript.
> - **Ordering rule, from a probe:** `settle → resolve → abort the losing surfaces → broadcast → append
>   JSONL`. Reversed, the abort resolves the losing TUI dialog to `false` (`interactive-mode.ts:2307`),
>   which re-enters the decorator as an apparent TUI **deny** and overwrites the phone's approve.
> - **`settle()` is synchronous** from pending-check through `resolve()`. One `await` inside lets both
>   answers pass validation — and the bug is silent, because the second `resolve()` is a no-op.
> - **The protocol change is ONE atomic commit**, not a sequence: the mirror gate fails on any unmirrored
>   union member, the goldens gate fails on any declared-but-unrecorded type, and the bridge answers an
>   undeclared frame by closing every phone's connection with 1008.

<details>
<summary>Original framing, 2026-08-21 — kept as the record of what was decided against</summary>

**Confidence:** the probe and the advisor disagree. Both agree R34-PERM.2 as written is wrong.

**Ask:** Should the permission relay hook the attach wire (sessions you start in your terminal) or the ACP path (sessions geist spawns)? Recommended: attach wire.

### What the probe established by running code, not reading it

`createExtensionUIContext` is exactly where R34-PERM.2 says (`interactive-mode.ts:2190`) — but it is a
*producer*, not a chokepoint, and **the phone never reaches draht through it.** geist spawns `draht-acp` as
a headless subprocess with no InteractiveMode and no TUI, running a second, independent permission system
(`draht-acp/src/draht-acp-agent.ts:164`). There are two disconnected permission architectures and the
requirement names the one the phone cannot see.

Three things the probe proved that change the plan:
1. **Under shipped defaults an external ACP client's `bash` call hard-fails with NO permission request
   raised at all.** The probe only saw the happy path because its shell had `DRAHT_PERMISSION_MODE=auto`
   set. With `default`, requests raised: 0, tool status: failed. This is a shipped defect today, not a
   Phase 34 feature gap.
2. **A real approved permission leaves zero trace in the session JSONL.** R34-PERM.2 demands the
   resolution be asserted "from the session's own JSONL, not in-process state". Nothing writes one —
   `SessionEntry` has no permission variant. That is a durability task, not part of the relay.
3. **An attached socket client sees only `[Tool: bash]`, and answering "Yes" is swallowed as a queued new
   prompt.** The relay does not partially exist on the attach wire; it does not exist at all.

### The disagreement

- **Probe's fallback:** re-spec onto the ACP seam — geist already fans out to N listeners there
  (`acp-harness-session.ts:469`), enforces first-answer-wins (`:325`), and a real round-trip passes today.
- **Fable 5 advisor (high confidence) REJECTS that**: the ACP path runs through
  `packages/geist/src/pairing/server.ts:296-313`, which is rev-7 leftover — that file is GSEC-04's named
  subject, and rev-8 §7 marks geist-acp an "upgrade, not a v1 gate". Re-speccing onto it would relay
  permissions only for geist-*spawned* headless sessions and leave the actual §1 sentence — the sessions
  you start in your own terminal — with no relay at all. Its recommendation: a `RelayUIContext` decorator
  over whatever base context the mode bound, installed where the session is made attachable, at the
  mode-agnostic injection point one level below `createExtensionUIContext`.

**The advisor names the thing only you can settle:** if geist-owned ACP sessions are the product's future,
the attach-wire relay optimises the rev-8 path at the cost of a second permission system living on.

### What I am doing meanwhile

Running the R34-PERM.8 turn-hold measurement, which is seam-agnostic and is the only finding that could
invalidate the product premise: if a provider turn tolerates *less* delay than a human walking away
needs, Phase 34 changes from hold-the-turn to park/auto-deny/notify/retry. Not building the relay until
the seam is settled.

</details>

---

## Phase 42 — batching vs. per-path callback

**Confidence:** high

**Ask:** Batch /rewind file restores in chunks with a per-batch progress callback and a test-tunable chunk size? Recommended: yes — one code path, kill-tests stay deterministic.

### Recommendation

Adopt shape (b), sharpened: keep deletes per-path in-process (they are rmSync, not spawns — checkpoint-manager.ts:481-483 — and cost nothing), and chunk only diff.writes through `git checkout-index -f -u -z --stdin` (default 100 paths per process, ~2 spawns instead of 200 for the failing fixture). Rename the callback to `onPathsRestored(paths: readonly string[])`, fired after each batch has fully landed (each delete is a batch of one; each write chunk is a batch), with the same abort-on-throw → rollback semantics. `writeChunkSize` is plain data through the identical loop, so failure-injection tests pass `writeChunkSize: 1` and keep exact per-mutation determinism while exercising the production code path — no test-only fork, no derived/stat-based progress.

### Rationale

Verified facts drive this. (1) The 25s is only the writes loop (checkpoint-manager.ts:493 spawns per path); deletes are in-process rmSync (:441-466, :481-483), so batching writes alone fixes the timeout — and also fixes the rollback path (:932), which today spends the same 25s while the tree is unprotected. (2) The callback has no production consumer: interactive-mode.ts:5017 passes no onPathRestored; it is purely the test seam (6 sites) plus the extension pass-through (types.ts:1490, loader.ts:380). So the contract can change shape as long as the seam stays deterministic. (3) The deciding constraint — Phase 43 killing the process MID-restore — is *strengthened* by a between-batches execution point in our process and *destroyed* by a single opaque batch: with one `--stdin` process there is no in-our-process moment during writes to coordinate a SIGKILL from, and per-path callbacks derived from stdin writes or stat polling would lie (a path fed to the pipe is not yet on disk), which is disqualifying in a phase blocked by adversarial review over data-safety honesty. (4) Chunk boundaries are not load-bearing for safety: recovery after a kill re-diffs the actual half-state tree against the safety tree (restore() refuses on the marker at :867-871, then recovery restores safetyRecoveryId), so a git process dying mid-chunk with an arbitrary prefix applied is handled identically — chunking only bounds reporting granularity. (5) The spec's locked decision #5 (.planning/specs/2026-07-12-rewind-checkpoint-design.md, "Decisions log") mandates the temp-index read-tree/checkout-index mechanism, so (d) would reopen the spec for no correctness gain.

Exactly how Phase 43 kills mid-restore under this design (R43-SFT.1, REQUIREMENTS.md:322): the test spawns a child node harness running manager.restore({writeChunkSize: 1, onPathsRestored}) where the callback, after the first write batch, writes a beacon file and then awaits a never-resolving promise — freezing the restore mid-mutation with the marker on disk and later batches unapplied. The parent polls for the beacon, SIGKILLs the child, then asserts: the tree is genuinely intermediate (first path has target content, rest untouched); .git/draht-restore-in-progress.json names safetyRef and targetRef and both `git rev-parse --verify` (both refs anchored); CheckpointManager.findInterruptedRestore reports it and a fresh restore() refuses; deleting the marker and restoring the safety recoveryId makes the tree byte-equal to the pre-rewind snapshot ("equal to the safety snapshot" post-recovery). The hang-then-kill removes all timing races. "Git failing mid-restore" is covered in-process the same as today: writeChunkSize:1 plus a callback that throws at the Nth batch (existing rolled-back tests migrate mechanically), or a chmod-unwritable parent dir to make the Nth chunk's git process itself fail.

### Rejected alternatives

- **(a) Single --stdin batch, per-path progress re-derived by stat/diff** — During the one opaque git process there is no in-our-process execution point, so Phase 43 cannot deterministically SIGKILL mid-writes (only before/after), and stat-derived callbacks are dishonest — a path written to the pipe is not yet on disk, checkout-index writes in place (a stat can see a truncated file), and a passive observer cannot abort between mutations, which the rolled-back tests (checkpoint-restore.test.ts:242-268) depend on.
- **(c) Per-path processes for tests only, batch in production, callback as post-hoc reconciliation** — Forks the tested path from the shipped path — the failure-injection suite would prove properties of code production never runs, exactly the evidence-class problem the 2026-07-13 audit and the Phase 42 adversarial reviewers blocked on; and a post-hoc callback can neither abort the restore nor observe the marker mid-restore (checkpoint-restore-safety.test.ts:328-341).
- **(d) Replace checkout-index (cat-file --batch / git archive|tar / git restore --source)** — cat-file hands us raw blobs, silently dropping smudge filters, autocrlf/eol conversion, and mode/symlink handling that checkout-index -u applies — a correctness regression in a data-safety feature; archive|tar adds a system-tar dependency and keeps the opaque-single-process problem; git restore is porcelain over the same opacity. All three also violate the spec's locked decision #5 (temp-index read-tree/checkout-index) without buying determinism.
- **(b-naive) Chunked batches with failure injection only at chunk boundaries, fixed chunk size** — A fixed production chunk size (e.g. 100) makes the existing path-precise tests (throw at touched===2) unexpressible and ties test determinism to a tuning constant; making writeChunkSize an option keeps chunk-boundary injection AND path-level injection (size 1) through one loop.

### Concrete change to adopt

```
In packages/coding-agent/src/core/checkpoints/checkpoint-manager.ts:

// 1. New helper next to git()/gitRaw() (~line 220) — spawn-based because execFileAsync takes no stdin:
async function gitWithInput(cwd: string, args: string[], input: string, extraEnv?: Record<string, string>): Promise<void>;
// spawn("git", args, {cwd, env}); write `input` to stdin, end, reject on non-zero exit with stderr in the message.

// 2. Chunk-size constant + option:
export const DEFAULT_RESTORE_WRITE_CHUNK_SIZE = 100;

// 3. CheckpointRestoreOptions (replaces onPathRestored, ~line 130-144):
export interface CheckpointRestoreOptions {
  targetEntryId: string;
  currentEntryId: string;
  /**
   * Invoked after each batch of mutations has fully landed on disk: once per
   * deleted path (a batch of one, deletes first, in diff order), then once per
   * checkout-index chunk with exactly that chunk's paths. No mutation is in
   * flight when it runs — the chunk's git process has exited. Progress seam for
   * the UI and the failure-injection seam for tests: throwing aborts the
   * restore between batches (batches already reported are fully applied,
   * unreported ones untouched) and triggers rollback to the safety snapshot.
   */
  onPathsRestored?: (paths: readonly string[]) => void | Promise<void>;
  /**
   * Max paths per `git checkout-index -z --stdin` process. Default
   * DEFAULT_RESTORE_WRITE_CHUNK_SIZE; clamped to >= 1. Tests pass 1 for
   * path-precise failure injection — same code path, smaller batches.
   */
  writeChunkSize?: number;
}

// 4. applyTreeDiff (replaces lines 474-503):
async function applyTreeDiff(
  top: string,
  sourceTree: string,
  diff: TreeDiff,
  onPathsRestored?: (paths: readonly string[]) => void | Promise<void>,
  writeChunkSize: number = DEFAULT_RESTORE_WRITE_CHUNK_SIZE,
): Promise<void> {
  for (const path of diff.deletes) {
    deleteWorktreePath(top, path);            // unchanged, in-process
    await onPathsRestored?.([path]);
  }
  if (diff.writes.length === 0) return;
  const chunkSize = Math.max(1, Math.floor(writeChunkSize));
  const indexDir = mkdtempSync(join(tmpdir(), "draht-checkpoint-restore-"));
  try {
    const indexEnv = { ...CHECKPOINT_IDENTITY, GIT_INDEX_FILE: join(indexDir, "index") };
    await git(top, ["read-tree", sourceTree], indexEnv);
    for (let i = 0; i < diff.writes.length; i += chunkSize) {
      const chunk = diff.writes.slice(i, i + chunkSize);
      // -z --stdin: NUL-separated, no quoting ambiguity; -f -u as before.
      await gitWithInput(top, ["checkout-index", "-f", "-u", "-z", "--stdin"], chunk.join("\0") + "\0", indexEnv);
      await onPathsRestored?.(chunk);
    }
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

// 5. restore() threads both through (line ~922):
await applyTreeDiff(top, targetTree, diff, options.onPathsRestored, options.writeChunkSize);
// rollback (line ~932) stays callback-less but gains the same batching:
await applyTreeDiff(top, safety.treeHash, inverse, undefined, options.writeChunkSize);

// 6. Ripples (compiler-forced by the rename): rewind.ts:112-113/234/258/286 forward
// onPathsRestored + writeChunkSize on CheckpointRewindOptions/PerformRewindOptions;
// extension surface types.ts:1490 inherits via CheckpointRestoreOptions (note in docs, Phase 43 R43-SFT.6).
// Test migration: existing 6 sites take (paths) instead of (path); the counting tests
// (checkpoint-restore.test.ts:254, safety:332) add writeChunkSize: 1; keep at least one
// green-path restore test at chunkSize >= 2 with a multi-path fixture (space/UTF-8 names)
// so the NUL feed encoding is covered.

// Phase 43 R43-SFT.1 kill-test recipe this enables: child node harness runs
// manager.restore({ writeChunkSize: 1, onPathsRestored: async (paths) => { if (isFirstWriteBatch(paths)) { writeFileSync(beacon, "1"); await new Promise(() => {}); } } });
// parent polls beacon → SIGKILL → asserts intermediate tree, marker present with both
// refs rev-parse-verifiable, findInterruptedRestore + refusal, then marker delete +
// restore(safetyRecoveryId) === pre-rewind snapshot.
```

### Risks carried

- The NUL --stdin feed is a new encoding surface (paths with spaces, UTF-8, quotes); mitigated by mandating one multi-path-chunk test with hostile filenames — without it, chunking is only ever tested at size 1.
- checkout-index --stdin may partially apply a chunk when its process dies; safe because rollback/recovery re-diff the actual tree state, but the Phase 43 test must assert recovery invariants, not intra-chunk state, or it will be flaky.
- Renaming onPathRestored → onPathsRestored is a breaking change to the extension-facing CheckpointRestoreOptions (types.ts:1490); acceptable while Phase 42 is `partial` and pre-release, but docs/extensions.md must be updated in Phase 43 (R43-SFT.6) or extensions will code against a dead field.
- An extension passing writeChunkSize: 1 on a huge restore reproduces today's slowness; clamp exists but no upper-bound warning — consider logging when a restore exceeds a soft path-count/duration threshold.
- The hang-then-kill harness leaves a SIGKILLed child and a marker in the fixture repo; the test must clean the marker (it is the designed refusal state) or subsequent tests in the same fixture will fail with the interrupted-restore message.

---

## GSEC-04 & GSEC-05 amendment sign-off

**Confidence:** high

**Ask:** Sign off both GSEC-04 and GSEC-05 amendments with the listed binding conditions (recommended), sign off as written, or reject either?

### Recommendation

SIGN OFF BOTH WITH CONDITIONS. Amendment 1 (GSEC-04): the replacement is architecturally right for rev 8's browser clients and the bind half is verifiably landed, but the "strengthens the posture" claim only holds if seven conditions enter Phase 33's closure gate — a deny-only identity header proven against the forged-OWNER-header case, revocation that stops outbound streaming not just inbound frames, rotation that invalidates predecessors and surfaces theft, fragment-only credentials, named phone-side storage plus CSP, an honestly recorded trust relocation, and flushing the stale 0.0.0.0 config. Amendment 2 (GSEC-05): the re-owning is correct — geist has no restore primitive and Milestone 5 owns the audited semantics — but the negative condition must be enforced as pinned frame-type and route allowlists with a written reopen rule, and GSEC-05 must be recorded OPEN with owner Phases 42-43, not "moved and done".

### Rationale

Amendment 1. The bind half is real: `packages/gateway/src/config/config.ts:50` sets `host: "127.0.0.1"` (its comment at :47-48 says remote reach is `tailscale serve`, "not by widening the bind"), `createPairingServer` routes through `assertBindHostAllowed` before wiring anything (`packages/geist/src/pairing/server.ts:138` and the call at the top of `createPairingServer`, citing R32-FLEET.9), and `scripts/check-bun-serve-hostname.mjs` exists as the repo-wide gate. Replacing LAN mTLS is justified by the product pivot: spec §6.2 (2026-08-18-geist-remote-control-rev8.md) — "Quest browser and iOS clients require `wss://` with a trusted cert" — and pinned client-cert mTLS is effectively undeployable in those browsers; no LAN listener at all dominates a pinned-mTLS LAN listener against the original finding's network attacker. BUT the amendment does not close the threat model by itself, it relocates trust, and three verified gaps make an as-written sign-off unsafe: (1) the daemon cannot distinguish `tailscale serve` traffic from any loopback client, so any local process/user/container with loopback reach can send `Tailscale-User-Login: <owner>`; Phase 33's acceptance (ROADMAP.md:199) tests forged-NON-owner-refused and absent-header-still-authed but omits forged-OWNER-header-with-missing/invalid-credential-refused — the one case a local attacker actually produces, and the case that proves R33-REACH.8's "never the only check" (REQUIREMENTS.md:223); (2) R33-REACH.6 (REQUIREMENTS.md:221) demands refusal "at its next frame" — inbound-only, so a revoked device holding an open WS and sending nothing keeps RECEIVING transcripts/diffs/permission requests indefinitely; testable only if revoke also tears down live connections; (3) the credential substrate today is the finding's own vice — `packages/geist-core/src/pairing/pairing-state.ts:53-54` declares the token "Stable for the object's lifetime", `auth.ts:79` still accepts `?token=`, and no `Tailscale-User-*` handling exists anywhere (grep empty), so every credential-half property is future work and must be phrased as closure evidence, with rotation-invalidates-predecessor unspecified in R33-REACH.5 (REQUIREMENTS.md:220). Also `~/.draht/gateway.config.json` still holds `host: "0.0.0.0"` with token `"test"` (latent — spec §9 noted it; the new bind refusal covers next start). Amendment 2. The subject genuinely vanished: `packages/geist-protocol/src/wire.ts` defines exactly hello/attach/input/detach + server_hello/fleet/session_metadata/output/input_echo/client_joined/client_left/error/protocol_error — no restore-shaped frame; the served bundle (`packages/geist-console/bundle/console.js`) greps clean for approve/undo/restore/awaiting; `routes/sessions.ts:43,117` refuses caller-supplied commands. Milestone 5 owns exactly the semantics GSEC-05's closure demanded: temporary-index write-tree/commit-tree (REQUIREMENTS.md:303, R41-CKP.1), untracked-not-ignored capture (:304), GC-proof refs (:305), mandatory pre-restore safety snapshot (:314, R42-RWD.3), failure injection (:322, R43-SFT.1) — duplicating that inside geist would be strictly worse, as SECURITY-2026-07-13.md:52 argues. But a bare "no affordance in the bundle" test drifts: string/DOM greps evade renames. The drift-proof form already has substrate — `wire.ts` exports `CLIENT_FRAME_TYPES`/`SERVER_FRAME_TYPES`, R32-FLEET.4's gate refuses frames no schema validates, R32-FLEET.5's corpus gate forces version bumps — so pin the lists and the route table by deep-equality in a GSEC-05-named tripwire test, converting the negative into a positive. Two hazards need naming in the record: `messages.ts:83-86` still exports rev-7's `awaiting_review` with a comment promising "the approve/undo affordance" (the sprouting point), and R32-FLEET.3's relay-input-unchanged means a phone can type `/rewind` into an interactive session once Milestone 5 ships — acceptable only because that is the audited coding-agent path with its own selector and safety snapshot, and only once Phase 42's process-global `isRewindInProgress()` residual (ROADMAP Phase 42, colliding with attachable sessions from e35f12b0d) is fixed before Phase 35's default-on.

### Rejected alternatives

- **Sign off Amendment 1 as written** — The on-record claim 'strengthens the posture' overclaims three verified gaps: Phase 33's acceptance (ROADMAP.md:199) never tests a forged identity header naming the OWNER with a bad credential — the exact local-attacker case, since the daemon cannot distinguish proxy from loopback traffic; R33-REACH.6's next-frame revocation is inbound-only, leaving outbound streaming to a revoked silent device unbounded; and R33-REACH.5 never states that rotation invalidates the predecessor credential. Signing as written lets these become closure-evidence gaps.
- **Reject Amendment 1 and demand the original LAN mTLS 1.3 with pinned identities** — Rev 8's clients are iOS Safari and the Quest browser (spec §6.2), where pinned client-cert mTLS is effectively undeployable; a bespoke LAN mTLS stack would be a larger, permanently-owned attack surface than no LAN listener at all. Loopback-only bind (verified landed at config.ts:50 and pairing/server.ts:138) plus tailnet-scoped reachability strictly dominates a LAN-exposed mTLS listener for the finding's stated network-attacker model. The one real regression — pre-auth parser reachability by tailnet peers versus handshake-level refusal — is better handled as a recorded residual with bounded-transport mitigation (R32-FLEET.6) than by an undeployable remediation.
- **Sign off Amendment 2 as written** — 'No approve/undo affordance exists in the served bundle' invites a string/DOM grep that silently drifts under renaming, and 'moved to Milestone 5' without an explicit OPEN status plus named closure evidence risks exactly the label-closure the 2026-07-13 audit exists to prevent — Phase 42 is `partial` with blocking data-safety residuals and Phase 43 is `pending`, so the destination milestone does not yet hold the evidence.
- **Reject Amendment 2 and keep GSEC-05 in Milestone 4** — Rev 8 geist has no restore primitive to harden — wire.ts contains no approve/undo/restore frame and the bundle greps clean — so keeping the finding in Milestone 4 would force building a second, unaudited restore stack inside geist purely to satisfy the finding's original wording, which is the worse outcome SECURITY-2026-07-13.md:52 correctly names.

### Concrete change to adopt

```
## Amendment record — 2026-08-20 sign-off adjudication

### AMENDMENT A — GSEC-04 remediation replacement: SIGNED OFF WITH CONDITIONS

The "wildcard bind requires LAN mTLS 1.3 with pinned bridge identity and headset device key" remediation is replaced by: permanent loopback bind (landed: `DEFAULT_CONFIG.host: "127.0.0.1"` at `packages/gateway/src/config/config.ts:50`; `assertBindHostAllowed` guards `createPairingServer` at `packages/geist/src/pairing/server.ts:138` per R32-FLEET.9; repo-wide `scripts/check-bun-serve-hostname.mjs` gate) + `tailscale serve` terminating TLS + tailnet identity header as deny-only defense in depth + one-time bootstrap exchanged for a rotated per-device credential with revocation. Accepted because rev 8's clients are browsers (spec §6.2: iOS Safari and the Quest browser require `wss://` with a WebPKI cert; pinned client-cert mTLS is undeployable there), and eliminating the LAN listener strictly dominates hardening one. GSEC-04 remains **OPEN**: Phase 32 closed only the bind half; the credential half closes only with R33-REACH.3/.5/.6/.7/.8 evidence. Today `PairingState`'s token is "Stable for the object's lifetime" (`packages/geist-core/src/pairing/pairing-state.ts:53-54`) — the reusable-bearer vice this finding names — and `?token=` query auth still exists (`packages/gateway/src/gateway/middleware/auth.ts:79`).

Binding conditions, each added to Phase 33's closure gate:

1. **Deny-only identity header, proven against the forged-owner case.** The daemon cannot distinguish `tailscale serve` traffic from any other loopback client, so any local process can send `Tailscale-User-Login: <owner>`. Beyond the existing forged-non-owner and absent-header regressions, a regression must present a forged identity header naming the owner with (a) no device credential and (b) an invalid device credential, and be refused both times. Structurally, the header check may only short-circuit to refusal; no code path may let it satisfy or skip credential auth.
2. **Revocation stops outbound bytes, not only inbound frames.** `geist devices revoke` terminates every live connection bound to that device id within a stated bound (≤1s), regression-tested by revoking mid-stream and asserting zero further server frames arrive without the client sending anything. R33-REACH.6's "refused at its next frame" is necessary but not sufficient.
3. **Rotation invalidates the predecessor and surfaces theft.** Each rotation atomically invalidates the prior credential; a predecessor presented after rotation is refused and logged/surfaced as a security event, so a two-holder race is visible. The credential is recorded as bearer-class for v1, with rotation + next-frame revocation as compensating controls; a proof-of-possession upgrade (non-extractable WebCrypto key, connect-time challenge) is filed as a follow-up, not silently forgotten.
4. **No credential in any transmitted URL.** Bootstrap token and device credential ride only the URL fragment (stripped on first tick, as the console already does — `packages/geist-console/bundle/console.js:13,77-89`) or a first message/header. The transport-recording and log scan of R33-REACH.3 remains in the gate; this resolves the apparent tension between R33-REACH.4 (deep link carries token) and R33-REACH.3 (no credential in any URL) in writing.
5. **Phone-side storage and XSS blast radius stated.** R33-REACH.9's persistent credential names its storage mechanism and eviction behavior, and the served document ships a strict Content-Security-Policy — origin-scoped storage makes any bundle XSS a credential theft.
6. **Trust relocation recorded, not implied.** Tailnet ACLs and the Tailscale coordination server govern who can *reach* the endpoint, never who is *authorized*: a compromised coordination server or tailnet node gains pre-auth parser access plus a forgeable header, nothing more. Pre-auth HTTP/WS parser exposure to all ACL-permitted tailnet peers is the accepted residual versus handshake-refusing mTLS, mitigated by bounded transport (R32-FLEET.6) and auth-before-Unix-socket-open (R32-FLEET.3). `TAILSCALE_SETUP.md` documents narrowing the serve ACL to the owner's devices and states that tailnet reachability is not an authentication boundary. Funnel remains forbidden (R33-REACH.1).
7. **Stale wide-bind config flushed.** `~/.draht/gateway.config.json` on the dev machine still holds `host: "0.0.0.0"` and a trivial token; correct it now, and `geist doctor` (R38-ONE) must report any non-loopback config as a refusal.

### AMENDMENT B — GSEC-05 re-owned to Milestone 5: SIGNED OFF WITH CONDITIONS

Accepted: rev 8 geist has no filesystem-restore primitive — the served wire is exactly {hello, attach, input, detach} / {server_hello, fleet, session_metadata, output, input_echo, client_joined, client_left, error, protocol_error} (`packages/geist-protocol/src/wire.ts`), the served bundle contains no approve/undo/restore affordance, and `POST /sessions` spawns nothing (`packages/gateway/src/gateway/routes/sessions.ts:43`). Milestone 5 owns the demanded semantics: temporary-index `write-tree`/`commit-tree` (R41-CKP.1), untracked-not-ignored capture (R41-CKP.2), GC-proof refs (R41-CKP.3), mandatory pre-restore safety snapshot (R42-RWD.3), diff-driven restore (R42-RWD.4), atomic ordering (R42-RWD.5), failure injection (R43-SFT.1). A second restore stack inside geist would be strictly worse.

GSEC-05 status: **OPEN, owner Phases 42–43** — not closed by relocation. Phase 42 is `partial` with blocking data-safety residuals; Phase 43 is `pending`. Closure evidence: R42-RWD.3/.4/.5 plus R43-SFT.1/.2/.3 green.

Binding conditions:

1. **The negative becomes a pinned positive.** A string or DOM grep for "approve/undo" drifts under rename and proves nothing. Instead: a tripwire test named for GSEC-05 pins `CLIENT_FRAME_TYPES` and `SERVER_FRAME_TYPES` (`packages/geist-protocol/src/wire.ts`) by deep-equality to literal allowlists, and pins the daemon's public HTTP route table the same way. Any added or renamed frame type or route fails the test; the test header states condition 2's reopen rule. Combined with the refuse-unknown-frames gate (R32-FLEET.4, `scripts/check-geist-protocol.mjs`) and the corpus version-bump gate (R32-FLEET.5), "no undo affordance" becomes "the public surface equals exactly this list."
2. **Reopen rule, verbatim:** GSEC-05 reopens at the first wire frame type or HTTP route whose handler mutates working-tree state, and Phase 38's `geist/1.0` freeze review must record an explicit GSEC-05 check in its migration-note process.
3. **Indicative labelling is tested and the sprouting point is named.** Rev-7's `FleetSessionStatusSchema` still exports `awaiting_review` with a comment promising "the approve/undo affordance" (`packages/geist-protocol/src/messages.ts:83-86`); it is off the served wire today. If any review-style status reaches a served surface, a golden-snapshot test must show it labelled indicative, its source must satisfy R35-ALWAYS.8 (probe failure yields `unknown`, never `clean`, never terminal), and it may enter the wire only through condition 1's pinned allowlist.
4. **The relayed-input path is adjudicated now.** Attach relays input unchanged (R32-FLEET.3), so once Milestone 5 ships, a remote client can type `/rewind` into an interactive session. That is accepted as the audited coding-agent path (interactive selector + R42-RWD.3 safety snapshot), not a geist restore primitive — provided R43-SFT.4 holds (non-interactive/RPC never restores without an explicit option) and the process-global `isRewindInProgress()` residual (ROADMAP Phase 42) is fixed session-scoped before Phase 35 turns attach on by default.
```

### Risks carried

- The tailnet identity-header contract is pinned from one observed tailscale version (Phase 33 class-4 run); a tailscale header-semantics change could silently weaken the deny gate — the fixture annotation mitigates but does not eliminate this.
- Until the proof-of-possession follow-up, the device credential is bearer-class: replayable from any tailnet node or local process in the window between theft and rotation/revocation, and phone-side web storage is extractable by anything that can script the origin.
- Pre-auth HTTP/WS parser exposure to all ACL-permitted tailnet peers is a genuine regression versus handshake-refusing mTLS; a parser bug in Hono/Bun.serve becomes reachable by every tailnet device, bounded only by R32-FLEET.6 caps.
- The pinned-allowlist tripwire can be defeated by a developer editing the pin and the code in one commit without reading the GSEC-05 note; the corpus migration-note process and Phase 38 freeze review are the human backstops, and they are process, not mechanism.
- GSEC-05's closure now depends on Milestone 5 finishing: Phase 42's blocking residuals (per-path checkout-index performance, fail-closed false refusals, module-global rewind state) could park the finding OPEN for months with only the affordance-absence pin guarding it.
- CI never exercises a live tailnet — the reverse-proxy fixture reproduces the topology, and the single real-tailnet run is manual evidence that can go stale as tailscale versions advance.

---

## Phase 44 — sandbox threat model (R44-SBX.2)

**Confidence:** high

**Ask:** Confine the live tree minus its exec-config surfaces (git config/hooks, caches, shared temp), not a copied worktree? Recommended: yes.

### Recommendation

Keep confining the live tree (writes must land — a copied worktree has no coherent reconcile and draht already has worktree isolation + /rewind), and instead carve the execution surfaces OUT of the write set: deny `.git/config`+`.git/hooks/` (keep index/objects/refs writable so commits work), agent-config dirs, the shared `$TMPDIR` (replace with a session-private temp), and the package caches (read-only for warm hits). Default the sandbox OFF but offer it when entering auto/yolo; keep network on with loopback named as an accepted residual.

### Rationale

Every one of the six escapes is real and traces to R44-SBX.2's policy inputs, not the code: policy.ts:308 writes the whole live cwd (so `.git/config` core.hooksPath/pager/alias is plantable) and :310 adds the shared OS temp — which on this host is the FIRST PATH entry (`$TMPDIR/cmux-cli-shims/<UUID>`) and holds unsandboxed daemon sockets that seatbelt-profile.ts:264 lets a confined process reach (the profile's own comment calls it "a full escape (verified)"). The cache-root defense in policy.ts's comment table is factually wrong: npm's request-cache index carries its own `integrity` inline (host-verified), and cargo 1.95.0 extracts NO `.cargo-checksum.json` (host: 515 crates, 0 checksum files, only `.cargo-ok {"v":1}`) so a tampered `build.rs` runs at the next unsandboxed `cargo build`. Copied-worktree is the trap the task warns about: reconciling edits back either re-imports the poison or drops legitimate build output (node_modules/target), and it kills incremental builds and editor sync — an unusable product traded for the escape. FSEvents is a red herring cost: `fs.watch` is dead only because the deny-default profile omits the notification service, which is a read-side channel over already-readable paths and safe to grant (mitigate, not reject Seatbelt). The sysctl KERN_PROCARGS2 leak (seatbelt-profile.ts:219 bare `(allow sysctl-read)`) defeats env.ts entirely and must be closed by scoping sysctl to named MIBs.

### Rejected alternatives

- **Confine bash to a copied/overlay worktree (the ROADMAP 'next step')** — No coherent reconcile: copying writes back re-imports a poisoned .git/config or planted build.rs (no security gain), while filtering what lands drops the legitimate output the agent MEANT to produce (node_modules, target/, generated code). Copying gigabyte dep trees per bash call kills incremental builds and breaks editor/file sync. draht already provides worktree isolation (Phase 23) and /rewind (Phase 41-43) for the propose-then-apply case; a second copy layer under every command is the 'real escape traded for an unusable product' failure the task names.
- **Keep cache roots in the default WRITE allowlist (status quo)** — Verified false-safety: npm _cacache request-cache integrity is attacker-writable inline, and cargo 1.95 re-hashes nothing in the extracted src tree (0 of 515 crates carry .cargo-checksum.json on this host). Both are direct persistence routes into the next unsandboxed install/build.
- **Keep shared OS temp writable** — On this host $TMPDIR is the first PATH entry and holds ~20 unsandboxed daemon sockets; writable shared temp is simultaneously a binary-plant route and a socket-injection route. A session-private temp closes both at zero usability cost (tools honor the overridden $TMPDIR).
- **Reject Seatbelt because fs.watch/FSEvents is dead** — FSEvents denial is a deny-default omission, not an inherent Seatbelt limit. The change-notification service is a read-side channel over already-readable paths (v1 is read-allow-all) and grants no write/exec/persistence — safe to add. Watch-mode is restored with one profile allow.
- **Default the sandbox ON for the solo freelancer** — It silently changes execution semantics (cold caches, .git/config escalations, watch-mode needing its service) that a solo dev with no security team cannot triage; 'draht broke my build' with no one to ask. Default-off-but-offered-on-auto/yolo matches Claude Code/Codex and keeps the sandbox an opt-in upgrade, never a regression.

### Concrete change to adopt

```
Primary — replace R44-SBX.2:

- R44-SBX.2: `SandboxPolicy` v1 — the write allowlist confines the **live** project tree (edits must land in the real working tree; a copied/overlay worktree is rejected — reconciling writes back either re-imports the poison or drops legitimate build output, and draht already has worktree isolation and `/rewind` for the propose-then-apply case) plus a **session-private** scratch/temp dir exported to the child as `TMPDIR`/`TMP`/`TEMP`; the shared OS temp dir is **not** writable (on the dev host it is the first `PATH` entry and holds unsandboxed daemon sockets — both a binary-plant and a socket-injection route). Carved out of the project-tree write set — writes there denied and routed to the Phase 45 escalation — are the surfaces a later *unsandboxed* tool reads as code or config: the VCS exec-config surface (`.git/config` and `.git/hooks/`, plus per-worktree/submodule `config`/`hooks` equivalents; `.git` index, objects, refs and logs stay writable so `git add`/`commit` work) and agent/tool config dirs (`.claude/`, `.draht/`, `.codex/`; existing hooks still read+exec, only writes are denied). Package cache roots are **not** in the default write allowlist — read-allow-all covers warm-cache hits (a read cannot poison), while cache *writes* (cold-cache `npm install`/`cargo fetch`/`pnpm add`) require explicit `extraWritePaths` opt-in with documented residual risk, or Phase 45 escalation; the previously-curated default cache roots (npm `_cacache`, cargo `registry`, pnpm store, …) are removed from the write set because the integrity value each toolchain verifies against lives in the same attacker-writable entry (npm request-cache index carries `integrity` inline) or is absent from the built artifact (cargo 1.95 extracts no `.cargo-checksum.json` — verified: 515 extracted crates, 0 checksum files). Read allow-all, single network on/off toggle (default **on** — `npm install`/`git fetch`; loopback reachability of the user's own local services is an accepted, documented residual, not a persistence route once temp, caches and git-config are closed), no privilege escalation possible inside the sandbox. Threat-model invariant: **no writable surface is one a later unsandboxed process reads as code or configuration** — blast radius is bounded to the project working tree and session-private scratch; the boundary explicitly does not cover a human later choosing to run a file the agent legitimately wrote into the tree (e.g. a `package.json` script).

Consequential amendments (paste-ready):

- R44-SBX.1: `SandboxExecutor` interface in `packages/coding-agent/src/core/sandbox/` with per-platform backends — macOS Seatbelt (`sandbox-exec -f` + a **deny-default** SBPL profile generated from policy, every `allow` named and justified), Linux Landlock (kernel ≥ 5.13) with `unshare`/bwrap namespace fallback; unsupported platforms report `unavailable`. A deny-default profile must still grant the read-side/notification capabilities real toolchains need without widening write or exec — including the file-change-notification service (FSEvents on macOS) so `fs.watch`/chokidar watch-mode is not dead — since those are notifications over already-readable paths, not new write or persistence capability.

- R44-SBX.3: Policy paths real-path resolved before profile generation — a symlink inside the project pointing outside must not widen the writable set, and the carved-out deny surfaces (`.git/config`, `.git/hooks/`, agent-config dirs) and the shared-temp/cache exclusions are matched on real paths too, so a symlinked `.git`, a relinked cache, or a `..` hop cannot dodge the deny.

- R44-SBX.4: Startup self-test (Phase 28 pattern): inside a throwaway sandbox, probe that a write outside the allowlist fails, that a write to the carved-out exec-config surface (a `.git/config` under the probe root) fails, and that the shared OS temp dir is not writable; probe network with a two-sided control against the self-test's **own in-process listener** (positive: connect succeeds with network on; negative: connect fails, `EPERM`/timeout, with network off) — the probe never depends on reaching a third-party service. Only a passing self-test lets the backend report `available`; a broken profile degrades to `unavailable`, never to unconfined execution.

- R44-SBX.5: Environment hygiene — the sandboxed child receives a constructed env (allowlist, not the full parent env). This is not sufficient on its own: the profile must also deny the kernel channels that hand back another process's environment or arguments — `kern.procargs2`/`kern.procargs` sysctls and same-uid task-port/process-info inspection — by scoping `sysctl-read` to the specific MIBs toolchains need (`hw.ncpu`, `hw.memsize`, `kern.osrelease`, `uname`-class) rather than a blanket `(allow sysctl-read)`, since KERN_PROCARGS2 otherwise returns the parent draht process's full argv+environment and defeats the allowlist. macOS Keychain and `SSH_AUTH_SOCK`/`GPG_AGENT_INFO` stay denied (live-key disclosure is not bounded by the filesystem allowlist); authenticated outward git/`gh` therefore escalates in Phase 45 rather than reading stored credentials silently.

- R45-SBM.1: Session sandbox state (`on`/`off`) alongside `PermissionMode` — `/sandbox` command, settings key + `DRAHT_SANDBOX` env seeding, status-bar indicator. Default is **off** (the sandbox changes execution semantics — cold caches, escalation on `.git/config` writes, `fs.watch` needing its service granted — and a solo freelancer cannot triage a silent semantic change), but when the user enters `auto` or `yolo` and a backend self-tests `available`, offer to turn it on once (and `/yolo` recommends it); `DRAHT_SANDBOX=1`/settings force default-on for users who want it.

- R46-SBH.4: Dogfood proof — a full `npm run check` + build of this monorepo completes inside the sandbox on the curated default allowlist alone, and the dogfood explicitly validates the usability/security split: watch-mode (`fs.watch`), `pbcopy`/`pbpaste`, and the sysctl MIBs toolchains read all work, while `kern.procargs2`, the shared `$TMPDIR`, the package caches, `.git/config`/`.git/hooks/`, and macOS Keychain stay denied — with cold-cache `npm install`/`cargo fetch` friction handled by `extraWritePaths` or escalation and documented, not by re-adding a cache root to the default write set.
```

### Risks carried

- The `.git` carve-out depends on SBPL last-match-wins semantics to express 'allow .git except config+hooks' and on Landlock/namespaces expressing the same nested deny on Linux — Landlock rules are allow-only and cannot subtract a subpath, so on Linux the carve-out likely needs a bind-mount of a read-only .git/config+hooks over the writable .git (or denying .git wholesale and escalating commits); Phase 46's Linux matrix must prove whichever mechanism is chosen.
- Cold-cache friction is real: with caches read-only, `npm install` of a NEW package and `cargo fetch` of a new crate fail until the user opts the cache root into extraWritePaths (re-opening the poison route they accept) or approves the Phase 45 escalation. Warm-cache rebuilds/reinstalls — the common agent loop — work read-only. The dogfood (R46-SBH.4) must confirm the exact failure mode per tool and that the escalation UX is not hit on every install.
- Denying `.git/config` means legitimate `git config` writes (e.g. `git config user.email` in a fresh clone) escalate; frequent enough to annoy if the agent scripts git setup. Mitigate by treating a curated safe-key subset or routing first-run git config through the unsandboxed path with a notice.
- Loopback-to-local-services stays reachable under network-on; a confined process can still read/write the user's running dev DB or hit a Docker API bound to a TCP port. Named as accepted residual, but a security-conscious project may need a network-off or loopback-deny profile that then breaks agents testing against a local server — a v2 tension left open.
- Session-private $TMPDIR breaks any workflow that hands a file to an unsandboxed process via a hardcoded `/tmp/known-path`; intended (that IS the socket/plant route) but may surface as a confusing 'file not found' across a sandbox boundary.

---

---

## Phase 36.1 — does RESUME also get `--no-approve`, or only SPAWN?

**Confidence:** medium — this is a product call, not a correctness one.

**Ask:** A phone-initiated SPAWN starts untrusted (`--no-approve` defeats any standing `trust.json` grant
and `defaultProjectTrust: "always"`). Should a phone-initiated RESUME do the same? Recommended: yes, with
the cost stated.

### Recommendation

Give resume the same flag. Both verbs are driven by `session_resume`/`session_spawn` over the attach wire,
so in both the phone is the actor. The distinction that tempts you the other way — "the user already
trusted this project locally" — is exactly the assumption the flag exists to refuse: a standing grant is
evidence about a past local decision, not about who is holding the phone now.

### Rationale

The flag is on the argv, not conditioned on origin, so this is one line either way (the resume argv in
`spawn-primitive.ts`). Today a phone-resumed session in a project with a standing grant loads
`.draht/extensions` — arbitrary code — plus `.draht/settings.json`, `.draht/SYSTEM.md` and ancestor
`.agents/skills`. That is the same exposure the spawn path was hardened against, reachable by a verb that
already ships.

### Rejected alternatives

- **Only spawn gets it.** Leaves the exposure above live on a shipped verb, and makes the security posture
  depend on which frame a client happened to send for the same project.
- **Condition the flag on whether the project was trusted before the daemon started.** Adds a stateful
  distinction that cannot be tested from the wire and that a reader of the argv cannot see.

### Risks carried

Resumed sessions stop loading project extensions and project settings. If any of your workflows resume a
session from the phone and expect its project extensions, this breaks them — visibly, not silently. That
is the whole cost, and it is why this is your call rather than mine.

---

## Phase 36.2 — what is the LOCAL re-grant path for a phone-spawned session?

**Confidence:** high on the recommendation, low on urgency.

**Ask:** R36-SPAWN.5 requires trust to be granted only through the local machine. Nothing today turns a
running untrusted spawned session into a trusted one without restarting it. Recommended: defer, record.

### Recommendation

Defer to Phase 37, where the wire opens, and record it as named debt now. Do not build a re-grant path in
Phase 36.

### Rationale

Every mechanism that would carry a grant is either not built yet or is the wrong place. A wire field would
be a trust grant delivered over the network, which R36-SPAWN.5 forbids outright. A local CLI verb needs a
way to name a running session, which is what Phase 37 adds. And the practical workaround exists today: the
operator trusts the project locally and the next spawn picks it up.

### Risks carried

Until then, a phone-spawned session in an untrusted project stays untrusted for its whole life. That is
the correct failure direction, but it will read as a bug the first time you hit it.

---

## Phase 36.3 — `DRAHT_CODING_AGENT_DIR` crosses into the child, and it is the root for `auth.json`

**Confidence:** high that this needs an answer; medium on which one.

**Ask:** The spawned child inherits `DRAHT_CODING_AGENT_DIR`, whose directory holds `auth.json` — every
provider credential you have. Per-harness `credentialEnv` (wave 3) narrows the ENVIRONMENT; it does
nothing about the FILE. Recommended: scope the child's agent dir, accepting that harnesses must then be
given credentials explicitly.

### Recommendation

Give a spawned session its own agent dir containing only what its harness declares, rather than the
operator's. The environment half is already narrowable per harness; the file half should follow the same
rule, or the narrowing is decorative — a child that cannot read `ANTHROPIC_API_KEY` from its environment
can still read it out of `auth.json`.

### Rationale

This is the one place where "the phone cannot hand out a shell" stops being true in a way the wire cannot
show you. Everything else in Phase 36 constrains what the child is *started* with; this is what the child
can *read* once running. A harness that needs a provider credential should declare it, exactly as it
declares its executable.

### Rejected alternatives

- **Leave it and rely on `credentialEnv`.** The environment narrowing is then defeated by one file read.
- **Strip `auth.json` from the inherited dir at spawn time.** Mutates the operator's own state to protect
  a child; a crash mid-spawn leaves the operator without credentials.

### Risks carried

Spawned sessions stop working until their harness declares credentials — a real setup cost, paid once per
harness. If you would rather ship spawn working-by-default and tighten later, say so and I will record
that as the decision rather than treat it as an oversight.

---

## Phase 36.4 — is a spawned session the daemon's CHILD?

**Confidence:** medium.

**Ask:** `detached` is a documented open decision on the spawn path and unresolved for resume.
Recommended: detached, i.e. NOT the daemon's child.

### Recommendation

Detached. Deciding it for resume decides it for spawn, since wave 3 shares the whole post-spawn block
between both origins.

### Rationale

Phase 39 runs a 7-day soak. If sessions are the daemon's children, a single daemon restart during that
week takes every running session with it — which contradicts the product sentence the phase is built on
("every draht session running on your machine is there"). Detached also gives `pgid == pid`, which is what
makes `stop()`'s group signalling reach the whole tree; without it the child sits in the daemon's own
process group and a group signal would hit the daemon.

### Rejected alternatives

- **Daemon's child.** Simpler lifecycle and guaranteed cleanup, at the cost of losing every session on any
  daemon restart. Acceptable only if you consider a restart rare enough to not matter across a 7-day soak.

### Risks carried

The daemon cannot guarantee TERM→KILL for a session it did not parent and did not record — an orphan
survives a daemon crash. The lock file's pid and `processStartedAtMs` are what let a restarted daemon
re-adopt them, so this is bounded, but it is not free.
