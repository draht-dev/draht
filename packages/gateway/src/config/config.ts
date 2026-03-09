import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

	/** Host to bind to (default: "0.0.0.0" for Tailscale access) */
	host: string;

	/** Authentication tokens (map of token name to token value) */
	tokens: Record<string, string>;

	/** Allowed working directory paths for session creation */
	allowedPaths: string[];

	/** Maximum number of concurrent sessions (default: 100) */
	maxSessions: number;

	/** Idle timeout for connections in seconds (max 255) */
	idleTimeout: number;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: GatewaySettings = {
	port: 7878,
	host: "0.0.0.0",
	tokens: {},
	allowedPaths: [homedir()], // Allow user home directory by default
	maxSessions: 100,
	idleTimeout: 255,
};

/**
 * Path to the gateway config file.
 */
export const CONFIG_PATH = join(homedir(), ".draht", "gateway.config.json");

/**
 * Load configuration from file, merging with defaults (async version).
 *
 * @returns The merged configuration object.
 */
export async function loadConfig(): Promise<GatewaySettings> {
	if (!existsSync(CONFIG_PATH)) {
		return { ...DEFAULT_CONFIG };
	}

	try {
		const file = Bun.file(CONFIG_PATH);
		const json = JSON.parse(await file.text());

		return {
			port: json.port ?? DEFAULT_CONFIG.port,
			host: json.host ?? DEFAULT_CONFIG.host,
			tokens: json.tokens ?? DEFAULT_CONFIG.tokens,
			allowedPaths: json.allowedPaths ?? DEFAULT_CONFIG.allowedPaths,
			maxSessions: json.maxSessions ?? DEFAULT_CONFIG.maxSessions,
			idleTimeout: Math.min(json.idleTimeout ?? DEFAULT_CONFIG.idleTimeout, 255),
		};
	} catch (error) {
		console.error(`Failed to load config from ${CONFIG_PATH}:`, error);
		console.error("Using default configuration");
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * Synchronous version of loadConfig for contexts where async is not available.
 */
export function loadConfigSync(): GatewaySettings {
	if (!existsSync(CONFIG_PATH)) {
		return { ...DEFAULT_CONFIG };
	}

	try {
		const content = require("fs").readFileSync(CONFIG_PATH, "utf-8");
		const json = JSON.parse(content);

		return {
			port: json.port ?? DEFAULT_CONFIG.port,
			host: json.host ?? DEFAULT_CONFIG.host,
			tokens: json.tokens ?? DEFAULT_CONFIG.tokens,
			allowedPaths: json.allowedPaths ?? DEFAULT_CONFIG.allowedPaths,
			maxSessions: json.maxSessions ?? DEFAULT_CONFIG.maxSessions,
			idleTimeout: Math.min(json.idleTimeout ?? DEFAULT_CONFIG.idleTimeout, 255),
		};
	} catch (error) {
		console.error(`Failed to load config from ${CONFIG_PATH}:`, error);
		console.error("Using default configuration");
		return { ...DEFAULT_CONFIG };
	}
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
 * @returns The path to the created config file, or null if it already exists.
 */
export async function createDefaultConfigFile(): Promise<string | null> {
	if (existsSync(CONFIG_PATH)) {
		return null;
	}

	// Ensure directory exists
	const configDir = join(homedir(), ".draht");
	if (!existsSync(configDir)) {
		await Bun.write(configDir, ""); // Create directory
		require("fs").mkdirSync(configDir, { recursive: true });
	}

	const defaultConfigContent = {
		$schema: "https://draht.io/gateway.schema.json",
		port: 7878,
		host: "0.0.0.0",
		tokens: {
			default: `change-me-${crypto.randomUUID()}`,
		},
		allowedPaths: ["~/", "~/projects", "~/code"],
		maxSessions: 100,
		idleTimeout: 255,
		_comments: {
			port: "Port to listen on",
			host: "Host to bind to (0.0.0.0 for all interfaces, 127.0.0.1 for localhost only)",
			tokens: "Named authentication tokens (use in Authorization: Bearer <token>)",
			allowedPaths: "Paths where session processes can be started",
			maxSessions: "Maximum number of concurrent sessions",
			idleTimeout: "Idle timeout for connections in seconds (max 255)",
		},
	};

	await Bun.write(CONFIG_PATH, JSON.stringify(defaultConfigContent, null, 2));
	return CONFIG_PATH;
}
