/**
 * R36-SPAWN.3 — the user-owned registry is security-checked on EVERY load, and
 * the loader REFUSES rather than repairing.
 *
 * Everything here runs against real inodes in a `mkdtemp` under /private/tmp:
 * mode bits, symlinks and ownership are properties of a filesystem, and a mock
 * of `fs` would prove only that this test agrees with itself.
 *
 * Two disciplines make these assertions non-vacuous:
 *
 *  - **every refusal is checked by RULE, not by "it threw".** `loadGeistConfigFile`
 *    has seven ways to refuse and a bare `toThrow()` cannot tell them apart — a
 *    fixture that meant to prove the ownership rule would pass on the mode rule
 *    and nobody would know.
 *  - **every refusal is paired with a POSITIVE CONTROL.** A symlink fixture where
 *    the target is itself unloadable proves nothing; each one is accompanied by
 *    the sibling file that DOES load, so the refusal is attributable to the one
 *    property under test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	Stats,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseGeistConfig } from "../src/config.js";
import {
	assertPrivateRegistryFile,
	loadGeistConfigFile,
	RegistryFileRefusedError,
	type RegistryPathScope,
	type RegistryRefusalRule,
	resolveUserRegistryPath,
} from "../src/config-load.js";

const VALID_YAML = [
	"harness:",
	"  default: draht",
	"  agents:",
	"    draht: { cmd: /usr/local/bin/draht-acp }",
	"projects:",
	"  fr3n: { root: /Users/you/dev/fr3n }",
	"approvedRoots:",
	"  - /Users/you/dev",
	"",
].join("\n");

/** Root of every fixture. 0700 by construction (`mkdtemp`), on /private/tmp so the hardlink probe below can reach it. */
let root: string;

