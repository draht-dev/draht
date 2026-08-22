/**
 * R36-SPAWN.4 and R36-SPAWN.1/.3 each end in a clause only docs can satisfy. This file guards
 * `docs/geist/spec.md` §15.1/§15.2 in two layers: the statements are there, and they are still true of the code.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const SPEC = join(REPO, "docs", "geist", "spec.md");
const SPAWN_PRIMITIVE = join(REPO, "packages", "gateway", "src", "session", "spawn-primitive.ts");
const GEIST_INDEX = join(REPO, "packages", "geist", "src", "index.ts");

const spec = (): string => readFileSync(SPEC, "utf-8");

/** The body of one `### <number> …` section: its heading to the next heading of the same or a higher level. */
function section(text: string, number: string): { heading: string; body: string } {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`### ${number} `));
	expect(
		start,
		`docs/geist/spec.md has no "### ${number}" section — the statement it carries was deleted`,
	).toBeGreaterThanOrEqual(0);
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i += 1) {
		if (/^#{1,3} /.test(lines[i] ?? "")) {
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
		`"### ${number}" is inside an unclosed HTML comment — the section renders as nothing, so nothing is "stated in the docs"`,
	).toBe(closed);
	expect(body, `"### ${number}" opens an HTML comment it never closes`).not.toMatch(/<!--(?![\s\S]*-->)/);

	return { heading: lines[start] ?? "", body };
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

describe("spec §15.1 states the spawned/discovered environment split (R36-SPAWN.4)", () => {
	test("the section exists and is reachable from the sessions chapter", () => {
		const text = spec();
		const { heading } = section(text, "15.1");
		expect(heading.toLowerCase()).toContain("environment");
		expect(
			text,
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
		const text = spec();
		const example = text.slice(text.indexOf("### 9.1 Config"), text.indexOf("### 9.2 "));
		expect(example.length, "§9.1 could not be located").toBeGreaterThan(0);
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
