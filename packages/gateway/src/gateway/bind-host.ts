/**
 * Bind-host policy for the gateway.
 *
 * The gateway binds loopback by default and refuses any other interface unless
 * the caller opts in explicitly. This module is the single place that decision
 * is made, so the CLI and the programmatic surface (`createServer` /
 * `startGateway`) cannot drift apart — an embedder gets the same refusal an
 * operator does.
 *
 * Scope note: this is the gateway's own bind posture. It is NOT a closure of
 * the GSEC-04 finding in `.planning/geist/SECURITY-2026-07-13.md`, whose named
 * component is the pairing server; that finding remains open and is tracked
 * separately.
 */

/**
 * The only hostnames treated as loopback.
 *
 * Deliberately an exact set rather than a 127.0.0.0/8 range check: anything we
 * are not certain is loopback must fall into the guarded path.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Human-readable type name for a rejected value, used in error messages. */
function describeType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * Pure predicate — is `host` a loopback bind target?
 *
 * `0.0.0.0` (all interfaces), `::`, LAN addresses and Tailscale `100.x`
 * addresses are all non-loopback and therefore require an explicit opt-in.
 *
 * @param host - The hostname or address the gateway would bind to.
 * @returns true when binding `host` cannot be reached from another machine.
 * @throws TypeError when `host` is not a string — a malformed config must
 *         produce a clear message, not a crash inside the guard.
 */
export function isLoopbackHost(host: string): boolean {
	if (typeof host !== "string") {
		throw new TypeError(`bind host must be a string, got ${describeType(host)}`);
	}
	// Normalize the shapes a human or a config file may legitimately produce:
	// surrounding whitespace, mixed case, and bracketed IPv6 (`[::1]`).
	const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
	return LOOPBACK_HOSTS.has(normalized);
}

/**
 * Error message for a non-loopback bind attempted without the opt-out flag.
 */
export function nonLoopbackBindError(host: string): string {
	return [
		`Refusing to bind non-loopback host '${host}'.`,
		"",
		"POST /sessions accepts an arbitrary `command` array and spawns it, so a",
		"non-loopback bind is remote code execution for anyone holding a bearer token.",
		"",
		"Supported remote access path: leave the gateway on loopback and put Tailscale",
		"in front of it:",
		"",
		"    tailscale serve --bg http://127.0.0.1:<port>",
		"",
		"That terminates TLS with a real certificate on a stable MagicDNS name, which",
		"browser and iOS clients require. Never use `tailscale funnel` for this.",
		"",
		"If you understand the risk and still want a raw non-loopback bind, pass",
		"--allow-non-loopback explicitly (or allowNonLoopback: true programmatically).",
	].join("\n");
}

/**
 * Warning emitted when the caller has opted into a non-loopback bind.
 */
export function nonLoopbackBindWarning(host: string): string {
	return [
		"",
		"!!! ============================================================== !!!",
		`!!! Binding NON-LOOPBACK host '${host}'.`,
		"!!! POST /sessions runs an arbitrary `command` array with your user's",
		"!!! privileges. This gateway is therefore REMOTE CODE EXECUTION for any",
		"!!! holder of a bearer token that can reach this interface.",
		"!!! Prefer: bind 127.0.0.1 and expose it with `tailscale serve`.",
		"!!! ============================================================== !!!",
		"",
	].join("\n");
}

/** Inputs to {@link assertBindHostAllowed}. */
export interface BindHostPolicy {
	/** The interface the caller wants to bind. */
	host: string;
	/** True when the caller explicitly accepted a non-loopback bind. */
	allowNonLoopback?: boolean;
	/** Sink for the opt-in warning. Defaults to `console.warn`. */
	warn?: (message: string) => void;
}

/**
 * Enforce the loopback-by-default bind posture.
 *
 * @returns The host, unchanged, once it is allowed to be bound.
 * @throws Error when `host` is non-loopback and `allowNonLoopback` is not set,
 *         or TypeError when `host` is not a string.
 *
 * NOTE on blast radius: POST /sessions only shape-checks `command` (see
 * validateCommand in gateway/routes/sessions.ts) before handing it to
 * Bun.spawn. Narrowing that to an allowlist is a separate planned phase; until
 * then loopback is the containment boundary.
 */
export function assertBindHostAllowed({ host, allowNonLoopback = false, warn }: BindHostPolicy): string {
	if (isLoopbackHost(host)) {
		return host;
	}
	if (!allowNonLoopback) {
		throw new Error(nonLoopbackBindError(host));
	}
	(warn ?? ((message: string) => console.warn(message)))(nonLoopbackBindWarning(host));
	return host;
}

/**
 * Is `address` the address of a peer that is necessarily on this machine?
 *
 * This is the *peer* counterpart to {@link isLoopbackHost}, and it is
 * deliberately shaped differently. For a bind host, being unsure must mean
 * "guarded"; for a peer, being unsure must mean "refused" — so here the set of
 * accepted values is the set that provably cannot be routed in from another
 * host: the whole `127.0.0.0/8` block, `::1`, and their IPv4-mapped IPv6 forms
 * (`::ffff:127.0.0.1`), which is what Bun reports for a loopback connection to
 * a dual-stack listener.
 *
 * @param address - Peer address as reported by `Bun.Server.requestIP()`.
 * @returns true when the connection provably originated on this machine.
 */
export function isLoopbackPeer(address: string): boolean {
	if (typeof address !== "string") return false;
	const normalized = address
		.trim()
		.toLowerCase()
		.replace(/^\[/, "")
		.replace(/\]$/, "")
		.replace(/^::ffff:/, "");
	if (normalized === "::1" || normalized === "localhost") return true;
	// 127.0.0.0/8 in full: a packet with such a source cannot cross a router.
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * Operator-facing record of a refused off-box request.
 *
 * Logged once per server, not per request: a port scan must not be able to turn
 * the guard into a log-flooding primitive.
 */
export function nonLoopbackPeerRefusal(address: string): string {
	return [
		"",
		"!!! ============================================================== !!!",
		`!!! Refused a request from non-loopback peer '${address}'.`,
		"!!! This gateway was built for a loopback bind, but the app was served",
		"!!! on an interface reachable from another machine. POST /sessions runs",
		"!!! an arbitrary `command` array, so serving it off-box is remote code",
		"!!! execution for any bearer-token holder — every off-box request is",
		"!!! being refused with 403.",
		"!!! Fix: serve with startGateway(), which owns the bind, or pass",
		"!!! allowNonLoopback: true if you accept the risk.",
		"!!! ============================================================== !!!",
		"",
	].join("\n");
}
