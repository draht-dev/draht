/**
 * R36-SPAWN.4 and R36-SPAWN.1/.3 each end in a clause no code can satisfy: the
 * environment exemption and the registry's scope must be **stated in the docs**.
 * Before this file, both statements lived in `.planning/phases/35-default-on/PLAN.md`
 * and in the module comment of `spawn-primitive.ts` — a planning file nobody
 * operating this daemon reads, and a comment you have to already be inside the
 * implementation to find. This file is the failing mode of that clause.
 *
 * It guards `docs/geist/spec.md` §15.1 and §15.2 in two layers, because either
 * one alone is a gate with a hole in it:
 *
 *  1. **The statements are there.** Each section is located by its heading and
 *     asserted on its OWN body, so a phrase that happens to appear elsewhere in
 *     a 250-line spec cannot stand in for a deleted section. The anchors are the
 *     requirements' own load-bearing words — "out of scope", "no project-supplied
 *     config", "every load" — not prose that ordinary editing would touch.
 *  2. **The statements are still TRUE of the code they describe.** A doc is a
 *     claim about a system, and a claim nobody re-checks decays into a lie that
 *     reads authoritatively. So the symbols §15.1 cites are asserted to exist in
 *     `spawn-primitive.ts`, `buildChildEnvironment` is asserted to still contain
 *     no `...process.env`, every name the doc says is blocked is asserted to be
 *     in `NEVER_FORWARDED`, and `resolveConfigPath` — which §15.2 names as the
 *     resolver deliberately kept OFF the daemon path — is asserted to still
 *     exist under that name in `packages/geist/src/index.ts`. Layer 2 is what
 *     stops this from being a spell-checker.
 *
 * DELIBERATE DEVIATION FROM THE TASK BRIEF, and it is enforced below: the doc
 * cites implementation by SYMBOL, never by `file.ts:390`. Three tasks are
 * editing `spawn-primitive.ts` across this phase's waves; a line number written
 * into a public-facing spec is wrong before the phase lands, and a wrong
 * citation is worse than none because it sends a reader to unrelated code.
 * `assertNoLineCitations` keeps the next editor honest about that.
 *
 * **Evidence class 2** (`.planning/TEST-STRATEGY.md`): this file reads files off
 * disk. It spawns nothing. The behaviour these documents describe is proven by
 * the spawn suites; what is proven HERE is only that the documents say it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `packages/gateway/src/__tests__` → the repo root. */
const REPO = join(import.meta.dir, "..", "..", "..", "..");
const SPEC = join(REPO, "docs", "geist", "spec.md");
const SPAWN_PRIMITIVE = join(REPO, "packages", "gateway", "src", "session", "spawn-primitive.ts");
const GEIST_INDEX = join(REPO, "packages", "geist", "src", "index.ts");

const spec = (): string => readFileSync(SPEC, "utf-8");

/**
 * The body of one `### <number> …` section: everything from its heading to the
 * next heading of the same or a higher level.
 *
 * Sectioning matters. `expect(wholeSpec).toMatch(/out of scope/)` passes for a
 * spec that says it about something else entirely, and keeps passing after the
 * section this file exists to protect has been deleted.
 */
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

	// A HEADING IS NOT A STATEMENT. This scans raw lines, so `<!--` before the
	// heading and `-->` after the section leaves every assertion below green
	// while the requirement's "stated in the docs" clause is false: GitHub and
	// every other viewer render exactly nothing. Measured — wrapping §15.1
	// through §15.2 in one comment kept this file at 11 pass / 0 fail.
	//
	// Counting delimiters over the whole prefix is what catches it: an unclosed
	// `<!--` anywhere above this heading means the heading itself is inside a
	// comment, however far away the opener is.
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

/** The paragraph of `body` that mentions `needle`, so a claim can be asserted whole. */
function paragraphWith(body: string, needle: RegExp, label: string): string {
	const paragraphs = body.split(/\n\s*\n/);
	const hit = paragraphs.find((p) => needle.test(p));
	expect(hit, `no paragraph in this section mentions ${label}`).toBeDefined();
	return hit ?? "";
}

