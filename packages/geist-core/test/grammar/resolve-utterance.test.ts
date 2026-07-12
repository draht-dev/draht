import { describe, expect, test } from "bun:test";
import {
	type ResolutionContext,
	type ResolvedBoardNew,
	type ResolvedBoardVariants,
	type ResolvedCommand,
	type ResolvedMessage,
	type ResolvedPermission,
	resolveUtterance,
} from "../../src/grammar/resolve-utterance.js";

/**
 * Fixture context. Note the deliberate collision: `draht` is BOTH a configured
 * harness AND the slug/name of a known project — the spec §9.5 "nothing may
 * shadow anything earlier in the chain" invariant is tested against it.
 */
const ctx: ResolutionContext = {
	configuredHarnesses: ["draht", "claude", "codex", "gemini"],
	knownProjects: [
		{ slug: "kintura", name: "Kintura" },
		{ slug: "fr3n", name: "Fr3n Web" },
		{ slug: "draht", name: "Draht Mono" },
	],
	availableCommands: [{ name: "review", description: "Review the diff" }, { name: "plan" }],
};

describe("resolveUtterance — reserved verbs (stage 1, always win)", () => {
	test("allow (EN) resolves to a permission allow", () => {
		expect(resolveUtterance("allow", ctx)).toEqual({
			kind: "permission",
			verb: "allow",
		} satisfies ResolvedPermission);
	});

	test("erlauben (DE) resolves to a permission allow", () => {
		expect(resolveUtterance("erlauben", ctx)).toEqual({ kind: "permission", verb: "allow" });
	});

	test("deny (EN) resolves to a permission deny", () => {
		expect(resolveUtterance("deny", ctx)).toEqual({ kind: "permission", verb: "deny" });
	});

	test("ablehnen (DE) resolves to a permission deny", () => {
		expect(resolveUtterance("ablehnen", ctx)).toEqual({ kind: "permission", verb: "deny" });
	});

	test("case-insensitive and tolerant of trailing punctuation", () => {
		expect(resolveUtterance("Allow.", ctx)).toEqual({ kind: "permission", verb: "allow" });
		expect(resolveUtterance("DENY", ctx)).toEqual({ kind: "permission", verb: "deny" });
		expect(resolveUtterance("Erlauben!", ctx)).toEqual({ kind: "permission", verb: "allow" });
	});

	test("a trailing harness qualifier cannot shadow the reserved verb", () => {
		// "codex" is a configured harness, "kintura" a known project — neither may demote allow.
		expect(resolveUtterance("allow codex in kintura", ctx)).toEqual({ kind: "permission", verb: "allow" });
	});

	test("a trailing project qualifier cannot shadow the reserved verb", () => {
		expect(resolveUtterance("deny kintura", ctx)).toEqual({ kind: "permission", verb: "deny" });
	});

	test("a trailing advertised command cannot shadow the reserved verb", () => {
		// "review" is an advertised command; the earlier reserved verb still wins.
		expect(resolveUtterance("allow review the diff", ctx)).toEqual({ kind: "permission", verb: "allow" });
	});

	test("'allowing …' is NOT a reserved verb (word-boundary anchored)", () => {
		const result = resolveUtterance("allowing extra padding", ctx);
		expect(result.kind).toBe("message");
	});
});

describe("resolveUtterance — command match (stage 2)", () => {
	test("verbatim /… passthrough with no args (raw, unadvertised is still fine)", () => {
		expect(resolveUtterance("/plan", ctx)).toEqual({
			kind: "command",
			command: "plan",
			raw: true,
			text: undefined,
		} satisfies ResolvedCommand);
	});

	test("verbatim /… passthrough carries its trailing text", () => {
		expect(resolveUtterance("/review the auth flow", ctx)).toEqual({
			kind: "command",
			command: "review",
			raw: true,
			text: "the auth flow",
		});
	});

	test("verbatim /… passthrough works even when not in availableCommands", () => {
		expect(resolveUtterance("/deploy now", ctx)).toEqual({
			kind: "command",
			command: "deploy",
			raw: true,
			text: "now",
		});
	});

	test("a leading slash beats reserved-verb detection: /allow is a command, not permission", () => {
		expect(resolveUtterance("/allow", ctx)).toEqual({
			kind: "command",
			command: "allow",
			raw: true,
			text: undefined,
		});
	});

	test("an advertised command matched by bare name (raw=false) carries trailing text", () => {
		expect(resolveUtterance("review the header spacing", ctx)).toEqual({
			kind: "command",
			command: "review",
			raw: false,
			text: "the header spacing",
		});
	});

	test("an advertised command matched with no trailing text", () => {
		expect(resolveUtterance("plan", ctx)).toEqual({ kind: "command", command: "plan", raw: false, text: undefined });
	});

	test("advertised-command matching is case-insensitive and returns the canonical name", () => {
		expect(resolveUtterance("Review the spacing", ctx)).toEqual({
			kind: "command",
			command: "review",
			raw: false,
			text: "the spacing",
		});
	});
});

