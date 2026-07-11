import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * geist composition root (spec §6, §8): wires `@draht/geist-core` (harness-free
 * product logic) and `@draht/geist-acp` (the ACP client) into the bridge process
 * that `@draht/geist-console` talks to over WS. Phase 31 scope is config path
 * resolution only — the actual wiring lands with the ACP client in Phase 35 (M3).
 */

export interface ConfigPathOptions {
	/** Explicit path passed via `--config`, if any. */
	explicit?: string;
	/** Working directory the relative default is resolved against. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Home directory the fallback default is resolved against. Defaults to `os.homedir()`. */
	home?: string;
}

/**
 * Resolves the effective `geist.yaml` path per spec §6's precedence:
 * `--config` > `./geist.yaml` > `~/.geist/config.yaml`.
 *
 * Only resolves the path — reading and validating the file against the
 * config contract is `@draht/geist-protocol`'s job (spec §9.1).
 */
export function resolveConfigPath(options: ConfigPathOptions = {}): string {
	if (options.explicit) {
		return options.explicit;
	}

	const cwd = options.cwd ?? process.cwd();
	const localConfigPath = join(cwd, "geist.yaml");
	if (existsSync(localConfigPath)) {
		return localConfigPath;
	}

	const home = options.home ?? homedir();
	return join(home, ".geist", "config.yaml");
}

/**
 * Starts the geist bridge (composition root). Not implemented yet — the
 * `geist-core` ⇄ `geist-acp` ⇄ `geist-console` wiring lands in later phases,
 * starting with the ACP loop closing in Phase 35 (M3).
 */
export function runGeist(_configPath: string): Promise<void> {
	throw new Error("geist bridge not implemented yet — lands in later phases (starting Phase 35, M3)");
}
