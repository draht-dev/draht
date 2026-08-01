import { describe, expect, test } from "vitest";
import { parseExperimentalCliOptions } from "../src/cli/experimental/options.ts";

describe("parseExperimentalCliOptions", () => {
	test("selects combined mode when no role is present", () => {
		expect(parseExperimentalCliOptions(["--cwd", "/workspace", "inspect", "the project"])).toEqual({
			ok: true,
			options: {
				role: "combined",
				cwd: "/workspace",
				initialPrompt: "inspect the project",
				help: false,
				version: false,
			},
		});
	});

	test("parses repeatable server listeners", () => {
		const result = parseExperimentalCliOptions([
			"server",
			"--listen",
			"unix:///tmp/pi.sock",
			"--listen=unix:///tmp/pi-admin.sock",
		]);
		expect(result).toMatchObject({
			ok: true,
			options: {
				role: "server",
				listen: [
					{ transport: "unix", path: "/tmp/pi.sock" },
					{ transport: "unix", path: "/tmp/pi-admin.sock" },
				],
			},
		});
	});

	test("parses a client connection endpoint", () => {
		const result = parseExperimentalCliOptions(["client", "--connect", "unix:///tmp/pi.sock"]);
		expect(result).toMatchObject({
			ok: true,
			options: { role: "client", connect: { transport: "unix", path: "/tmp/pi.sock" } },
		});
	});

	test("parses shared model options and inline values", () => {
		const result = parseExperimentalCliOptions([
			"--provider=anthropic",
			"--model",
			"claude-sonnet",
			"--thinking=high",
			"--session",
			"session-1",
		]);
		expect(result).toMatchObject({
			ok: true,
			options: {
				role: "combined",
				provider: "anthropic",
				model: "claude-sonnet",
				thinking: "high",
				sessionId: "session-1",
			},
		});
	});

	test.each([
		[["--auth-token", "secret"], { type: "token", token: "secret" }],
		[["--auth-token-file", "/tmp/token"], { type: "file", path: "/tmp/token" }],
	] as const)("parses server authentication source %j", (argv, auth) => {
		const result = parseExperimentalCliOptions(argv);
		expect(result).toMatchObject({ ok: true, options: { role: "combined", auth } });
	});

	test("accepts token and token-file authentication in client mode", () => {
		expect(parseExperimentalCliOptions(["client", "--auth-token", "secret"])).toMatchObject({
			ok: true,
			options: { role: "client", auth: { type: "token", token: "secret" } },
		});
		expect(parseExperimentalCliOptions(["client", "--auth-token-file", "/tmp/token"])).toMatchObject({
			ok: true,
			options: { role: "client", auth: { type: "file", path: "/tmp/token" } },
		});
	});

	test("supports help, version, and positional-only prompts", () => {
		expect(parseExperimentalCliOptions(["-h", "-v", "--", "--review", "this"])).toEqual({
			ok: true,
			options: {
				role: "combined",
				help: true,
				version: true,
				initialPrompt: "--review this",
			},
		});
	});

	test.each([[[]], [["server"]], [["client"]]] as const)(
		"permits omitted authentication for later environment/default resolution",
		(argv) => {
			const result = parseExperimentalCliOptions(argv);
			expect(result.ok).toBe(true);
			if (result.ok) expect("auth" in result.options).toBe(false);
		},
	);

	test.each([
		[
			["--auth-token", "secret", "--auth-token-file", "/tmp/token"],
			"--auth-token and --auth-token-file are mutually exclusive",
		],
		[["server", "--session", "session-1"], "--session is only valid for combined or client mode"],
		[["server", "hello"], "An initial prompt is only valid for combined or client mode"],
		[["--provider", "anthropic"], "--provider requires --model"],
		[["--thinking", "extreme"], 'Invalid thinking level "extreme"'],
		[["--listen", "/tmp/pi.sock"], 'Invalid --listen endpoint "/tmp/pi.sock"'],
		[["--listen", "ws://localhost:8080"], 'Unsupported --listen transport "ws:"'],
		[["--listen", "unix://relative.sock"], "Unix endpoint must not include an authority"],
		[["client", "--listen", "unix:///tmp/pi.sock"], "--listen is only valid for combined or server mode"],
		[["server", "--connect", "unix:///tmp/pi.sock"], "--connect is only valid for client mode"],
		[["client", "--connect", "ws://localhost:8080"], 'Unsupported --connect transport "ws:"'],
		[["--unknown"], "Unknown option: --unknown"],
		[["-x"], "Unknown option: -x"],
		[["--model"], "--model requires a value"],
		[["--model="], "--model requires a value"],
		[["@prompt.md"], "@file arguments are not supported in experimental mode"],
	] as const)("rejects invalid input %j", (argv, error) => {
		const result = parseExperimentalCliOptions(argv);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining(error));
	});

	test("reports independent errors together", () => {
		expect(parseExperimentalCliOptions(["server", "--provider", "anthropic", "hello"])).toEqual({
			ok: false,
			errors: ["--provider requires --model", "An initial prompt is only valid for combined or client mode"],
		});
	});

	test("treats role names after the first argument as a combined-mode prompt", () => {
		expect(parseExperimentalCliOptions(["--cwd", "/workspace", "server"])).toMatchObject({
			ok: true,
			options: { role: "combined", initialPrompt: "server" },
		});
	});
});
