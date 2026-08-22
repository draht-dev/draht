/**
 * Secure loader for the user-owned harness/project registry (R36-SPAWN.3). It refuses rather than
 * repairing, and lstat-walks the SUPPLIED path before any realpath — realpath follows the symlinks
 * this walk exists to refuse.
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { type GeistConfig, parseGeistConfig } from "./config.js";

export type RegistryRefusalRule =
	| "not-absolute"
	| "traversal"
	| "missing"
	| "symlink"
	| "foreign-owner"
	| "mode"
	| "not-a-file";

export type RegistryPathScope = "file" | "parent" | "ancestor";

export class RegistryFileRefusedError extends Error {
	readonly rule: RegistryRefusalRule;
	readonly path: string;
	readonly scope: RegistryPathScope;

	constructor(rule: RegistryRefusalRule, path: string, scope: RegistryPathScope, detail: string) {
		super(`Refused geist registry (${rule} on ${scope} ${path}): ${detail}`);
		this.name = "RegistryFileRefusedError";
		this.rule = rule;
		this.path = path;
		this.scope = scope;
	}
}

function currentUid(): number | null {
	return typeof process.getuid === "function" ? process.getuid() : null;
}

function refuse(rule: RegistryRefusalRule, path: string, scope: RegistryPathScope, detail: string): never {
	throw new RegistryFileRefusedError(rule, path, scope, detail);
}

function octal(mode: number): string {
	return `0${(mode & 0o7777).toString(8)}`;
}

function assertLeafStats(stats: Stats, path: string, uid: number): void {
	if (stats.uid !== uid) {
		refuse(
			"foreign-owner",
			path,
			"file",
			`owned by uid ${stats.uid}, not by this user (uid ${uid}). Root is not accepted either: whoever owns this file chooses which program the daemon runs.`,
		);
	}
	if ((stats.mode & 0o077) !== 0) {
		refuse(
			"mode",
			path,
			"file",
			`mode ${octal(stats.mode)} is accessible to group or other. It must be ${octal(0o600)} (or ${octal(0o400)}): it names executables and credential env vars, so "not writable" is not enough — it must not be READABLE either. Fix it yourself; this loader will not chmod your file.`,
		);
	}
	if (!stats.isFile()) {
		refuse("not-a-file", path, "file", "not a regular file");
	}
}

function assertParentStats(stats: Stats, path: string, uid: number): void {
	if (stats.uid !== uid) {
		refuse(
			"foreign-owner",
			path,
			"parent",
			`owned by uid ${stats.uid}, not by this user (uid ${uid}) — its owner can replace the registry file inside it`,
		);
	}
	if ((stats.mode & 0o022) !== 0) {
		refuse(
			"mode",
			path,
			"parent",
			`mode ${octal(stats.mode)} is writable by group or other, so the registry file can be replaced. No sticky exemption applies here: a sticky directory is a SHARED one, and a file naming executables does not live in a shared directory.`,
		);
	}
}

function assertAncestorStats(stats: Stats, path: string, uid: number): void {
	if (stats.uid !== uid && stats.uid !== 0) {
		refuse("foreign-owner", path, "ancestor", `owned by uid ${stats.uid}, neither this user (uid ${uid}) nor root`);
	}
	const sticky = (stats.mode & 0o1000) !== 0;
	if ((stats.mode & 0o022) !== 0 && !sticky) {
		refuse("mode", path, "ancestor", `mode ${octal(stats.mode)} is writable by group or other and is not sticky`);
	}
}

export function assertPrivateRegistryFile(path: string): string {
	if (!isAbsolute(path)) {
		refuse("not-absolute", path, "file", "a relative registry path would be resolved against the current directory");
	}

	const parts = path.split(sep).filter((part) => part.length > 0);
	for (const part of parts) {
		if (part === "." || part === "..") {
			refuse(
				"traversal",
				path,
				"file",
				`the segment "${part}" cannot be checked component-by-component — the kernel applies it AFTER resolving the preceding component, so a textual check would describe a different file than the one opened`,
			);
		}
	}
	if (parts.length === 0) {
		refuse("not-a-file", path, "file", "the filesystem root is not a registry file");
	}

	const uid = currentUid();
	if (uid === null) {
		refuse(
			"foreign-owner",
			path,
			"file",
			"this platform reports no uid, so the registry's ownership cannot be established",
		);
	}

	const leafIndex = parts.length;
	const parentIndex = parts.length - 1;

	let current: string = sep;
	for (let index = 0; index <= leafIndex; index++) {
		if (index > 0) current = index === 1 ? sep + parts[0] : `${current}${sep}${parts[index - 1]}`;

		let stats: Stats;
		try {
			stats = lstatSync(current);
		} catch (error) {
			refuse("missing", current, scopeFor(index, parentIndex, leafIndex), (error as Error).message);
		}

		if (stats.isSymbolicLink()) {
			refuse(
				"symlink",
				current,
				scopeFor(index, parentIndex, leafIndex),
				"symbolic links are refused, never resolved — resolving one would check the target's ownership while the link stays repointable by whoever owns the link's directory",
			);
		}

		if (index === leafIndex) {
			assertLeafStats(stats, current, uid);
			continue;
		}

		if (index === parentIndex) {
			assertParentStats(stats, current, uid);
			continue;
		}

		assertAncestorStats(stats, current, uid);
	}

	return current;
}

function scopeFor(index: number, parentIndex: number, leafIndex: number): RegistryPathScope {
	if (index === leafIndex) return "file";
	if (index === parentIndex) return "parent";
	return "ancestor";
}

export function loadGeistConfigFile(path: string): GeistConfig {
	const checked = assertPrivateRegistryFile(path);

	// O_NOFOLLOW: if the leaf became a symlink after the walk's lstat, this fails rather than reading through it.
	let fd: number;
	try {
		fd = openSync(checked, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP" || code === "EMLINK") {
			refuse("symlink", checked, "file", "became a symbolic link between the check and the open");
		}
		refuse("missing", checked, "file", (error as Error).message);
	}

	let raw: string;
	try {
		const uid = currentUid();
		if (uid === null) {
			refuse("foreign-owner", checked, "file", "this platform reports no uid");
		}
		// Re-check and read the OPEN DESCRIPTOR, never the name: checked inode and read inode are then the same one.
		assertLeafStats(fstatSync(fd), checked, uid);
		raw = readFileSync(fd, "utf-8");
	} finally {
		closeSync(fd);
	}

	let document: unknown;
	try {
		document = parseYaml(raw);
	} catch (error) {
		throw new Error(`Invalid geist config at ${checked}: ${(error as Error).message}`);
	}

	return parseGeistConfig(document);
}

export const USER_REGISTRY_PATH_SEGMENTS = [".geist", "config.yaml"] as const;

export interface UserRegistryPathOptions {
	explicit?: string;
	home?: string;
}

export function resolveUserRegistryPath(options: UserRegistryPathOptions = {}): string {
	const explicit = options.explicit;
	if (explicit !== undefined && explicit !== "") {
		if (!isAbsolute(explicit)) {
			refuse(
				"not-absolute",
				explicit,
				"file",
				"an explicit registry path must be absolute — resolving it would mean resolving it against the current directory, which this resolver must never read",
			);
		}
		return explicit;
	}

	const home = options.home ?? homedir();
	if (!isAbsolute(home)) {
		refuse("not-absolute", home, "parent", "the home directory did not resolve to an absolute path");
	}
	return join(home, ...USER_REGISTRY_PATH_SEGMENTS);
}
