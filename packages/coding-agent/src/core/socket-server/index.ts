/**
 * Socket Server - Attachable session infrastructure
 *
 * Enables tmux-style multi-client attachment to draht sessions.
 */

export { discoverSocketSessions, isProcessRunning } from "./discovery.js";
export type { DeliverableAsk, PermissionDeliveryOptions } from "./permission-delivery.js";
export { PermissionDelivery } from "./permission-delivery.js";
export type {
	PermissionEntry,
	PermissionInsert,
	PermissionRegistryOptions,
	RegisteredOption,
	SettleResult,
	TerminalDecision,
} from "./permission-registry.js";
export {
	DEFAULT_PERMISSION_EXPIRY_MS,
	MAX_PERMISSION_EXPIRY_MS,
	MIN_PERMISSION_EXPIRY_MS,
	PERMISSION_EXPIRY_ENV,
	PermissionRegistry,
	resolvePermissionExpiryMs,
} from "./permission-registry.js";
export type {
	PermissionRecorder,
	PermissionSocketServer,
	SocketPermissionRelay,
	SocketPermissionRelayOptions,
} from "./permission-relay.js";
export { createSocketPermissionRelay } from "./permission-relay.js";
export type { AttachableSession, AttachableSessionOptions } from "./session-integration.js";
export { makeSessionAttachable, registerAttachableSessionCleanup } from "./session-integration.js";
export { SocketClient } from "./socket-client.js";
export type { SocketServerOptions } from "./socket-server.js";
export {
	DEFAULT_MAX_LIVE_SOCKETS,
	SocketCapReachedError,
	SocketDirectoryUnsafeError,
	SocketServer,
	SocketSessionBusyError,
} from "./socket-server.js";
export * from "./types.js";
