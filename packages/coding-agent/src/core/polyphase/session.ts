/**
 * Session-scoped polyphase state, keyed off `ctx.sessionManager` so draht-acp sessions never
 * mix. Created on first use and disposed on `session_shutdown`.
 */

import type { PermissionMode } from "../multi-agent/index.ts";
import type { PolyphaseSettings } from "../settings-manager.ts";
import { AgentLimiter } from "./limiter.ts";
import { type ResolvedPolyphaseSettings, resolvePolyphaseSettings } from "./settings.ts";
import { PolyphaseStore } from "./store.ts";
import { createUpdatePump, type UpdatePump } from "./update-pump.ts";

const INSPECTOR_INTERVAL_CAP_MS = 100;

export interface PolyphaseSession {
	readonly store: PolyphaseStore;
	readonly limiter: AgentLimiter;
	settings(): ResolvedPolyphaseSettings;
	/** Re-resolves settings; updates the limiter's capacity and the pump's interval. */
	refreshSettings(raw: PolyphaseSettings | undefined): void;
	/** "default" until a provider is set. */
	permissionMode(): PermissionMode;
	setPermissionModeProvider(provider: () => PermissionMode): void;
	onParentPrompt(listener: () => void): () => void;
	/** The inspector closes so a parent dialog stays reachable. */
	notifyParentPrompt(): void;
	/** Pump interval: `min(100, liveUpdateMs)` while open. */
	setInspectorOpen(open: boolean): void;
	readonly disposed: boolean;
	dispose(reason: string): void;
}

class PolyphaseSessionImpl implements PolyphaseSession {
	readonly store: PolyphaseStore;
	readonly limiter: AgentLimiter;

	private readonly pump: UpdatePump;
	private resolved: ResolvedPolyphaseSettings;
	private permissionModeProvider: () => PermissionMode = () => "default";
	private readonly parentPromptListeners = new Set<() => void>();
	private inspectorOpen = false;
	private disposedValue = false;

	constructor(raw: PolyphaseSettings | undefined) {
		this.resolved = resolvePolyphaseSettings(raw);
		this.limiter = new AgentLimiter(this.resolved.maxConcurrency);
		this.pump = createUpdatePump({ intervalMs: this.resolved.liveUpdateMs });
		this.store = new PolyphaseStore({ pump: this.pump, retainRuns: this.resolved.retainRuns });
	}

	settings(): ResolvedPolyphaseSettings {
		return this.resolved;
	}

	refreshSettings(raw: PolyphaseSettings | undefined): void {
		this.resolved = resolvePolyphaseSettings(raw);
		this.limiter.setCapacity(this.resolved.maxConcurrency);
		this.applyPumpInterval();
	}

	permissionMode(): PermissionMode {
		return this.permissionModeProvider();
	}

	setPermissionModeProvider(provider: () => PermissionMode): void {
		this.permissionModeProvider = provider;
	}

	onParentPrompt(listener: () => void): () => void {
		this.parentPromptListeners.add(listener);
		return () => this.parentPromptListeners.delete(listener);
	}

	notifyParentPrompt(): void {
		for (const listener of this.parentPromptListeners) {
			try {
				listener();
			} catch {
				// An inspector-close listener must not block the parent prompt it is making way for.
			}
		}
	}

	setInspectorOpen(open: boolean): void {
		this.inspectorOpen = open;
		this.applyPumpInterval();
	}

	get disposed(): boolean {
		return this.disposedValue;
	}

	dispose(reason: string): void {
		if (this.disposedValue) return;
		this.disposedValue = true;
		this.store.dispose();
		this.limiter.rejectAll(new Error(reason));
		this.parentPromptListeners.clear();
	}

	private applyPumpInterval(): void {
		this.pump.setIntervalMs(
			this.inspectorOpen
				? Math.min(INSPECTOR_INTERVAL_CAP_MS, this.resolved.liveUpdateMs)
				: this.resolved.liveUpdateMs,
		);
	}
}

const sessions = new WeakMap<object, PolyphaseSession>();

function isObjectKey(key: unknown): key is object {
	return typeof key === "object" && key !== null;
}

/** Creates on first use; refreshes settings on every call. `key` is `ctx.sessionManager`. */
export function getPolyphaseSession(key: object, raw: PolyphaseSettings | undefined): PolyphaseSession {
	let session = sessions.get(key);
	// A session disposed directly (not through disposePolyphaseSession) leaves a dead entry in the
	// map: its pump is disposed, so it would never flush again.
	if (!session || session.disposed) {
		session = new PolyphaseSessionImpl(raw);
		sessions.set(key, session);
	}
	session.refreshSettings(raw);
	return session;
}

/** Returns undefined for non-object keys (tests pass contexts without `sessionManager`). */
export function peekPolyphaseSession(key: unknown): PolyphaseSession | undefined {
	if (!isObjectKey(key)) return undefined;
	return sessions.get(key);
}

/** Idempotent: disposes and deletes the entry, if any. */
export function disposePolyphaseSession(key: unknown, reason: string): void {
	if (!isObjectKey(key)) return;
	const session = sessions.get(key);
	if (!session) return;
	session.dispose(reason);
	sessions.delete(key);
}
