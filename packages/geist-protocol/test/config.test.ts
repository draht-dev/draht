import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseGeistConfig } from "../src/config.js";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const EXAMPLE_CONFIG_PATH = join(REPO_ROOT, "geist.yaml.example");

describe("parseGeistConfig", () => {
	test("geist.yaml.example (spec §9.1) parses successfully", () => {
		const raw = readFileSync(EXAMPLE_CONFIG_PATH, "utf-8");
		const parsed = parseYaml(raw);

		const config = parseGeistConfig(parsed);

		expect(config.harness.default).toBe("draht");
		expect(config.harness.agents.draht).toEqual({ cmd: "draht-acp" });
		expect(config.harness.agents.claude).toEqual({ cmd: "claude-agent-acp" });
		expect(config.harness.agents.codex).toEqual({ cmd: "codex-acp" });
		expect(config.harness.agents.gemini).toEqual({ cmd: "gemini", args: ["--experimental-acp"] });
	});

	test("rejects a config missing harness.default", () => {
		expect(() => parseGeistConfig({ harness: { agents: { draht: { cmd: "draht-acp" } } } })).toThrow(
			/Invalid geist config/,
		);
	});

	test("rejects a config with a non-string agent cmd", () => {
		expect(() =>
			parseGeistConfig({
				harness: { default: "draht", agents: { draht: { cmd: 42 } } },
			}),
		).toThrow(/Invalid geist config/);
	});

	test("rejects a non-object input", () => {
		expect(() => parseGeistConfig("not a config")).toThrow(/Invalid geist config/);
	});
});
