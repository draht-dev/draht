import { Hono } from "hono";
import { type GatewaySettings, isPathAllowed } from "../../config/config.js";
import type { Session } from "../../session/session.js";
import type { SessionManager } from "../../session/session-manager.js";
import { SessionProcess } from "../../session/session-process.js";
import { notifyWebSocketsProcessAttached } from "./ws.js";

/**
 * Serialized session shape returned by all session endpoints.
 * `createdAt` is emitted as an ISO 8601 string for JSON wire transport.
 */
interface SerializedSession {
	id: string;
	status: Session["status"];
	createdAt: string;
}

/**
 * Expected JSON body for POST /sessions.
 *
 * `command` — optional array of command + arguments to spawn as the session
 *             process (e.g. `["draht", "start", "--prompt", "..."]`).
 *             When omitted the session is created in 'starting' status with no
 *             backing process (useful for testing / placeholder sessions).
 * `cwd`     — optional working directory path for the session process.
 *             If omitted, defaults to the gateway's current working directory.
 */
interface CreateSessionBody {
	command?: string[];
	cwd?: string;
}

/**
 * Expected JSON body for POST /sessions/:id/input.
 *
 * `text` — The input text to send to the session's stdin.
 */
interface SendInputBody {
	text: string;
}

/**
 * Validate that a value is a non-empty array of non-empty strings.
 * Returns a descriptive error message, or null if the value is acceptable.
 */
function validateCommand(command: unknown): string | null {
	if (!Array.isArray(command)) return "command must be an array";
	if (command.length === 0) return "command must be a non-empty array";
	for (let i = 0; i < command.length; i++) {
		if (typeof command[i] !== "string" || (command[i] as string).length === 0) {
			return `command[${i}] must be a non-empty string`;
		}
	}
	return null;
}

/**
 * Pure serializer — converts a Session entity to its wire representation.
 * Extracted so it is reused identically across all route handlers.
 */
function serializeSession(session: Session): SerializedSession {
	return {
		id: session.id,
		status: session.status,
		createdAt: session.createdAt.toISOString(),
	};
}

/**
 * createSessionRoutes — factory that builds a Hono sub-app for session CRUD.
 *
 * Designed for injection: the caller supplies the SessionManager instance,
 * keeping this module free of global state and straightforward to test.
 *
 * Mount with: `app.route('/sessions', createSessionRoutes(manager, config))`
 *
 * Routes:
 *   POST   /          → Create a session; optional JSON body `{ command?: string[], cwd?: string }`;
 *                       returns 201 + serialized session
 *   GET    /          → List all sessions; returns 200 + { sessions: [...] }
 *   GET    /:id       → Get one session; 200 or 404
 *   DELETE /:id       → Destroy a session; 204 or 404
 *   POST   /:id/input → Send input to a session; requires JSON body `{ text: string }`;
 *                       returns 204 or 404
 */
