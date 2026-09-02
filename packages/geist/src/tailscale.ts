import { spawnSync } from "node:child_process";

/**
 * Reading the live `tailscale serve` mapping (R33-REACH.4).
 *
 * R33-REACH.4 is explicit about where `geist pair`'s origin may come from:
 * "derived from the live `tailscale serve` mapping rather than typed into
 * config". That clause is doing real work. A MagicDNS name in a config file is
 * a claim about the past — the node was renamed, the mapping was taken down,
 * the port moved, someone copied a colleague's config — and a QR built on a
 * stale claim sends a phone somewhere that either does not answer or, worse,
 * is now a different machine on the same tailnet. `tailscale serve status
 * --json` is not a claim; it is the daemon describing what it is doing right
 * now. So this module reads that, and there is deliberately no code path here
 * that reads a hostname from anywhere else.
 *
 * Two further properties this module is shaped by:
 *
 * - **It only ever reads.** Publishing a mapping is
 *   `scripts/geist-tailscale-serve.mjs`'s job, and keeping the mutation in one
 *   reviewed place is what makes that script's Funnel guard meaningful. A
 *   `pair` command that could publish would be a second, unreviewed path to
 *   exposing this daemon. {@link readServeConfig} therefore builds exactly one
 *   argv, `serve status --json`, and {@link assertReadOnlyArgv} refuses
 *   anything else before it reaches a spawn.
 * - **The command runner is injectable.** Not for mock convenience: without it
 *   the only way to test origin derivation is a live tailnet, which means it
 *   would not be tested, which means the requirement's central clause would
 *   rest on nothing.
 *
 * The parsing mirrors `resolveOrigin()` in `scripts/geist-tailscale-serve.mjs`
 * — same `ipn.ServeConfig` shape, same normalisation — because the script and
 * the CLI must agree on which mapping is "the" mapping. The script is a plain
 * `.mjs` with no build step and cannot be imported from TypeScript, so the two
 * are kept honest by both being driven from the same fixture shape rather than
 * by sharing a module.
 */

/** Environment variable naming the tailscale binary, so a test can point at a fake. */
export const TAILSCALE_BIN_ENV = "TAILSCALE_BIN";

/** Exit code a runner reports when the binary itself could not be found. */
const ENOENT_CODE = 127;

/** How long to wait on `tailscale serve status --json` before giving up. */
const STATUS_TIMEOUT_MS = 10_000;

/** What a command runner reports back. Deliberately the shape `spawnSync` already produces. */
export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * The seam between this module and the `tailscale` binary. Synchronous because
 * every call it carries is a sub-second status read, and a synchronous seam is
 * one fewer thing for a test to get wrong.
 */
export type CommandRunner = (bin: string, args: string[]) => CommandResult;

/** Why an origin could not be resolved. One reason per fix. */
export type TailscaleFailure =
	| "tailscale_missing"
	| "serve_status_failed"
	| "serve_status_unparsable"
	| "no_serve_mapping";

/** A named failure the CLI turns into an exit code and an operator-facing message. */
export class TailscaleError extends Error {
	readonly reason: TailscaleFailure;
	readonly detail: string;

	constructor(reason: TailscaleFailure, message: string, detail = "") {
		super(message);
		this.name = "TailscaleError";
		this.reason = reason;
		this.detail = detail;
	}
}

/** The subset of `ipn.ServeConfig` this module reads. */
export interface ServeConfig {
	Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> } | undefined>;
}

export function resolveTailscaleBin(env: NodeJS.ProcessEnv = process.env): string {
	return env[TAILSCALE_BIN_ENV] ?? "tailscale";
}

/**
 * Refuse any argv that would do more than read status.
 *
 * `geist pair` publishes nothing and takes nothing down. This guard is what
 * makes that a property of the code rather than a property of the current
 * call sites: a future edit that reaches for `serve --bg` — or, catastrophically,
 * `funnel` — from here dies at this line instead of quietly gaining the power
 * to expose the daemon from a command whose job is printing a QR.
 */
export function assertReadOnlyArgv(args: readonly string[]): readonly string[] {
	const mutating = args.find((token) => /funnel/i.test(token));
	if (mutating !== undefined) {
		throw new TailscaleError(
			"serve_status_failed",
			`refusing to run tailscale with \`${mutating}\` — geist pair never publishes`,
		);
	}
	if (!(args[0] === "serve" && args[1] === "status")) {
		throw new TailscaleError(
			"serve_status_failed",
			`refusing to run \`tailscale ${args.join(" ")}\` — geist pair only reads serve status`,
		);
	}
	return args;
}

