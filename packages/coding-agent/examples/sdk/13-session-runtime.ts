/**
 * Session Runtime Host
 *
 * Use the runtime host when you need to replace the active AgentSession,
 * for example for new-session, resume, fork, or import flows.
 *
 * The important pattern is: after the host replaces the runtime, rebind any
 * session-local subscriptions and extension bindings to `runtimeHost.session`.
 */

import { AgentSessionRuntimeHost, createAgentSessionRuntime, SessionManager } from "@mariozechner/pi-coding-agent";

const bootstrap = {};
const runtime = await createAgentSessionRuntime(bootstrap, {
	cwd: process.cwd(),
	sessionManager: SessionManager.create(process.cwd()),
});
const runtimeHost = new AgentSessionRuntimeHost(bootstrap, runtime);

let unsubscribe: (() => void) | undefined;

async function bindSession() {
	unsubscribe?.();
	const session = runtimeHost.session;
	await session.bindExtensions({});
	unsubscribe = session.subscribe((event) => {
		if (event.type === "queue_update") {
			console.log("Queued:", event.steering.length + event.followUp.length);
		}
	});
	return session;
}

let session = await bindSession();
const originalSessionFile = session.sessionFile;
console.log("Initial session:", originalSessionFile);

await runtimeHost.newSession();
session = await bindSession();
console.log("After newSession():", session.sessionFile);

if (originalSessionFile) {
	await runtimeHost.switchSession(originalSessionFile);
	session = await bindSession();
	console.log("After switchSession():", session.sessionFile);
}

unsubscribe?.();
await runtimeHost.dispose();
