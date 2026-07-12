# Bash Sandbox Confinement — Design Spec (v1)

- **Date:** 2026-07-12
- **Status:** Proposed (planned as Milestone 6, Phases 44–46 — nothing implemented; all phases `pending`)
- **Planned via:** in-session design (Fable 5), directly following the permission-mode work it completes
- **Scope:** `packages/coding-agent` (core + interactive mode + `core/builtins/`). No new package.
- **Prior planning:** none for the bash tool. Direct prior art in-repo: Phase 28 sandboxed the RLM Python REPL at the OS process boundary (`packages/rlm/src/sandbox.ts`, `packages/rlm/sandbox/macos.sb`).

> One-line: run the **bash tool itself inside an OS-level sandbox** (macOS Seatbelt, Linux Landlock/namespaces) so that what a command *can do* is bounded by policy, not by string matching — making it safe for auto mode to stop prompting, and closing the interpreter escape hatch (`python -c`, script files, in-language `shutil.rmtree`) that no text gate can close.

---

## Context

**The permission gate is a heuristic, not a boundary — by its own documentation.** `src/core/multi-agent/permission-gate.ts` gates bash via textual pattern matching plus a session `PermissionMode` (`default`/`auto`/`yolo`, added 2026-07-12). Its module doc records two known limitations that are *not fixable with text matching*: no real path containment, and interpreter escape hatches — once a command hands control to a language runtime, no shell-shaped pattern (deny rules included) can see the payload. `python -c "os.system('rm -rf /')"` never surfaces `rm -rf /` as a match candidate; `python script.py` hides the danger in file contents the gate never reads; `shutil.rmtree('/')` involves no shell command at all. The inline-eval danger patterns added alongside auto mode flag the *common* smuggling shapes so auto mode prompts on them, but script files and in-language equivalents are out of reach by construction. The gate protects against a confused agent; it cannot confine an adversarial or deeply-misled one.

**The execution seam already exists.** `src/core/tools/bash.ts` defines `BashOperations` — a pluggable `exec(command, cwd, options)` interface explicitly designed for swapping execution backends ("Override these to delegate command execution to remote systems (for example SSH)"), with `createLocalBashOperations()` as the default local spawn. A sandboxed backend is a new implementation of an existing interface, not surgery on the tool.

**The hard part was already solved once, in this repo.** Phase 28 (RLM REPL Sandbox & Safety) established the pattern after a security-advisor consult moved the boundary from in-process guardrails (trivially bypassable via the Python object graph) to the OS process boundary:
- macOS: `sandbox-exec -f` with a deny-default SBPL profile (`packages/rlm/sandbox/macos.sb`)
- Linux: `unshare --user --map-root-user --net --mount` (bwrap fallback), fail-closed if neither is available
- A `self_test` wire round-trip immediately after spawn proving the sandbox actually holds before real work runs
- Environment hygiene: the child does not inherit the full parent env

Milestone 6 generalizes that pattern from "confine the RLM REPL" to "confine the agent's bash tool", with one crucial difference in failure posture (below).

**External parity:** Claude Code's sandboxed bash (Seatbelt/bubblewrap: filesystem writes confined to workspace + temp, network mediated, "rerun without sandbox?" escalation prompt on denial) is the UX reference point. Codex CLI ships the same shape (Seatbelt on macOS, Landlock on Linux).

## Design

### Policy model (v1 — deliberately simple)

One `SandboxPolicy` object, resolved per invocation:

- **Write allowlist (the core of the policy):** project cwd (real-path resolved), the session scratch dir, OS temp, and an explicit `extraWritePaths` list from settings/`permissions.yml`. Everything else on the filesystem is read-only. Symlinks resolve to real paths *before* policy generation so a link inside the project pointing outside does not widen the writable set.
- **Read policy:** allow-all in v1 (dev workflows read toolchains, caches, and dotfiles constantly; a read-deny list is a v2 concern and must not block v1).
- **Network:** a single on/off toggle in v1, default **on** (dev workflows are network-heavy: `npm install`, `git fetch`). Off is available per-project for sensitive work. No proxy mediation in v1.
- **Process:** no privilege escalation — `sudo` cannot work inside the sandbox by construction on both platforms.

What this buys concretely: `rm -rf /`, `shutil.rmtree(os.path.expanduser("~"))`, a build script with a malicious postinstall writing to `~/.ssh`, and `python -c` payloads all fail with a policy denial regardless of how they were spelled — the class of harm is bounded, not the spelling.

### Platform backends

`src/core/sandbox/` with a common `SandboxExecutor` interface and per-platform implementations:

- **macOS — Seatbelt:** generate an SBPL profile from the policy (template + parameterized allowlist paths, same technique as `packages/rlm/sandbox/macos.sb` but write-scoped rather than deny-default-everything), wrap the shell spawn in `sandbox-exec -f <generated-profile>`. `sandbox-exec` is deprecated-but-functional (macOS still ships it; Claude Code and Codex both rely on it) — the executor interface isolates us if Apple ever removes it.
- **Linux — Landlock first, namespaces fallback:** Landlock (kernel ≥ 5.13) for filesystem restriction without root or setuid helpers; `unshare`/`bwrap` mount+net namespaces as fallback where Landlock is unavailable (Phase 28's exact technique). Network-off uses a net namespace on both paths.
- **Windows / unsupported:** no backend; sandbox reports unavailable (see failure posture).

Each backend ships a **startup self-test** (Phase 28's pattern): attempt a write outside the allowlist and (if network-off) a loopback connect from inside a probe sandbox; only a passing self-test lets the executor report `available`.

### Failure posture — the one deliberate difference from Phase 28

RLM runs *untrusted generated code* whose only purpose is the sandbox, so Phase 28 is fail-closed (refuse to run at all). The bash tool is the agent's primary limb: hard-failing every command on a machine without a working backend bricks the product. Instead:

- Sandbox unavailable → **fall back to the permission gate exactly as it works today** (auto mode keeps its danger-filter prompts), with a one-time visible notice. The gate's text heuristics remain the floor; the sandbox is an upgrade, never a regression vector.
- Sandbox available → policy failures inside a command surface as a **denial escalation**: detect the platform's denial signature in stderr/exit status and offer one approval prompt — "command was blocked by the sandbox (wrote outside the project); rerun unsandboxed?" — reusing the existing `ctx.ui.confirm` approval path. Approved reruns execute through today's unsandboxed backend and are logged. In non-interactive/RPC mode there is no escalation: the denial is the result.

### Permission-gate integration

The sandbox composes with, and does not replace, the `PermissionMode` system:

- New session state `sandbox: on|off` alongside the mode — settable via `/sandbox`, seeded from settings + `DRAHT_SANDBOX` env, shown in the status bar next to `perms:`.
- With sandbox **on**, auto mode's semantics upgrade: unmatched bash commands are auto-allowed *because they are confined*, and the inline-interpreter-eval danger patterns stop prompting (the whole point — the sandbox handles what the strings cannot). Genuinely-outward patterns that the sandbox does not model (`git push`, `npm publish` — network writes with real-world effect) **keep prompting**; the sandbox bounds the filesystem and network reachability, not the semantics of an authorized remote.
- `deny` rules in `permissions.yml` still hard-block before execution in every combination — authored intent always wins.
- `yolo` + sandbox is the recommended "seamless but not naked" configuration and should be what `/yolo` suggests when a backend is available.

### Explicitly out of scope for v1

Read-deny lists (secrets shielding beyond env hygiene), per-command dynamic policies, network proxy/domain allowlists, Docker/VM isolation, sandboxing of tools other than bash (read/write/edit already go through path-scoped gate rules), and Windows support.

## Phases

- **Phase 44 — Sandbox Executor Core:** `src/core/sandbox/` with the policy model, Seatbelt + Landlock/namespace backends, real-path policy generation, self-test, env hygiene, and a `BashOperations` wrapper. Proven by escape-attempt tests (write outside allowlist via direct path / symlink / `python -c` / script file; network when off) on macOS + Linux CI.
- **Phase 45 — Permission Integration & Escalation UX:** `/sandbox` command, settings + env seeding, status indicator, auto-mode semantics upgrade, denial detection → rerun-unsandboxed approval flow, non-interactive behavior, `permissions.yml` `extraWritePaths`.
- **Phase 46 — Hardening, Performance & Docs:** adversarial escape suite (symlink pivots, `/tmp` tricks, interpreter matrix, git-hook-triggered writes, env secret leakage probe), spawn-overhead budget enforced by test, Linux CI coverage for both Landlock and namespace paths, docs (extensions.md, quickstart security section, permission-gate module doc updated to point at the sandbox as the hard boundary).

## Risks & open questions

- **Seatbelt deprecation:** `sandbox-exec` has been deprecated for years yet remains the industry-standard approach (Claude Code, Codex, Chrome). Mitigation: backend interface + self-test means a broken backend degrades to today's behavior, never to silent unconfinement.
- **Denial-signature detection is heuristic:** macOS logs `deny` lines but a child may swallow stderr. Acceptable: mis-detection means a worse error message, never a security failure (the block already happened).
- **Build-tool friction:** compilers and package managers write caches outside the project (`~/.npm`, `~/.cache`, `~/Library/Caches`). v1 ships a curated default `extraWritePaths` covering the common cache roots; the escalation prompt is the release valve for the long tail. This is the main UX risk and the reason Phase 46's budget includes dogfooding time on this repo itself.
- **Performance:** Seatbelt/Landlock wrap adds process-spawn overhead only (no syscall-level slowdown measurable for typical dev commands). Budget: < 50 ms added p95 per invocation, enforced by test in Phase 46.
