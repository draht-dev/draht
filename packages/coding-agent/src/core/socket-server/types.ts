/**
 * Socket Server Protocol Types
 *
 * JSON-based protocol for multi-client session attachment.
 * Inspired by tmux's multi-attach model.
 */

/** Client connection mode */
export type ClientMode = "read-write" | "read-only";

/**
 * The capability a client declares in its `attach` frame to say it understands
 * permission frames (R34-PERM.1).
 *
 * This is the whole skew story. `permission_request` / `permission_resolved` are
 * sent ONLY to clients that named this, so a bridge built before geist/0.3 —
 * whose attach line carries no `capabilities` at all — never receives a frame it
 * cannot decode, and is therefore never dropped with a `protocol_error
 * unknown_type` and close 1008. Emission is opt-in, not opt-out.
 */
export const PERMISSION_RELAY_CAPABILITY = "permission-relay";

/** Every `ClientMode` there is, as a runtime value. `attach` is validated against it. */
export const CLIENT_MODES: readonly ClientMode[] = ["read-write", "read-only"];

/** Message types: Client → Server */
export type ClientMessage = AttachMessage | InputMessage | DetachMessage | PermissionResponseMessage;

/** Message types: Server → Client */
export type ServerMessage =
	| OutputMessage
	| InputEchoMessage
	| ClientJoinedMessage
	| ClientLeftMessage
	| SessionMetadataMessage
	| ErrorMessage
	| PermissionRequestMessage
	| PermissionResolvedMessage;

/** Client requests to attach */
export interface AttachMessage {
	type: "attach";
	clientId: string;
	mode: ClientMode;
	/**
	 * What this client understands beyond the frames every client has always
	 * received. Absent means "an older client": it is sent nothing new.
	 * See {@link PERMISSION_RELAY_CAPABILITY}.
	 */
	capabilities?: string[];
}

/** Client sends input to session */
export interface InputMessage {
	type: "input";
	data: string;
	clientId: string;
}

/** Client detaches gracefully */
export interface DetachMessage {
	type: "detach";
	clientId: string;
}

/** Server broadcasts output */
export interface OutputMessage {
	type: "output";
	data: string;
	stream: "stdout" | "stderr";
}

/** Server echoes input from one client to all others */
export interface InputEchoMessage {
	type: "input_echo";
	data: string;
	clientId: string; // Who typed it
}

/** Server notifies clients when another client joins */
export interface ClientJoinedMessage {
	type: "client_joined";
	clientId: string;
	mode: ClientMode;
}

/** Server notifies clients when another client leaves */
export interface ClientLeftMessage {
	type: "client_left";
	clientId: string;
}

/** Server sends session metadata on attach */
export interface SessionMetadataMessage {
	type: "session_metadata";
	sessionId: string;
	cwd: string;
	createdAt: string;
}

/** Server reports an error */
export interface ErrorMessage {
	type: "error";
	message: string;
	code?: string;
}

/**
 * One answer a permission ask offers.
 *
 * `id` is opaque and is the only thing an answer may name — a client never
 * sends a decision, it names one of the options it was actually offered, so the
 * offered set stays the single source of truth about what may happen.
 */
export interface PermissionOption {
	id: string;
	label: string;
}

/**
 * Client answers a permission ask (R34-PERM.1).
 *
 * `optionId` must be one of the ids the matching `permission_request` carried;
 * validating that against the immutable offered set is the session's job, not
 * the transport's.
 */
export interface PermissionResponseMessage {
	type: "permission_response";
	clientId: string;
	requestId: string;
	optionId: string;
}

/**
 * Server asks an attached client to decide a permission (R34-PERM.1).
 *
 * Every free-text field here is attacker-influenced — the model chose the
 * command, the path and the tool name — so all of it is neutralized and bounded
 * where this frame is CONSTRUCTED (`safe-text.ts`), never where it is rendered.
 * `truncated` says whether any of it had to be elided, so a surface can show
 * that a decision is being made on an abbreviated string.
 *
 * `deadline` is ADVISORY RENDERING DATA only: it lets a surface draw a countdown.
 * Real expiry binds solely to the session's own fail-closed timer — one clock —
 * and a client that ignores this field changes no outcome.
 */
export interface PermissionRequestMessage {
	type: "permission_request";
	requestId: string;
	method: "confirm" | "select" | "input";
	toolCallId: string;
	toolName: string;
	cwd: string;
	title: string;
	message: string;
	command?: string;
	path?: string;
	operation?: string;
	truncated: boolean;
	options: PermissionOption[];
	requestedAt: string;
	deadline: string | null;
}

/**
 * Server tells every capable client how a permission ask ended (R34-PERM.1).
 *
 * Broadcast after the ask is settled, so a surface that lost the race takes its
 * prompt down and says who decided instead of leaving a dead dialog up.
 * `chosenOptionId` and `clientId` are null for outcomes no client chose —
 * `cancelled` and `expired`.
 *
 * `answered` is the NEUTRAL member (geist/0.4). A `select` or an `input` grants
 * nothing and refuses nothing: no option of theirs declares a `decision`, so
 * neither `approved` nor `denied` is a true thing to say about one, and the two
 * words this wire used before it existed were each false in one direction —
 * `cancelled` about an ask that was answered and whose tool call RAN, `approved`
 * about a grant nobody made. It GRANTS NOTHING and every consumer must read it
 * fail-closed; the choice that was actually made travels as `chosenOptionId`.
 *
 * MIRRORED: `PermissionResolvedFrameSchema.decision` in
 * `packages/geist-protocol/src/wire.ts` is this union field for field, and
 * `MIRRORED_FRAMES` in `scripts/check-geist-protocol.mjs` fails the build if the
 * two sets ever differ — including by one member.
 */
export interface PermissionResolvedMessage {
	type: "permission_resolved";
	requestId: string;
	decision: "approved" | "denied" | "cancelled" | "expired" | "answered";
	chosenOptionId: string | null;
	surface: string;
	clientId: string | null;
}

/** Connected client state */
export interface ConnectedClient {
	id: string;
	mode: ClientMode;
	socket: import("net").Socket;
	connectedAt: Date;
	/** Exactly what this client declared on attach. Empty for a client that declared nothing. */
	capabilities: string[];
}

/** Socket session discovery result */
export interface SocketSessionInfo {
	sessionId: string;
	socketPath: string;
	pid: number;
	createdAt: Date;
	cwd: string;
}