beforeAll(() => {
	root = mkdtempSync("/private/tmp/geist-reg-");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A fresh 0700 directory under the fixture root. */
function dir(name: string): string {
	const path = join(root, name);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
	return path;
}

/** A registry file with the given mode. 0600 unless a test is about the mode. */
function registry(parent: string, name = "config.yaml", mode = 0o600, body = VALID_YAML): string {
	const path = join(parent, name);
	writeFileSync(path, body, { mode });
	chmodSync(path, mode);
	return path;
}

/** Asserts the call refused, and refused for the stated REASON on the stated PATH. */
function expectRefusal(
	call: () => unknown,
	rule: RegistryRefusalRule,
	scope: RegistryPathScope,
	path?: string,
): RegistryFileRefusedError {
	let caught: unknown;
	try {
		call();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(RegistryFileRefusedError);
	const refusal = caught as RegistryFileRefusedError;
	expect(refusal.rule).toBe(rule);
	expect(refusal.scope).toBe(scope);
	if (path !== undefined) expect(refusal.path).toBe(path);
	return refusal;
}

describe("loadGeistConfigFile — the happy path, so every refusal below is attributable", () => {
	test("a 0600 file under a 0700 parent loads and parses", () => {
		const path = registry(dir("clean"));

		const config = loadGeistConfigFile(path);

		expect(config.harness.default).toBe("draht");
		expect(config.harness.agents.draht.cmd).toBe("/usr/local/bin/draht-acp");
		expect(config.projects?.fr3n.root).toBe("/Users/you/dev/fr3n");
		expect(config.approvedRoots).toEqual(["/Users/you/dev"]);
	});

	test("0400 also loads — the rule is `(mode & 0o077) === 0`, not an equality against 0600", () => {
		const path = registry(dir("readonly"), "config.yaml", 0o400);

		expect(loadGeistConfigFile(path).harness.default).toBe("draht");
	});

	test("valid permissions but invalid yaml fails as a CONFIG error, not a refusal", () => {
		const path = registry(dir("badyaml"), "config.yaml", 0o600, "harness: [unclosed\n");

		let caught: unknown;
		try {
			loadGeistConfigFile(path);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(RegistryFileRefusedError);
	});

	test("valid permissions but a bare-name cmd fails schema validation", () => {
		const parent = dir("relcmd");
		const path = registry(
			parent,
			"config.yaml",
			0o600,
			"harness:\n  default: draht\n  agents:\n    draht: { cmd: draht-acp }\n",
		);

		expect(() => loadGeistConfigFile(path)).toThrow(/Invalid geist config/);

		// Positive control: the identical file with an absolute cmd loads, so the
		// failure above is the refinement and not the file.
		const ok = registry(
			parent,
			"absolute.yaml",
			0o600,
			"harness:\n  default: draht\n  agents:\n    draht: { cmd: /usr/local/bin/draht-acp }\n",
		);
		expect(loadGeistConfigFile(ok).harness.agents.draht.cmd).toBe("/usr/local/bin/draht-acp");
	});
});

describe("mode — the file must not be group/world ACCESSIBLE, which is stronger than 'not writable'", () => {
	test("0644 refuses, and refuses on the MODE rule (0644 has no group/world WRITE bit at all)", () => {
		const path = registry(dir("mode644"), "config.yaml", 0o644);

		const refusal = expectRefusal(() => loadGeistConfigFile(path), "mode", "file", path);
		// The message has to name the mode, or an operator cannot act on it.
		expect(refusal.message).toContain("0644");
	});

	test("0640 refuses — group-readable is enough, this file names credential env vars", () => {
		const path = registry(dir("mode640"), "config.yaml", 0o640);

		expectRefusal(() => loadGeistConfigFile(path), "mode", "file", path);
	});

	test("0604 refuses — world-readable with no write bit anywhere", () => {
		const path = registry(dir("mode604"), "config.yaml", 0o604);

		expectRefusal(() => loadGeistConfigFile(path), "mode", "file", path);
	});

	test("nothing is repaired: the mode is untouched after the refusal", () => {
		const path = registry(dir("norepair"), "config.yaml", 0o644);

		expectRefusal(() => loadGeistConfigFile(path), "mode", "file", path);

		expect(lstatSync(path).mode & 0o777).toBe(0o644);
	});

	test("the check runs on EVERY load, not once — a file that loaded refuses after chmod", () => {
		const path = registry(dir("recheck"));

		expect(loadGeistConfigFile(path).harness.default).toBe("draht");

		chmodSync(path, 0o644);
		expectRefusal(() => loadGeistConfigFile(path), "mode", "file", path);

		chmodSync(path, 0o600);
		expect(loadGeistConfigFile(path).harness.default).toBe("draht");
	});
});

describe("symlinks — refused, never resolved, at every component of the SUPPLIED path", () => {
	test("a symlinked FILE path refuses, while its target loads", () => {
		const parent = dir("linkfile");
		const target = registry(parent, "real.yaml");
		const link = join(parent, "config.yaml");
		symlinkSync(target, link);

		// Positive control first: the target is a perfectly loadable registry, so
		// the refusal below cannot be blamed on the target's own permissions.
		expect(loadGeistConfigFile(target).harness.default).toBe("draht");

		expectRefusal(() => loadGeistConfigFile(link), "symlink", "file", link);
	});

	test("a symlinked PARENT refuses (this is the fixture a realpath-first loader passes vacuously)", () => {
		const real = dir("linkparent-real");
		const target = registry(real);
		const linkedParent = join(root, "linkparent-link");
		symlinkSync(real, linkedParent);
		const viaLink = join(linkedParent, "config.yaml");

		expect(loadGeistConfigFile(target).harness.default).toBe("draht");

		const refusal = expectRefusal(() => loadGeistConfigFile(viaLink), "symlink", "parent", linkedParent);
		// If the loader had realpath'd first, `path` would be the resolved
		// directory and the rule would never have fired at all.
		expect(refusal.path).not.toBe(real);
	});

	test("a symlinked GRANDPARENT refuses too — the walk covers every component, not just two", () => {
		const real = dir("linkgrand-real");
		const inner = join(real, "inner");
		mkdirSync(inner, { mode: 0o700 });
		chmodSync(inner, 0o700);
		const target = registry(inner);
		const linkedGrandparent = join(root, "linkgrand-link");
		symlinkSync(real, linkedGrandparent);

		expect(loadGeistConfigFile(target).harness.default).toBe("draht");

		expectRefusal(
			() => loadGeistConfigFile(join(linkedGrandparent, "inner", "config.yaml")),
			"symlink",
			"ancestor",
			linkedGrandparent,
		);
	});
});

describe("the parent directory", () => {
	test("a world-writable parent refuses — its owner is not the only one who can replace the file", () => {
		const parent = dir("openparent");
		const path = registry(parent);

		expect(loadGeistConfigFile(path).harness.default).toBe("draht");

		chmodSync(parent, 0o777);
		expectRefusal(() => loadGeistConfigFile(path), "mode", "parent", parent);
		chmodSync(parent, 0o700);
	});

	test("a group-writable parent refuses", () => {
		const parent = dir("groupparent");
		const path = registry(parent);
		chmodSync(parent, 0o770);

		expectRefusal(() => loadGeistConfigFile(path), "mode", "parent", parent);
		chmodSync(parent, 0o700);
	});

	test("a STICKY world-writable parent still refuses — no sticky exemption applies to the parent", () => {
		const parent = dir("stickyparent");
		const path = registry(parent);
		chmodSync(parent, 0o1777);

		// This is the single line that separates this check from
		// `assertSafeExecutablePath`, which exempts sticky paths and would allow a
		// registry sitting directly in /tmp.
		expectRefusal(() => loadGeistConfigFile(path), "mode", "parent", parent);
		chmodSync(parent, 0o700);
	});
});

/**
 * A registry that is VALID but is not ours — the payload every swap below tries
 * to get the loader to return. It parses cleanly, so if it ever reaches
 * `parseGeistConfig` the loader hands the daemon `pwned`'s executable and no
 * error is raised anywhere. `default: pwned` is therefore the failure signal.
 */
const ATTACKER_YAML = ["harness:", "  default: pwned", "  agents:", "    pwned: { cmd: /tmp/pwn }", ""].join("\n");

/**
 * Opens the check-to-read window DETERMINISTICALLY and swaps the leaf inside it.
 *
 * The loader's central claim — "what was checked and what was read are the same
 * inode by construction" — is falsifiable only by re-binding the name BETWEEN
 * the check and the read. That window is microseconds wide, so racing it from a
 * second process would be a coin flip, and a coin-flip security test is worse
 * than none. So the window is opened on purpose.
 *
 * Nothing about the filesystem is mocked. Every syscall the loader makes is
 * real, against real inodes under /private/tmp, and the swap itself is a real
 * `rename(2)`/`symlink(2)`. The only thing borrowed is the CLOCK:
 * `Stats.prototype.isFile()` is the LAST rule `assertLeafStats` applies, so
 * counting its calls names two instants inside `loadGeistConfigFile` exactly:
 *
 *  - **`nth: 1`** — the walk's `lstat` leaf check has just completed and
 *    `openSync` has not happened yet. A swap here is the textbook "check the
 *    name, then re-bind the name" attack; `O_NOFOLLOW` and the `fstat` re-check
 *    are the two things that exist to survive it.
 *  - **`nth: 2`** — the `fstat` of the OPEN DESCRIPTOR has just been
 *    re-validated and the read has not happened yet. A swap here cannot fool a
 *    loader that reads `fd`. It completely fools one that goes back to the NAME,
 *    and a loader that reads by name is a TOCTOU again no matter how carefully
 *    the descriptor was checked.
 *
 * `fired` is returned, and every test below asserts it, because a trigger that
 * never ran makes the whole fixture vacuous: a loader that DELETED the re-check
 * would never reach instant 2 and would otherwise sail through green.
 */
function withSwapAt<T>(nth: 1 | 2, swap: () => void, call: () => T): { result?: T; error?: unknown; fired: boolean } {
	const realIsFile = Stats.prototype.isFile;
	let seen = 0;
	let fired = false;
	Object.defineProperty(Stats.prototype, "isFile", {
		configurable: true,
		writable: true,
		value: function (this: Stats): boolean {
			// The answer is computed from the Stats SNAPSHOT the loader already
			// holds, so swapping afterwards cannot change what this call reports —
			// the check completes honestly, and only then does the world move.
			const answer = realIsFile.call(this);
			seen += 1;
			if (seen === nth && !fired) {
				fired = true;
				swap();
			}
			return answer;
		},
	});
	try {
		return { result: call(), fired };
	} catch (error) {
		return { error, fired };
	} finally {
		Object.defineProperty(Stats.prototype, "isFile", { configurable: true, writable: true, value: realIsFile });
	}
}

describe("the leaf is checked twice — what was CHECKED and what was READ are the same inode", () => {
	test("an inode swapped in between the walk and the open is caught by the fstat re-check", () => {
		const parent = dir("swap-fstat");
		const path = registry(parent, "config.yaml");
		const substitute = registry(parent, "substitute.yaml", 0o644, ATTACKER_YAML);

		// Two positive controls: the fixture loads when nothing is swapped in, and
		// the substitute is refused on its own for the reason we are about to see.
		// So the refusal below is attributable to the SUBSTITUTION being noticed,
		// not to either file being unusable.
		expect(loadGeistConfigFile(path).harness.default).toBe("draht");
		expectRefusal(() => loadGeistConfigFile(substitute), "mode", "file", substitute);

		const swapped = withSwapAt(
			1,
			() => renameSync(substitute, path),
			() => loadGeistConfigFile(path),
		);

		expect(swapped.fired).toBe(true);
		// The swap landed: the name now resolves to the attacker's 0644 inode.
		expect(lstatSync(path).mode & 0o777).toBe(0o644);
		// The lstat walk said 0600 and passed. Only the re-check of the OPEN
		// DESCRIPTOR can see 0644, so this refusal is that re-check and nothing
		// else. Drop it — `void fstatSync(fd)` — and the attacker's config is
		// returned with no error at all.
		expect(swapped.result).toBeUndefined();
		expect(swapped.error).toBeInstanceOf(RegistryFileRefusedError);
		expect((swapped.error as RegistryFileRefusedError).rule).toBe("mode");
		expect((swapped.error as RegistryFileRefusedError).scope).toBe("file");
		expect((swapped.error as RegistryFileRefusedError).path).toBe(path);
	});

	test("a symbolic link swapped in between the walk and the open is refused by O_NOFOLLOW, never followed", () => {
		const parent = dir("swap-nofollow");
		const path = registry(parent, "config.yaml");
		const target = registry(parent, "target.yaml", 0o600, ATTACKER_YAML);

		// Positive control that carries this whole test: the link's target is a
		// PERFECTLY LOADABLE registry — our uid, 0600, a regular file, valid yaml.
		// Every leaf rule passes on it. So nothing about the target can explain the
		// refusal below, and nothing about the target would stop a loader that
		// followed the link from succeeding.
		expect(loadGeistConfigFile(target).harness.default).toBe("pwned");
		expect(loadGeistConfigFile(path).harness.default).toBe("draht");

		const swapped = withSwapAt(
			1,
			() => {
				rmSync(path);
				symlinkSync(target, path);
			},
			() => loadGeistConfigFile(path),
		);

		expect(swapped.fired).toBe(true);
		expect(lstatSync(path).isSymbolicLink()).toBe(true);
		expect(swapped.result).toBeUndefined();
		const refusal = swapped.error as RegistryFileRefusedError;
		expect(refusal).toBeInstanceOf(RegistryFileRefusedError);
		expect(refusal.rule).toBe("symlink");
		expect(refusal.scope).toBe("file");
		// This exact wording separates the OPEN-time refusal from the walk's
		// lstat-time one. Both report `symlink` on `file`; only `O_NOFOLLOW` can
		// produce this one, because the walk had already seen a regular file.
		expect(refusal.message).toContain("between the check and the open");
	});

	test("the bytes come from the checked DESCRIPTOR: a name re-bound after the fstat changes nothing", () => {
		const parent = dir("swap-read");
		const path = registry(parent, "config.yaml");
		const substitute = registry(parent, "substitute.yaml", 0o600, ATTACKER_YAML);

		// Positive control: the substitute is a FULLY COMPLIANT registry — our uid,
		// 0600, a regular file, valid yaml. No leaf rule would ever keep it out, so
		// the only thing that can keep its contents out of the result is that the
		// loader never goes back to the name.
		expect(loadGeistConfigFile(substitute).harness.default).toBe("pwned");
		const checkedIno = lstatSync(path).ino;

		const swapped = withSwapAt(
			2,
			() => renameSync(substitute, path),
			() => loadGeistConfigFile(path),
		);

		// The trigger firing is itself load-bearing: it only exists if the loader
		// still re-checks the descriptor, so this assertion also fails for a loader
		// that dropped the fstat re-check entirely.
		expect(swapped.fired).toBe(true);
		// The swap landed. The NAME now resolves to a different inode holding the
		// attacker's config — `readFileSync(checked, ...)` would return this.
		expect(lstatSync(path).ino).not.toBe(checkedIno);
		expect(readFileSync(path, "utf-8")).toContain("pwned");
		// And the loader returned the inode it checked, which no longer has a name.
		expect(swapped.error).toBeUndefined();
		expect(swapped.result?.harness.default).toBe("draht");
		expect(swapped.result?.harness.agents.draht.cmd).toBe("/usr/local/bin/draht-acp");
		expect(swapped.result?.harness.agents.pwned).toBeUndefined();
	});
});

/**
 * A foreign-uid inode on this device that this process may hardlink, proved by
 * actually hardlinking it, or null when there is none.
 *
 * `chown` needs sudo, so a second name for somebody else's inode is the only
 * route to a foreign-owned file inside a directory we control.
 */
function probeForeignUidSource(): string | null {
	const probeDir = mkdtempSync("/private/tmp/geist-uidprobe-");
	try {
		for (const candidate of FOREIGN_UID_CANDIDATES) {
			let stats: ReturnType<typeof lstatSync>;
			try {
				stats = lstatSync(candidate);
			} catch {
				continue;
			}
			if (!stats.isFile() || stats.uid === process.getuid?.()) continue;
			const probe = join(probeDir, "probe");
			try {
				linkSync(candidate, probe);
			} catch {
				continue;
			}
			const linked = lstatSync(probe);
			rmSync(probe, { force: true });
			if (linked.uid !== process.getuid?.()) return candidate;
		}
		return null;
	} finally {
		rmSync(probeDir, { recursive: true, force: true });
	}
}

const FOREIGN_UID_CANDIDATES = [
	"/private/var/db/mtrecorder.enable",
	"/private/var/db/.AppleSetupDone",
	"/private/var/db/analyticsd/tmp",
	"/private/var/log/asl/StoreData",
];

const FOREIGN_UID_SOURCE = probeForeignUidSource();

describe("ownership — strictly the current uid, root NOT accepted", () => {
	test("a foreign-uid registry file refuses ON THE OWNERSHIP RULE", () => {
		// A skipped security fixture is not evidence. If this host has no
		// hardlinkable foreign-uid inode, that is a hole in the evidence and it
		// must be visible, not silently green.
		if (FOREIGN_UID_SOURCE === null) {
			throw new Error(
				"No hardlinkable foreign-uid inode found on this host, so the ownership rule is UNPROVEN. " +
					`Candidates tried: ${FOREIGN_UID_CANDIDATES.join(", ")}. Add one that exists on this machine ` +
					"(uid != this user, same device as /private/tmp) rather than skipping this test.",
			);
		}

		const parent = dir("foreignuid");
		const ours = registry(parent, "ours.yaml");
		// Positive control: our own file in the very same directory loads, so the
		// refusal below is the FILE's owner and nothing about the directory.
		expect(loadGeistConfigFile(ours).harness.default).toBe("draht");

		const planted = join(parent, "config.yaml");
		linkSync(FOREIGN_UID_SOURCE, planted);
		const plantedStats = lstatSync(planted);
		expect(plantedStats.uid).not.toBe(process.getuid?.());

		const refusal = expectRefusal(() => loadGeistConfigFile(planted), "foreign-owner", "file", planted);
		expect(refusal.message).toContain(`uid ${plantedStats.uid}`);
	});

	test("the foreign-uid fixture is root-owned, so this proves uid 0 is REFUSED, not merely 'some other uid'", () => {
		if (FOREIGN_UID_SOURCE === null) throw new Error("no hardlinkable foreign-uid inode on this host");

		// `assertSafeExecutablePath` accepts `stats.uid === 0`. If this loader ever
		// grows that clause, this assertion is what fails.
		expect(lstatSync(FOREIGN_UID_SOURCE).uid).toBe(0);
	});
});

/**
 * The base scanned for the ancestor fixture. It is root-owned and 0755 on every
 * macOS box, and it is full of daemon directories owned by service uids — the
 * only place a "neither this user nor root" DIRECTORY is obtainable without sudo.
 */
const ANCESTOR_PROBE_BASE = "/private/var/db";

/**
 * A directory owned by neither root nor this user, PAIRED with a root-owned
 * sibling at the same depth, or null when this host has no such pair.
 *
 * The pair is the whole point: the two paths differ in exactly one property —
 * the owner of one component — so the control below is not "some other path
 * behaves differently", it is "the same shape at the same depth, one uid apart".
 * Both are required to be free of group/world write bits, so the ancestor MODE
 * clause cannot fire on either and ownership is the only live variable.
 */
function probeAncestorOwnerPair(): { foreign: string; rootOwned: string } | null {
	const me = process.getuid?.();
	if (me === undefined) return null;
	let entries: string[];
	try {
		entries = readdirSync(ANCESTOR_PROBE_BASE);
	} catch {
		return null;
	}
	let foreign: string | undefined;
	let rootOwned: string | undefined;
	for (const entry of entries.sort()) {
		const path = join(ANCESTOR_PROBE_BASE, entry);
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(path);
		} catch {
			continue;
		}
		if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
		if ((stats.mode & 0o022) !== 0) continue;
		if (stats.uid === 0) rootOwned ??= path;
		else if (stats.uid !== me) foreign ??= path;
	}
	return foreign !== undefined && rootOwned !== undefined ? { foreign, rootOwned } : null;
}

const ANCESTOR_OWNER_PAIR = probeAncestorOwnerPair();

describe("ownership of the DIRECTORIES on the path — strict on the parent, loose on the ancestors", () => {
	test("a root-owned PARENT refuses on the OWNERSHIP rule, even around a file that is impeccably ours", () => {
		// `/private/tmp` is root-owned and 1777 on every macOS box. That is exactly
		// the shape "a registry sitting in /tmp" has, it is a real root-owned
		// directory rather than a stand-in, and obtaining it needs no privilege at
		// all — only the willingness to put the fixture somewhere shared.
		const shared = "/private/tmp";
		const sharedStats = lstatSync(shared);
		expect(sharedStats.uid).toBe(0);
		expect(sharedStats.uid).not.toBe(process.getuid?.());

		const path = join(shared, `geist-reg-parentowner-${process.pid}-${Date.now()}.yaml`);
		writeFileSync(path, VALID_YAML, { mode: 0o600 });
		chmodSync(path, 0o600);
		try {
			// The LEAF is beyond reproach: our uid, 0600, a regular file, valid yaml.
			// The positive control is the byte-identical file under a parent we own,
			// which loads. So the refusal below is the PARENT's owner and nothing
			// about the file.
			expect(lstatSync(path).uid).toBe(process.getuid?.());
			expect(lstatSync(path).mode & 0o777).toBe(0o600);
			expect(loadGeistConfigFile(registry(dir("parentowner-control"))).harness.default).toBe("draht");

			const refusal = expectRefusal(() => loadGeistConfigFile(path), "foreign-owner", "parent", shared);
			expect(refusal.message).toContain("uid 0");
			// `mode` is the OTHER rule this directory trips — 1777 is world-writable.
			// Asserting the RULE rather than "it threw" is what makes this test die
			// when the parent's ownership clause is deleted: the refusal would still
			// happen, one clause later, under a different name.
			expect(refusal.rule).not.toBe("mode");
		} finally {
			rmSync(path, { force: true });
		}
	});

	test("an ANCESTOR owned by neither this user nor root refuses on the OWNERSHIP rule", () => {
		// A skipped security fixture is not evidence — same rule as the hardlink
		// probe above.
		if (ANCESTOR_OWNER_PAIR === null) {
			throw new Error(
				`No directory owned by neither root nor this user was found under ${ANCESTOR_PROBE_BASE}, so the ` +
					"ancestor ownership rule is UNPROVEN on this host. Point the probe at a base that has one rather " +
					"than skipping this test.",
			);
		}
		const { foreign, rootOwned } = ANCESTOR_OWNER_PAIR;
		expect(lstatSync(foreign).uid).not.toBe(0);
		expect(lstatSync(foreign).uid).not.toBe(process.getuid?.());
		expect(lstatSync(rootOwned).uid).toBe(0);
		// Neither is group- or world-writable, so the ancestor MODE clause cannot
		// fire on either one. Ownership is the only difference between them.
		expect(lstatSync(foreign).mode & 0o022).toBe(0);
		expect(lstatSync(rootOwned).mode & 0o022).toBe(0);

		// Nothing is planted inside these directories, and nothing needs to be: the
		// walk refuses AT the ancestor, before it ever lstats what comes after it.
		const tail = join("geist-registry-does-not-exist", "config.yaml");

		expectRefusal(() => loadGeistConfigFile(join(foreign, tail)), "foreign-owner", "ancestor", foreign);

		// Positive control: the identical nonexistent tail under the ROOT-owned
		// sibling walks straight past the ancestor rules — root IS accepted here,
		// deliberately — and fails later, on the missing component. Same depth,
		// same tail, one uid apart, and that is what changes the answer.
		expectRefusal(
			() => loadGeistConfigFile(join(rootOwned, tail)),
			"missing",
			"parent",
			join(rootOwned, "geist-registry-does-not-exist"),
		);
	});
});

describe("ancestors — the deliberately WEAKER rules, and the asymmetry with the parent is the point", () => {
	test("a world-writable, non-sticky ANCESTOR refuses on MODE — while the very same directory, sticky, loads", () => {
		const ancestor = dir("ancmode");
		const inner = join(ancestor, "inner");
		mkdirSync(inner, { recursive: true, mode: 0o700 });
		chmodSync(inner, 0o700);
		const path = registry(inner);

		// Positive control: with the ancestor at 0700 the identical file loads, so
		// every refusal below is that one directory's mode and nothing else.
		expect(loadGeistConfigFile(path).harness.default).toBe("draht");

		chmodSync(ancestor, 0o777);
		try {
			expectRefusal(() => loadGeistConfigFile(path), "mode", "ancestor", ancestor);

			// The SAME 0777 directory, now sticky, loads — on a sticky directory a
			// non-owner cannot rename our entry, which is exactly what the
			// writability rule is asking about. Contrast the PARENT, where sticky
			// 1777 still refuses (see the fixture above). The two rules differ ON
			// PURPOSE, and this pair is what fails if anyone "harmonises" them.
			chmodSync(ancestor, 0o1777);
			expect(loadGeistConfigFile(path).harness.default).toBe("draht");
		} finally {
			chmodSync(ancestor, 0o700);
		}
	});
});

describe("paths this loader will not even walk", () => {
	test("a relative path refuses before touching the filesystem", () => {
		expectRefusal(() => loadGeistConfigFile("geist.yaml"), "not-absolute", "file", "geist.yaml");
	});

	test("a `..` segment refuses rather than being normalised away", () => {
		const parent = dir("traversal");
		registry(parent);
		// Built by concatenation, not `join`, which would normalise the `..` away
		// before the loader ever saw it — the whole point is that the loader must
		// refuse the segment rather than normalise it itself.
		const sneaky = `${parent}/sub/../config.yaml`;

		expectRefusal(() => loadGeistConfigFile(sneaky), "traversal", "file", sneaky);
	});

	test("a missing file refuses on the MISSING rule", () => {
		const parent = dir("absent");

		expectRefusal(() => loadGeistConfigFile(join(parent, "config.yaml")), "missing", "file");
	});

	test("a directory in the file's place refuses on NOT-A-FILE", () => {
		const parent = dir("dirleaf");
		const asDir = join(parent, "config.yaml");
		mkdirSync(asDir, { mode: 0o700 });
		chmodSync(asDir, 0o700);

		expectRefusal(() => loadGeistConfigFile(asDir), "not-a-file", "file", asDir);
	});
});

describe("assertPrivateRegistryFile is usable on its own, and returns the path it walked", () => {
	test("returns the checked path for a clean file", () => {
		const path = registry(dir("assertclean"));

		expect(assertPrivateRegistryFile(path)).toBe(path);
	});

	test("refuses without reading — a 0644 file with unparseable yaml still fails on MODE", () => {
		const path = registry(dir("assertmode"), "config.yaml", 0o644, "harness: [unclosed\n");

		expectRefusal(() => assertPrivateRegistryFile(path), "mode", "file", path);
	});
});

describe("resolveUserRegistryPath — the daemon's resolver never considers the current directory", () => {
	test("defaults to ~/.geist/config.yaml", () => {
		expect(resolveUserRegistryPath({ home: "/Users/someone" })).toBe("/Users/someone/.geist/config.yaml");
	});

	test("an explicit absolute path wins", () => {
		expect(resolveUserRegistryPath({ explicit: "/etc/geist/registry.yaml", home: "/Users/someone" })).toBe(
			"/etc/geist/registry.yaml",
		);
	});

	test("a cwd holding a geist.yaml does not change the answer", () => {
		const project = dir("cwdproject");
		const decoy = registry(project, "geist.yaml");
		const home = dir("cwdhome");

		const previous = process.cwd();
		process.chdir(project);
		try {
			const resolved = resolveUserRegistryPath({ home });

			expect(resolved).toBe(join(home, ".geist", "config.yaml"));
			expect(resolved).not.toBe(decoy);
			expect(resolved.startsWith(project)).toBe(false);
			// And with no `home` override either: whatever it returns, it is not the
			// project's own file sitting right there in cwd.
			expect(resolveUserRegistryPath()).not.toBe(decoy);
			expect(dirname(resolveUserRegistryPath())).not.toBe(project);
		} finally {
			process.chdir(previous);
		}
	});

	test("a relative explicit path refuses instead of being resolved against cwd", () => {
		expectRefusal(() => resolveUserRegistryPath({ explicit: "geist.yaml" }), "not-absolute", "file", "geist.yaml");
	});

	test("the default never lands in the system temp directory or anywhere cwd-derived", () => {
		// A guard against the obvious future "convenience": falling back to a
		// discovered path when ~/.geist is absent.
		const resolved = resolveUserRegistryPath({ home: "/Users/someone" });

		expect(resolved.startsWith(tmpdir())).toBe(false);
		expect(resolved.endsWith(join(".geist", "config.yaml"))).toBe(true);
	});
});

describe("the schema half that lands with the loader", () => {
	test("an absolute cmd passes and a relative one does not", () => {
		const base = { harness: { default: "draht", agents: {} } };

		expect(
			parseGeistConfig({
				...base,
				harness: { default: "draht", agents: { draht: { cmd: "/usr/local/bin/draht" } } },
			}).harness.agents.draht.cmd,
		).toBe("/usr/local/bin/draht");

		expect(() =>
			parseGeistConfig({
				...base,
				harness: { default: "draht", agents: { draht: { cmd: "./node_modules/.bin/pwn" } } },
			}),
		).toThrow(/absolute/);

		expect(() =>
			parseGeistConfig({ ...base, harness: { default: "draht", agents: { draht: { cmd: "draht-acp" } } } }),
		).toThrow(/absolute/);
	});

	test("credentialEnv and approvedRoots round-trip", () => {
		const config = parseGeistConfig({
			harness: {
				default: "claude",
				agents: { claude: { cmd: "/usr/local/bin/claude-agent-acp", credentialEnv: ["ANTHROPIC_API_KEY"] } },
			},
			approvedRoots: ["/Users/you/dev"],
		});

		expect(config.harness.agents.claude.credentialEnv).toEqual(["ANTHROPIC_API_KEY"]);
		expect(config.approvedRoots).toEqual(["/Users/you/dev"]);
		// Absent means "none", never "all" — see AgentLaunchSpecSchema's comment.
		const bare = parseGeistConfig({
			harness: { default: "draht", agents: { draht: { cmd: "/usr/local/bin/draht-acp" } } },
		});
		expect(bare.harness.agents.draht.credentialEnv).toBeUndefined();
	});
});
