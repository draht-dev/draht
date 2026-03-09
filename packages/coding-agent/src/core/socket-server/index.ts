/**
 * Socket Server - Attachable session infrastructure
 *
 * Enables tmux-style multi-client attachment to draht sessions.
 */

export { discoverSocketSessions } from "./discovery.js";
export type { AttachableSessionOptions } from "./session-integration.js";
export { makeSessionAttachable } from "./session-integration.js";
export { SocketClient } from "./socket-client.js";
export type { SocketServerOptions } from "./socket-server.js";
export { SocketServer } from "./socket-server.js";
export * from "./types.js";
