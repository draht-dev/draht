import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/args.ts";
import { EXIT_CHANGES_PENDING, EXIT_ERROR, EXIT_OK, EXIT_PARTIAL } from "../src/exit-codes.ts";
import { runCliCapture } from "./helpers/cli.ts";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));

describe("exit codes", () => {
	it("pins the adjudicated table", () => {
		expect({ EXIT_OK, EXIT_ERROR, EXIT_CHANGES_PENDING, EXIT_PARTIAL }).toEqual({
			EXIT_OK: 0,
			EXIT_ERROR: 1,
			EXIT_CHANGES_PENDING: 2,
			EXIT_PARTIAL: 3,
		});
	});
});

describe("draht-install help and version", () => {
	it("prints usage listing every verb on --help and exits 0", async () => {
		const run = await runCliCapture(["--help"]);

		expect(run.code).toBe(EXIT_OK);
		expect(run.stderr).toBe("");
		for (const verb of ["plan", "install", "status", "doctor", "update", "uninstall"]) {
			expect(run.stdout).toContain(verb);
		}
	});

	it("accepts the -h short flag", async () => {
		const run = await runCliCapture(["-h"]);

		expect(run.code).toBe(EXIT_OK);
		expect(run.stdout).toContain("draht-install");
	});

	it("prints usage when invoked with no arguments at all", async () => {
		const run = await runCliCapture([]);

		expect(run.code).toBe(EXIT_OK);
		expect(run.stdout).toContain("draht-install");
	});

	it("prints the package version on --version", async () => {
		const run = await runCliCapture(["--version"]);

		expect(run.code).toBe(EXIT_OK);
		expect(run.stdout.trim()).toBe(manifest.version);
	});

	it("emits a schema-versioned document for --version --json", async () => {
		const run = await runCliCapture(["--version", "--json"]);

		expect(run.code).toBe(EXIT_OK);
		expect(JSON.parse(run.stdout)).toEqual({
			schemaVersion: 1,
			command: "version",
			bin: "draht-install",
			version: manifest.version,
		});
	});
});

describe("basename dispatch", () => {
	it("selects the draht-init surface from the bin name", async () => {
		const run = await runCliCapture(["--help"], { binName: "draht-init" });

		expect(run.code).toBe(EXIT_OK);
		expect(run.stdout).toContain("draht-init");
		// draht-init is project bootstrap, not machine component management: it
		// must not advertise the machine verbs.
		expect(run.stdout).not.toContain("uninstall");
	});

	it("tolerates the .js suffix a direct `node dist/cli.js` invocation produces", async () => {
		const run = await runCliCapture(["--help"], { binName: "cli.js" });

		expect(run.code).toBe(EXIT_OK);
		expect(run.stdout).toContain("draht-install");
	});

	it("rejects an unrecognized bin name instead of guessing a surface", async () => {
		const run = await runCliCapture(["--help"], { binName: "draht-something-else" });

		expect(run.code).toBe(EXIT_ERROR);
		expect(run.stderr).toContain("draht-something-else");
	});
});

describe("argument rejection is fail-closed", () => {
	it("rejects an unknown verb", async () => {
		const run = await runCliCapture(["frobnicate"]);

		expect(run.code).toBe(EXIT_ERROR);
		expect(run.stderr).toContain("frobnicate");
		expect(run.stdout).toBe("");
	});

	it("rejects an unknown flag", async () => {
		const run = await runCliCapture(["status", "--wat"]);

		expect(run.code).toBe(EXIT_ERROR);
		expect(run.stderr).toContain("--wat");
	});

	it("rejects a channel other than latest with an honest message", async () => {
		const run = await runCliCapture(["plan", "--channel", "next"]);

		expect(run.code).toBe(EXIT_ERROR);
		expect(run.stderr).toContain("next");
		expect(run.stderr).toContain("latest");
	});

	it("accepts --channel latest at the parser level", () => {
		const parsed = parseCliArgs("draht-install", ["plan", "--channel", "latest"]);

		expect(parsed.command).toBe("plan");
		expect(parsed.channel).toBe("latest");
	});

	it("rejects combining --full with explicit selectors", async () => {
		const run = await runCliCapture(["plan", "--full", "claude-plugin"]);

		expect(run.code).toBe(EXIT_ERROR);
		expect(run.stderr).toContain("--full");
	});

	it("keeps duplicate selectors deterministic at the parser level", () => {
		const parsed = parseCliArgs("draht-install", ["plan", "codex-plugin", "claude-plugin", "codex-plugin"]);

		expect(parsed.selectors).toEqual(["codex-plugin", "claude-plugin"]);
	});

	it("rejects a flag that needs a value but is given none", async () => {
		const run = await runCliCapture(["plan", "--channel"]);

		expect(run.code).toBe(EXIT_ERROR);
		expect(run.stderr).toContain("--channel");
	});

	it("keeps errors off stdout so --json consumers never see prose", async () => {
		const run = await runCliCapture(["frobnicate", "--json"]);

		expect(run.code).toBe(EXIT_ERROR);
		expect(run.stdout === "" || JSON.parse(run.stdout).schemaVersion === 1).toBe(true);
	});

	it("emits a schema-stable error document in JSON mode", async () => {
		const run = await runCliCapture(["frobnicate", "--json"]);
		const doc = JSON.parse(run.stdout);

		expect(doc.schemaVersion).toBe(1);
		expect(doc.ok).toBe(false);
		expect(typeof doc.error.code).toBe("string");
		expect(typeof doc.error.message).toBe("string");
	});
});
