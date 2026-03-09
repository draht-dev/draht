import { SessionProcess } from "./session-process.js";

/**
 * SessionStatus — value object representing the lifecycle state of a session.
 *
 * Valid states:
 * - 'starting' : session is being initialised; process is spawning
 * - 'running'  : session is active and ready
 * - 'stopped'  : session has been terminated or process has exited
 */
export type SessionStatus = "starting" | "running" | "stopped";

/**
 * Session — entity representing a managed draht coding agent instance.
 *
 * Identifiers are UUID v4 strings, guaranteed unique per process.
 * The `status` field is mutable and transitions through the lifecycle as
 * the underlying SessionProcess progresses.
 *
 * When a `command` is provided to `Session.create()`, a real OS process is
 * spawned and attached as `session.process`. Status transitions are wired
 * automatically: starting → running → stopped.
 *
 * When no `command` is provided, `process` is undefined and status starts
 * as 'starting' (suitable for metadata-only sessions).
 */
export interface Session {
	/** UUID v4 identifier, unique for the lifetime of the gateway process. */
	id: string;
	/** Current lifecycle state of the session (mutable). */
	status: SessionStatus;
	/** Wall-clock time at which the session was created. */
	createdAt: Date;
	/**
	 * The underlying OS process for this session, if one was spawned.
	 * Undefined when no command was provided to Session.create().
	 */
	process?: SessionProcess;
}

/**
 * Session companion object — factory for creating new Session entities.
 *
 * Separated from the interface so callers can import both the type and the
 * constructor under the same name, following the companion object pattern.
 */
export const Session = {
	/**
	 * Create a new Session with a unique UUID v4 id.
	 *
	 * When `command` is provided, a SessionProcess is spawned and status
	 * transitions are wired automatically:
	 *   - 'starting' (synchronous, immediately after create)
	 *   - 'running'  (after proc.ready resolves)
	 *   - 'stopped'  (after proc.exited resolves)
	 *
	 * When no command is provided, `session.process` is undefined and
	 * status remains 'starting'.
	 *
	 * @param command - Optional command + arguments array to spawn.
	 * @param cwd - Optional working directory for the process.
	 * @returns A new Session entity.
	 */
	create(command?: string[], cwd?: string): Session {
		const session: Session = {
			id: crypto.randomUUID(),
			status: "starting",
			createdAt: new Date(),
		};

		if (command !== undefined) {
			const proc = new SessionProcess(command, cwd);
			session.process = proc;

			// Transition to 'running' once the process confirms it is alive.
			// The .catch() prevents an unhandled rejection if proc.ready rejects
			// (e.g. the binary was not found); status will be updated via exited.
			proc.ready
				.then(() => {
					session.status = "running";
				})
				.catch(() => {
					// Process failed to start — status will be corrected by exited below.
				});

			// Transition to 'stopped' on exit regardless of cause.
			// The .catch() covers the rare case where Bun's exited promise rejects.
			proc.exited
				.then(() => {
					session.status = "stopped";
				})
				.catch(() => {
					session.status = "stopped";
				});
		}

		return session;
	},
};
