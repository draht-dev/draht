/**
 * SessionStatus — the status a session record reports.
 *
 * Only 'starting' is ever produced: a session is a record with no process, and
 * `destroy` deletes the record instead of marking it stopped. 'running' and
 * 'stopped' remain only as serialized values the Adler client reads.
 */
export type SessionStatus = "starting" | "running" | "stopped";

/**
 * Session — entity representing a session record held by the gateway.
 *
 * Identifiers are UUID v4 strings, guaranteed unique per process.
 *
 * A Session is a record and never owns an OS process.
 */
export interface Session {
	/** UUID v4 identifier, unique for the lifetime of the gateway process. */
	id: string;
	/** Always 'starting' for a record this daemon creates; see {@link SessionStatus}. */
	status: SessionStatus;
	/** Wall-clock time at which the session was created. */
	createdAt: Date;
}

/**
 * Session companion object — factory for creating new Session entities.
 *
 * Separated from the interface so callers can import both the type and the
 * constructor under the same name, following the companion object pattern.
 */
export const Session = {
	/**
	 * Create a new Session with a unique UUID v4 id and status 'starting'.
	 *
	 * @returns A new Session entity.
	 */
	create(): Session {
		return {
			id: crypto.randomUUID(),
			status: "starting",
			createdAt: new Date(),
		};
	},
};
