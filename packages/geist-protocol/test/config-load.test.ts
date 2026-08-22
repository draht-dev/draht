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

let root: string;

beforeAll(() => {
	// /private/tmp, not tmpdir(): the hardlink probe below needs the fixture on the same device.
	root = mkdtempSync("/private/tmp/geist-reg-");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function dir(name: string): string {
	const path = join(root, name);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
	return path;
}

function registry(parent: string, name = "config.yaml", mode = 0o600, body = VALID_YAML): string {
	const path = join(parent, name);
	writeFileSync(path, body, { mode });
	chmodSync(path, mode);
	return path;
}

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

		expectRefusal(() => loadGeistConfigFile(path), "mode", "parent", parent);
		chmodSync(parent, 0o700);
	});
});

const ATTACKER_YAML = ["harness:", "  default: pwned", "  agents:", "    pwned: { cmd: /tmp/pwn }", ""].join("\n");

type SwapInstant = "after-walk-lstat" | "after-fstat-recheck";

// `Stats.prototype.isFile()` is the LAST rule `assertLeafStats` applies, so counting its calls names two
// instants exactly: after the walk's lstat of the leaf, and after the fstat re-check of the open descriptor.
function withSwapAt<T>(
	instant: SwapInstant,
	swap: () => void,
	call: () => T,
): { result?: T; error?: unknown; fired: boolean } {
	const nth = instant === "after-walk-lstat" ? 1 : 2;
	const realIsFile = Stats.prototype.isFile;
	let seen = 0;
	let fired = false;
	Object.defineProperty(Stats.prototype, "isFile", {
		configurable: true,
		writable: true,
		value: function (this: Stats): boolean {
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

		expect(loadGeistConfigFile(path).harness.default).toBe("draht");
		expectRefusal(() => loadGeistConfigFile(substitute), "mode", "file", substitute);

		const swapped = withSwapAt(
			"after-walk-lstat",
			() => renameSync(substitute, path),
			() => loadGeistConfigFile(path),
		);

		expect(swapped.fired).toBe(true);
		expect(lstatSync(path).mode & 0o777).toBe(0o644);
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

		expect(loadGeistConfigFile(target).harness.default).toBe("pwned");
		expect(loadGeistConfigFile(path).harness.default).toBe("draht");

		const swapped = withSwapAt(
			"after-walk-lstat",
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
		expect(refusal.message).toContain("between the check and the open");
	});

	test("the bytes come from the checked DESCRIPTOR: a name re-bound after the fstat changes nothing", () => {
		const parent = dir("swap-read");
		const path = registry(parent, "config.yaml");
		const substitute = registry(parent, "substitute.yaml", 0o600, ATTACKER_YAML);

		expect(loadGeistConfigFile(substitute).harness.default).toBe("pwned");
		const checkedIno = lstatSync(path).ino;

		const swapped = withSwapAt(
			"after-fstat-recheck",
			() => renameSync(substitute, path),
			() => loadGeistConfigFile(path),
		);

		expect(swapped.fired).toBe(true);
		expect(lstatSync(path).ino).not.toBe(checkedIno);
		expect(readFileSync(path, "utf-8")).toContain("pwned");
		expect(swapped.error).toBeUndefined();
		expect(swapped.result?.harness.default).toBe("draht");
		expect(swapped.result?.harness.agents.draht.cmd).toBe("/usr/local/bin/draht-acp");
		expect(swapped.result?.harness.agents.pwned).toBeUndefined();
	});
});

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
		if (FOREIGN_UID_SOURCE === null) {
			throw new Error(
				"No hardlinkable foreign-uid inode found on this host, so the ownership rule is UNPROVEN. " +
					`Candidates tried: ${FOREIGN_UID_CANDIDATES.join(", ")}. Add one that exists on this machine ` +
					"(uid != this user, same device as /private/tmp) rather than skipping this test.",
			);
		}

		const parent = dir("foreignuid");
		const ours = registry(parent, "ours.yaml");
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

		expect(lstatSync(FOREIGN_UID_SOURCE).uid).toBe(0);
	});
});

const ANCESTOR_PROBE_BASE = "/private/var/db";

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
		const shared = "/private/tmp";
		const sharedStats = lstatSync(shared);
		expect(sharedStats.uid).toBe(0);
		expect(sharedStats.uid).not.toBe(process.getuid?.());

		const path = join(shared, `geist-reg-parentowner-${process.pid}-${Date.now()}.yaml`);
		writeFileSync(path, VALID_YAML, { mode: 0o600 });
		chmodSync(path, 0o600);
		try {
			expect(lstatSync(path).uid).toBe(process.getuid?.());
			expect(lstatSync(path).mode & 0o777).toBe(0o600);
			expect(loadGeistConfigFile(registry(dir("parentowner-control"))).harness.default).toBe("draht");

			const refusal = expectRefusal(() => loadGeistConfigFile(path), "foreign-owner", "parent", shared);
			expect(refusal.message).toContain("uid 0");
			expect(refusal.rule).not.toBe("mode");
		} finally {
			rmSync(path, { force: true });
		}
	});

	test("an ANCESTOR owned by neither this user nor root refuses on the OWNERSHIP rule", () => {
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
		expect(lstatSync(foreign).mode & 0o022).toBe(0);
		expect(lstatSync(rootOwned).mode & 0o022).toBe(0);

		const tail = join("geist-registry-does-not-exist", "config.yaml");

		expectRefusal(() => loadGeistConfigFile(join(foreign, tail)), "foreign-owner", "ancestor", foreign);

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

		expect(loadGeistConfigFile(path).harness.default).toBe("draht");

		chmodSync(ancestor, 0o777);
		try {
			expectRefusal(() => loadGeistConfigFile(path), "mode", "ancestor", ancestor);

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
		const bare = parseGeistConfig({
			harness: { default: "draht", agents: { draht: { cmd: "/usr/local/bin/draht-acp" } } },
		});
		expect(bare.harness.agents.draht.credentialEnv).toBeUndefined();
	});
});
