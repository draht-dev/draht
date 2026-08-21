import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApplyEvent } from "../src/engine.ts";
import { EXIT_CHANGES_PENDING, EXIT_ERROR, EXIT_OK, EXIT_PARTIAL } from "../src/exit-codes.ts";
import { helpText } from "../src/help.ts";
import type { JsonErrorDocument } from "../src/json.ts";
import {
	checkJsonContract,
	JSON_CONTRACT_NAMES,
	type JsonContractName,
	jsonSchemaPath,
	renderJsonSchema,
} from "../src/json-schema.ts";
import { runCliCapture } from "./helpers/cli.ts";
import { claudeCleanUninstall, createWorld } from "./helpers/world.ts";

/**
 * Locks the machine-readable contract down from three directions at once:
 *
 * 1. the checked-in `schemas/*.schema.json` artifacts are file snapshots of
 *    `src/json-schema.ts`, so changing the contract is never invisible;
 * 2. every document and NDJSON record a real CLI run emits is validated
 *    against those (strict) definitions, so an added, renamed or retyped
 *    field fails rather than being silently tolerated;
 * 3. the observed shape of each run is snapshotted as a key/type fingerprint,
 *    so even a change that stays schema-legal — an optional field appearing or
 *    disappearing, a record order changing — has to be acknowledged.
 */

/** Keys whose *value* is part of the contract (discriminators and flags), not just its type. */
const LITERAL_KEYS = new Set([
	"bin",
	"channel",
	"command",
	"drift",
	"dryRun",
	"effectiveness",
	"event",
	"kind",
	"ok",
	"profile",
	"reason",
	"repairable",
	"schemaVersion",
	"severity",
	"type",
]);

/**
 * A deterministic description of a document's shape: one `path: type` line per
 * leaf, with discriminator values kept verbatim. Deliberately drops volatile
 * values (temp paths, resolved versions, transaction ids) so the snapshot
 * fails on shape changes and never on environment noise.
 */
function fingerprint(value: unknown, path: string, key?: string): string[] {
	if (value === null) return [`${path}: null`];
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${path}: []`];
		const lines = new Set<string>();
		for (const entry of value) for (const line of fingerprint(entry, `${path}[]`, key)) lines.add(line);
		return [...lines].sort();
	}
	if (typeof value === "object") {
		const lines: string[] = [];
		for (const name of Object.keys(value as object).sort()) {
			lines.push(...fingerprint((value as Record<string, unknown>)[name], `${path}.${name}`, name));
		}
		return lines;
	}
	const literal = key !== undefined && LITERAL_KEYS.has(key);
	return [`${path}: ${literal ? JSON.stringify(value) : typeof value}`];
}

function shapeOf(document: unknown): string {
	return fingerprint(document, "$").join("\n");
}

function parseNdjson(stdout: string): unknown[] {
	return stdout
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as unknown);
}

/** Asserts one value satisfies its contract, reporting the offending document when it does not. */
function expectValid(name: JsonContractName, value: unknown): void {
	const report = checkJsonContract(name, value);
	expect(report ?? "valid", `${JSON.stringify(value, null, 2)}`).toBe("valid");
}

/** Validates every line of an NDJSON stream and returns its per-line shape, order included. */
function streamShape(name: JsonContractName, stdout: string): string {
	const records = parseNdjson(stdout);
	expect(records.length).toBeGreaterThan(0);
	for (const record of records) expectValid(name, record);
	return records.map((record, index) => `# record ${index + 1}\n${shapeOf(record)}`).join("\n\n");
}

/** A stand-in for the draht-tools CLI: creates the planning tree and nothing else. */
function writeToolsStub(path: string): void {
	writeFileSync(
		path,
		`#!/usr/bin/env node
require("node:fs").mkdirSync(require("node:path").join(process.cwd(), ".planning"), { recursive: true });
process.exit(0);
`,
	);
}

