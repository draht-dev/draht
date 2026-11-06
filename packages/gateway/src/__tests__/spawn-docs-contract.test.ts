/**
 * R36-SPAWN.4 and R36-SPAWN.1/.3 each end in a clause only docs can satisfy. This file guards
 * `docs/geist/spec.md` §15.1/§15.2/§15.3 in two layers: the statements are there, and they are still true of the code.
 * The gateway README, its SPEC.md and `geist.yaml.example` are held to the same rule.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	ClientFrameSchema,
	RegistryFrameSchema,
	RegistryHarnessSchema,
	RegistryIdSchema,
	RegistryProjectSchema,
	RegistryResyncFrameSchema,
	SessionSpawnCodeSchema,
	SessionSpawnedFrameSchema,
	SessionSpawnFrameSchema,
} from "@draht/geist-protocol";
import { parseArgs } from "../cli";
import type { GatewaySettings } from "../config/config";
import { HarnessResolutionError, resolveHarnessLaunch, userRegistry } from "../session/harness-resolver";
import { V1_SPAWNABLE_HARNESS_IDS } from "../session/session-launcher";
import { buildSpawnArgv, NO_APPROVE_FLAG } from "../session/spawn-argv";
import * as spawnPrimitive from "../session/spawn-primitive";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const SPEC = join(REPO, "docs", "geist", "spec.md");
const EXAMPLE = join(REPO, "geist.yaml.example");
const README = join(REPO, "packages", "gateway", "README.md");
const GATEWAY_SPEC = join(REPO, "packages", "gateway", "SPEC.md");
const SPAWN_PRIMITIVE = join(REPO, "packages", "gateway", "src", "session", "spawn-primitive.ts");
const GEIST_INDEX = join(REPO, "packages", "geist", "src", "index.ts");
const WIRE = join(REPO, "packages", "geist-protocol", "src", "wire.ts");

const spec = (): string => readFileSync(SPEC, "utf-8");

/** The body of one numbered `##`/`###` section: its heading to the next heading of the same or a higher level. */
function section(text: string, number: string): { heading: string; body: string } {
	const lines = text.split("\n");
	const heading = new RegExp(`^(#{2,4}) ${number.replace(/\./g, "\\.")}\\.?\\s`);
	const start = lines.findIndex((line) => heading.test(line));
	expect(
		start,
		`docs/geist/spec.md has no "${number}" section — the statement it carries was deleted`,
	).toBeGreaterThanOrEqual(0);
	const level = (heading.exec(lines[start] ?? "")?.[1] ?? "###").length;
	const next = new RegExp(`^#{1,${level}} `);
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i += 1) {
		if (next.test(lines[i] ?? "")) {
			end = i;
			break;
		}
	}
	const body = lines.slice(start + 1, end).join("\n");

	// An unclosed `<!--` ANYWHERE above the heading, however far away, renders this section as nothing —
	// every assertion below stays green while "stated in the docs" is false. Hence counting over the whole prefix.
	const prefix = lines.slice(0, start).join("\n");
	const opened = (prefix.match(/<!--/g) ?? []).length;
	const closed = (prefix.match(/-->/g) ?? []).length;
	expect(
		opened,
		`"${number}" is inside an unclosed HTML comment — the section renders as nothing, so nothing is "stated in the docs"`,
	).toBe(closed);
	expect(body, `"${number}" opens an HTML comment it never closes`).not.toMatch(/<!--(?![\s\S]*-->)/);

	// A closed comment renders as nothing too, so a claim inside one is not stated.
	return { heading: lines[start] ?? "", body: body.replace(/<!--[\s\S]*?-->/g, "") };
}

function paragraphWith(body: string, needle: RegExp, label: string): string {
	const paragraphs = body.split(/\n\s*\n/);
	const hit = paragraphs.find((p) => needle.test(p));
	expect(hit, `no paragraph in this section mentions ${label}`).toBeDefined();
	return hit ?? "";
}

/** Several tasks edit these files per phase, so a `spawn-primitive.ts:390` in the spec is wrong before the phase lands. */
function assertNoLineCitations(body: string, where: string): void {
	const rotten = body.match(/[A-Za-z0-9_-]+\.ts:\d+/g) ?? [];
	expect(
		rotten,
		`${where} cites source by line number (${rotten.join(", ")}); cite the symbol instead — three tasks edit these files this phase`,
	).toEqual([]);
}

function functionBody(source: string, name: string): string {
	const signature = source.indexOf(`export function ${name}(`);
	expect(signature, `${name} is no longer an exported function — the doc cites it`).toBeGreaterThanOrEqual(0);
	const open = source.indexOf("{", signature);
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		if (source[i] === "{") depth += 1;
		else if (source[i] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(open, i + 1);
		}
	}
	throw new Error(`unbalanced braces reading ${name}`);
}

/**
 * A whole `export const <name> = …;` statement: it starts below the doc comment so prose above cannot satisfy a
 * field check, and runs to the terminating `;` so a field chained on in `.extend({…})` is inside what is checked.
 */
function schemaDeclaration(source: string, name: string): string {
	const signature = source.indexOf(`export const ${name} = `);
	expect(signature, `${name} is no longer an exported schema — §15.3 cites it`).toBeGreaterThanOrEqual(0);
	let depth = 0;
	for (let i = signature; i < source.length; i += 1) {
		const ch = source[i];
		if (ch === "{" || ch === "(" || ch === "[") depth += 1;
		else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
		else if (ch === ";" && depth === 0) return source.slice(signature, i + 1);
	}
	throw new Error(`unterminated declaration for ${name}`);
}