/** A citation like `spawn-primitive.ts:390` rots; see the header. */
function assertNoLineCitations(body: string, where: string): void {
	const rotten = body.match(/[A-Za-z0-9_-]+\.ts:\d+/g) ?? [];
	expect(
		rotten,
		`${where} cites source by line number (${rotten.join(", ")}); cite the symbol instead — three tasks edit these files this phase`,
	).toEqual([]);
}

/** The body of a top-level `export function <name>(…) {…}`, by brace matching. */
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

// ---------------------------------------------------------------------------
// R36-SPAWN.4 — the environment exemption
// ---------------------------------------------------------------------------

describe("spec §15.1 states the spawned/discovered environment split (R36-SPAWN.4)", () => {
	test("the section exists and is reachable from the sessions chapter", () => {
		const text = spec();
		const { heading } = section(text, "15.1");
		expect(heading.toLowerCase()).toContain("environment");
		// §12 is where a reader looking for spawn semantics lands first.
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
		// All three clauses in ONE paragraph: an "out of scope" floating three
		// paragraphs away from "discovers" is not the statement the requirement
		// asked for.
		const p = paragraphWith(body, /DISCOVERS/, "sessions geist discovers");
		expect(p, "the exemption does not say discovered sessions INHERIT").toMatch(/inherit/i);
		expect(p, "the exemption does not name the user's own shell as the source").toMatch(/shell/i);
		expect(p, "the exemption does not say it is BY CONSTRUCTION").toMatch(/by construction/i);
		expect(p, "the exemption does not say discovered sessions are OUT OF SCOPE").toMatch(/out of scope/i);
	});

	test("the exemption is stated as scope, not as a gap someone will close later", () => {
		const { body } = section(spec(), "15.1");
		const p = paragraphWith(body, /DISCOVERS/, "sessions geist discovers");
		// A "for now" turns a scope statement into a promise, and a promise in a
		// spec is what a later reader files a bug against.
		expect(p, "the exemption is hedged into a temporary state").not.toMatch(
			/\b(for now|until we|todo|planned for|v2 will)\b/i,
		);
		// And it must tell the reader what to do instead, or it is a disclaimer.
		expect(p, "the exemption gives the reader no action").toMatch(/spawn the session from the board/i);
	});

	test("what §15.1 says about the code is still true of the code", () => {
		const { body } = section(spec(), "15.1");
		assertNoLineCitations(body, "§15.1");

		const source = readFileSync(SPAWN_PRIMITIVE, "utf-8");
		// Every symbol the section names must exist, or the doc is sending a
		// reader to something that is not there.
		for (const symbol of [
			"buildChildEnvironment",
			"DEFAULT_RESUME_PATH",
			"BASE_ENV_NAMES",
			"DECLARED_CREDENTIAL_ENV",
			"NEVER_FORWARDED",
		]) {
			// UNCONDITIONAL, AND IN THIS DIRECTION ON PURPOSE. `if (!body.includes(…))
			// continue` let an ordinary prose rewrite delete the guard: a §15.1 that
			// keeps every asserted phrase but drops the backticked symbol names left a
			// gutted NEVER_FORWARDED passing 11/0, with the expect() count quietly
			// falling 69 → 58 as the only trace. The doc must NAME the symbol, and the
			// code must HAVE it — neither half optional.
			expect(body.includes(symbol), `§15.1 no longer names ${symbol}; it must, or this guard is silent`).toBe(true);
			expect(source.includes(symbol), `§15.1 cites ${symbol}, which spawn-primitive.ts no longer defines`).toBe(
				true,
			);
		}

		// The doc's central claim about the built environment, checked against
		// the function rather than believed.
		const built = functionBody(source, "buildChildEnvironment");
		expect(
			built,
			"buildChildEnvironment spreads process.env — §15.1's 'built from nothing' is now false",
		).not.toMatch(/\.\.\.\s*process\.env/);

		// Every name §15.1 tells an operator is refused had better be refused.
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

// ---------------------------------------------------------------------------
// R36-SPAWN.1 / R36-SPAWN.3 — the registry is user-owned and names what launches
// ---------------------------------------------------------------------------

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
		// The vacuous-satisfaction trap: R36-SPAWN.3's second clause is met
		// because no project config is read AT ALL. If that ever softens into
		// "a project config may name only approved ids", this assertion is the
		// thing that notices.
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
