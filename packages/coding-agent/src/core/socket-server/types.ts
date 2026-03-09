/**
 * Socket Server Protocol Types
 *
 * JSON-based protocol for multi-client session attachment.
 * Inspired by tmux's multi-attach model.
 */

/** Client connection mode */
export type ClientMode = "read-write" | "read-only";

/** Message types: Client → Server */
export type ClientMessage = AttachMessage | InputMessage | DetachMessage;

/** Message types: Server → Client */
export type ServerMessage =
	| OutputMessage
	| InputEchoMessage
	| ClientJoinedMessage
	| ClientLeftMessage
	| SessionMetadataMessage
	| ErrorMessage;

/** Client requests to attach */
export interface AttachMessage {
	type: "attach";
	clientId: string;
	mode: ClientMode;
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

/** Connected client state */
export interface ConnectedClient {
	id: string;
	mode: ClientMode;
	socket: import("net").Socket;
	connectedAt: Date;
}

/** Socket session discovery result */
export interface SocketSessionInfo {
	sessionId: string;
	socketPath: string;
	pid: number;
	createdAt: Date;
	cwd: string;
}
