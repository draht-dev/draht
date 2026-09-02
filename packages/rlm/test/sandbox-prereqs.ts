// Shared module-scope probes for the test files that spawn a real `python3`
// subprocess (directly, or wrapped in the OS-level sandbox via
// `../src/sandbox.ts`). Mirrors the probes 42c509398 added to
// packages/coding-agent/test/rlm-cli.test.ts. Probed once at import time --
// the answers can't change during the test process's lifetime.

import { spawnSync } from "node:child_process";

/**
 * Whether a working `python3` exists on PATH at all. Gates every test that
 * spawns the REPL driver, wrapped or not -- without this, a bare
 * `spawn("python3", ...)` child never answers the wire protocol and the test
 * hangs to its timeout (observed on hosts with no python3, e.g. NixOS without
 * python in the profile).
 */
export const HAS_PYTHON3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * On Linux the driver is wrapped in `unshare --user --map-root-user --net
 * --mount` (see packages/rlm/src/sandbox.ts, `buildLinuxCommand` -- keep this
 * probe's flag set in sync with it) and is fail-closed. GitHub's Ubuntu 24.04
 * runners restrict unprivileged user namespaces, so `unshare` dies with
 * "write failed /proc/self/uid_map: Operation not permitted" and the
 * sandboxed child is dead on arrival (sessions fail with `write EPIPE`).
 * Probe the exact same namespace set the sandbox uses and skip when it's
 * unavailable. Non-Linux hosts never take the `unshare` path, so the probe
 * only gates Linux.
 */
export const HAS_USERNS =
	process.platform !== "linux" ||
	spawnSync("unshare", ["--user", "--map-root-user", "--net", "--mount", "--", "true"], {
		stdio: "ignore",
	}).status === 0;
