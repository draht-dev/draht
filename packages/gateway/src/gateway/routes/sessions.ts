import { Hono } from "hono";
import { type GatewaySettings, isPathAllowed } from "../../config/config.js";
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
 * `cwd` — optional working directory path for the session, validated against
 *         the configured `allowedPaths`.
 *
 * There is deliberately no `command` field. This route used to accept a
 * caller-supplied `command: string[]` and hand it to `Bun.spawn` (R32-FLEET.8,
 * GSEC-12): with only a shape check in front of it, any bearer-token holder
 * could run any binary as the gateway's user. The field is gone rather than
 * narrowed — the harness-id + project selection that replaces it is resolved
 * against the registry in a later phase, and until that exists no request body
 * may influence what gets executed.
 */
interface CreateSessionBody {
	cwd?: string;
}

/**
 * Operator/caller-facing refusal for a request that still carries `command`.
 *
 * Refused rather than ignored: a caller asking for arbitrary execution must be
 * told no. Silently creating a process-less session would leave an integration
 * believing it had launched something.
 */
const COMMAND_REJECTED =
	"command is not accepted: POST /sessions does not spawn caller-supplied commands. " +
	"Create the session without a command; what runs is chosen by the gateway, never by the request body.";

/**
 * Refusal for input addressed to a session record that has no process.
 *
 * ## The lazy spawn that used to live here, and why it is gone rather than hardened
 *
 * `POST /sessions/:id/input` used to notice `!session.process` and quietly run
 * `new SessionProcess(["draht", "start"])`: a bare PATH lookup, with the
 * daemon's whole environment, no cwd, no deadline and no teardown, reachable by
 * any bearer-token holder. It was the front door this file's own header says was
 * closed — `command` was removed from `POST /sessions` under R32-FLEET.8 /
 * GSEC-12 for exactly this reason — reopened at the side.
 *
 * R35-ALWAYS.9 builds ONE hardened spawn primitive
 * (`session/spawn-primitive.ts`) and R36-SPAWN.1 requires that it be the only
 * spawn path. That left two options for this call site, and the choice is
 * recorded here because it is a decision and not an oversight:
 *
 *  - **Route it through the primitive.** Rejected. The primitive's security
 *    property is that it resolves an id against the daemon's OWN history index
 *    and constructs the argv itself. A gateway `Session` record has no draht
 *    session id, no recorded cwd and no history row — there is nothing for the
 *    primitive to resolve, so routing this through it would mean adding a "just
 *    start something" mode whose whole purpose is to bypass the resolution that
 *    makes the primitive safe.
 *  - **Delete it.** Taken. This route creates a session RECORD, never a process
 *    (R32-FLEET.8); a record with no process is a record nothing can be typed
 *    into, and saying so with a 409 is honest. A caller that wants a live draht
 *    session starts one, or resumes a recorded one over `session_resume`, which
 *    is the path that has an id space, a trust check, a deadline and a teardown.
 *
 * The consequence is deliberate: there is now NO route on this daemon that
 * creates a process from an HTTP request. The only spawn is
 * `session/spawn-primitive.ts`, reached only by `session_resume`.
 */
const NO_PROCESS =
	"this session has no process: POST /sessions creates a session record, never a process. " +
	"Nothing can be typed into it. Resume a recorded draht session over the attach wire instead.";

/**
 * Expected JSON body for POST /sessions/:id/input.
 *
 * `text` — The input text to send to the session's stdin.
 */
interface SendInputBody {
	text: string;
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
 *   POST   /          → Create a session; optional JSON body `{ cwd?: string }`;
 *                       returns 201 + serialized session. A body carrying
 *                       `command` is refused with 400 (R32-FLEET.8).
 *   GET    /          → List all sessions; returns 200 + { sessions: [...] }
 *   GET    /:id       → Get one session; 200 or 404
 *   DELETE /:id       → Destroy a session; 204 or 404
 *   POST   /:id/input → Send input to a session; requires JSON body `{ text: string }`;
 *                       returns 200, 404, or 409 when the session has no process.
 *
 * NO HANDLER IN THIS FILE STARTS A PROCESS. `POST /` never did; `POST /:id/input`
 * used to, lazily and through a bare PATH lookup, and no longer does — see
 * {@link NO_PROCESS} for what was there and why it was deleted rather than
 * hardened.
 */
export function createSessionRoutes(manager: SessionManager, config?: GatewaySettings): Hono {
	const app = new Hono();

	// POST / — register a new session and return its metadata.
	// Accepts an optional JSON body: { cwd?: string }. No process is spawned
	// here, and no field of the body can cause one to be: the caller-supplied
	// `command` path was removed in R32-FLEET.8 and a body still carrying
	// `command` is refused.
	app.post("/", async (c): Promise<Response> => {
		console.log(`[SESSION CREATE] Received session creation request`);

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
						return c.json({ error: COMMAND_REJECTED }, 400);
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

		// `undefined` command, unconditionally: this route creates a session
		// record, never a process (R32-FLEET.8).
		const session = manager.create(undefined, cwd);
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

		// NO LAZY SPAWN. See NO_PROCESS above.
		if (!session.process) {
			console.log(`[INPUT] Session ${sessionId} has no process; refusing rather than spawning`);
			return c.json({ error: NO_PROCESS }, 409);
		}

		console.log(`[INPUT] Writing to process stdin...`);
		session.process.write(text);
		console.log(`[INPUT] Input written successfully`);

		// Return 200 (Adler expects 200, not 204)
		return c.json({ success: true }, 200);
	});

	return app;
}
