/**
 * SBPL (Seatbelt) profile generation from a `SandboxPolicy` (R44-SBX.1, macOS).
 *
 * Pure string building, deliberately separated from the backend that spawns
 * `sandbox-exec`, so the exact bytes handed to the kernel are directly testable
 * and diffable without running anything.
 *
 * ## The profile is an allow-list. It used to be a deny-list, and that was a bug
 *
 * Phase 44 shipped `(allow default)` plus targeted denies, on the argument that
 * "an enumerable allowlist of everything a compiler touches does not exist". The
 * argument is wrong, and two independent reviews proved it wrong with working
 * escapes. A deny-list sandbox grants every capability nobody thought to
 * enumerate, and on macOS the capabilities nobody enumerated included:
 *
 * - **`mach-lookup` to LaunchServices.** `open -a Calculator` inside the sandbox
 *   made launchd start Calculator *outside* it. Reproduced: an app bundle whose
 *   executable wrote to a path outside the write allowlist, launched via `open`,
 *   and the file appeared. The write allowlist and the network toggle are both
 *   irrelevant once you can ask launchd to run a program for you.
 * - **`mach-priv-task-port`.** `lldb -p <pid>` inside the sandbox attached to an
 *   unsandboxed same-uid process and ran `expr (int)system("echo ... > outside")`
 *   in it. Reproduced with the network off.
 * - **Unix-domain sockets.** A sandboxed process connected to the socket of an
 *   already-running unsandboxed daemon and injected a payload into it.
 * - **Every pty on the machine**, via `(regex #"^/dev/ttys[0-9]*$")`, so a
 *   confined process could write a fake prompt into an unrelated terminal.
 *
 * So the shape is now the one Phase 28 used for the RLM REPL
 * (`packages/rlm/sandbox/macos.sb`):
 *
 *     (deny default)                      ; nothing, unless named below
 *     (allow <one capability at a time>)  ; each with a reason it is here
 *     (deny <the escape routes>)          ; restating intent where it matters
 *
 * The enumeration turned out to be small: **thirteen** capability allows, plus a
 * network section of five, cover `bash`, `python3`, `node`, `git`, `npm`, `make`,
 * `clang`, `curl`, `tar`, `sqlite3`, `openssl`, python `venv` and
 * `multiprocessing`, node worker threads, and local HTTP servers. Each one below
 * is here because a specific command failed without it, and the comment says
 * which. Nothing is here "to be safe".
 *
 * ## Rules for changing this file
 *
 * 1. An allow needs a one-sentence justification naming what breaks without it.
 * 2. Reach for the narrowest filter that works -- `(global-name "...")` over a
 *    bare `(allow mach-lookup)`, a `(literal "...")` over a `(subpath "...")`.
 * 3. Verify the narrowing, do not assume it. `com.apple.system.notification_center`
 *    was in an earlier draft of this list and is not here now, because testing
 *    showed `com.apple.system.opendirectoryd.libinfo` alone was sufficient.
 * 4. Every capability an escape used gets an explicit `(deny ...)` even though
 *    `(deny default)` already covers it, so the next reader can see the intent
 *    rather than having to re-derive it from an absence.
 *
 * ## Properties verified empirically on macOS 26.5 (darwin 25.5), not assumed
 *
 * - A write outside the allowlist fails with `EPERM`, whether spelled directly,
 *   reached through a symlink whose *link* sits inside an allowed directory, or
 *   performed by an interpreter. Seatbelt checks the resolved vnode, so the
 *   symlink case needs no rule of its own.
 * - `(deny network*)` blocks a loopback TCP connect (`EPERM`, not a refused
 *   connection), which is what makes the R44-SBX.4 network probe meaningful.
 * - **Privilege escalation is impossible by construction**: exec of a setuid
 *   binary is refused for *any* sandboxed process, so `sudo` fails at exec time
 *   regardless of the rules below. The explicit denies are a statement of intent.
 * - A sandboxed process cannot re-enter `sandbox-exec` with a looser profile:
 *   the nested `sandbox_apply` fails with `EPERM`. Profiles compose by
 *   intersection and are inherited across `exec`.
 *
 * ## Untrusted strings in a profile
 *
 * `writePaths` can contain user-configured directories (`extraWritePaths` from
 * settings). A path containing `"` would close the SBPL string literal early and
 * let the rest of the path be parsed as profile source -- `(allow default)`
 * smuggled in through a directory name. Backslash and quote are escaped;
 * anything that cannot be represented at all (control characters, newlines)
 * makes generation **throw**, which the backend turns into `unavailable`. A path
 * we cannot render exactly is never rendered approximately.
 */