describe("spec §15.1 states the spawned/discovered environment split (R36-SPAWN.4)", () => {
	test("the section exists and is reachable from the sessions chapter", () => {
		const text = spec();
		const { heading } = section(text, "15.1");
		expect(heading.toLowerCase()).toContain("environment");
		const { body: sessions } = section(text, "12");
		expect(
			sessions,
			"§12 no longer points at §15.1/§15.2 — the statements are unreachable from the spawn chapter",
		).toMatch(/§15\.1[–-]§15\.2/);
	});

	test("it states that SPAWNED sessions get an environment built from nothing", () => {
		const { body } = section(spec(), "15.1");
		const p = paragraphWith(body, /SPAWNS/, "sessions geist spawns");
		expect(p).toMatch(/built from nothing/i);
		expect(p).toMatch(/\bPATH\b/);
		expect(p).toMatch(/buildChildEnvironment/);
		expect(p).toMatch(/spawn-primitive\.ts/);
	});

	test("it states that DISCOVERED sessions inherit the user's own shell environment and are out of scope", () => {
		const { body } = section(spec(), "15.1");
		const p = paragraphWith(body, /DISCOVERS/, "sessions geist discovers");
		expect(p, "the exemption does not say discovered sessions INHERIT").toMatch(/inherit/i);
		expect(p, "the exemption does not name the user's own shell as the source").toMatch(/shell/i);
		expect(p, "the exemption does not say it is BY CONSTRUCTION").toMatch(/by construction/i);
		expect(p, "the exemption does not say discovered sessions are OUT OF SCOPE").toMatch(/out of scope/i);
	});

	test("the exemption is stated as scope, not as a gap someone will close later", () => {
		const { body } = section(spec(), "15.1");
		const p = paragraphWith(body, /DISCOVERS/, "sessions geist discovers");
		expect(p, "the exemption is hedged into a temporary state").not.toMatch(
			/\b(for now|until we|todo|planned for|v2 will)\b/i,
		);
		expect(p, "the exemption gives the reader no action").toMatch(/spawn the session from the board/i);
	});

	test("what §15.1 says about the code is still true of the code", () => {
		const { body } = section(spec(), "15.1");
		assertNoLineCitations(body, "§15.1");

		const source = readFileSync(SPAWN_PRIMITIVE, "utf-8");
		for (const symbol of [
			"buildChildEnvironment",
			"DEFAULT_RESUME_PATH",
			"BASE_ENV_NAMES",
			"FORWARDED_PERMISSION_MODE_ENV",
			"DECLARED_CREDENTIAL_ENV",
			"NEVER_FORWARDED",
		]) {
			// Both halves unconditional on purpose: skipping the code check when the doc stops naming the symbol
			// let an ordinary prose rewrite disarm this loop entirely.
			expect(body.includes(symbol), `§15.1 no longer names ${symbol}; it must, or this guard is silent`).toBe(true);
			expect(source.includes(symbol), `§15.1 cites ${symbol}, which spawn-primitive.ts no longer defines`).toBe(
				true,
			);
		}

		const built = functionBody(source, "buildChildEnvironment");
		expect(
			built,
			"buildChildEnvironment spreads process.env — §15.1's 'built from nothing' is now false",
		).not.toMatch(/\.\.\.\s*process\.env/);

		const blocklist = source.slice(source.indexOf("const NEVER_FORWARDED"), source.indexOf("const ENV_NAME"));
		expect(blocklist.length, "NEVER_FORWARDED could not be located in spawn-primitive.ts").toBeGreaterThan(0);
		for (const name of ["PATH", "LD_", "DYLD_", "NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "IFS"]) {
			expect(
				body.includes(`\`${name}`),
				`§15.1 no longer names ${name}; the blocklist guard below is only as strong as the prose above it`,
			).toBe(true);
			expect(
				blocklist.includes(`"${name}"`),
				`§15.1 promises ${name} is never forwarded, but it is not in NEVER_FORWARDED`,
			).toBe(true);
		}
	});
});

describe("spec §15.2 states the registry's ownership and scope (R36-SPAWN.1, R36-SPAWN.3)", () => {
	test("its heading says the registry is user-owned and is the ONLY thing that names what may be launched", () => {
		const { heading } = section(spec(), "15.2");
		expect(heading).toMatch(/user-owned/i);
		expect(heading).toMatch(/only thing that names what may be launched/i);
	});

	test("it names the user-owned location and says the wire carries ids, not programs", () => {
		const { body } = section(spec(), "15.2");
		expect(body).toMatch(/~\/\.geist\/config\.yaml/);
		expect(body, "the doc does not say what a spawn frame actually carries").toMatch(/opaque ids/i);
		expect(body, "the doc does not say the wire carries no command or path").toMatch(/no path, no command/i);
	});

	test("it states plainly that the daemon reads NO project-supplied config", () => {
		const { body } = section(spec(), "15.2");
		const p = paragraphWith(body, /project-supplied/i, "project-supplied config");
		expect(p).toMatch(/no project-supplied config/i);
		expect(p, "the doc does not name the CLI resolver kept off the daemon path").toMatch(/resolveConfigPath/);
		expect(p).toMatch(/packages\/geist\/src\/index\.ts/);
		expect(p, "the doc does not say resolveConfigPath is not on the daemon path").toMatch(/not on the daemon path/i);
		expect(p, "a repo-local geist.yaml is no longer documented as IGNORED").toMatch(/\bignored\b/i);
		expect(p, "the doc now suggests the daemon merges a project config").not.toMatch(
			/\bmerged with\b|\bis merged\b/i,
		);
	});

	test("it states the per-load ownership check, and that it refuses rather than repairs", () => {
		const { body } = section(spec(), "15.2");
		const p = paragraphWith(body, /every load/i, "the per-load check");
		expect(p, "the doc does not say the check runs on EVERY load").toMatch(/every load/i);
		expect(p, "the doc does not say the path is lstat-walked before realpath").toMatch(/lstat/);
		expect(p, "the doc does not require CURRENT-uid ownership").toMatch(/current uid/i);
		expect(p, "the doc does not mention symbolic links").toMatch(/symbolic link/i);
		expect(p, "the doc does not say group/world ACCESSIBLE (the stronger rule), only writable").toMatch(
			/accessible/i,
		);
		expect(p, "the doc does not say the loader REFUSES").toMatch(/refus/i);
		expect(p, "the doc no longer says the loader never repairs the file").toMatch(
			/never chmods|rather than repairs/i,
		);
	});

	test("what §15.2 says about the code is still true of the code", () => {
		const { body } = section(spec(), "15.2");
		assertNoLineCitations(body, "§15.2");
		const geist = readFileSync(GEIST_INDEX, "utf-8");
		expect(
			geist.includes("export function resolveConfigPath"),
			"§15.2 names resolveConfigPath as the CLI-only resolver, but packages/geist/src/index.ts no longer exports it",
		).toBe(true);
	});

	test("the §9.1 config example does not contradict §15.2's absolute-path rule", () => {
		const { body: example } = section(spec(), "9.1");
		const cmds = [...example.matchAll(/\bcmd:\s*([^\s,}]+)/g)].map((m) => m[1] ?? "");
		expect(cmds.length, "§9.1 shows no launch specs at all").toBeGreaterThan(0);
		for (const cmd of cmds) {
			expect(
				cmd.startsWith("/"),
				`§9.1 shows a bare-PATH cmd "${cmd}" while §15.2 says every cmd is an absolute path`,
			).toBe(true);
		}
	});
});