describe("checked-in JSON schemas", () => {
	it("covers every --json surface the CLI has", () => {
		expect(JSON_CONTRACT_NAMES).toEqual([
			"apply-stream",
			"doctor",
			"error",
			"init-stream",
			"plan",
			"status",
			"uninstall-stream",
			"version",
		]);
	});

	for (const name of JSON_CONTRACT_NAMES) {
		it(`pins schemas/${name}.schema.json to src/json-schema.ts`, async () => {
			await expect(renderJsonSchema(name)).toMatchFileSnapshot(jsonSchemaPath(name));
		});
	}
});

describe("version --json", () => {
	it("matches the version contract from draht-install", async () => {
		const run = await runCliCapture(["--version", "--json"]);
		const document = JSON.parse(run.stdout);

		expect(run.code).toBe(EXIT_OK);
		expectValid("version", document);
		expect(shapeOf(document)).toMatchSnapshot();
	});

	it("matches the version contract from draht-init", async () => {
		const run = await runCliCapture(["--version", "--json"], { binName: "draht-init" });
		const document = JSON.parse(run.stdout);

		expect(run.code).toBe(EXIT_OK);
		expectValid("version", document);
		expect(shapeOf(document)).toMatchSnapshot();
	});
});

describe("plan --json", () => {
	it("matches the plan contract with pending actions and a host-skipped component", async () => {
		const world = createWorld();
		try {
			const run = await world.run(["plan", "--json"]);
			const document = JSON.parse(run.stdout);

			expect(run.code).toBe(EXIT_CHANGES_PENDING);
			// The fixture PATH has claude but not codex, so `skipped` is populated
			// rather than theoretical.
			expect(document.skipped).toHaveLength(1);
			expectValid("plan", document);
			expect(shapeOf(document)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});

	it("matches the plan contract when an explicitly-selected component has no host", async () => {
		const world = createWorld({ hosts: ["npm", "node"] });
		try {
			const run = await world.run(["plan", "claude-plugin", "--json"]);
			const document = JSON.parse(run.stdout);

			expect(document.hostMissing).toHaveLength(1);
			expectValid("plan", document);
			expect(shapeOf(document)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});
});

describe("install --json / update --json", () => {
	it("matches the apply-stream contract for a transaction that runs", async () => {
		const world = createWorld();
		try {
			const run = await world.run(["install", "--json", "--yes"]);

			expect(run.code).toBe(EXIT_OK);
			expect(streamShape("apply-stream", run.stdout)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});

	it("matches the apply-stream contract for a dry run", async () => {
		const world = createWorld();
		try {
			const run = await world.run(["install", "--json", "--dry-run"]);

			expect(run.code).toBe(EXIT_OK);
			expect(streamShape("apply-stream", run.stdout)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});

	it("matches the apply-stream contract when there is nothing to do", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "--json", "--yes"]);
			const run = await world.run(["install", "--json", "--yes"]);

			expect(run.code).toBe(EXIT_OK);
			expect(streamShape("apply-stream", run.stdout)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});

	it("matches the apply-stream contract when an update is blocked as a downgrade", async () => {
		const world = createWorld({ versions: { "draht-claude": "2026.9.1-1" } });
		try {
			await world.run(["install", "claude-plugin", "--yes"]);
			const older = createWorld({ versions: { "draht-claude": "2026.1.1-1" } });
			try {
				const run = await world.run(["update", "claude-plugin", "--json", "--yes"], { registry: older.registry });

				expect(run.code).toBe(EXIT_PARTIAL);
				expect(streamShape("apply-stream", run.stdout)).toMatchSnapshot();
			} finally {
				older.dispose();
			}
		} finally {
			world.dispose();
		}
	});

	it("matches the error contract when a mutation is refused without a TTY", async () => {
		const world = createWorld();
		try {
			const run = await world.run(["install", "--json"]);
			const [record, ...rest] = parseNdjson(run.stdout);

			expect(run.code).toBe(EXIT_PARTIAL);
			expect(rest).toEqual([]);
			expectValid("apply-stream", record);
			expectValid("error", record);
			expect((record as JsonErrorDocument).error.code).toBe("confirmation-required");
			expect(shapeOf(record)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});
});

describe("status --json", () => {
	it("matches the status contract with a file-backed and a delegated component", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "--json", "--yes"]);
			const run = await world.run(["status", "--json"]);
			const document = JSON.parse(run.stdout);

			expect(run.code).toBe(EXIT_OK);
			// One component whose bytes this engine owns, one an external package
			// manager owns — the two status shapes that differ.
			expect(document.components.map((component: { drift: string }) => component.drift).sort()).toEqual([
				"clean",
				"delegated",
			]);
			expectValid("status", document);
			expect(shapeOf(document)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});
});

describe("doctor --json", () => {
	it("matches the doctor contract for environment findings", async () => {
		const world = createWorld({ hosts: [] });
		try {
			const run = await world.run(["doctor", "--json"]);
			const document = JSON.parse(run.stdout);

			expect(run.code).toBe(EXIT_ERROR);
			expectValid("doctor", document);
			expect(shapeOf(document)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});

	it("matches the doctor contract for an installed machine", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "--json", "--yes"]);
			const run = await world.run(["doctor", "--json"]);
			const document = JSON.parse(run.stdout);

			expectValid("doctor", document);
			expect(shapeOf(document)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});
});

describe("uninstall --json", () => {
	it("matches the uninstall-stream contract for a transaction that runs", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "claude-plugin", "--yes"]);
			const run = await world.run(["uninstall", "claude-plugin", "--json", "--yes"], {
				hostRunner: createWorld({ responses: claudeCleanUninstall() }).host.runner,
			});

			expect(run.code).toBe(EXIT_OK);
			expect(streamShape("uninstall-stream", run.stdout)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});

	it("matches the uninstall-stream contract for a dry run", async () => {
		const world = createWorld();
		try {
			await world.run(["install", "claude-plugin", "--yes"]);
			const run = await world.run(["uninstall", "claude-plugin", "--json", "--dry-run"]);

			expect(run.code).toBe(EXIT_OK);
			expect(streamShape("uninstall-stream", run.stdout)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});

	it("matches the uninstall-stream contract when nothing is installed", async () => {
		const world = createWorld();
		try {
			const run = await world.run(["uninstall", "--all", "--json", "--yes"]);

			expect(run.code).toBe(EXIT_OK);
			expect(streamShape("uninstall-stream", run.stdout)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});
});

describe("draht-init --json", () => {
	function initWorld(): { world: ReturnType<typeof createWorld>; project: string; env: NodeJS.ProcessEnv } {
		const world = createWorld();
		const toolsBin = join(world.home, "draht-tools-stub.cjs");
		mkdirSync(world.home, { recursive: true });
		writeToolsStub(toolsBin);
		return { world, project: join(world.home, "projects", "acme"), env: { ...world.env, DRAHT_TOOLS_BIN: toolsBin } };
	}

	it("matches the init-stream contract for a full bootstrap", async () => {
		const { world, project, env } = initWorld();
		try {
			const run = await world.run([project, "--json", "--yes"], { binName: "draht-init", env });

			expect(run.code).toBe(EXIT_OK);
			expect(streamShape("init-stream", run.stdout)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});

	it("matches the init-stream contract for a dry run", async () => {
		const { world, project, env } = initWorld();
		try {
			const run = await world.run([project, "--json", "--dry-run"], { binName: "draht-init", env });

			expect(run.code).toBe(EXIT_OK);
			expect(streamShape("init-stream", run.stdout)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});

	it("matches the error contract when the target already has a scaffold", async () => {
		const { world, project, env } = initWorld();
		try {
			mkdirSync(join(project, ".planning"), { recursive: true });
			const run = await world.run([project, "--json", "--yes"], { binName: "draht-init", env });
			const [record, ...rest] = parseNdjson(run.stdout);

			expect(run.code).toBe(EXIT_PARTIAL);
			expect(rest).toEqual([]);
			expectValid("init-stream", record);
			expectValid("error", record);
			expect((record as JsonErrorDocument).error.code).toBe("planning-exists");
			expect(shapeOf(record)).toMatchSnapshot();
		} finally {
			world.dispose();
		}
	});
});

describe("read-verb error documents", () => {
	it("matches the error contract for an unknown verb", async () => {
		const run = await runCliCapture(["frobnicate", "--json"]);
		const document = JSON.parse(run.stdout);

		expect(run.code).toBe(EXIT_ERROR);
		expectValid("error", document);
		expect(shapeOf(document)).toMatchSnapshot();
	});

	it("matches the error contract when the failure carries structured detail", async () => {
		const run = await runCliCapture(["plan", "--channel", "next", "--json"]);
		const document = JSON.parse(run.stdout);

		expect(run.code).toBe(EXIT_ERROR);
		expect(document.error.detail).toEqual({ channel: "next" });
		expectValid("error", document);
		expect(shapeOf(document)).toMatchSnapshot();
	});
});

/**
 * Two record variants the engine declares but no reachable code path emitted at
 * the time of writing: `blocked` is part of the exported `ApplyEvent` union but
 * is currently only ever surfaced through a summary's `blocked` array, and
 * `recovered` needs a crashed predecessor transaction. Typing the samples as
 * `ApplyEvent` makes the compiler — not a comment — the thing that keeps this
 * list complete: adding or changing a variant breaks this file.
 */
describe("declared-but-unexercised records", () => {
	const samples: ApplyEvent[] = [
		{ event: "action-start", componentId: "claude-plugin", type: "install" },
		{ event: "action-done", componentId: "claude-plugin", type: "install", version: "2026.8.1-1", notes: [] },
		{ event: "action-done", componentId: "claude-plugin", type: "remove", notes: ["host released the plugin"] },
		{ event: "blocked", componentId: "claude-plugin", reason: "downgrade" },
		{ event: "recovered", transactions: ["tx-1"], notes: ["rolled back tx-1"] },
	];

	for (const sample of samples) {
		it(`accepts a "${sample.event}" record on every stream`, () => {
			expectValid("apply-stream", { schemaVersion: 1, command: "install", ...sample });
			expectValid("uninstall-stream", { schemaVersion: 1, command: "uninstall", ...sample });
			expectValid("init-stream", { schemaVersion: 1, ...sample, command: "init" });
		});
	}
});

describe("help disambiguates the two entry points", () => {
	const install = helpText("draht-install");
	const init = helpText("draht-init");

	it("tells draht-install apart from draht install on the draht-install surface", () => {
		expect(install).toContain(`Not the same command as "draht install"`);
		// The distinction must be stated in both directions, not just named.
		expect(install).toContain("draht install <source>");
		expect(install).toContain("extension manager");
		expect(install).toContain("machine-level components");
	});

	it("names all three entry points on the draht-init surface", () => {
		expect(init).toContain("draht-init [directory]");
		expect(init).toContain("draht-install <command>");
		expect(init).toContain("draht install <source>");
		expect(init).toContain("extension manager");
	});

	it("keeps the claim about draht install true: draht is the coding-agent component's bin", () => {
		// `draht install <source>` is only reachable once the "coding-agent"
		// component is installed, because that component is what provides the
		// `draht` bin. If that ever stops being true the help text is a lie.
		const manifest = JSON.parse(
			readFileSync(join(import.meta.dirname, "..", "..", "coding-agent", "package.json"), "utf8"),
		) as { name: string; bin: Record<string, string> };

		expect(manifest.name).toBe("@draht/coding-agent");
		expect(Object.keys(manifest.bin)).toContain("draht");
		expect(install).toContain(`"coding-agent" component`);
	});
});
