/**
 * Two opaque ids from a phone — a harness and a project — become a canonical
 * executable and a canonical directory, or a refusal (R36-SPAWN.2, R36-SPAWN.3).
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath, sep } from "node:path";
import {
	type AgentLaunchSpec,
	type GeistConfig,
	loadGeistConfigFile,
	resolveUserRegistryPath,
	type UserRegistryPathOptions,
} from "@draht/geist-protocol";
import { canonicalize, type ExecutableRoots, SpawnRefusedError } from "./spawn-primitive.js";

/** A strict subset of the wire's spawn codes; the caller maps it with an exhaustive switch, so drift is a compile error there. */
export type HarnessResolutionCode = "unknown_harness" | "unknown_project" | "refused";

export class HarnessResolutionError extends Error {
	readonly code: HarnessResolutionCode;

	constructor(code: HarnessResolutionCode, message: string) {
		super(message);
		this.name = "HarnessResolutionError";
		this.code = code;
	}
}

export interface ResolvedHarnessLaunch {
	harnessId: string;
	projectId: string;
	/** Canonical absolute executable, ownership-walked and root-contained. */
	executable: string;
	/** Args that belong to the executable itself (an interpreter's script path, then the spec's own `args`). */
	leadingArgs: string[];
	/** Canonical absolute project root; the spawn's cwd AND its `--context-root`. */
	projectRoot: string;
	/** Exactly the env names this harness may receive. Empty means none beyond the built-in minimum. */
	credentialEnv: readonly string[];
}

export type RegistryProvider = () => GeistConfig;

export interface HarnessResolverOptions {
	/** Asked on EVERY call. Not a value captured at construction. */
	registry: RegistryProvider;
	uid?: number;
	/** Roots a spawn may never enter, whatever the registry says. */
	forbiddenRoots?: readonly string[];
	/** Only these ids may be spawned; empty/absent means every declared one. A harness with no socket would spawn and time out. */
	spawnableHarnessIds?: readonly string[];
}

/** The path is fixed once; the FILE is re-checked and re-read on every call, because R36-SPAWN.3 says on every load. */
export function userRegistryProvider(options: UserRegistryPathOptions = {}): RegistryProvider {
	const path = resolveUserRegistryPath(options);
	return () => loadGeistConfigFile(path);
}

export function resolveHarnessLaunch(
	harnessId: string,
	projectId: string,
	options: HarnessResolverOptions,
): ResolvedHarnessLaunch {
	const config = options.registry();
	const uid = options.uid ?? process.getuid?.() ?? 0;

	const spec = declared(config.harness.agents, harnessId);
	if (spec === undefined) {
		throw new HarnessResolutionError("unknown_harness", `no harness "${harnessId}" is declared in the registry`);
	}
	if (!isSpawnable(harnessId, options.spawnableHarnessIds)) {
		throw new HarnessResolutionError(
			"unknown_harness",
			`the harness "${harnessId}" is declared but not spawnable: it does not publish an attachable socket, so a spawn would produce no session to join`,
		);
	}

	const project = declared(config.projects, projectId);
	if (project === undefined) {
		throw new HarnessResolutionError("unknown_project", `no project "${projectId}" is declared in the registry`);
	}

	const roots: ExecutableRoots = {
		// Absent is unconstrained, and passed through anyway so the constraint exists the moment an operator writes one.
		approvedRoots: config.approvedRoots ?? [],
		forbiddenRoots: options.forbiddenRoots ?? [],
	};
	const { executable, leadingArgs } = resolveHarnessExecutable(harnessId, spec, uid, roots);
	const projectRoot = canonicalDirectory(project.root, `the "${projectId}" project root`, roots);

	return {
		harnessId,
		projectId,
		executable,
		leadingArgs,
		projectRoot,
		// Absent is EMPTY, never "all" — the field exists so a harness stops receiving every key the daemon holds.
		// Copied, never aliased: a provider that memoises its parse would otherwise hand callers the registry itself.
		credentialEnv: [...(spec.credentialEnv ?? [])],
	};
}

/** `spawnable` is {@link HarnessResolverOptions}'s list: a phone may not be offered an id its own resolver refuses. */
export function registryProjection(
	config: GeistConfig,
	spawnable?: readonly string[],
): {
	harnesses: { id: string; isDefault: boolean }[];
	projects: { id: string; name: string; root: string }[];
} {
	return {
		harnesses: Object.keys(config.harness.agents)
			.filter((id) => isSpawnable(id, spawnable))
			.map((id) => ({ id, isDefault: id === config.harness.default })),
		projects: Object.entries(config.projects ?? {}).map(([id, project]) => ({
			id,
			name: project.name ?? id,
			root: project.root,
		})),
	};
}

/** `agents["constructor"]` is a function on every plain object: an id from the wire may only match an OWN key. */
function declared<T>(table: Record<string, T> | undefined, id: string): T | undefined {
	return table !== undefined && Object.hasOwn(table, id) ? table[id] : undefined;
}

