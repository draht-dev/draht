import { DeviceRegistry } from "@draht/geist-core";
import * as QRCode from "qrcode";
import {
	type CommandRunner,
	resolveLiveOrigin,
	resolveTailscaleBin,
	serveRemediation,
	TailscaleError,
} from "../tailscale.js";

/**
 * `geist pair` — the one command that puts a phone on this daemon
 * (R33-REACH.4, and the URL half of R33-REACH.3).
 *
 * The command prints two representations of exactly one string: a QR to scan
 * and the same URL to copy. Everything below follows from three decisions.
 *
 * **The token lives in the fragment, never the query.** `#token=…` is not
 * cosmetic. A fragment is never sent to the server, so it cannot land in an
 * access log; it is not part of the `Referer` a browser forwards to a third
 * party; it does not survive into the proxy's request line. A query parameter
 * fails all three, which is why R33-REACH.3 removed the `?token=` gateway
 * fallback and why {@link assertNoQueryCredential} refuses to print a link
 * carrying one — a future edit that builds the URL with `?` dies here rather
 * than quietly reintroducing the leak the phase exists to close.
 *
 * **The origin is read from the live `tailscale serve` mapping.** Never from
 * config. See `../tailscale.ts` for why. `--origin` exists because a test
 * cannot stand up a tailnet, and it announces itself on stderr every single
 * time: an operator who reaches for it must not be able to mistake it for the
 * supported path.
 *
 * **Nothing is minted until there is somewhere to send it.** The origin is
 * resolved *before* `mintBootstrap()`. Minting first and failing after would
 * leave a live, spendable bootstrap token in the store that nobody ever saw —
 * a credential in existence with no owner, expiring quietly two minutes later.
 * Cheap to avoid, so it is avoided by construction rather than by care.
 */

/** Where the console bundle is served, relative to the published origin. */
const UI_PATH = "/ui";

/** The loopback port the daemon listens on, and therefore the port whose serve mapping we want. */
const DEFAULT_PORT = 7878;

/** Terminal QR options. Fixed, because the QR must be reproducible from the printed URL alone. */
const QR_OPTIONS = { type: "terminal", small: true } as const;

/** A published origin, as `tailscale serve` reports it: scheme, host, optional port. Nothing else. */
const ORIGIN_PATTERN = /^https:\/\/[A-Za-z0-9._-]+(?::\d{1,5})?$/;

/** Exit codes. `2` is usage, matching the CLI's unknown-subcommand refusal; the rest name the failure. */
export const PAIR_EXIT = Object.freeze({
	OK: 0,
	USAGE: 2,
	TAILSCALE_MISSING: 69,
	SERVE_STATUS_FAILED: 70,
	NO_SERVE_MAPPING: 75,
});

export interface PairDeps {
	/** Where the bootstrap token is minted. Injected so a test and the daemon can share one store. */
	registry?: DeviceRegistry;
	/** The seam to the `tailscale` binary. */
	run?: CommandRunner;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	env?: NodeJS.ProcessEnv;
	/** Renders the QR block. Injectable only so a non-TTY context can substitute; defaults to a real QR. */
	renderQr?: (text: string) => Promise<string>;
}

interface PairArgs {
	port: number;
	servePath: string;
	origin?: string;
	ttlMs?: number;
}

/** Refuses a link that carries a credential in a query string. See the module note. */
export function assertNoQueryCredential(url: string): string {
	if (url.includes("?") || /[?&]token=/i.test(url)) {
		throw new Error(
			`refusing to print a pairing link with a query string: credentials belong in the fragment (${url.split("#")[0]}?…)`,
		);
	}
	return url;
}

/**
 * Builds the deep link. Kept separate from the printing so the invariant above
 * is enforced on one string, at one place, whatever the caller assembled.
 */
export function buildPairLink(origin: string, bootstrapToken: string, servePath = "/"): string {
	if (!ORIGIN_PATTERN.test(origin)) {
		throw new Error(`not a usable origin: ${origin} (expected https://<host> with no path, query or fragment)`);
	}
	const prefix = servePath === "/" ? "" : servePath.replace(/\/+$/, "");
	return assertNoQueryCredential(`${origin}${prefix}${UI_PATH}#token=${bootstrapToken}`);
}

