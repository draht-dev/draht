import { describe, expect, test } from "bun:test";
import type { ChangeSet, CodeScene } from "../src/contract.ts";
import { llmWriter, templateWriter, withTemplateFallback } from "../src/script.ts";

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
	return {
		id: "abc123def456",
		commits: ["abc123def456"],
		title: "Add greeting helper",
		body: "",
		authors: ["Ada Lovelace"],
		date: "2024-01-01T00:00:00Z",
		files: [
			{
				path: "src/greet.ts",
				status: "modified",
				additions: 2,
				deletions: 1,
				hunks: [
					{
						header: "@@ -1,3 +1,4 @@",
						lines: [" function greet() {", "+  console.log('hi');", " }", "-  // todo"],
					},
				],
			},
			{
				path: "src/other.ts",
				status: "added",
				additions: 1,
				deletions: 0,
				hunks: [{ header: "@@ -0,0 +1 @@", lines: ["+export const x = 1;"] }],
			},
		],
		...overrides,
	};
}

describe("templateWriter", () => {
	test("every code scene's lines exist verbatim in the source hunk", async () => {
		const script = await templateWriter(changeSet());
		const codeScenes = script.scenes.filter((s): s is CodeScene => s.kind === "code");
		expect(codeScenes.length).toBeGreaterThan(0);
		for (const scene of codeScenes) {
			const file = changeSet().files.find((f) => f.path === scene.path);
			const hunkLines = file?.hunks.flatMap((h) => h.lines) ?? [];
			for (const line of scene.lines) {
				expect(hunkLines).toContain(line);
			}
		}
	});

	test("opens with a title scene and closes with an outro scene", async () => {
		const script = await templateWriter(changeSet());
		expect(script.scenes[0].kind).toBe("title");
		expect(script.scenes[script.scenes.length - 1].kind).toBe("outro");
		expect(script.writer).toBe("template");
	});

	test("includes a diagram scene only when more than one directory changed", async () => {
		const oneDir = await templateWriter(
			changeSet({
				files: [
					{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, hunks: [] },
					{ path: "src/b.ts", status: "modified", additions: 1, deletions: 0, hunks: [] },
				],
			}),
		);
		expect(oneDir.scenes.some((s) => s.kind === "diagram")).toBe(false);

		const twoDirs = await templateWriter(
			changeSet({
				files: [
					{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, hunks: [] },
					{ path: "docs/b.md", status: "modified", additions: 1, deletions: 0, hunks: [] },
				],
			}),
		);
		expect(twoDirs.scenes.some((s) => s.kind === "diagram")).toBe(true);
	});

	test("respects the lang option for narration text", async () => {
		const en = await templateWriter(changeSet(), { lang: "en" });
		const de = await templateWriter(changeSet(), { lang: "de" });
		const enStats = en.scenes.find((s) => s.kind === "stats");
		const deStats = de.scenes.find((s) => s.kind === "stats");
		expect(enStats?.narration).toContain("touches");
		expect(deStats?.narration).toContain("betrifft");
	});

	test("S2: caps an oversized commit subject at 200 chars for both title and narration", async () => {
		const script = await templateWriter(changeSet({ title: "x".repeat(500) }));
		const titleScene = script.scenes.find((s) => s.kind === "title");
		expect(titleScene?.title.length).toBeLessThanOrEqual(201); // 200 chars + ellipsis
		expect(titleScene?.narration.length).toBeLessThanOrEqual(201);
	});

	test("P1: an empty commit subject never produces empty narration", async () => {
		const script = await templateWriter(changeSet({ title: "" }));
		const titleScene = script.scenes.find((s) => s.kind === "title");
		expect(titleScene?.narration.length).toBeGreaterThan(0);
		expect(titleScene?.title.length).toBeGreaterThan(0);
	});
});

