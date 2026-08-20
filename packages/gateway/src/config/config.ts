import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TailnetFrontingSettings } from "../gateway/middleware/tailnet-identity";

/**
 * Gateway settings loaded from config file.
 *
 * Values can come from:
 * 1. Config file (~/.draht/gateway.config.json)
 * 2. CLI arguments (override config file)
 * 3. Defaults
 */
export interface GatewaySettings {
	/** Port to listen on (default: 7878) */
	port: number;

	/**
	 * Host to bind to (default: "127.0.0.1" — loopback only).
	 *
	 * Binding a non-loopback interface exposes the session API — which drives a
	 * `draht` agent process on this user's behalf — to every holder of a bearer
	 * token on that interface, so it requires the explicit
	 * `--allow-non-loopback` flag. For
	 * remote access use `tailscale serve` in front of the loopback listener
	 * instead.
	 */
	host: string;

	/** Authentication tokens (map of token name to token value) */
	tokens: Record<string, string>;

	/** Allowed working directory paths for session creation */
	allowedPaths: string[];

	/** Maximum number of concurrent sessions (default: 100) */
	maxSessions: number;

	/** Idle timeout for connections in seconds (max 255) */
	idleTimeout: number;

	/**
	 * Declares the deployment fronted by `tailscale serve`, and names the tailnet
	 * user allowed through it (R33-REACH.8).
	 *
	 * Absent on a daemon nobody has fronted — which is the common case and not a
	 * weaker posture, because this block can only ever *refuse*. The header it
	 * describes is forgeable by anything that can reach the loopback listener,
	 * so it is never a credential and never the only check; see
	 * `gateway/middleware/tailnet-identity.ts`.
	 */
	tailnet?: TailnetFrontingSettings;
}

/**
 * Default configuration values.
 *
 * `host` defaults to loopback. Reaching the gateway from another device is done
 * by putting `tailscale serve` in front of it, not by widening the bind.
 */
export const DEFAULT_CONFIG: GatewaySettings = {
	port: 7878,
	host: "127.0.0.1",
	tokens: {},
	allowedPaths: [homedir()], // Allow user home directory by default
	maxSessions: 100,
	idleTimeout: 255,
};

/**
 * Name of the directory this package creates and therefore may tighten.
 *
 * Permission repair only ever chmods a directory with this name: a config path
 * the operator pointed elsewhere (`/etc`, a shared config dir) belongs to
 * somebody else and must not have its mode changed underneath them.
 */
const CONFIG_DIR_NAME = ".draht";

/**
 * Path to the gateway config file.
 */
export const CONFIG_PATH = join(homedir(), CONFIG_DIR_NAME, "gateway.config.json");

/** Render a mode for an operator-facing message, e.g. 420 -> "0644". */
function octal(mode: number): string {
	return `0${mode.toString(8).padStart(3, "0")}`;
}

/**
 * Narrow an over-permissive config file (and our own config directory) in place.
 *
 * `createDefaultConfigFile` writes `0600`/`0700`, but that only covers installs
 * created by this version. An install upgraded from an earlier one still has
 * whatever the old code left behind — typically `0644`, world-readable — and the
 * file holds a bearer token that is shell access as the current user. So the
 * mode is repaired on every load rather than only at creation.
 *
 * Repair, not refusal: refusing to start would take every upgraded install down
 * until an operator typed the very chmod this function performs, which is a
 * worse outcome than doing it and saying so.
 *
 * Deliberately total — a mode that cannot be read or changed (Windows, a
 * read-only mount, a file owned by someone else) produces a warning, never a
 * throw. Configuration must stay loadable.
 *
 * @param configPath - The config file to inspect.
 * @param warn - Sink for the operator-facing notice. Defaults to `console.warn`.
 */