export function createSessionRoutes(manager: SessionManager, config?: GatewaySettings): Hono {
	const app = new Hono();

	// POST / — spawn a new session and return its metadata.
	// Accepts an optional JSON body: { command?: string[] }
	// When `command` is present it is validated and passed to the session manager
	// to spawn a real subprocess. When absent, a no-process session is created.
	app.post("/", async (c): Promise<Response> => {
		console.log(`[SESSION CREATE] Received session creation request`);

		let command: string[] | undefined;
		let cwd: string | undefined;

		const contentType = c.req.header("Content-Type") ?? "";
		console.log(`[SESSION CREATE] Content-Type: ${contentType}`);

		if (contentType.includes("application/json")) {
			// Check if body is actually present (Content-Length > 0 or body not empty)
			const rawBody = await c.req.text();
			if (rawBody.trim().length > 0) {
				let body: unknown;
				try {
					body = JSON.parse(rawBody);
				} catch {
					return c.json({ error: "Invalid JSON body" }, 400);
				}

				if (body !== null && typeof body === "object") {
					const bodyObj = body as CreateSessionBody;

					if ("command" in bodyObj) {
						const err = validateCommand(bodyObj.command);
						if (err !== null) {
							return c.json({ error: err }, 400);
						}
						command = bodyObj.command;
					}

					if ("cwd" in bodyObj) {
						if (typeof bodyObj.cwd !== "string" || bodyObj.cwd.length === 0) {
							return c.json({ error: "cwd must be a non-empty string" }, 400);
						}
						cwd = bodyObj.cwd;

						// Validate path against allowed paths
						if (config && !isPathAllowed(cwd, config)) {
							return c.json(
								{
									error: "cwd path not allowed",
									allowedPaths: config.allowedPaths,
								},
								403,
							);
						}
					}
				}
			}
			// Empty body with Content-Type: application/json is OK, creates no-process session
		}

		const session = manager.create(command, cwd);
		console.log(
			`[SESSION CREATE] Created session ${session.id}, status: ${session.status}, hasProcess: ${!!session.process}`,
		);
		return c.json(serializeSession(session), 201);
	});

	// GET / — list all active sessions
	app.get("/", (c): Response => {
		const sessions = manager.list().map(serializeSession);
		return c.json({ sessions });
	});

	// GET /:id — retrieve a single session by id
	app.get("/:id", (c): Response => {
		const session = manager.get(c.req.param("id"));
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}
		return c.json(serializeSession(session));
	});

	// DELETE /:id — destroy a session; 204 on success, 404 if absent
	app.delete("/:id", (c): Response => {
		const destroyed = manager.destroy(c.req.param("id"));
		if (!destroyed) {
			return c.json({ error: "Session not found" }, 404);
		}
		return new Response(null, { status: 204 });
	});

	// POST /:id/input — send input to a session's stdin
	app.post("/:id/input", async (c): Promise<Response> => {
		const sessionId = c.req.param("id");
		console.log(`[INPUT] Received input request for session ${sessionId}`);

		const session = manager.get(sessionId);

		if (!session) {
			console.log(`[INPUT] Session ${sessionId} not found`);
			return c.json({ error: "Session not found" }, 404);
		}

		let body: unknown;
		try {
			body = await c.req.json();
		} catch (err) {
			console.log(`[INPUT] Invalid JSON body:`, err);
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (!body || typeof body !== "object" || !("text" in body)) {
			console.log(`[INPUT] Missing text field in body:`, body);
			return c.json({ error: "Missing 'text' field in request body" }, 400);
		}

		const { text } = body as SendInputBody;
		if (typeof text !== "string") {
			console.log(`[INPUT] text is not a string:`, typeof text);
			return c.json({ error: "'text' must be a string" }, 400);
		}

		console.log(`[INPUT] Received text for session ${sessionId}:`, text.slice(0, 50));

		// Lazy spawn: if session has no process, spawn draht automatically on first input
		if (!session.process) {
			console.log(`[INPUT] Session has no process, spawning draht...`);

			// Spawn draht with default command
			const command = ["draht", "start"];
			const proc = new SessionProcess(command);
			session.process = proc;

			// Wire up status transitions
			proc.ready
				.then(() => {
					console.log(`[INPUT] Process ready for session ${sessionId}`);
					session.status = "running";
				})
				.catch((err) => {
					console.error(`[INPUT] Process failed to start:`, err);
				});

			proc.exited
				.then(() => {
					console.log(`[INPUT] Process exited for session ${sessionId}`);
					session.status = "stopped";
				})
				.catch(() => {
					session.status = "stopped";
				});

			// Wait for process to be ready before writing input
			try {
				console.log(`[INPUT] Waiting for process to be ready...`);
				await proc.ready;
				console.log(`[INPUT] Process is ready!`);

				// Notify any connected WebSockets about the new process
				console.log(`[INPUT] Notifying WebSockets about new process...`);
				notifyWebSocketsProcessAttached(sessionId, session);
			} catch (err) {
				console.error(`[INPUT] Failed to spawn process:`, err);
				return c.json({ error: "Failed to spawn process" }, 500);
			}
		}

		console.log(`[INPUT] Writing to process stdin...`);
		session.process.write(text);
		console.log(`[INPUT] Input written successfully`);

		// Return 200 (Adler expects 200, not 204)
		return c.json({ success: true }, 200);
	});

	return app;
}
