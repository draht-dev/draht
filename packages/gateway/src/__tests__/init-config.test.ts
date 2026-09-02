import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInitConfig } from "../cli";
import { createDefaultConfigFile } from "../config/config";

const CLI_ENTRY = join(import.meta.dir, "..", "cli.ts");

/** Temp HOMEs created by this file, torn down once at the end. */
const temps: string[] = [];

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "draht-gateway-init-"));
	temps.push(dir);
	return dir;
}

/** The config path the CLI derives from a given HOME. Never the real ~/.draht. */
function configPathFor(home: string): string {
	return join(home, ".draht", "gateway.config.json");
}

afterAll(() => {
	for (const dir of temps) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("runInitConfig", () => {
	test("creates the file and reports the real path, exit code 0", async () => {
		const configPath = configPathFor(tempHome());
		const lines: string[] = [];

		const code = await runInitConfig(configPath, (message) => lines.push(message));

		expect(code).toBe(0);
		expect(lines).toEqual([`Created default config at ${configPath}`]);
		expect(existsSync(configPath)).toBe(true);
	});

	test("reports an already-existing config, exit code 0, without rewriting it", async () => {
		const configPath = configPathFor(tempHome());
		await runInitConfig(configPath, () => {});
		const firstBytes = await Bun.file(configPath).text();

		const lines: string[] = [];
		const code = await runInitConfig(configPath, (message) => lines.push(message));

		expect(code).toBe(0);
		expect(lines).toEqual([`Config already exists at ${configPath}`]);
		expect(await Bun.file(configPath).text()).toBe(firstBytes);
	});

	test("never emits the old 'unreachable' control-flow sentinel", async () => {
		const configPath = configPathFor(tempHome());
		const lines: string[] = [];
		await runInitConfig(configPath, (message) => lines.push(message));
		await runInitConfig(configPath, (message) => lines.push(message));

		expect(lines.join("\n")).not.toContain("unreachable");
	});
});

describe("createDefaultConfigFile permissions", () => {
	test("writes the token file 0600 inside a 0700 directory", async () => {
		const home = tempHome();
		const configPath = configPathFor(home);

		const created = await createDefaultConfigFile(configPath);

		expect(created).toBe(configPath);
		// The generated file carries a root-equivalent bearer token.
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(home, ".draht")).mode & 0o777).toBe(0o700);
	});

	test("returns null and leaves the existing file untouched", async () => {
		const configPath = configPathFor(tempHome());
		await createDefaultConfigFile(configPath);
		const before = await Bun.file(configPath).text();

		expect(await createDefaultConfigFile(configPath)).toBeNull();
		expect(await Bun.file(configPath).text()).toBe(before);
	});
});

describe("cli --init-config (subprocess, temp HOME)", () => {
	async function runCli(home: string): Promise<{ code: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn([process.execPath, CLI_ENTRY, "--init-config"], {
			env: { ...process.env, HOME: home },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const code = await proc.exited;
		return { code, stdout, stderr };
	}

	test("prints the created message and exits 0", async () => {
		const home = tempHome();

		const { code, stdout, stderr } = await runCli(home);

		expect(stdout.trim()).toBe(`Created default config at ${configPathFor(home)}`);
		expect(stdout).not.toContain("unreachable");
		expect(stderr).not.toContain("unreachable");
		expect(code).toBe(0);
	});

	test("prints the already-exists message and exits 0 on a second run", async () => {
		const home = tempHome();
		await runCli(home);

		const { code, stdout } = await runCli(home);

		expect(stdout.trim()).toBe(`Config already exists at ${configPathFor(home)}`);
		expect(code).toBe(0);
	});
});