/** Strings §15.3 says an id can never be: each reads as something a daemon might OPEN rather than look up. */
const OPENABLE = ["../../etc/passwd", "/bin/sh", "a/b", "..", "~/.ssh"];

/** Every field that sentence is about, as a predicate over one id with the REST of the frame valid. */
const ID_FIELDS: ReadonlyArray<readonly [string, (id: string) => boolean]> = [
	[
		"SessionSpawnFrameSchema.harnessId",
		(id) => SessionSpawnFrameSchema.safeParse({ type: "session_spawn", harnessId: id, projectId: "draht" }).success,
	],
	[
		"SessionSpawnFrameSchema.projectId",
		(id) => SessionSpawnFrameSchema.safeParse({ type: "session_spawn", harnessId: "claude", projectId: id }).success,
	],
	["RegistryHarnessSchema.id", (id) => RegistryHarnessSchema.safeParse({ id, isDefault: false }).success],
	["RegistryProjectSchema.id", (id) => RegistryProjectSchema.safeParse({ id, name: "p", root: "/p" }).success],
];

describe("spec §15.3 states the spawn verb's shape and its closed answer (R36-SPAWN.1)", () => {
	test("the section exists and is reachable from the protocol chapter", () => {
		const text = spec();
		const { heading } = section(text, "15.3");
		expect(heading).toMatch(/two ids, and nothing else/i);
		const { body: protocol } = section(text, "9.2");
		expect(protocol, "§9.2 no longer points at §15.3 — the verb is unreachable from the protocol table").toMatch(
			/`registry_resync`[^\n]*§15\.3|§15\.3[^\n]*`registry_resync`/,
		);
		assertNoLineCitations(protocol, "§9.2");
	});

	test("it states that a spawn carries two registry ids and NOTHING ELSE", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /SessionSpawnFrameSchema/, "the spawn frame");
		expect(p, "the doc no longer says the frame carries nothing beyond the two ids").toMatch(/nothing else/i);
		expect(p, "the doc no longer enumerates the fields that are absent").toMatch(
			/no path, no cwd, no argv, no environment/i,
		);
		expect(p, "the doc no longer names session_resume as built on the same rule").toMatch(/SessionResumeFrameSchema/);
		expect(p, "the doc no longer says a path field makes the RENDERER a party to what executes").toMatch(
			/party to what executes/i,
		);
		expect(p, "the doc no longer says this frame reaches a phone").toMatch(/this frame reaches a phone/i);
		expect(p, "the doc no longer names the schema that keeps an id from naming something openable").toMatch(
			/RegistryIdSchema/,
		);
	});

	test("nothing later in §15.3 hands back a field its opening sentence refuses", () => {
		const { body } = section(spec(), "15.3");
		const FIELD = "\\b(?:path|cwd|argv|env|command|working directory)\\b";
		const GRANT =
			"\\b(?:add|adds|send|sends|set|sets|supply|supplies|pass|passes|include|includes|override|overrides|permitted|allowed|accepted|supported)\\b";
		const grants = [
			new RegExp(`${GRANT}[^\\n]{0,60}?${FIELD}`, "i"),
			new RegExp(`${FIELD}[^\\n]{0,60}?${GRANT}`, "i"),
		];
		// Sentences that negate are the section's own claims; only an affirmative one can hand a field back.
		for (const sentence of body.split(/(?<=\.)\s+/)) {
			if (/\b(?:no|not|never|nothing|neither|cannot)\b/i.test(sentence)) continue;
			for (const grant of grants) {
				expect(
					sentence,
					"§15.3 now has a sentence granting a spawn frame one of the fields its opening sentence refuses",
				).not.toMatch(grant);
			}
		}
	});

	test("it states that one answer follows one spawn, and only when the answer is true", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /SessionSpawnCodeSchema/, "the answer frame");
		expect(p, "the doc no longer says exactly one answer follows exactly one spawn").toMatch(
			/exactly one `session_spawned` answers exactly one `session_spawn`/i,
		);
		expect(p, "the doc no longer forbids answering optimistically on receipt").toMatch(
			/never optimistically on receipt/i,
		);
	});

	test("it lists all six codes and says what each means to a person", () => {
		const { body } = section(spec(), "15.3");
		const codes = paragraphWith(body, /`spawn_failed`/, "the code list");
		// The second half of each pair is what stops a copy-pasted gloss from surviving: two codes that differ only
		// in which id was wrong read identically unless each names its own.
		const glossMustName: Record<string, RegExp> = {
			spawned: /fleet|board/i,
			unknown_harness: /\bharness\b/i,
			unknown_project: /\bproject\b/i,
			refused: /policy|revoked|unapproved/i,
			spawn_failed: /could not be started/i,
			timeout: /deadline/i,
		};
		for (const [code, mustName] of Object.entries(glossMustName)) {
			const gloss = codes.match(new RegExp(`\`${code}\` — ([^\\n]+)`))?.[1];
			expect(gloss, `§15.3 does not document the \`${code}\` code`).toBeDefined();
			expect(gloss ?? "", `§15.3's gloss for \`${code}\` does not say what it means`).toMatch(mustName);
		}
		expect(
			codes.match(/`unknown_harness` — ([^\n]+)/)?.[1] ?? "",
			"§15.3's unknown_harness gloss talks about the project id",
		).not.toMatch(/\bproject\b/i);
		expect(
			codes.match(/`unknown_project` — ([^\n]+)/)?.[1] ?? "",
			"§15.3's unknown_project gloss talks about the harness id",
		).not.toMatch(/\bharness\b/i);
	});

	test("the codes §15.3 lists are exactly the codes the answer frame can carry", () => {
		const { body } = section(spec(), "15.3");
		const codes = paragraphWith(body, /`spawn_failed`/, "the code list");
		const documented = [...codes.matchAll(/^- `([a-z_]+)` — /gm)].map((m) => m[1] ?? "");
		expect(
			documented.slice().sort(),
			"§15.3 says the code set is closed and lists it; SessionSpawnCodeSchema now answers with a different set",
		).toEqual([...SessionSpawnCodeSchema.options].sort());
	});

	test("it states that sessionId is present only on success, because the DAEMON mints it", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /sessionId/, "the minted session id");
		expect(p, "the doc no longer restricts sessionId to the success case").toMatch(
			/\bpresent \*{0,2}only when a process was started/i,
		);
		expect(p, "the doc no longer says the daemon mints the id").toMatch(/daemon mints it/i);
		expect(p, "the doc no longer names session_resumed as the frame this differs from").toMatch(/session_resumed/);
	});

	test("it states that the picker's data NEVER carries an executable path", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /RegistryFrameSchema/, "the registry frame");
		expect(p, "the doc no longer rules out an executable path on the registry frame").toMatch(
			/never an executable path/i,
		);
		expect(p, "the doc no longer says a harness row omits its cmd").toMatch(/never its `cmd`/i);
		expect(p, "the doc no longer explains why a project root DOES cross").toMatch(/`cwd`/);
		expect(p, "the doc no longer says the registry frame carries the two lists and nothing more").toMatch(
			/those two lists and no third thing/i,
		);
		expect(p, "the doc no longer says the resync asks for them with no fields at all").toMatch(
			/`RegistryResyncFrameSchema` asks for them with no fields at all/i,
		);
	});

	test("it states that discovery and recents are deliberately not spawnable in v1", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /recents/i, "discovery and recents");
		expect(p, "the doc no longer excludes scanned workspace roots from what a phone may spawn into").toMatch(
			/workspace roots/i,
		);
		expect(p, "the doc no longer says the picker shows the registry's own projects map").toMatch(
			/`projects` map in `~\/\.geist\/config\.yaml`/,
		);
		expect(p, "the exclusion is hedged into a temporary state").not.toMatch(/\b(for now|until we|todo)\b/i);
	});

	test("it tells a renderer to read the capabilities rather than probe for the verb", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /server_hello/, "the capability rule");
		expect(p, "the doc no longer names both capabilities a spawning renderer must find").toMatch(/`session-spawn`/);
		expect(p, "the doc no longer names the registry capability").toMatch(/`registry`/);
		expect(p, "the doc no longer says an undeclared type CLOSES the connection").toMatch(
			/the connection is \*{0,2}closed/i,
		);
		expect(p, "the doc no longer says a guessed verb costs the connection it was guessed on").toMatch(
			/pays for the guess/i,
		);
		expect(p, "the doc no longer separates a capability from what the connection has earned").toMatch(
			/never says the connection sending it has earned anything/i,
		);
	});

	test("it states that the absence of a stop verb is a decision, not an omission", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /stop verb/i, "the absent stop verb");
		expect(p, "the doc no longer states that the missing stop verb is a decision").toMatch(
			/no stop verb on the wire, and that is deliberate/i,
		);
		expect(p, "the doc no longer explains the 1.0 freeze that makes a wire stop expensive").toMatch(/geist\/1\.0/);
	});

	test("what §15.3 says about the wire is still true of the wire", () => {
		const { body } = section(spec(), "15.3");
		assertNoLineCitations(body, "§15.3");

		const wire = readFileSync(WIRE, "utf-8");
		for (const symbol of [
			"SessionSpawnFrameSchema",
			"SessionSpawnedFrameSchema",
			"SessionSpawnCodeSchema",
			"RegistryResyncFrameSchema",
			"RegistryFrameSchema",
			"RegistryHarnessSchema",
			"RegistryProjectSchema",
			"RegistryIdSchema",
		]) {
			// Both halves unconditional, as in §15.1: dropping the symbol from the prose must not disarm the code check.
			expect(body.includes(symbol), `§15.3 no longer names ${symbol}; it must, or this guard is silent`).toBe(true);
			expect(
				wire.includes(`export const ${symbol}`),
				`§15.3 cites ${symbol}, which packages/geist-protocol/src/wire.ts no longer exports`,
			).toBe(true);
		}

		const spawnFrame = schemaDeclaration(wire, "SessionSpawnFrameSchema");
		for (const field of ["path", "cwd", "argv", "command", "env"]) {
			expect(
				spawnFrame,
				`§15.3 promises a spawn frame carries no ${field}, but SessionSpawnFrameSchema declares one`,
			).not.toMatch(new RegExp(`\\b${field}\\s*:`, "i"));
		}

		for (const row of ["RegistryHarnessSchema", "RegistryProjectSchema"]) {
			expect(
				schemaDeclaration(wire, row),
				`§15.3 promises the registry names no executable, but ${row} declares one`,
			).not.toMatch(/\b(?:cmd|command|argv|exec|bin)\s*:/i);
		}
	});

	test("the spawn frame and its answer still have the shape §15.3 describes", () => {
		expect(
			Object.keys(SessionSpawnFrameSchema.shape).sort(),
			"§15.3 promises two ids and nothing else, but the spawn frame now declares another field",
		).toEqual(["harnessId", "projectId", "type"]);

		const smuggled = SessionSpawnFrameSchema.safeParse({
			type: "session_spawn",
			harnessId: "claude",
			projectId: "draht",
			cwd: "/etc",
			path: "/bin/sh",
		});
		expect(
			smuggled.success && "cwd" in smuggled.data,
			"§15.3 promises the daemon resolves the cwd itself, but a caller-supplied one now survives decoding",
		).toBe(false);

		expect(
			ClientFrameSchema.safeParse({ type: "session_spawn", harnessId: "claude", projectId: "draht" }).success,
			"§15.3 documents a verb no client can send — session_spawn is not decodable as a client frame",
		).toBe(true);

		expect(
			SessionSpawnedFrameSchema.shape.sessionId.isOptional(),
			"§15.3 says sessionId is present only when a process was started, but the answer frame now requires one",
		).toBe(true);
	});

	test("the registry frame still carries two lists of ids and nothing executable", () => {
		expect(
			Object.keys(RegistryFrameSchema.shape).sort(),
			"§15.3 promises the registry frame carries those two lists and no third thing",
		).toEqual(["harnesses", "projects", "type"]);

		expect(
			Object.keys(RegistryHarnessSchema.shape).sort(),
			"§15.3 promises a harness row names a harness and whether it is the default, and never its cmd",
		).toEqual(["id", "isDefault"]);

		expect(
			Object.keys(RegistryProjectSchema.shape).sort(),
			"§15.3 promises the picker's data is never an executable path, but a project row now declares one",
		).toEqual(["id", "name", "root"]);

		for (const openable of OPENABLE) {
			expect(
				RegistryIdSchema.safeParse(openable).success,
				`§15.3 says an id cannot be mistaken for something the daemon might open, but "${openable}" is a valid id`,
			).toBe(false);
		}
		expect(
			RegistryIdSchema.safeParse("claude-code").success,
			"RegistryIdSchema no longer accepts an ordinary registry id, so the checks above prove nothing",
		).toBe(true);
	});

	// The check above proves only that the SYMBOL is strict, which is not what §15.3 claims. Both halves below
	// fail to different edits: the behaviour is the claim, and the citation is where the reader was sent.
	// Identity (`shape.harnessId === RegistryIdSchema`) is neither — it passes a reference that constrains
	// nothing and fails a `.describe()` that changes nothing.
	test("the ids §15.3 constrains are constrained IN THE FIELDS, and by the schema it names", () => {
		// Both loops are vacuous over an empty list; the counts are what the loops cannot assert about themselves.
		expect(OPENABLE.length, "OPENABLE was emptied — every refusal check in this file now proves nothing").toBe(5);
		expect(ID_FIELDS.length, "a field dropped from ID_FIELDS is a field nothing here checks").toBe(4);
		for (const [field, accepts] of ID_FIELDS) {
			for (const openable of OPENABLE) {
				expect(
					accepts(openable),
					`§15.3 says neither id can be mistaken for something the daemon might open, but ${field} accepts "${openable}"`,
				).toBe(false);
			}
			expect(
				accepts("claude-code"),
				`${field} no longer accepts an ordinary registry id, so the refusals above prove nothing`,
			).toBe(true);
		}

		const wire = readFileSync(WIRE, "utf-8");
		for (const [field] of ID_FIELDS) {
			const [schema, key] = field.split(".");
			expect(
				schemaDeclaration(wire, schema ?? ""),
				`§15.3 sends the reader to RegistryIdSchema for ${field}, which no longer declares it with that schema`,
			).toMatch(new RegExp(`\\b${key}:\\s*RegistryIdSchema\\b`));
		}
	});

	test("registry_resync asks for the registry with no fields at all", () => {
		// `parse` proves nothing here: it drops UNDECLARED keys either way, so a declared filter survives it.
		expect(
			Object.keys(RegistryResyncFrameSchema.shape),
			"§15.3 promises registry_resync asks with no fields at all, but it now declares one",
		).toEqual(["type"]);
	});
});

