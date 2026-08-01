import { describe, expect, test } from "vitest";
import { parseExperimentalCliOptions } from "../src/cli/experimental/options.ts";

describe("parseExperimentalCliOptions", () => {
	test("selects combined mode and preserves existing CLI arguments", () => {
		expect(
			parseExperimentalCliOptions([
				"--cwd",
				"/workspace",
				"--provider=anthropic",
				"--model",
				"claude-sonnet",
				"--thinking=high",
				"inspect",
				"the project",
			]),
		).toEqual({
			ok: true,
			options: {
				role: "combined",
				remainingArgs: [
					"--cwd",
					"/workspace",
					"--provider=anthropic",
					"--model",
					"claude-sonnet",
					"--thinking=high",
					"inspect",
					"the project",
				],
			},
		});
	});

	test("parses repeatable server listeners and preserves other arguments", () => {
		expect(
			parseExperimentalCliOptions([
				"server",
				"--listen",
				"unix:///tmp/pi.sock",
				"--model",
				"claude-sonnet",
				"--listen=unix:///tmp/pi-admin.sock",
			]),
		).toEqual({
			ok: true,
			options: {
				role: "server",
				listen: [
					{ transport: "unix", path: "/tmp/pi.sock" },
					{ transport: "unix", path: "/tmp/pi-admin.sock" },
				],
				remainingArgs: ["--model", "claude-sonnet"],
			},
		});
	});

	test("parses a client transport address", () => {
		expect(parseExperimentalCliOptions(["client", "--connect", "unix:///tmp/pi.sock", "hello"])).toEqual({
			ok: true,
			options: {
				role: "client",
				connect: { transport: "unix", path: "/tmp/pi.sock" },
				remainingArgs: ["hello"],
			},
		});
	});

	test.each([
		[["--auth-token", "secret"], { type: "token", token: "secret" }],
		[["--auth-token-file", "/tmp/token"], { type: "file", path: "/tmp/token" }],
	] as const)("parses authentication source %j", (argv, auth) => {
		expect(parseExperimentalCliOptions(argv)).toEqual({
			ok: true,
			options: { role: "combined", auth, remainingArgs: [] },
		});
	});

	test.each([[[]], [["server"]], [["client"]]] as const)(
		"permits omitted authentication for later environment/default resolution",
		(argv) => {
			expect(parseExperimentalCliOptions(argv)).toEqual({
				ok: true,
				options: { role: argv[0] ?? "combined", remainingArgs: [] },
			});
		},
	);

	test("preserves unknown options, @file arguments, and the positional separator", () => {
		expect(parseExperimentalCliOptions(["--unknown", "@prompt.md", "--", "--listen", "unix:///tmp/pi.sock"])).toEqual(
			{
				ok: true,
				options: {
					role: "combined",
					remainingArgs: ["--unknown", "@prompt.md", "--", "--listen", "unix:///tmp/pi.sock"],
				},
			},
		);
	});

	test.each([
		[
			["--auth-token", "secret", "--auth-token-file", "/tmp/token"],
			"--auth-token and --auth-token-file are mutually exclusive",
		],
		[["--listen", "/tmp/pi.sock"], 'Invalid --listen address "/tmp/pi.sock"'],
		[["--listen", "ws://localhost:8080"], 'Unsupported --listen transport "ws:"'],
		[["--listen", "unix://relative.sock"], "Unix transport address must not include an authority"],
		[["client", "--listen", "unix:///tmp/pi.sock"], "--listen is only valid for combined or server mode"],
		[["server", "--connect", "unix:///tmp/pi.sock"], "--connect is only valid for client mode"],
		[["client", "--connect", "ws://localhost:8080"], 'Unsupported --connect transport "ws:"'],
		[["--listen"], "--listen requires a value"],
		[["--connect="], "--connect requires a value"],
	] as const)("rejects invalid experimental input %j", (argv, error) => {
		const result = parseExperimentalCliOptions(argv);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining(error));
	});

	test("reports independent experimental errors together", () => {
		expect(
			parseExperimentalCliOptions([
				"client",
				"--listen",
				"ws://localhost:8080",
				"--auth-token",
				"secret",
				"--auth-token-file",
				"/tmp/token",
			]),
		).toEqual({
			ok: false,
			errors: [
				'Unsupported --listen transport "ws:"',
				"--auth-token and --auth-token-file are mutually exclusive",
				"--listen is only valid for combined or server mode",
			],
		});
	});

	test("treats role names after the first argument as existing CLI arguments", () => {
		expect(parseExperimentalCliOptions(["--cwd", "/workspace", "server"])).toEqual({
			ok: true,
			options: { role: "combined", remainingArgs: ["--cwd", "/workspace", "server"] },
		});
	});
});