export async function renderQrBlock(text: string): Promise<string> {
	return (await QRCode.toString(text, QR_OPTIONS)).trimEnd();
}

function parseArgs(argv: string[]): PairArgs | { error: string } {
	const args: PairArgs = { port: DEFAULT_PORT, servePath: "/" };

	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		switch (flag) {
			case "--port": {
				if (value === undefined) return { error: "--port needs a port number" };
				const port = Number.parseInt(value, 10);
				if (!Number.isInteger(port) || port < 1 || port > 65535)
					return { error: `--port must be 1–65535, got ${value}` };
				args.port = port;
				i++;
				break;
			}
			case "--serve-path": {
				if (value === undefined) return { error: "--serve-path needs a path" };
				args.servePath = value.startsWith("/") ? value : `/${value}`;
				i++;
				break;
			}
			case "--origin": {
				if (value === undefined) return { error: "--origin needs a URL" };
				args.origin = value.replace(/\/+$/, "");
				i++;
				break;
			}
			case "--ttl": {
				if (value === undefined) return { error: "--ttl needs a number of seconds" };
				const seconds = Number.parseInt(value, 10);
				if (!Number.isInteger(seconds) || seconds < 1)
					return { error: `--ttl must be a positive number of seconds, got ${value}` };
				args.ttlMs = seconds * 1000;
				i++;
				break;
			}
			default:
				return { error: `unknown flag for \`geist pair\`: ${flag}` };
		}
	}

	return args;
}

function humanizeRemaining(expiresAt: number, now: number): string {
	const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export async function runPair(argv: string[], deps: PairDeps): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		deps.stderr(`geist pair: ${parsed.error}`);
		deps.stderr("usage: geist pair [--port <port>] [--serve-path <path>] [--ttl <seconds>]");
		return PAIR_EXIT.USAGE;
	}

	// Resolve where the phone will go BEFORE minting what it will carry.
	let origin: string;
	if (parsed.origin !== undefined) {
		deps.stderr(
			`geist pair: --origin bypasses the live \`tailscale serve\` mapping — the printed link is only as correct as ${parsed.origin}`,
		);
		origin = parsed.origin;
	} else {
		try {
			origin = resolveLiveOrigin({
				port: parsed.port,
				path: parsed.servePath,
				run: deps.run,
				bin: resolveTailscaleBin(deps.env ?? process.env),
			});
		} catch (error) {
			if (error instanceof TailscaleError) {
				deps.stderr(`geist pair: ${error.message}`);
				deps.stderr(error.detail || serveRemediation(parsed.port));
				return error.reason === "tailscale_missing"
					? PAIR_EXIT.TAILSCALE_MISSING
					: error.reason === "no_serve_mapping"
						? PAIR_EXIT.NO_SERVE_MAPPING
						: PAIR_EXIT.SERVE_STATUS_FAILED;
			}
			throw error;
		}
	}

	const registry = deps.registry ?? new DeviceRegistry();
	const bootstrap = registry.mintBootstrap(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs });

	let link: string;
	try {
		link = buildPairLink(origin, bootstrap.token, parsed.servePath);
	} catch (error) {
		deps.stderr(`geist pair: ${error instanceof Error ? error.message : String(error)}`);
		return PAIR_EXIT.SERVE_STATUS_FAILED;
	}

	const renderQr = deps.renderQr ?? renderQrBlock;
	deps.stdout(await renderQr(link));
	deps.stdout(link);
	deps.stdout("");
	deps.stdout(
		`Scan the code, or open the link above. It expires in ${humanizeRemaining(bootstrap.expiresAt, Date.now())} and works exactly once.`,
	);
	deps.stdout(`Devices are listed and revoked with \`geist devices\` (store: ${registry.path}).`);

	return PAIR_EXIT.OK;
}