describe("resolveUtterance — harness & project qualifiers (stages 3–5)", () => {
	test("harness qualifier alone", () => {
		expect(resolveUtterance("claude: make it blue", ctx)).toEqual({
			kind: "message",
			harness: "claude",
			project: undefined,
			text: "make it blue",
		} satisfies ResolvedMessage);
	});

	test("harness qualifier is case-insensitive and canonicalized", () => {
		expect(resolveUtterance("Claude: do it", ctx)).toEqual({
			kind: "message",
			harness: "claude",
			project: undefined,
			text: "do it",
		});
	});

	test("project qualifier alone (by slug)", () => {
		expect(resolveUtterance("in kintura: make it blue", ctx)).toEqual({
			kind: "message",
			harness: undefined,
			project: "kintura",
			text: "make it blue",
		});
	});

	test("project qualifier by display name (multi-word), case-insensitive", () => {
		expect(resolveUtterance("in Fr3n Web: ship it", ctx)).toEqual({
			kind: "message",
			harness: undefined,
			project: "fr3n",
			text: "ship it",
		});
	});

	test("harness + project qualifiers combined", () => {
		expect(resolveUtterance("claude in kintura: fix the bug", ctx)).toEqual({
			kind: "message",
			harness: "claude",
			project: "kintura",
			text: "fix the bug",
		});
	});

	test("harness qualifier with the 'session' filler word (spec §9.5 example)", () => {
		const result = resolveUtterance("claude session in kintura: fix the bug", ctx);
		// Explicitly NOT board-new (no leading 'new'): it is a plain qualified message.
		expect(result.kind).toBe("message");
		expect(result).toEqual({ kind: "message", harness: "claude", project: "kintura", text: "fix the bug" });
	});

	test("plain message with no qualifiers passes straight through as text", () => {
		expect(resolveUtterance("make the header sticky", ctx)).toEqual({
			kind: "message",
			harness: undefined,
			project: undefined,
			text: "make the header sticky",
		});
	});

	test("SHADOW INVARIANT: a project named the same as a harness resolves as the harness (earlier stage)", () => {
		// 'draht' is both a configured harness and a known project slug/name.
		// The harness qualifier is earlier in the chain, so it must win and the
		// project qualifier must NOT capture it.
		const result = resolveUtterance("draht: fix the bug", ctx);
		expect(result).toEqual({ kind: "message", harness: "draht", project: undefined, text: "fix the bug" });
	});
});

describe("resolveUtterance — board grammar: new … session", () => {
	test("full form (spec example): new <harness> session in <project>: <text>", () => {
		expect(resolveUtterance("new claude session in kintura: tighten the hero animation", ctx)).toEqual({
			kind: "board-new",
			harness: "claude",
			command: undefined,
			project: "kintura",
			text: "tighten the hero animation",
		} satisfies ResolvedBoardNew);
	});

	test("harness omitted (default applies downstream)", () => {
		expect(resolveUtterance("new session in kintura: add a footer", ctx)).toEqual({
			kind: "board-new",
			harness: undefined,
			command: undefined,
			project: "kintura",
			text: "add a footer",
		});
	});

	test("with a command/persona slot (verbatim, slash preserved)", () => {
		expect(resolveUtterance("new draht /plan session in fr3n: draft the api", ctx)).toEqual({
			kind: "board-new",
			harness: "draht",
			command: "/plan",
			project: "fr3n",
			text: "draft the api",
		});
	});

	test("no project qualifier", () => {
		expect(resolveUtterance("new codex session: refactor utils", ctx)).toEqual({
			kind: "board-new",
			harness: "codex",
			command: undefined,
			project: undefined,
			text: "refactor utils",
		});
	});

	test("a reserved verb inside the free text does NOT fire (verb must be the operative leading verb)", () => {
		const result = resolveUtterance("new claude session in kintura: allow more whitespace", ctx);
		expect(result).toEqual({
			kind: "board-new",
			harness: "claude",
			command: undefined,
			project: "kintura",
			text: "allow more whitespace",
		});
	});
});

describe("resolveUtterance — board grammar: variants <n>", () => {
	test("full form (spec example): variants <n> with <list> : <text>", () => {
		expect(resolveUtterance("variants 3 with claude, codex and draht: try a dark theme", ctx)).toEqual({
			kind: "board-variants",
			count: 3,
			harnesses: ["claude", "codex", "draht"],
			project: undefined,
			text: "try a dark theme",
		} satisfies ResolvedBoardVariants);
	});

	test("minimal form: variants <n> : <text> (no harness list, no project)", () => {
		expect(resolveUtterance("variants 2: try a bolder hero", ctx)).toEqual({
			kind: "board-variants",
			count: 2,
			harnesses: [],
			project: undefined,
			text: "try a bolder hero",
		});
	});

	test("with a harness list AND a trailing project qualifier", () => {
		expect(resolveUtterance("variants 3 with claude and codex in kintura: compare layouts", ctx)).toEqual({
			kind: "board-variants",
			count: 3,
			harnesses: ["claude", "codex"],
			project: "kintura",
			text: "compare layouts",
		});
	});
});
