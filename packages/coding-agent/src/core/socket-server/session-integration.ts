/**
 * Integration layer between AgentSession and SocketServer
 *
 * Wires up socket server to broadcast agent output and forward client input.
 */

import path from "node:path";
import { getAgentDir } from "../../config.js";
import type { AgentSession } from "../agent-session.js";
import { SocketServer } from "./socket-server.js";

export interface AttachableSessionOptions {
	session: AgentSession;
	enabled: boolean;
}

/**
 * Wrap an agent session with a socket server if attachable mode is enabled.
 *
 * Returns cleanup function to stop the socket server.
 */
export async function makeSessionAttachable(options: AttachableSessionOptions): Promise<() => Promise<void>> {
	if (!options.enabled) {
		return async () => {}; // No-op cleanup
	}

	const session = options.session;
	const agentDir = getAgentDir();
	const socketDir = path.join(agentDir, "sockets");

	// Get session ID from the session manager header
	const header = session.sessionManager.getHeader();
	if (!header) {
		throw new Error("Cannot make session attachable: no session header found");
	}
	const sessionId = header.id;

	const socketServer = new SocketServer({
		sessionId,
		socketDir,
		cwd: process.cwd(),
		maxClients: 10,
		broadcastInputEcho: true,
	});

	// Start socket server
	await socketServer.start();

	// Subscribe to session events to broadcast output
	session.subscribe((event) => {
		// Broadcast different event types
		if (event.type === "message_update") {
			// Handle streaming updates (text and thinking deltas)
			const assistantEvent = event.assistantMessageEvent;
			if (assistantEvent.type === "text_delta") {
				socketServer.broadcastOutput(assistantEvent.delta, "stdout");
			} else if (assistantEvent.type === "thinking_delta") {
				socketServer.broadcastOutput(`[Thinking] ${assistantEvent.delta}\n`, "stdout");
			}
		} else if (event.type === "tool_execution_start") {
			socketServer.broadcastOutput(`\n[Tool: ${event.toolName}]\n`, "stdout");
		} else if (event.type === "tool_execution_end") {
			// Broadcast tool result
			const result = event.result;
			if (result?.content) {
				for (const content of result.content) {
					if (content.type === "text") {
						socketServer.broadcastOutput(`${content.text}\n`, "stdout");
					}
				}
			}
		}
	});

	// Forward input from socket clients to session
	socketServer.onInput((data: string, _clientId: string) => {
		// Send message to session
		void session.prompt(data);
	});

	console.log(`\n🔗 Attachable session started: ${sessionId}`);
	console.log(`   Socket: ${socketServer.socketPath}`);
	console.log(`   Attach: draht --attach ${sessionId}\n`);

	// Return cleanup function
	return async () => {
		await socketServer.stop();
	};
}