/** The default runner: `spawnSync`, with a missing binary reported as its own reason. */
export const spawnCommandRunner: CommandRunner = (bin, args) => {
	const result = spawnSync(bin, args, { encoding: "utf-8", timeout: STATUS_TIMEOUT_MS });
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code === "ENOENT" ? ENOENT_CODE : 1;
		return { code, stdout: "", stderr: String(result.error.message ?? result.error) };
	}
	return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/**
 * Read the live serve config. A node with nothing published reports `{}` —
 * that is a valid answer, not an error, and it is distinguished from a failed
 * read so the caller can say "publish it first" rather than "tailscale is
 * broken".
 */
export function readServeConfig(
	run: CommandRunner = spawnCommandRunner,
	bin: string = resolveTailscaleBin(),
): ServeConfig {
	const args = assertReadOnlyArgv(["serve", "status", "--json"]);
	const { code, stdout, stderr } = run(bin, [...args]);

	if (code === ENOENT_CODE) {
		throw new TailscaleError(
			"tailscale_missing",
			`\`${bin}\` is not on PATH`,
			`Install Tailscale and log in, or set ${TAILSCALE_BIN_ENV} to the binary's path.`,
		);
	}
	if (code !== 0) {
		throw new TailscaleError(
			"serve_status_failed",
			"`tailscale serve status --json` failed",
			stderr.trim() || stdout.trim(),
		);
	}

	const text = stdout.trim();
	if (!text) return {};

	try {
		return JSON.parse(text) as ServeConfig;
	} catch (error) {
		throw new TailscaleError(
			"serve_status_unparsable",
			"could not parse `tailscale serve status --json`",
			String(error),
		);
	}
}

function normalizeProxy(target: unknown): string {
	if (typeof target !== "string") return "";
	return target.trim().replace(/\/+$/, "");
}

/**
 * The public origin serving a given loopback port, or `null` when nothing does.
 *
 * The key in `Web` is `host:port` and the handler's `Proxy` is the loopback
 * target, so matching both is what ties "this daemon" to "this hostname". The
 * explicit port is dropped for 443 because a URL that says `:443` still works
 * but looks wrong on a phone, and this string is read by humans off a screen.
 */
export function resolveServeOrigin(config: ServeConfig, options: { port: number; path?: string }): string | null {
	const path = options.path ?? "/";
	const wanted = new Set([
		normalizeProxy(`http://127.0.0.1:${options.port}`),
		normalizeProxy(`http://localhost:${options.port}`),
	]);

	for (const [key, web] of Object.entries(config?.Web ?? {})) {
		const handler = web?.Handlers?.[path];
		if (!handler || !wanted.has(normalizeProxy(handler.Proxy))) continue;

		const separator = key.lastIndexOf(":");
		const host = separator === -1 ? key : key.slice(0, separator);
		const servedPort = separator === -1 ? "443" : key.slice(separator + 1);
		return servedPort === "443" ? `https://${host}` : `https://${host}:${servedPort}`;
	}

	return null;
}

export interface LiveOriginOptions {
	port: number;
	path?: string;
	run?: CommandRunner;
	bin?: string;
}

/**
 * The origin `geist pair` prints, read from the running daemon.
 *
 * Throws rather than returning a fallback. There is no safe fallback: guessing
 * a hostname would produce a QR that looks right and is wrong, and the whole
 * point of deriving from the live mapping is that a wrong name is caught here,
 * in front of an operator who can fix it, instead of on a phone that just
 * spins.
 */
export function resolveLiveOrigin(options: LiveOriginOptions): string {
	const path = options.path ?? "/";
	const config = readServeConfig(options.run ?? spawnCommandRunner, options.bin ?? resolveTailscaleBin());
	const origin = resolveServeOrigin(config, { port: options.port, path });

	if (!origin) {
		throw new TailscaleError(
			"no_serve_mapping",
			`no \`tailscale serve\` mapping publishes http://127.0.0.1:${options.port} at ${path}`,
			serveRemediation(options.port),
		);
	}

	return origin;
}

/**
 * What to tell an operator who has no mapping. Names the one command that
 * fixes it, and stays free of internal finding identifiers — an operator
 * reading a refusal should get a fix, not an audit reference (R33-REACH.10).
 */
export function serveRemediation(port: number): string {
	return [
		`Nothing is published for http://127.0.0.1:${port}, so there is no name to put in the QR.`,
		"geist pair will not guess one: a hostname typed from memory produces a code that scans",
		"cleanly and points at the wrong machine.",
		"",
		"Publish the listener, then run this again:",
		`  node scripts/geist-tailscale-serve.mjs --port ${port}`,
		"",
		"If publishing succeeds and this still fails, MagicDNS is the usual cause — enable it in",
		"the Tailscale admin console so the node has a name to serve on.",
	].join("\n");
}