import type { SandboxPolicy } from "./policy.ts";

/** Thrown when a policy cannot be rendered into a profile exactly. Backends turn this into `unavailable`. */
export class SandboxProfileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxProfileError";
	}
}

/**
 * Device nodes a shell and its children need to write to in order to behave at
 * all: `/dev/null` redirects, `/dev/fd` process substitution, pty allocation.
 * None of these is filesystem persistence, so allowing them does not widen what
 * the policy is about.
 *
 * `/dev/tty` is the per-process alias for the *controlling* terminal, so it can
 * only ever reach the child's own terminal -- unlike the machine-wide
 * `/dev/ttys*` regex this list used to carry, which is now the extension-gated
 * pty rule in `buildSeatbeltProfile`.
 */
const DEVICE_WRITE_RULES = [
	'(literal "/dev/null")',
	'(literal "/dev/zero")',
	'(literal "/dev/random")',
	'(literal "/dev/urandom")',
	'(literal "/dev/stdin")',
	'(literal "/dev/stdout")',
	'(literal "/dev/stderr")',
	'(literal "/dev/tty")',
	'(literal "/dev/ptmx")',
	'(subpath "/dev/fd")',
] as const;

/**
 * Binaries whose entire purpose is to acquire another user's privileges. Denying
 * exec of them states the invariant in the profile itself; the kernel's refusal
 * to exec setuid binaries inside any sandbox is what actually enforces it.
 */
const PRIVILEGE_ESCALATION_BINARIES = ["/usr/bin/sudo", "/usr/bin/su", "/usr/bin/sudoedit", "/usr/bin/login"] as const;

/**
 * The system resolver's socket. `getaddrinfo` on macOS reaches mDNSResponder
 * through this unix socket, so without it every hostname fails to resolve even
 * with IP networking fully allowed (measured: `curl` reports
 * "Could not resolve host", `node` reports `ENOTFOUND`).
 */
const DNS_RESOLVER_SOCKET = "/private/var/run/mDNSResponder";

/**
 * Renders `value` as an SBPL string literal.
 *
 * Escapes what SBPL can escape and refuses what it cannot, rather than dropping
 * or substituting characters -- a path rendered as something other than itself
 * is a policy that does not match the policy that was reviewed.
 */