function isSpawnable(harnessId: string, spawnable: readonly string[] | undefined): boolean {
	return spawnable === undefined || spawnable.length === 0 || spawnable.includes(harnessId);
}

function isScript(path: string): boolean {
	return [".js", ".mjs", ".cjs", ".ts"].some((extension) => path.endsWith(extension));
}

/**
 * NO-FOLLOW and root-bounded on the declaration, neither on the interpreter — the split `resolveDrahtExecutable`
 * makes. A declaration names a FILE inside an approved root; `process.execPath` is a version manager's symlink in
 * a directory nobody approves, and constraining it stops every script harness the moment a root is written.
 */
function resolveHarnessExecutable(
	harnessId: string,
	spec: AgentLaunchSpec,
	uid: number,
	roots: ExecutableRoots,
): { executable: string; leadingArgs: string[] } {
	const specArgs = [...(spec.args ?? [])];
	const what = `the "${harnessId}" harness executable`;
	assertNoParentTraversal(spec.cmd, what);
	const target = refusing(() => canonicalize(spec.cmd, uid, what, { ...roots, followSymlinks: false }));
	if (!isScript(target)) return { executable: target, leadingArgs: specArgs };
	const interpreter = refusing(() => canonicalize(realpathSync(process.execPath), uid, "the javascript runtime"));
	return { executable: interpreter, leadingArgs: [target, ...specArgs] };
}

function refusing<T>(attempt: () => T): T {
	try {
		return attempt();
	} catch (error) {
		if (error instanceof SpawnRefusedError) throw new HarnessResolutionError("refused", error.message);
		throw error;
	}
}

/** {@link canonicalize} for a directory: its ownership walk demands a regular file at the leaf. */
function canonicalDirectory(supplied: string, what: string, roots: ExecutableRoots): string {
	if (!isAbsolute(supplied)) {
		throw new HarnessResolutionError("refused", `${what} must be an absolute path, got ${supplied}`);
	}
	assertNoParentTraversal(supplied, what);
	assertNoSymlinkComponents(supplied, what);
	let canonical: string;
	try {
		canonical = realpathSync(supplied);
	} catch {
		throw new HarnessResolutionError("refused", `${what} does not exist: ${supplied}`);
	}
	if (!statSync(canonical).isDirectory()) {
		throw new HarnessResolutionError("refused", `${what} is not a directory: ${canonical}`);
	}
	for (const root of roots.forbiddenRoots ?? []) {
		if (isInsideRoot(canonical, canonicalRoot(root))) {
			throw new HarnessResolutionError("refused", `${what} is inside a forbidden root: ${canonical}`);
		}
	}
	const approved = roots.approvedRoots ?? [];
	if (approved.length > 0 && !approved.some((root) => isInsideRoot(canonical, canonicalRoot(root)))) {
		throw new HarnessResolutionError("refused", `${what} is not inside an approved root: ${canonical}`);
	}
	return canonical;
}

/** `assertNoSymlinkComponents` normalises lexically, so an unrefused `..` erases the link it exists to see. */
function assertNoParentTraversal(supplied: string, what: string): void {
	if (supplied.split(sep).includes("..")) {
		throw new HarnessResolutionError("refused", `${what} must not climb through "..": ${supplied}`);
	}
}

/** Copied from `assertNoSymlinkComponents` in spawn-primitive.ts, which cannot be called for a directory. */
function assertNoSymlinkComponents(supplied: string, what: string): void {
	const parts = resolvePath(supplied)
		.split(sep)
		.filter((part) => part.length > 0);
	let current: string = sep;
	for (const part of parts) {
		current = current === sep ? sep + part : `${current}${sep}${part}`;
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(current);
		} catch {
			throw new HarnessResolutionError("refused", `${what} does not exist: ${supplied}`);
		}
		// Root-owned links are exempt because `/tmp`, `/var` and `/etc` are ones, on every macOS machine.
		if (stats.isSymbolicLink() && stats.uid !== 0) {
			throw new HarnessResolutionError("refused", `symlink on the path to ${what}: ${current}`);
		}
	}
}

/** Copied from `isInsideRoot` in spawn-primitive.ts: `startsWith` alone reads `/x/projects-evil` as inside `/x/projects`. */
function isInsideRoot(canonical: string, root: string): boolean {
	if (canonical === root) return true;
	return canonical.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Copied from `canonicalRoot` in spawn-primitive.ts: an unresolvable root normalises lexically rather than vanishing. */
function canonicalRoot(root: string): string {
	if (!isAbsolute(root)) {
		throw new HarnessResolutionError("refused", `a containment root must be an absolute path, got ${root}`);
	}
	try {
		return realpathSync(root);
	} catch {
		return resolvePath(root);
	}
}
