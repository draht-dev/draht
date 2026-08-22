/**
 * The secure loader for the USER-OWNED harness/project registry (R36-SPAWN.3).
 *
 * This file exists because the registry names EXECUTABLES. A frame from a phone
 * says "spawn harness `draht` in project `fr3n`" and carries nothing else; the
 * daemon turns those two opaque ids into an absolute program path by reading
 * this file. So whoever can write this file can choose what the daemon runs,
 * and whoever can READ it learns which credential names a harness receives.
 * That is why the check below is about ACCESSIBILITY, not just writability.
 *
 * ## Two rules that are not negotiable, and are easy to lose
 *
 * **1. It REFUSES; it never repairs.** There is no `chmod` in this file. A
 * loader that fixes your permissions for you is a loader that hides the fact
 * that somebody else could read your registry a moment ago — the window already
 * happened, and silently closing it destroys the only evidence. The operator is
 * told exactly which rule failed on exactly which path and fixes it themselves.
 *
 * **2. It lstat-walks the SUPPLIED path, BEFORE any `realpath`.** Canonicalising
 * first and checking afterwards is the classic inversion: `realpath` FOLLOWS the
 * symlink, so a symlinked registry path — or a symlinked parent — is checked in
 * its *target's* clothes and passes. The fixtures that exist to catch that would
 * then pass vacuously, which is worse than not having them. Every component of
 * the path as given is lstat'd, and any symbolic link anywhere on it is a
 * refusal, not something to resolve.
 *
 * ## Why this is a DISTINCT function, and why "unifying" it later is a regression
 *
 * Two lookalikes exist in this repo. Neither may be reused here, and if a future
 * reader collapses the three into one they will silently downgrade this one:
 *
 *  - `assertSafeExecutablePath` (gateway/src/session/spawn-primitive.ts) is the
 *    right check for `/usr/bin/…`: it accepts uid 0 as owned, masks only the
 *    WRITE bits (`& 0o022`), and exempts sticky directories. All three are wrong
 *    for a registry file. Accepting root means a root-owned registry planted by
 *    an installer is trusted; masking only write bits means mode 0644 — world
 *    READABLE — passes, and this file may name credential env vars; the sticky
 *    exemption applied to a leaf would make a registry sitting in `/tmp` fine.
 *  - `ensureConfigPrivate` (gateway/src/config/config.ts) REPAIRS by `chmod` and
 *    never looks at uid at all. That is the correct posture for the gateway's
 *    own token file, which must stay loadable; it is the wrong posture for a
 *    file that decides which program runs.
 *
 * The rule here — `(mode & 0o077) === 0` on the file, strict current-uid
 * ownership on the file AND its parent — is strictly stronger than both.
 *
 * ## What the walk does and does not demand, per component
 *
 *  - **the file**: not a symlink, `uid === process.getuid()` (root is NOT
 *    accepted), `(mode & 0o077) === 0`, a regular file. No exemptions.
 *  - **its parent directory**: not a symlink, `uid === process.getuid()`, not
 *    group- or world-WRITABLE. No sticky exemption — a sticky parent is by
 *    definition a shared directory, and a file naming executables does not live
 *    in one.
 *  - **every ancestor above the parent**: not a symlink, owned by this uid or by
 *    root, and not group/world writable unless sticky. These are the WEAK rules,
 *    and they are weak because `/`, `/Users` and `/private/tmp` are root-owned
 *    and world-readable by construction — demanding otherwise refuses every real
 *    machine. They are not what protects the registry; the file and parent rules
 *    are. Do not "harmonise" the strong rules down to these.
 *
 * ## The leaf is checked twice, deliberately
 *
 * An lstat-then-read is a TOCTOU: the name could be swapped between the check
 * and the open. So {@link loadGeistConfigFile} opens with `O_NOFOLLOW` and
 * re-applies the leaf rules to `fstat` of the OPEN DESCRIPTOR, then reads from
 * that same descriptor. What was checked and what was read are then the same
 * inode by construction. The parent's non-writability is what bounds the
 * remaining directory-level race.
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { type GeistConfig, parseGeistConfig } from "./config.js";

/** Which rule refused, so a caller (and a test) can tell the refusals apart. */
export type RegistryRefusalRule =
	/** The path given was not absolute — a relative registry path would be resolved against cwd. */
	| "not-absolute"
	/** The path contains a `.` or `..` segment, which cannot be checked component-by-component. */
	| "traversal"
	/** A component does not exist or could not be lstat'd. */
	| "missing"
	/** A component is a symbolic link. Never followed, never resolved. */
	| "symlink"
	/** A component is owned by someone other than this process's uid (root included, for the file). */
	| "foreign-owner"
	/** A component's mode grants access to group or other. */
	| "mode"
	/** The leaf is not a regular file. */
	| "not-a-file";

/** Which part of the path the rule fired on. The file and its parent carry the strict rules. */
export type RegistryPathScope = "file" | "parent" | "ancestor";

