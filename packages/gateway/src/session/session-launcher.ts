/** Two registry ids from a phone become one running session, or a refusal the wire has a word for (R36-SPAWN.1). */

import { randomUUID } from "node:crypto";
import type { RegistryHarness, RegistryProject, SessionSpawnCode } from "@draht/geist-protocol";
import {
	type HarnessResolutionCode,
	HarnessResolutionError,
	type RegistryProvider,
	registryProjection,
	resolveHarnessLaunch,
} from "./harness-resolver.js";
import { type SessionSpawner, type SpawnRefusalCode, SpawnRefusedError } from "./spawn-primitive.js";

/** Structural: `@draht/geist-core` exports its bridge port types from no entry point this package can import. */
export interface SessionSpawnOutcome {
	code: SessionSpawnCode;
	sessionId?: string;
	message?: string;
}

export interface RegistrySnapshot {
	harnesses: readonly RegistryHarness[];
	projects: readonly RegistryProject[];
}

/** A spawner's launch half. `SessionSpawner`'s `#` fields make the class nominal, and a test needs a double. */
export type SessionLaunchPort = Pick<SessionSpawner, "launch">;

export interface SessionLauncherOptions {
	spawner: SessionLaunchPort;
	/** Asked on EVERY call. Not a value captured at construction. */
	registry: RegistryProvider;
	uid?: number;
	forbiddenRoots?: readonly string[];
	spawnableHarnessIds?: readonly string[];
	mintSessionId?: () => string;
}

/** No `RegistryIdSchema` id can contain it, so `a` + `b.c` and `a.b` + `c` cannot share one key. */
const PAIR_SEPARATOR = "\u0000";

/** EXACTLY ONE PER DAEMON: the in-flight guard is this object's own state, and a per-connection one bounds nothing. */
export class SessionLauncher {
	readonly #spawner: SessionLaunchPort;
	readonly #registry: RegistryProvider;
	readonly #uid: number | undefined;
	readonly #forbiddenRoots: readonly string[] | undefined;
	readonly #spawnableHarnessIds: readonly string[] | undefined;
	readonly #mint: () => string;
	readonly #inFlight = new Set<string>();

	constructor(options: SessionLauncherOptions) {
		this.#spawner = options.spawner;
		this.#registry = options.registry;
		this.#uid = options.uid;
		this.#forbiddenRoots = options.forbiddenRoots;
		this.#spawnableHarnessIds = options.spawnableHarnessIds;
		this.#mint = options.mintSessionId ?? randomUUID;
	}

	/** A `sessionId` comes back only with `spawned`: a renderer handed an id for nothing will try to attach to it. */
	async launch(harnessId: string, projectId: string): Promise<SessionSpawnOutcome> {
		const pair = `${projectId}${PAIR_SEPARATOR}${harnessId}`;
		// Claimed before the first `await` below, so two frames in one turn of the loop cannot both pass.
		if (this.#inFlight.has(pair)) {
			return {
				code: "refused",
				message:
					"a spawn for this project and harness is already in flight; wait for it to finish before asking again",
			};
		}
		this.#inFlight.add(pair);
		try {
			const resolved = resolveHarnessLaunch(harnessId, projectId, {
				registry: this.#registry,
				uid: this.#uid,
				forbiddenRoots: this.#forbiddenRoots,
				spawnableHarnessIds: this.#spawnableHarnessIds,
			});
			// Minted after the resolve, so a refused one burns no id.
			const sessionId = this.#mint();
			await this.#spawner.launch({
				sessionId,
				executable: resolved.executable,
				leadingArgs: resolved.leadingArgs,
				projectRoot: resolved.projectRoot,
				credentialEnv: resolved.credentialEnv,
			});
			return { code: "spawned", sessionId };
		} catch (error) {
			if (error instanceof HarnessResolutionError)
				return { code: resolutionCode(error.code), message: error.message };
			// Passed through, not sanitised again: the bridge runs it through `neutralized()`, and one owner per property.
			if (error instanceof SpawnRefusedError) return { code: refusalCode(error.code), message: error.message };
			throw error;
		} finally {
			// In `finally`, so a throw from any depth cannot leave a pair permanently unlaunchable.
			this.#inFlight.delete(pair);
		}
	}

	/** Throws when the registry cannot be read: the bridge's own snapshot already answers that with two empty arrays. */
	snapshot(): RegistrySnapshot {
		return registryProjection(this.#registry(), this.#spawnableHarnessIds);
	}
}

function resolutionCode(code: HarnessResolutionCode): SessionSpawnCode {
	switch (code) {
		case "unknown_harness":
			return "unknown_harness";
		case "unknown_project":
			return "unknown_project";
		case "refused":
			return "refused";
		default:
			return exhausted(code);
	}
}

function refusalCode(code: SpawnRefusalCode): SessionSpawnCode {
	switch (code) {
		case "refused":
			return "refused";
		case "spawn_failed":
			return "spawn_failed";
		case "timeout":
			return "timeout";
		// The root was canonicalised and stat'd microseconds ago; gone since is a refusal, and the wire has no word for it.
		case "cwd_missing":
			return "refused";
		// A minted uuid does not collide in practice, but the type says it is reachable, so it is mapped, not defaulted.
		case "already_live":
			return "refused";
		default:
			return exhausted(code);
	}
}

/** Adding a member to either union is a compile error here rather than a silent wrong code on the wire. */
function exhausted(code: never): never {
	throw new Error(`unmapped code: ${String(code)}`);
}