export function ensureConfigPrivate(configPath: string, warn: (message: string) => void = console.warn): void {
	// Mode bits do not describe access on Windows; acting on them there would be
	// noise at best and a broken ACL at worst.
	if (process.platform === "win32") return;

	try {
		// lstat, not stat: a symlinked config path must not have us chmod its
		// target, which is a file we know nothing about.
		const stats = lstatSync(configPath, { throwIfNoEntry: false });
		if (stats === undefined) return;
		if (!stats.isFile()) {
			warn(`Not repairing permissions on ${configPath}: it is not a regular file.`);
			return;
		}

		const fileMode = stats.mode & 0o777;
		if (fileMode & 0o077) {
			// `& 0o700` strips group and other; it can never grant anything.
			const repaired = fileMode & 0o700;
			chmodSync(configPath, repaired);
			warn(
				`Repaired permissions on ${configPath}: ${octal(fileMode)} -> ${octal(repaired)}. ` +
					"It holds a bearer token equivalent to shell access as you, so it must not be readable by other users.",
			);
		}

		const configDir = dirname(configPath);
		if (basename(configDir) !== CONFIG_DIR_NAME) return;
		const dirStats = lstatSync(configDir, { throwIfNoEntry: false });
		if (dirStats === undefined || !dirStats.isDirectory()) return;
		const dirMode = dirStats.mode & 0o777;
		if (dirMode & 0o077) {
			const repaired = dirMode & 0o700;
			chmodSync(configDir, repaired);
			warn(`Repaired permissions on ${configDir}: ${octal(dirMode)} -> ${octal(repaired)}.`);
		}
	} catch (error) {
		warn(
			`Could not repair permissions on ${configPath}: ${error instanceof Error ? error.message : String(error)}. ` +
				`Fix it by hand: chmod 600 '${configPath}'`,
		);
	}
}

/** Human-readable type name for a rejected config value. */
function describeType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/** True when the key was not supplied at all (so the default applies). */
function isAbsent(value: unknown): boolean {
	return value === undefined;
}

/**
 * Validate a parsed config object and merge it over {@link DEFAULT_CONFIG}.
 *
 * A key that is absent falls back to the default. A key that is *present* with
 * the wrong type is a config error, not something to paper over: an unvalidated
 * `host` reaches the bind guard and would otherwise crash inside it.
 *
 * Unknown keys (`$schema`, `_comments`, …) are ignored.
 *
 * @param json - The parsed JSON value.
 * @param source - Path used in error messages.
 * @throws Error listing every field that failed validation.
 */