/**
 * A registry file this process refuses to read, naming the rule and the path.
 *
 * Typed rather than a bare `Error` because the caller has to be able to say
 * "your registry is world-readable" instead of "config failed to load", and
 * because a test that cannot tell WHICH rule fired cannot prove that the rule it
 * cares about is the one doing the work.
 */
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

/** This process's uid, or `null` where the platform has none (Windows). */
function currentUid(): number | null {
	return typeof process.getuid === "function" ? process.getuid() : null;
}

function refuse(rule: RegistryRefusalRule, path: string, scope: RegistryPathScope, detail: string): never {
	throw new RegistryFileRefusedError(rule, path, scope, detail);
}

function octal(mode: number): string {
	return `0${(mode & 0o7777).toString(8)}`;
}

/**
 * The leaf rules, applied to whatever `Stats` the caller obtained — an `lstat`
 * of the name during the walk, and again an `fstat` of the OPEN descriptor.
 *
 * The order is load-bearing: ownership is checked BEFORE mode. The only
 * foreign-uid fixture obtainable without sudo is a hardlink to a root-owned
 * system file, which is mode 0644 and would therefore also fail the mode rule.
 * Checking ownership first is what makes that fixture prove the OWNERSHIP rule
 * rather than passing for the wrong reason.
 */
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

/**
 * Refuses unless `path` is a registry file only this user can reach, and returns
 * the exact path string that was walked.
 *
 * Runs on EVERY load — R36-SPAWN.3 says "checked on every load", and a check
 * cached at construction is a check that answers for a file that has since been
 * replaced.
 */
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
			if (stats.uid !== uid) {
				refuse(
					"foreign-owner",
					current,
					"parent",
					`owned by uid ${stats.uid}, not by this user (uid ${uid}) — its owner can replace the registry file inside it`,
				);
			}
			if ((stats.mode & 0o022) !== 0) {
				refuse(
					"mode",
					current,
					"parent",
					`mode ${octal(stats.mode)} is writable by group or other, so the registry file can be replaced. No sticky exemption applies here: a sticky directory is a SHARED one, and a file naming executables does not live in a shared directory.`,
				);
			}
			continue;
		}

		// Ancestors: the deliberately weaker rules. See the module comment — `/`,
		// `/Users` and `/private/tmp` are root-owned and world-readable by
		// construction, so the strong rules cannot apply here. Sticky IS honoured
		// for these, because on a sticky directory a non-owner cannot rename our
		// entry, which is exactly what the writability rule is asking about.
		if (stats.uid !== uid && stats.uid !== 0) {
			refuse(
				"foreign-owner",
				current,
				"ancestor",
				`owned by uid ${stats.uid}, neither this user (uid ${uid}) nor root`,
			);
		}
		const sticky = (stats.mode & 0o1000) !== 0;
		if ((stats.mode & 0o022) !== 0 && !sticky) {
			refuse(
				"mode",
				current,
				"ancestor",
				`mode ${octal(stats.mode)} is writable by group or other and is not sticky`,
			);
		}
	}

	return current;
}

function scopeFor(index: number, parentIndex: number, leafIndex: number): RegistryPathScope {
	if (index === leafIndex) return "file";
	if (index === parentIndex) return "parent";
	return "ancestor";
}

/**
 * Security-checks, reads, parses and validates the user-owned registry file.
 *
 * Throws {@link RegistryFileRefusedError} when the file is not exclusively this
 * user's, and a plain `Error` when it is but its contents are not a valid
 * config. Those are different failures and a caller may want to say so
 * differently: the first is "fix your permissions", the second is "fix your
 * yaml".
 */
export function loadGeistConfigFile(path: string): GeistConfig {
	const checked = assertPrivateRegistryFile(path);

	// O_NOFOLLOW closes the gap between the lstat above and the open below: if
	// the leaf became a symlink in between, this fails rather than reading
	// through it. The fstat re-check then applies the leaf rules to the inode
	// actually opened, not to a name that may since have been re-bound.
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

/** Where {@link resolveUserRegistryPath} looks when no explicit path is given. */
export const USER_REGISTRY_PATH_SEGMENTS = [".geist", "config.yaml"] as const;

export interface UserRegistryPathOptions {
	/** An explicit absolute path (`--registry` / `--config`). Must be absolute. */
	explicit?: string;
	/** Home directory the default is resolved against. Defaults to `os.homedir()`. */
	home?: string;
}

/**
 * The DAEMON's registry path resolver: an explicit absolute path, else
 * `~/.geist/config.yaml`. IT NEVER CONSIDERS THE CURRENT DIRECTORY.
 *
 * That omission is the whole of R36-SPAWN.3's second clause in v1. Because the
 * daemon reads no project-supplied config at all, "project-supplied config may
 * reference only approved harness ids and canonical approved roots" is satisfied
 * vacuously — there is no project-supplied config on this path to constrain.
 * That is a legitimate way to satisfy it only for as long as it stays TRUE and
 * stated, so: do not add a cwd fallback here, and do not let this function grow
 * a `cwd` option. The CLI's cwd-preferring `resolveConfigPath`
 * (packages/geist/src/index.ts) is a different resolver for a different
 * consumer, and the daemon must not call it.
 */
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
