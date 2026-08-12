import type { KnownKind } from "../catalog.ts";
import type { HostRunner } from "../host.ts";
import type { Effectiveness } from "../types.ts";

/** Everything an adapter may touch. Nothing is read from the ambient process. */
export interface AdapterContext {
	/** The engine's state root. */
	root: string;
	/** The resolved home directory every target path is derived from. */
	home: string;
	/** The environment host processes inherit. */
	env: NodeJS.ProcessEnv;
	/** Runs an external program with an explicit argv. */
	runHost: HostRunner;
	/** Resolves a host executable against the controlled PATH; `null` when absent. */
	hostPath: (name: string) => string | null;
}

/** The catalog fields an adapter needs. Adapters never see the whole catalog entry, and never branch on package name. */
export interface AdapterComponent {
	id: string;
	kind: string;
	npmName: string;
}

export interface RegisterOutcome {
	/** Whether the component is now wired into its host. */
	registered: boolean;
	/** When the change takes effect. Never optimistic: `unknown` is used wherever reload semantics are unverified. */
	effectiveness: Effectiveness;
	notes: string[];
}

export interface DeregisterOutcome {
	/**
	 * Whether the host has verifiably forgotten the component. The engine
	 * refuses to delete a local payload while this is false — deleting first
	 * and hoping is the exact hazard this contract exists to close.
	 */
	deregistered: boolean;
	notes: string[];
}

export interface DelegateOutcome {
	/** The mechanism used, recorded in state (e.g. `npm-global`). */
	method: string;
	packageName: string;
	effectiveness: Effectiveness;
	notes: string[];
}

/**
 * Behavior for one component *kind*. The engine holds no per-package logic:
 * everything host-specific lives behind this interface, and the catalog only
 * says which kind a component is.
 */
export interface Adapter {
	kind: KnownKind;
	/** `files` — the engine owns a target directory. `delegated` — an external package manager owns the artifact. */
	payload: "files" | "delegated";
	/** Where the payload belongs, or `null` for delegated kinds. */
	targetDir: (ctx: AdapterContext, component: AdapterComponent) => string | null;
	/** Lays out the target directory's contents in `stagingDir` from the extracted npm payload. */
	stage: (ctx: AdapterContext, component: AdapterComponent, payloadDir: string, stagingDir: string) => Promise<void>;
	/** Wires a swapped-in payload into its host. */
	register: (ctx: AdapterContext, component: AdapterComponent, targetDir: string) => Promise<RegisterOutcome>;
	/** Unwires a component from its host and verifies the host agrees, before any local deletion. */
	deregister: (ctx: AdapterContext, component: AdapterComponent, targetDir: string) => Promise<DeregisterOutcome>;
	/** Delegated kinds only. */
	delegateInstall?: (ctx: AdapterContext, component: AdapterComponent, version: string) => Promise<DelegateOutcome>;
	delegateUninstall?: (ctx: AdapterContext, component: AdapterComponent) => Promise<DelegateOutcome>;
}