const SETTINGS: GatewaySettings = {
	port: 0,
	host: "127.0.0.1",
	tokens: {},
	allowedPaths: ["~/"],
	maxSessions: 100,
	idleTimeout: 255,
};

/** Wording that would turn a statement about v1 into a promise about later. */
const PROMISE =
	/\b(?:will be (?:fixed|supported|resolved|changed|allowed)|will follow|soon|in a future (?:release|version))\b/i;

const dirs: string[] = [];

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Directly under /tmp, canonical: the registry loader refuses a symbolic link anywhere above the file. */
function tempDir(): string {
	const dir = realpathSync(mkdtempSync("/tmp/sdc-"));
	dirs.push(dir);
	return dir;
}

function clause(text: string, pattern: RegExp, missing: string): RegExpMatchArray {
	const hit = text.match(pattern);
	if (hit === null) throw new Error(missing);
	return hit;
}

/** A markdown heading line to the next heading of the same or a higher level, with line wrapping undone. */
function headingBody(text: string, heading: string): string {
	const lines = text.split("\n");
	const start = lines.indexOf(heading);
	expect(start, `no "${heading}" heading — the statements under it were deleted`).toBeGreaterThanOrEqual(0);
	const level = heading.match(/^#+/)?.[0].length ?? 1;
	const next = new RegExp(`^#{1,${level}} `);
	let end = lines.length;
	let fenced = false;
	for (let i = start + 1; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		// A `# comment` inside a code block is a shell comment, not a heading.
		if (line.startsWith("```")) fenced = !fenced;
		else if (!fenced && next.test(line)) {
			end = i;
			break;
		}
	}
	return lines
		.slice(start + 1, end)
		.join("\n")
		.replace(/\s+/g, " ");
}

describe("spec §15.2 states where the daemon looks for the registry, and when it offers to spawn (R36-SPAWN.1)", () => {
	test("it names --registry, requires an absolute path, and makes a relative one a startup error", () => {
		const { body } = section(spec(), "15.2");
		const p = paragraphWith(body, /--registry/, "the registry flag");
		expect(p, "the doc no longer names the flag that points the daemon at a registry").toMatch(
			/`--registry <absolute path>` names the file/,
		);
		expect(p, "the doc no longer says a relative path is refused").toMatch(/a relative path is a startup error/);
	});

	test("it says the default is the user's home and never the current directory", () => {
		const { body } = section(spec(), "15.2");
		const p = paragraphWith(body, /--registry/, "the registry flag");
		expect(p, "the doc no longer says what the daemon reads with no flag").toMatch(
			/With no flag the daemon uses `~\/\.geist\/config\.yaml` under its own HOME, and never the current directory/,
		);
	});

	test("it says spawning is offered per connection, only while something is at the path, with no restart", () => {
		const { body } = section(spec(), "15.2");
		const p = paragraphWith(body, /--registry/, "the registry flag");
		expect(p).toMatch(/decided per `\/attach` connection by whether anything is at that path, links not followed/);
		expect(p, "the doc no longer says an absent registry offers no capability").toMatch(
			/With nothing there the daemon advertises neither `session-spawn` nor `registry`/,
		);
		expect(p, "the doc no longer says a registry written later is offered without a restart").toMatch(
			/The first connection after a file appears is offered both, with no restart/,
		);
		expect(p, "the doc no longer says the absence is announced once at start").toMatch(
			/logs one notice at start that names the path/,
		);
		expect(p, "the doc now says a restart is needed").not.toMatch(
			/\b(?:requires?|needs?) a restart\b|\b(?:after|until) a restart\b/i,
		);
	});

	test("it says a registry that is there but refused is still offered, and the refusal names the rule", () => {
		const { body } = section(spec(), "15.2");
		const p = paragraphWith(body, /--registry/, "the registry flag");
		expect(p).toMatch(/A file that is there but will be refused still offers both/);
		expect(p, "the doc no longer says the spawn is answered with the rule").toMatch(
			/`session_spawn` is then answered `refused` with the rule named/,
		);
		expect(p, "the doc no longer admits the picker gets no reason").toMatch(
			/a `registry_resync` against it answers two empty lists, since the `registry` frame has no field to carry a reason/,
		);
	});

	test("what it says about the flag and the path is still true of the daemon", () => {
		const absolute = "/srv/example/registry.yaml";
		expect(parseArgs(["--registry", absolute, "--auth", "t"], SETTINGS).registryPath).toBe(absolute);
		expect(parseArgs(["--auth", "t"], SETTINGS).registryPath).toBeUndefined();
		expect(
			() => parseArgs(["--registry", "geist.yaml", "--auth", "t"], SETTINGS),
			"§15.2 says a relative --registry is a startup error",
		).toThrow("--registry must be an absolute path, got: geist.yaml");

		const home = "/srv/example/home";
		expect(
			userRegistry({ home }).path,
			"§15.2 says the default is ~/.geist/config.yaml under the daemon's own HOME",
		).toBe(join(home, ".geist", "config.yaml"));
	});

	test("offering follows what is at the path: absent, then a file, then a link that points nowhere", () => {
		const dir = tempDir();
		const path = join(dir, "config.yaml");
		const registry = userRegistry({ explicit: path });
		expect(registry.present(), "§15.2 says nothing at the path offers no capability").toBe(false);

		writeFileSync(path, "{}", { mode: 0o600 });
		expect(registry.present(), "§15.2 says a file written later is offered by the same daemon, with no restart").toBe(
			true,
		);

		rmSync(path);
		symlinkSync(join(dir, "nowhere"), path);
		expect(registry.present(), "§15.2 says the path is looked at with links not followed").toBe(true);
	});
});

describe("spec §15.3 states what v1 will spawn, and what the example does and does not claim (R36-SPAWN.1, R36-SPAWN.7)", () => {
	test("it states that only the draht harness is spawnable, and the others are declared but not offered", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /V1_SPAWNABLE_HARNESS_IDS/, "the spawnable set");
		expect(p, "the doc no longer says which harness a spawn can start").toMatch(
			/In v1 only the `draht` harness is spawnable \(`V1_SPAWNABLE_HARNESS_IDS`\)/,
		);
		expect(p, "the doc no longer says what becomes of a declared harness that is not spawnable").toMatch(
			/The other harnesses may be declared in the registry, but they are not offered in `registry`, and a spawn naming one is answered `unknown_harness` at once/,
		);
		expect(p, "the doc now says every harness the registry declares can be spawned").not.toMatch(
			/\b(?:every|all) (?:declared |configured )?harnesses?\b[^.]{0,40}\b(?:is|are) spawnable/i,
		);
	});

	test("it lists the unspawnable-but-declared case under unknown_harness, and the unreadable registry under refused", () => {
		const { body } = section(spec(), "15.3");
		const codes = paragraphWith(body, /`spawn_failed`/, "the code list");
		expect(
			codes.match(/`unknown_harness` — ([^\n]+)/)?.[1] ?? "",
			"§15.3 no longer says a declared harness that is not offered is unknown_harness",
		).toMatch(/or one it declares but does not offer for spawning/);
		const refused = codes.match(/`refused` — ([^\n]+)/)?.[1] ?? "";
		expect(refused, "§15.3 no longer says a registry the daemon refused or could not parse is `refused`").toMatch(
			/a registry file the daemon refused to read or could not parse \(the message names the rule\)/,
		);
		expect(refused, "§15.3 no longer says `refused` also covers an executable the daemon will not run").toMatch(
			/a harness executable it will not run/,
		);
	});

	test("it says the draht entry names the draht CLI, not the shim, because a spawn appends draht's flags", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /draht-acp/, "the ACP shim");
		expect(p, "the doc no longer says what the spawnable entry must name").toMatch(
			/The `draht` entry must name the draht CLI, because a spawn runs the executable with draht's own flags appended/,
		);
		expect(p, "the doc no longer says why the shim cannot be spawned").toMatch(
			/`draht-acp` is the ACP stdio shim and publishes no attachable socket/,
		);
		expect(p, "the doc now tells the operator to point `draht` at the shim").not.toMatch(
			/`draht` entry (?:must|should|can) name (?:the )?(?:ACP )?(?:stdio )?(?:shim|`draht-acp`)/i,
		);
	});

	test("it says a session started from the phone starts untrusted, spawn and resume alike, and what that costs a resume", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /starts untrusted/, "the untrusted start");
		expect(p, "the doc no longer says a resume starts untrusted like a spawn").toMatch(
			/A session started from the phone starts untrusted, whether it is a spawn or a resume\./,
		);
		expect(p, "the doc no longer names the flag both verbs put on the argv").toMatch(
			/Both put `--no-approve` on the argv \(`NO_APPROVE_FLAG`\)/,
		);
		expect(p, "the doc no longer lists what a standing grant fails to load").toMatch(
			/the project's extensions \(`\.draht\/extensions`\), `\.draht\/settings\.json`, `\.draht\/SYSTEM\.md` or `\.agents\/skills`/,
		);
		expect(p, "the doc no longer states the cost to a resumed session").toMatch(
			/a session you resume from the phone no longer loads those resources, even in a repository you trust locally/,
		);
		expect(p, "the doc hedges the untrusted start into a future change").not.toMatch(PROMISE);
	});

	test("what it says about the untrusted start is still true of the code: one flag, on both argvs", () => {
		const { body } = section(spec(), "15.3");
		expect(body.includes("NO_APPROVE_FLAG"), "§15.3 no longer names NO_APPROVE_FLAG").toBe(true);
		expect(NO_APPROVE_FLAG, "§15.3 promises `--no-approve`, which spawn-argv.ts no longer defines").toBe(
			"--no-approve",
		);

		const spawnArgv = buildSpawnArgv({ sessionId: "sdc-session", projectRoot: "/srv/alpha", leadingArgs: [] });
		expect(spawnArgv, "a spawn no longer starts untrusted").toContain(NO_APPROVE_FLAG);

		const source = readFileSync(SPAWN_PRIMITIVE, "utf-8");
		const start = source.indexOf("async resume(session");
		const end = source.indexOf("async launch(");
		expect(start, "SessionSpawner.resume could not be located in spawn-primitive.ts").toBeGreaterThanOrEqual(0);
		expect(end, "SessionSpawner.launch could not be located in spawn-primitive.ts").toBeGreaterThan(start);
		expect(source.slice(start, end), "a resume no longer starts untrusted").toContain("NO_APPROVE_FLAG");
	});

	test("it admits the map's ACP use is unresolved rather than claiming one entry serves both contracts", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /draht-acp/, "the ACP shim");
		expect(p, "the doc no longer says the same map is also the ACP launch-spec table").toMatch(
			/The same `harness\.agents` map is also the ACP launch-spec table of the dormant `geist-acp`/,
		);
		expect(p, "the doc no longer states what v1 does").toMatch(
			/In v1 the spawnable `draht` entry names the draht CLI/,
		);
		expect(p, "the doc no longer says the ACP use is open").toMatch(
			/how one map serves both launch contracts is unresolved\./,
		);
		expect(p, "the open question is tied to a phase again").not.toMatch(/\bPhase \d+\b/);
	});

	test("it says the installed draht symlink is refused, gives the workaround, and promises nothing", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /~\/\.local\/bin\/draht/, "the installed draht");
		expect(p, "the doc no longer says the installed draht cannot be declared").toMatch(
			/The installed `~\/\.local\/bin\/draht` cannot be declared/,
		);
		expect(p, "the doc no longer names the symlink chain that causes it").toMatch(
			/`install\.sh` makes it a symbolic link to `~\/\.draht\/runtime\/current\/draht`, and `current` is itself a symbolic link/,
		);
		expect(p, "the doc no longer states the workaround").toMatch(
			/The workaround is to declare a path that contains no symbolic link, under an approved root/,
		);
		expect(p, "the doc promises a change to the no-follow rule").not.toMatch(PROMISE);
	});

	test("it says an executable inside any declared project root is refused", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /inside any declared project root/, "the project-root rule");
		expect(p).toMatch(
			/A harness executable inside any declared project root is refused\*{0,2}, not only one inside the project being spawned into/,
		);
		expect(p, "the doc no longer says why the rule spans every project").toMatch(
			/a binary in project A is A's code in every spawn, B's included/,
		);
	});

	test("it states the two deadlines as numbers, and what each one does", () => {
		const { body } = section(spec(), "15.3");
		const p = paragraphWith(body, /DEFAULT_HANDSHAKE_DEADLINE_MS/, "the deadlines");
		expect(p, "the doc no longer says what happens when the handshake deadline passes").toMatch(
			/past that it is stopped and the answer is `timeout`/,
		);
		expect(p, "the doc no longer says the stop is TERM and then KILL to the group").toMatch(
			/A stop is `SIGTERM` to the process group, then `SIGKILL` to the group after \d+ seconds/,
		);
	});

	test("what §15.3 says about the spawnable set and the deadlines is still true of the code", () => {
		const { body } = section(spec(), "15.3");
		expect(body.includes("V1_SPAWNABLE_HARNESS_IDS"), "§15.3 no longer names V1_SPAWNABLE_HARNESS_IDS").toBe(true);

		const sentence = clause(
			body,
			/In v1 only the ((?:`[a-z0-9-]+`(?:, | and )?)+) harness(?:es)? (?:is|are) spawnable \(`V1_SPAWNABLE_HARNESS_IDS`\)/,
			"§15.3 no longer lists the spawnable ids in the sentence this check reads",
		);
		const named = [...(sentence[1] ?? "").matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1] ?? "");
		const exported: unknown = V1_SPAWNABLE_HARNESS_IDS;
		expect(
			Array.isArray(exported),
			"§15.3 cites V1_SPAWNABLE_HARNESS_IDS, which session-launcher.ts no longer exports",
		).toBe(true);
		expect(
			named.slice().sort(),
			"§15.3 names a different set of spawnable harnesses than the daemon passes its launcher",
		).toEqual([...V1_SPAWNABLE_HARNESS_IDS].sort());

		const handshake = clause(
			body,
			/has (\d+) seconds to publish its socket and join the fleet \(`DEFAULT_HANDSHAKE_DEADLINE_MS`\)/,
			"§15.3 no longer states the handshake deadline in the sentence this check reads",
		);
		const stop = clause(
			body,
			/then `SIGKILL` to the group after (\d+) seconds \(`DEFAULT_STOP_DEADLINE_MS`\)/,
			"§15.3 no longer states the stop deadline in the sentence this check reads",
		);
		expect(Number(handshake[1]) * 1000, "§15.3 states a handshake deadline the spawner does not use").toBe(
			spawnPrimitive.DEFAULT_HANDSHAKE_DEADLINE_MS,
		);
		expect(Number(stop[1]) * 1000, "§15.3 states a stop deadline the spawner does not use").toBe(
			spawnPrimitive.DEFAULT_STOP_DEADLINE_MS,
		);
	});
});