describe("llmWriter", () => {
	test("builds scenes from a valid response, slicing the real hunk", async () => {
		const writer = llmWriter(async () => ({
			text: JSON.stringify({
				title: "Add greeting",
				subtitle: "by Ada",
				titleNarration: "This adds a greeting.",
				statsNarration: "Two files changed.",
				scenes: [{ ref: { path: "src/greet.ts", hunkIndex: 0 }, narration: "The function now logs a greeting." }],
				outroNarration: "That is the change.",
			}),
		}));
		const script = await writer(changeSet());
		expect(script.writer).toBe("llm");
		const codeScene = script.scenes.find((s): s is CodeScene => s.kind === "code");
		expect(codeScene?.path).toBe("src/greet.ts");
		expect(codeScene?.lines).toEqual([" function greet() {", "+  console.log('hi');", " }", "-  // todo"]);
	});

	test("rejects a hunk reference whose path does not exist by skipping it", async () => {
		const writer = llmWriter(async () => ({
			text: JSON.stringify({
				title: "t",
				subtitle: "s",
				titleNarration: "t",
				statsNarration: "s",
				scenes: [
					{ ref: { path: "src/does-not-exist.ts", hunkIndex: 0 }, narration: "ghost" },
					{ ref: { path: "src/greet.ts", hunkIndex: 0 }, narration: "real" },
				],
				outroNarration: "o",
			}),
		}));
		const script = await writer(changeSet());
		const codeScenes = script.scenes.filter((s): s is CodeScene => s.kind === "code");
		expect(codeScenes).toHaveLength(1);
		expect(codeScenes[0].narration).toBe("real");
	});

	test("rejects a hunk reference whose hunkIndex is out of range by skipping it", async () => {
		const writer = llmWriter(async () => ({
			text: JSON.stringify({
				title: "t",
				subtitle: "s",
				titleNarration: "t",
				statsNarration: "s",
				scenes: [{ ref: { path: "src/greet.ts", hunkIndex: 5 }, narration: "ghost" }],
				outroNarration: "o",
			}),
		}));
		const script = await writer(changeSet());
		expect(script.scenes.some((s) => s.kind === "code")).toBe(false);
	});

	test("throws on malformed JSON", async () => {
		const writer = llmWriter(async () => ({ text: "not json" }));
		await expect(writer(changeSet())).rejects.toThrow(/valid JSON/);
	});

	test("throws when a required field is missing", async () => {
		const writer = llmWriter(async () => ({ text: JSON.stringify({ title: "t" }) }));
		await expect(writer(changeSet())).rejects.toThrow(/subtitle/);
	});

	test("throws when scenes is not an array", async () => {
		const writer = llmWriter(async () => ({
			text: JSON.stringify({
				title: "t",
				subtitle: "s",
				titleNarration: "t",
				statsNarration: "s",
				scenes: "nope",
				outroNarration: "o",
			}),
		}));
		await expect(writer(changeSet())).rejects.toThrow(/scenes/);
	});
});

function validResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		title: "Add greeting",
		subtitle: "by Ada",
		titleNarration: "This adds a greeting.",
		statsNarration: "Two files changed.",
		scenes: [{ ref: { path: "src/greet.ts", hunkIndex: 0 }, narration: "The function now logs a greeting." }],
		outroNarration: "That is the change.",
		...overrides,
	};
}

