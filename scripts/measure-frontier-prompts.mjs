#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseRef = process.argv[2] ?? "HEAD";
const groups = {
	canonical: ["skills"],
	native: ["packages/coding-agent/agents", "packages/coding-agent/prompts", "packages/coding-agent/skills"],
	claude: ["packages/draht-claude/agents", "packages/draht-claude/commands", "packages/draht-claude/skills"],
	codex: ["packages/draht-codex/agents", "packages/draht-codex/commands", "packages/draht-codex/skills"],
};
const bytes = (text) => Buffer.byteLength(text, "utf8");
const counts = (text) => ({ bytes: bytes(text), words: text.trim().split(/\s+/).filter(Boolean).length });
const records = new Map();
const totals = {};
for (const [name, paths] of Object.entries(groups)) {
	const files = execFileSync("git", ["ls-files", "-z", "--", ...paths], { cwd: root, encoding: "utf8" }).split("\0").filter((p) => p.endsWith(".md"));
	let before = 0;
	let after = 0;
	for (const file of files) {
		const old = execFileSync("git", ["show", `${baseRef}:${file}`], { cwd: root, encoding: "utf8" });
		const current = readFileSync(resolve(root, file), "utf8");
		const record = { before: counts(old), after: counts(current) };
		records.set(file, record);
		before += record.before.bytes;
		after += record.after.bytes;
	}
	totals[name] = { files: files.length, beforeBytes: before, afterBytes: after, reductionPercent: Math.round((1 - after / before) * 100) };
}
const selected = Object.fromEntries([...records].filter(([file]) => /\/(quick|fix|why)\/(command\.md)$|commands\/(quick|fix|why)\.md$|agents\/implementer\.md$|skills\/(brainstorming|debugging-workflow|verification-gate|atomic-reasoning)\/SKILL\.md$/.test(file)));
console.log(JSON.stringify({ baseRef, unit: "UTF-8 bytes; assets are separate contexts, not one prompt", totals, selected }, null, 2));
