import { existsSync } from "node:fs";
import { join } from "node:path";
import { whichOnPath } from "./host.ts";
import { resolveHome } from "./paths.ts";

/** One executable the engine cares about, resolved against the caller's PATH. */
export interface HostDetection {
	name: string;
	present: boolean;
	path: string | null;
}

/** A pre-installer artifact on this machine that changes how Draht behaves and should be reported, not silently handled. */
export interface LegacyFinding {
	id: "legacy-curl-clone" | "wrapper-shadowing" | "legacy-pi-state";
	path: string;
	message: string;
}

export interface DetectionResult {
	home: string;
	hosts: Record<string, HostDetection>;
	legacy: LegacyFinding[];
}

/** Executables detection resolves: the two plugin hosts plus the runtime/package manager doctor reports on. */
const DETECTED_EXECUTABLES = ["claude", "codex", "node", "npm"] as const;

/**
 * Detects host CLIs and legacy on-disk layouts.
 *
 * Everything is derived from the `env` passed in — no `process.env` read, no
 * `which` subprocess — so a test can present an exact PATH and HOME and get a
 * deterministic answer.
 */
export function detect(env: NodeJS.ProcessEnv): DetectionResult {
	const home = resolveHome(env);
	const hosts: Record<string, HostDetection> = {};
	for (const name of DETECTED_EXECUTABLES) {
		const path = whichOnPath(name, env);
		hosts[name] = { name, present: path !== null, path };
	}

	const legacy: LegacyFinding[] = [];

	const curlClone = join(home, ".draht", ".git");
	if (existsSync(curlClone)) {
		legacy.push({
			id: "legacy-curl-clone",
			path: curlClone,
			message: `~/.draht is a git clone from the legacy install.sh bootstrap (${curlClone}); the installer manages ~/.draht/install separately and will not touch the clone`,
		});
	}

	const wrapper = join(home, ".local", "bin", "draht");
	if (existsSync(wrapper)) {
		legacy.push({
			id: "wrapper-shadowing",
			path: wrapper,
			message: `a legacy draht wrapper exists at ${wrapper} and shadows the packaged draht bin whenever ~/.local/bin precedes the package manager's bin directory on PATH`,
		});
	}

	const piState = join(home, ".pi");
	if (existsSync(piState)) {
		legacy.push({
			id: "legacy-pi-state",
			path: piState,
			message: `legacy Pi Agent state exists at ${piState}; it is not read or migrated by this installer`,
		});
	}

	return { home, hosts, legacy };
}

/** Convenience predicate for `resolveSelection`. */
export function hostPresenceFrom(detection: DetectionResult): (host: string) => boolean {
	return (host) => detection.hosts[host]?.present === true;
}
