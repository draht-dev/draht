/** The argv a phone-initiated session is started with (R36-SPAWN.5). */

import { isAbsolute } from "node:path";
import { SpawnRefusedError } from "./spawn-primitive.js";

/** Checked here, not imported: packages/gateway must not depend on @draht/coding-agent. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export interface SpawnArgvInput {
	sessionId: string;
	/** Canonical absolute root: the session's cwd AND its context boundary. */
	projectRoot: string;
	leadingArgs: readonly string[];
}

export function buildSpawnArgv(input: SpawnArgvInput): string[] {
	if (!SESSION_ID_PATTERN.test(input.sessionId)) {
		throw new SpawnRefusedError("refused", `session id is not id-shaped: ${JSON.stringify(input.sessionId)}`);
	}
	if (!isAbsolute(input.projectRoot)) {
		throw new SpawnRefusedError("refused", `project root is not absolute: ${JSON.stringify(input.projectRoot)}`);
	}
	return [
		...input.leadingArgs,
		"--session-id",
		input.sessionId,
		"--attachable",
		"--mode",
		"rpc", // without a TTY the mode falls through to print, and the socket appears and vanishes
		"--no-approve", // untrusted despite any standing trust.json grant or defaultProjectTrust
		"--context-root",
		input.projectRoot,
	];
}
