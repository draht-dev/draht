/**
 * Child-process fixture for the attachable-session signal cleanup test.
 *
 * Starts an attachable session, prints its socket path, and then stays alive until a
 * signal arrives. `ATTACHABLE_FIXTURE_MODE=foreign-handler` additionally installs a
 * SIGTERM handler that ends in `process.exit()`, mirroring how interactive, print, and
 * rpc mode own that signal and never return from their run loop.
 */

import type { AgentSession } from "../../src/core/agent-session.ts";
import { makeSessionAttachable, registerAttachableSessionCleanup } from "../../src/core/socket-server/index.ts";

const sessionId = process.env.ATTACHABLE_FIXTURE_SESSION_ID ?? "fixture";

const session = {
	sessionManager: {
		getHeader: () => ({ id: sessionId }),
	},
	subscribe: () => () => {},
	prompt: async () => {},
} as unknown as AgentSession;

const handle = await makeSessionAttachable({
	session,
	enabled: true,
	cwd: process.cwd(),
	log: () => {},
});
registerAttachableSessionCleanup(handle);

if (process.env.ATTACHABLE_FIXTURE_MODE === "foreign-handler") {
	process.on("SIGTERM", () => {
		// Interactive mode runs async teardown and then calls process.exit().
		setTimeout(() => process.exit(0), 10);
	});
}

process.stdout.write(`READY ${handle.socketPath}\n`);

// Keep the event loop alive: the process must only die from the signal.
setInterval(() => {}, 2 ** 30);
