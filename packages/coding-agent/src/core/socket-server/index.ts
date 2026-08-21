/**
 * Socket Server - Attachable session infrastructure
 *
 * Enables tmux-style multi-client attachment to draht sessions.
 */

export { discoverSocketSessions, isProcessRunning } from "./discovery.js";
export type { AttachableSession, AttachableSessionOptions } from "./session-integration.js";
export { makeSessionAttachable, registerAttachableSessionCleanup } from "./session-integration.js";
export { SocketClient } from "./socket-client.js";
export type { SocketServerOptions } from "./socket-server.js";
export { SocketServer, SocketSessionBusyError } from "./socket-server.js";
export * from "./types.js";
