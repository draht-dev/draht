/**
 * Schema version stamped on every machine-readable document this CLI emits.
 * Consumers pin on it; it changes only when an existing field's meaning or
 * presence changes.
 */
export const JSON_SCHEMA_VERSION = 1;

export interface JsonErrorDocument {
	schemaVersion: number;
	ok: false;
	command: string;
	error: { code: string; message: string; detail?: Record<string, unknown> };
}

/** One schema-versioned success document. Read commands emit exactly one of these on stdout. */
export function jsonDocument<T extends Record<string, unknown>>(
	command: string,
	body: T,
): T & { schemaVersion: number; command: string } {
	return { schemaVersion: JSON_SCHEMA_VERSION, command, ...body };
}

/**
 * The schema-stable error shape. `code` is the machine-readable discriminator
 * (`usage`, `blocked`, `state-corrupt`, …); `message` is human prose that may
 * change between releases and must not be parsed.
 */
export function jsonError(
	command: string,
	code: string,
	message: string,
	detail?: Record<string, unknown>,
): JsonErrorDocument {
	const error: JsonErrorDocument["error"] = { code, message };
	if (detail !== undefined) error.detail = detail;
	return { schemaVersion: JSON_SCHEMA_VERSION, ok: false, command, error };
}

/** Serializes one document as a single stdout line-terminated JSON blob. */
export function renderJson(document: unknown): string {
	return `${JSON.stringify(document, null, 2)}\n`;
}

/** Serializes one NDJSON event record (mutating commands stream these). */
export function renderNdjson(record: unknown): string {
	return `${JSON.stringify(record)}\n`;
}