export function normalizeConfig(json: unknown, source: string): GatewaySettings {
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		throw new Error(`Invalid gateway config at ${source}: expected a JSON object, got ${describeType(json)}`);
	}

	const raw = json as Record<string, unknown>;
	const problems: string[] = [];

	function stringField(key: "host", fallback: string): string {
		const value = raw[key];
		if (isAbsent(value)) return fallback;
		if (typeof value !== "string" || value.trim() === "") {
			problems.push(`"${key}" must be a string, got ${describeType(value)}`);
			return fallback;
		}
		return value;
	}

	function intField(key: "port" | "maxSessions" | "idleTimeout", fallback: number, min: number, max: number): number {
		const value = raw[key];
		if (isAbsent(value)) return fallback;
		if (typeof value !== "number" || !Number.isFinite(value)) {
			problems.push(`"${key}" must be a number, got ${describeType(value)}`);
			return fallback;
		}
		if (!Number.isInteger(value) || value < min || value > max) {
			problems.push(`"${key}" must be an integer between ${min} and ${max}, got ${value}`);
			return fallback;
		}
		return value;
	}

	const host = stringField("host", DEFAULT_CONFIG.host);
	const port = intField("port", DEFAULT_CONFIG.port, 1, 65535);
	const maxSessions = intField("maxSessions", DEFAULT_CONFIG.maxSessions, 1, Number.MAX_SAFE_INTEGER);
	const idleTimeout = intField("idleTimeout", DEFAULT_CONFIG.idleTimeout, 0, 255);

	let tokens = DEFAULT_CONFIG.tokens;
	if (!isAbsent(raw.tokens)) {
		if (typeof raw.tokens !== "object" || raw.tokens === null || Array.isArray(raw.tokens)) {
			problems.push(`"tokens" must be an object of name → token, got ${describeType(raw.tokens)}`);
		} else {
			const entries = Object.entries(raw.tokens as Record<string, unknown>);
			const bad = entries.find(([, value]) => typeof value !== "string");
			if (bad) {
				problems.push(`"tokens.${bad[0]}" must be a string, got ${describeType(bad[1])}`);
			} else {
				tokens = Object.fromEntries(entries) as Record<string, string>;
			}
		}
	}

	let allowedPaths = DEFAULT_CONFIG.allowedPaths;
	if (!isAbsent(raw.allowedPaths)) {
		if (!Array.isArray(raw.allowedPaths)) {
			problems.push(`"allowedPaths" must be an array of strings, got ${describeType(raw.allowedPaths)}`);
		} else if (raw.allowedPaths.some((entry) => typeof entry !== "string")) {
			problems.push('"allowedPaths" must contain only strings');
		} else {
			allowedPaths = raw.allowedPaths as string[];
		}
	}

	// The tailnet block declares that `tailscale serve` fronts this daemon and
	// names the tailnet user allowed through it (R33-REACH.8). It is validated
	// strictly rather than best-effort: a typo here must be a startup error, not
	// a check that quietly turns itself off. That it can only ever *refuse* is
	// not a licence to be sloppy about whether it is on.
	let tailnet: TailnetFrontingSettings | undefined;
	if (!isAbsent(raw.tailnet)) {
		if (typeof raw.tailnet !== "object" || raw.tailnet === null || Array.isArray(raw.tailnet)) {
			problems.push(`"tailnet" must be an object, got ${describeType(raw.tailnet)}`);
		} else {
			const block = raw.tailnet as Record<string, unknown>;
			const before = problems.length;
			if (typeof block.fronted !== "boolean") {
				problems.push(`"tailnet.fronted" must be a boolean, got ${describeType(block.fronted)}`);
			}
			if (typeof block.owner !== "string" || block.owner.trim() === "") {
				problems.push(`"tailnet.owner" must be a non-empty string, got ${describeType(block.owner)}`);
			}
			if (!isAbsent(block.header) && (typeof block.header !== "string" || block.header.trim() === "")) {
				problems.push(`"tailnet.header" must be a non-empty string, got ${describeType(block.header)}`);
			}
			if (problems.length === before) {
				tailnet = {
					fronted: block.fronted as boolean,
					owner: block.owner as string,
					...(isAbsent(block.header) ? {} : { header: block.header as string }),
				};
			}
		}
	}

	if (problems.length > 0) {
		throw new Error(`Invalid gateway config at ${source}:\n  - ${problems.join("\n  - ")}`);
	}

	// Spread rather than always-present-and-undefined: a daemon with no tailnet
	// block returns exactly the settings it always did.
	return { port, host, tokens, allowedPaths, maxSessions, idleTimeout, ...(tailnet ? { tailnet } : {}) };
}

/**
 * Read and parse a config file.
 *
 * Unreadable or syntactically broken files degrade to the defaults with a
 * warning (the historical behaviour). A *parseable* file with the wrong types
 * is a different class of problem and is surfaced by {@link normalizeConfig}.
 *
 * @returns The parsed JSON, or null when the defaults should be used.
 */