export function quoteSbplString(value: string): string {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) {
			throw new SandboxProfileError(
				`cannot render path ${JSON.stringify(value)} into a sandbox profile: it contains a control character (U+${code
					.toString(16)
					.padStart(4, "0")
					.toUpperCase()}) that SBPL string literals cannot represent`,
			);
		}
	}
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Generates the SBPL profile text for `policy`. Deterministic: same policy, same bytes. */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
	if (policy.writePaths.length === 0) {
		// Every backend needs somewhere to write (the shell's own tmp, at minimum),
		// and an empty allowlist almost always means policy resolution silently
		// dropped everything. Refusing surfaces that as `unavailable`.
		throw new SandboxProfileError("cannot render a sandbox profile: the write allowlist is empty");
	}
	for (const path of policy.writePaths) {
		if (path === "/") {
			throw new SandboxProfileError(
				"cannot render a sandbox profile: the write allowlist contains the filesystem root, which would confine nothing",
			);
		}
	}

	const writeSubpaths = policy.writePaths.map((path) => `(subpath ${quoteSbplString(path)})`).join(" ");

	const lines: string[] = [
		"(version 1)",
		"",
		";; Generated from SandboxPolicy v1 by src/core/sandbox/seatbelt-profile.ts.",
		";; Do not edit by hand. Every allow below names the thing that breaks without it.",
		"",
		";; ---------------------------------------------------------------------------",
		";; Deny by default. A capability nobody enumerated is a capability nobody",
		";; reviewed; the previous `(allow default)` shape left launchd, the debugger",
		";; interface and unix sockets open, each of which is a complete escape.",
		";; ---------------------------------------------------------------------------",
		"(deny default)",
		"",
		";; --- what running a developer command actually requires -------------------",
		"",
		";; Running arbitrary binaries is the bash tool's entire purpose; confinement",
		";; here is over what those binaries may write and reach, not over which of",
		";; them exist. (Without it nothing runs at all: even `/bin/sh` fails to exec.)",
		"(allow process-exec*)",
		"",
		";; Every pipeline, subshell, `$(...)` and parallel build forks.",
		"(allow process-fork)",
		"",
		";; R44-SBX.2: v1 is read allow-all. Dev workflows read toolchains, caches and",
		";; dotfiles constantly, and a read-deny list is a v2 concern.",
		"(allow file-read*)",
		"",
		";; The policy: only these subtrees are writable. Seatbelt matches the resolved",
		";; vnode, so a symlink pointing out of one of these does not widen it.",
		`(allow file-write* ${writeSubpaths})`,
		"",
		";; Device nodes a shell needs to function. Not filesystem persistence.",
		`(allow file-write* ${DEVICE_WRITE_RULES.join(" ")})`,
		"",
		";; A pty the process allocates for itself (`script`, `node-pty`, `python -m pty`,",
		";; anything that wants a tty for a child). `pseudo-tty` issues the sandbox",
		";; extension that the following rule requires, so this grants the child *its",
		';; own* terminal and no other: the machine-wide `(regex #"^/dev/ttys[0-9]*$")`',
		";; this replaces let a confined process write a forged prompt into somebody",
		";; else's terminal. Idiom taken from Apple's own application.sb.",
		"(allow pseudo-tty)",
		'(allow file-read* file-write* (require-all (regex #"^/dev/ttys[0-9]*$") (extension "com.apple.sandbox.pty")))',
		"",
		";; `isatty`, terminal size, and the termios calls every interactive-ish tool",
		";; makes on descriptors it has already opened.",
		"(allow file-ioctl)",
		"",
		";; `hw.ncpu`, `kern.osversion` and friends: node, python and make read these",
		";; during startup (`os.cpus()`, `sysctl -n hw.ncpu`, `uname -a`).",
		"(allow sysctl-read)",
		"",
		";; Job control over the command's own process tree -- `kill %1`, `make` killing",
		";; a stuck child, `trap`. `(target same-sandbox)` stops there: without the",
		";; filter a confined command can SIGKILL the agent that launched it (verified:",
		";; it could, under the old profile).",
		"(allow signal (target same-sandbox))",
		"",
		";; POSIX semaphores: `multiprocessing.Pool` fails with EPERM in `sem_unlink`",
		";; without this, which takes out most parallel Python.",
		"(allow ipc-posix-sem)",
		"",
		";; POSIX shared memory: `multiprocessing.shared_memory` and the data-science",
		";; stacks layered on it. A memory-object namespace -- no filesystem, exec or",
		";; network reach comes with it.",
		"(allow ipc-posix-shm)",
		"",
		";; User and group lookup (`getpwuid`). Without it `id -un` and `whoami` print",
		";; a bare uid, `os.userInfo()` throws ENOENT, and git cannot name an author.",
		";; One service, by name: a bare `(allow mach-lookup)` is what put LaunchServices",
		";; -- and therefore launchd -- back in reach.",
		'(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
		"",
	];

	if (policy.network === "on") {
		lines.push(
			";; --- network on ------------------------------------------------------------",
			"",
			";; IP only, in both directions, plus binding a local port for a dev server.",
			"(allow network-outbound (remote ip))",
			"(allow network-inbound (local ip))",
			"(allow network-bind (local ip))",
			"",
			";; The system resolver's socket, named exactly, or nothing resolves.",
			`(allow network-outbound (literal ${quoteSbplString(DNS_RESOLVER_SOCKET)}))`,
			"",
			";; Unix-domain sockets, confined to the write allowlist: a command may run",
			";; its own helper daemon inside its own writable area, and a directory it",
			";; can already write into is one it could already plant a socket in -- so",
			";; this grants nothing the write allowlist did not already grant. Sockets",
			";; anywhere else -- docker.sock, a tmux or screen server, an emacs server --",
			";; belong to *unsandboxed* daemons that execute what they are told, and",
			";; reaching one is a full escape (verified: a confined process injected a",
			";; payload into a listening daemon this way).",
			`(allow network-outbound network-bind ${writeSubpaths})`,
			"",
		);
	} else {
		lines.push(
			";; --- network off -----------------------------------------------------------",
			"",
			";; Outbound, inbound, bind, and unix-domain sockets: the toggle means *no",
			";; sockets*, not merely no IP. A loopback connect fails with EPERM rather",
			";; than being refused, which is what the R44-SBX.4 self-test distinguishes.",
			"(deny network*)",
			"",
		);
	}

	lines.push(
		";; --- escape routes, denied explicitly -------------------------------------",
		";; `(deny default)` already covers every rule in this block. They are written",
		";; out anyway so that the next person to widen an allow above can see what the",
		";; widening must not reach.",
		"",
		";; task_for_pid / ptrace-style attach. A confined command could otherwise take",
		";; the task port of any same-uid process -- including the agent itself -- and",
		";; execute code inside it (verified: `lldb -p` did exactly that, network off).",
		"(deny mach-priv-task-port)",
		"(deny mach-priv-host-port)",
		";; Even a task *name* port hands out another process's address-space metadata.",
		"(deny mach-task-name)",
		";; Reading other processes' state. Scoped to `others` deliberately: an",
		";; unscoped `(deny process-info*)` also blocks a process inspecting itself,",
		";; which aborts curl and anything else that calls `proc_pidinfo` on self.",
		";; Known consequence: `pgrep` and other whole-machine process enumeration",
		";; stop working inside the sandbox. `lsof -p $$` and a command's own job",
		";; control still do. (`ps` was already refused -- it is setuid.)",
		"(deny process-info* (target others))",
		"",
		";; Asking launchd or LaunchServices to start a process for us. That process",
		";; would run *outside* this sandbox, which defeats the write allowlist and the",
		";; network toggle at once (verified: `open -a` launched an app that then wrote",
		";; outside the allowlist). `appleevent-send` is the same escape one hop over:",
		";; scripting an already-running unsandboxed app into running a shell command.",
		"(deny job-creation)",
		"(deny lsopen)",
		"(deny appleevent-send)",
		"",
		";; Authorization Services is the other way to ask the system for privileges.",
		"(deny authorization-right-obtain)",
		"",
		";; No privilege escalation (R44-SBX.2). The kernel already refuses to exec a",
		";; setuid binary from inside any sandbox -- verified: sudo fails EPERM even",
		";; under a bare `(allow default)` profile -- and profiles are inherited across",
		";; exec and cannot be loosened by re-entering sandbox-exec. These denies state",
		";; the invariant explicitly; they are not what enforces it.",
		"(deny file-write-setugid)",
		`(deny process-exec* ${PRIVILEGE_ESCALATION_BINARIES.map((bin) => `(literal ${quoteSbplString(bin)})`).join(" ")})`,
	);

	lines.push("");
	return lines.join("\n");
}
