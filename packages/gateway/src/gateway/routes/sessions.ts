import { Hono } from "hono";
import type { Session } from "../../session/session.js";
import type { SessionManager } from "../../session/session-manager.js";

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
 */
interface CreateSessionBody {
	command?: string[];
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
 * Mount with: `app.route('/sessions', createSessionRoutes(manager))`
 *
 * Routes:
 *   POST   /          → Create a session; optional JSON body `{ command?: string[] }`;
 *                       returns 201 + serialized session
 *   GET    /          → List all sessions; returns 200 + { sessions: [...] }
 *   GET    /:id       → Get one session; 200 or 404
 *   DELETE /:id       → Destroy a session; 204 or 404
 */
export function createSessionRoutes(manager: SessionManager): Hono {
	const app = new Hono();

	// POST / — spawn a new session and return its metadata.
	// Accepts an optional JSON body: { command?: string[] }
	// When `command` is present it is validated and passed to the session manager
	// to spawn a real subprocess. When absent, a no-process session is created.
	app.post("/", async (c): Promise<Response> => {
		let command: string[] | undefined;

		const contentType = c.req.header("Content-Type") ?? "";
		if (contentType.includes("application/json")) {
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: "Invalid JSON body" }, 400);
			}

			if (body !== null && typeof body === "object" && "command" in (body as object)) {
				const err = validateCommand((body as CreateSessionBody).command);
				if (err !== null) {
					return c.json({ error: err }, 400);
				}
				command = (body as CreateSessionBody).command;
			}
		}

		const session = manager.create(command);
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

	return app;
}