describe("geist.yaml.example and spec §9.1 give an honest spawnable entry (R36-SPAWN.1, R36-SPAWN.3)", () => {
	const drahtCmd = (text: string): string | undefined => text.match(/^\s*draht:\s*\{\s*cmd:\s*([^\s,}]+)/m)?.[1];

	test("§9.1 and the example agree that draht names the draht CLI, not the shim", () => {
		const shown = drahtCmd(section(spec(), "9.1").body);
		const shipped = drahtCmd(readFileSync(EXAMPLE, "utf-8"));
		expect(shown, "§9.1 shows no draht entry").toBeDefined();
		expect(shown, "§9.1 and geist.yaml.example show different draht entries").toBe(shipped);
		expect(shown, "the draht entry names the ACP shim, which a spawn cannot wait on").not.toMatch(/draht-acp$/);
		expect(shown).toMatch(/\/dist\/cli\.js$/);
	});

	test("§9.1 says the entry is the draht CLI and sends the reader to §15.3 for the ACP conflict", () => {
		const { body } = section(spec(), "9.1");
		expect(body).toMatch(
			/The `draht` entry names the draht CLI, not the `draht-acp` shim, because a spawn runs it with draht's own flags appended\./,
		);
		expect(body, "§9.1 no longer points at §15.3 for the ACP conflict").toMatch(
			/§15\.3 states the conflict this leaves with the ACP launch-spec table\./,
		);
		expect(body, "§9.1 restates the ACP conflict §15.3 owns").not.toMatch(/unresolved/);
	});

	test("the example says the same, and says the shipped entries are not all spawnable", () => {
		const text = readFileSync(EXAMPLE, "utf-8")
			.replace(/^\s*#\s?/gm, "")
			.replace(/\s+/g, " ");
		expect(text).toMatch(/ONLY `draht` IS SPAWNABLE IN v1/);
		expect(text, "the example no longer says the entry names the CLI, not the shim").toMatch(
			/this entry names the draht CLI, not the `draht-acp` shim/,
		);
		expect(text).toMatch(/`--registry <absolute path>`/);
		expect(text, "the example no longer says the ACP-only entries are answered unknown_harness").toMatch(
			/a spawn naming one is answered `unknown_harness`/,
		);
		expect(text, "the example no longer says the ACP conflict is open, or ties it to a phase").toMatch(
			/That conflict is unresolved\./,
		);
		expect(text).not.toMatch(/\bPhase \d+\b/);
	});

	test("the example loads through the real loader, and only its draht entry resolves to a launch", () => {
		const home = join(tempDir(), "home");
		const cli = join(home, "dev", "draht-mono", "packages", "coding-agent", "dist", "cli.js");
		mkdirSync(join(cli, ".."), { recursive: true });
		writeFileSync(cli, "", { mode: 0o644 });
		for (const project of ["fr3n", "kintura"]) mkdirSync(join(home, "dev", project), { recursive: true });
		const registryDir = join(home, ".geist");
		mkdirSync(registryDir, { mode: 0o700 });
		chmodSync(registryDir, 0o700);
		const file = join(registryDir, "config.yaml");
		writeFileSync(file, readFileSync(EXAMPLE, "utf-8").replaceAll("/Users/you", home), { mode: 0o600 });

		const { load } = userRegistry({ explicit: file });
		expect(load().harness.agents.draht?.cmd).toBe(cli);

		const options = { registry: load, spawnableHarnessIds: V1_SPAWNABLE_HARNESS_IDS };
		const launch = resolveHarnessLaunch("draht", "fr3n", options);
		expect(launch.leadingArgs[0], "the example's draht entry is refused: approvedRoots no longer covers it").toBe(
			realpathSync(cli),
		);
		expect(launch.projectRoot).toBe(join(home, "dev", "fr3n"));

		for (const harness of ["claude", "codex", "gemini"]) {
			let refusal: unknown;
			try {
				resolveHarnessLaunch(harness, "fr3n", options);
			} catch (error) {
				refusal = error;
			}
			expect(refusal, `${harness} resolved, but the example says it is not spawnable in v1`).toBeInstanceOf(
				HarnessResolutionError,
			);
			expect((refusal as HarnessResolutionError).code).toBe("unknown_harness");
			expect((refusal as HarnessResolutionError).message).toMatch(/declared but not spawnable/);
		}
	});
});

describe("the gateway README and SPEC.md say what the daemon now does", () => {
	const readme = (): string => readFileSync(README, "utf-8");

	test("README: 'What it does' no longer claims the gateway owns an agent's stdin and stdout", () => {
		const text = headingBody(readme(), "## What it does");
		expect(text, "the README still says the gateway spawns on demand").not.toMatch(
			/Spawns draht agent processes on demand/,
		);
		expect(text, "the README still says the gateway streams stdout").not.toMatch(/Streams agent stdout/);
		expect(text, "the README still says the gateway forwards stdin").not.toMatch(/Forwards client stdin/);
		expect(text).toMatch(/no HTTP route creates a process/);
		expect(text).toMatch(/starting a new one \(`session_spawn`\)/);
	});

	test("README: Usage names --registry as an absolute path whose default is the home directory, and defers to the spec", () => {
		const text = headingBody(readme(), "## Usage");
		expect(text, "the README Usage no longer shows --registry").toMatch(
			/bun src\/cli\.ts --registry \/home\/you\/\.geist\/config\.yaml --auth <your-token>/,
		);
		expect(text, "the README no longer says what --registry names and what the default is").toMatch(
			/`--registry <absolute path>` names the registry file; without it the daemon reads `~\/\.geist\/config\.yaml` and never the current directory\./,
		);
		expect(text, "the README no longer sends the reader to the spec for the rest").toMatch(
			/The contract is `docs\/geist\/spec\.md` §15\.2 and §15\.3/,
		);
	});

	test("README: the Adler section says input answers 409 and work starts with session_spawn", () => {
		const text = headingBody(readme(), "### Creating Sessions from Adler");
		expect(text, "the README still says the first input spawns a process").not.toMatch(
			/spawned by the gateway on the first/,
		);
		expect(text).toMatch(/`POST \/sessions\/:id\/input` answers \*\*409\*\*/);
		expect(text).toMatch(/Work starts with `session_spawn` on `\/attach`/);
	});

	test("SPEC.md: the gateway no longer owns an agent process or its output", () => {
		const text = readFileSync(GATEWAY_SPEC, "utf-8").replace(/\s+/g, " ");
		expect(text, "SPEC.md still says the gateway spawns and manages agent processes").not.toMatch(
			/- Spawns and manages draht coding agent processes/,
		);
		expect(text, "SPEC.md still says the gateway streams an agent's stdout").not.toMatch(
			/Streams agent output \(stdout\/events\)/,
		);
		expect(text).toMatch(/No HTTP route creates a process/);
		expect(text).toMatch(/the gateway does not own its stdout/);
	});
});