function readConfigJson(configPath: string): unknown | null {
	if (!existsSync(configPath)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (error) {
		console.error(`Failed to load config from ${configPath}:`, error);
		console.error("Using default configuration");
		return null;
	}
}

/**
 * Load configuration from file, merging with defaults (async version).
 *
 * @param configPath - Config file to read. Defaults to {@link CONFIG_PATH}.
 * @returns The merged configuration object.
 * @throws Error when the file parses but carries wrong-typed fields.
 */
export async function loadConfig(configPath: string = CONFIG_PATH): Promise<GatewaySettings> {
	if (!existsSync(configPath)) {
		return { ...DEFAULT_CONFIG };
	}

	// Before the token is read, not only when the file is created: an upgraded
	// install still carries whatever mode the previous version wrote.
	ensureConfigPrivate(configPath);

	let json: unknown;
	try {
		json = JSON.parse(await Bun.file(configPath).text());
	} catch (error) {
		console.error(`Failed to load config from ${configPath}:`, error);
		console.error("Using default configuration");
		return { ...DEFAULT_CONFIG };
	}

	return normalizeConfig(json, configPath);
}

/**
 * Synchronous version of loadConfig for contexts where async is not available.
 *
 * @param configPath - Config file to read. Defaults to {@link CONFIG_PATH}.
 * @throws Error when the file parses but carries wrong-typed fields.
 */
export function loadConfigSync(configPath: string = CONFIG_PATH): GatewaySettings {
	// See loadConfig: the repair belongs on the load path, not only on creation.
	ensureConfigPrivate(configPath);
	const json = readConfigJson(configPath);
	if (json === null) {
		return { ...DEFAULT_CONFIG };
	}
	return normalizeConfig(json, configPath);
}

/**
 * Validate that a path is allowed according to the config.
 *
 * @param path - The path to validate.
 * @param config - The gateway configuration.
 * @returns true if the path is allowed, false otherwise.
 */
export function isPathAllowed(path: string, config: GatewaySettings): boolean {
	// Normalize the path
	const normalized = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

	// Check if path starts with any allowed path
	return config.allowedPaths.some((allowed) => {
		const normalizedAllowed = allowed.startsWith("~/") ? join(homedir(), allowed.slice(2)) : allowed;
		return normalized.startsWith(normalizedAllowed);
	});
}

/**
 * Get a token by name from the config.
 *
 * @param name - The token name (e.g., "default", "adler", "cli").
 * @param config - The gateway configuration.
 * @returns The token value, or undefined if not found.
 */
export function getToken(name: string, config: GatewaySettings): string | undefined {
	return config.tokens[name];
}

/**
 * Create a default config file if it doesn't exist.
 *
 * The generated file contains a bearer token that is equivalent to shell access
 * as the current user, so it is written `0600` inside a `0700` directory. Modes
 * are applied with an explicit `chmod` so a permissive `umask` cannot widen
 * them, and an already-existing directory is left exactly as the user has it.
 *
 * @param configPath - Where to write. Defaults to {@link CONFIG_PATH}; tests
 *                     pass a temp path so the real `~/.draht` is never touched.
 * @returns The path to the created config file, or null if it already exists.
 */
export async function createDefaultConfigFile(configPath: string = CONFIG_PATH): Promise<string | null> {
	if (existsSync(configPath)) {
		return null;
	}

	const configDir = dirname(configPath);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		chmodSync(configDir, 0o700);
	}

	const defaultConfigContent = {
		$schema: "https://draht.io/gateway.schema.json",
		port: 7878,
		host: "127.0.0.1",
		tokens: {
			default: `change-me-${crypto.randomUUID()}`,
		},
		allowedPaths: ["~/", "~/projects", "~/code"],
		maxSessions: 100,
		idleTimeout: 255,
		_comments: {
			port: "Port to listen on",
			host: "Host to bind to. Keep 127.0.0.1 (loopback). Any other value is a non-loopback bind that exposes remote code execution to token holders and requires the --allow-non-loopback flag; use `tailscale serve` for remote access instead.",
			tokens: "Named authentication tokens (use in Authorization: Bearer <token>)",
			allowedPaths: "Paths where session processes can be started",
			maxSessions: "Maximum number of concurrent sessions",
			idleTimeout: "Idle timeout for connections in seconds (max 255)",
		},
	};

	writeFileSync(configPath, JSON.stringify(defaultConfigContent, null, 2), { mode: 0o600 });
	chmodSync(configPath, 0o600);
	return configPath;
}