describe("llmWriter hardening", () => {
	test("accepts JSON wrapped in a Markdown code fence", async () => {
		const writer = llmWriter(async () => ({ text: `\`\`\`json\n${JSON.stringify(validResponse())}\n\`\`\`` }));
		const script = await writer(changeSet());
		expect(script.scenes.some((s) => s.kind === "code")).toBe(true);
	});

	test("asks for the requested narration language", async () => {
		let prompt = "";
		const writer = llmWriter(async (req) => {
			prompt = req.prompt;
			return { text: JSON.stringify(validResponse()) };
		});
		await writer(changeSet(), { lang: "de" });
		expect(prompt).toContain("in German");
	});

	test("caps every narration string", async () => {
		const long = "word ".repeat(500);
		const writer = llmWriter(async () => ({
			text: JSON.stringify(validResponse({ titleNarration: long, outroNarration: long })),
		}));
		const script = await writer(changeSet());
		for (const scene of script.scenes) expect(scene.narration.length).toBeLessThanOrEqual(301);
	});

	test("S2: caps an oversized title/subtitle at 200 chars", async () => {
		const writer = llmWriter(async () => ({
			text: JSON.stringify(validResponse({ title: "t".repeat(500), subtitle: "s".repeat(500) })),
		}));
		const script = await writer(changeSet());
		const titleScene = script.scenes.find((s) => s.kind === "title");
		expect(titleScene?.title.length).toBeLessThanOrEqual(201);
		expect(titleScene?.subtitle.length).toBeLessThanOrEqual(201);
	});

	test("keeps at most maxCodeScenes code scenes", async () => {
		const ref = { ref: { path: "src/greet.ts", hunkIndex: 0 }, narration: "Again." };
		const writer = llmWriter(async () => ({
			text: JSON.stringify(validResponse({ scenes: Array.from({ length: 9 }, () => ref) })),
		}));
		const script = await writer(changeSet(), { maxCodeScenes: 2 });
		expect(script.scenes.filter((s) => s.kind === "code")).toHaveLength(2);
	});

	test("caps an oversized commit body at 4096 chars in the prompt", async () => {
		let prompt = "";
		const writer = llmWriter(async (req) => {
			prompt = req.prompt;
			return { text: JSON.stringify(validResponse()) };
		});
		await writer(changeSet({ body: "x".repeat(10_000) }));
		const bodyLine = prompt.split("\n").find((line) => line.startsWith("Body: "));
		expect(bodyLine?.length).toBeLessThanOrEqual("Body: ".length + 4097);
	});

	test("caps the prompt at 50 files, with a note on how many more there are", async () => {
		let prompt = "";
		const writer = llmWriter(async (req) => {
			prompt = req.prompt;
			return { text: JSON.stringify(validResponse()) };
		});
		const manyFiles = Array.from({ length: 60 }, (_, i) => ({
			path: `src/file${i}.ts`,
			status: "modified" as const,
			additions: 1,
			deletions: 0,
			hunks: [{ header: "@@ -1 +1 @@", lines: [" x"] }],
		}));
		await writer(changeSet({ files: manyFiles }));
		expect(prompt.match(/^file \d+ /gm)).toHaveLength(50);
		expect(prompt).toContain("... 10 more files");
	});

	test("caps the prompt at 10 hunks per file, with a note on how many more there are", async () => {
		let prompt = "";
		const writer = llmWriter(async (req) => {
			prompt = req.prompt;
			return { text: JSON.stringify(validResponse()) };
		});
		const manyHunks = Array.from({ length: 15 }, (_, i) => ({ header: `@@ -${i} +${i} @@`, lines: [" x"] }));
		await writer(
			changeSet({
				files: [{ path: "src/big.ts", status: "modified", additions: 1, deletions: 0, hunks: manyHunks }],
			}),
		);
		expect(prompt.match(/^ {2}hunk \d+ /gm)).toHaveLength(10);
		expect(prompt).toContain("... 5 more hunks");
	});
});

describe("withTemplateFallback", () => {
	test("returns the template script and reports the error when the primary writer fails", async () => {
		const failures: string[] = [];
		const writer = withTemplateFallback(
			llmWriter(async () => ({ text: "not json" })),
			(_cs, error) => failures.push(error.message),
		);
		const script = await writer(changeSet());
		expect(script.writer).toBe("template");
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatch(/valid JSON/);
	});

	test("passes a successful primary result through untouched", async () => {
		const writer = withTemplateFallback(
			llmWriter(async () => ({ text: JSON.stringify(validResponse()) })),
			() => {
				throw new Error("must not fall back");
			},
		);
		expect((await writer(changeSet())).writer).toBe("llm");
	});
});

describe("ModelCompletionRequest", () => {
	test("llmWriter sends a fixed maxTokens budget and no systemPrompt", async () => {
		let seen: { systemPrompt?: string; maxTokens: number } | undefined;
		const writer = llmWriter(async (req) => {
			seen = { systemPrompt: req.systemPrompt, maxTokens: req.maxTokens };
			return { text: JSON.stringify(validResponse()) };
		});
		await writer(changeSet());
		expect(seen?.systemPrompt).toBeUndefined();
		expect(seen?.maxTokens).toBeGreaterThan(0);
	});
});
