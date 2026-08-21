import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Emitted-binary proofs for R32-FLEET.8 and R32-FLEET.9.
 *
 * Everything here drives the process the `draht-gateway` bin actually starts
 * (`bun src/cli.ts`) over HTTP, never the in-process app object: the two
 * requirements are about what the shipped daemon exposes, and a package-level
 * test that constructs `createServer()` by hand cannot prove that.
 *
 * The daemon is started once with `HOME` pointed at a throwaway directory so
 * it can neither read nor repair the developer's real
 * `~/.draht/gateway.config.json`.
 */

const CLI = join(import.meta.dir, "..", "cli.ts");
const TOKEN = "emitted-daemon-e2e-token";

let home: string;
let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
let port: number;
let base: string;

/**
 * Claim a currently-free loopback TCP port.
 *
 * The CLI refuses `--port 0` (it validates 1..65535), so the ephemeral port is
 * chosen here and handed to the daemon explicitly.
 */
function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) {
		throw new Error("Bun.serve did not report a port for the ephemeral probe");
	}
	return claimed;
}

/** Read the daemon's stderr until the structured "listening" record appears. */
async function readBoundPort(stderr: ReadableStream<Uint8Array>, timeoutMs = 15_000): Promise<number> {
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;
	let buffered = "";
	try {
		while (Date.now() < deadline) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			for (const line of buffered.split("\n")) {
				if (!line.trim().startsWith("{")) continue;
				try {
					const record = JSON.parse(line) as { message?: string; port?: number };
					if (record.message === "draht-gateway listening" && typeof record.port === "number") {
						return record.port;
					}
				} catch {
					// Partial line — wait for the rest.
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	throw new Error(`daemon never reported a bound port. stderr so far:\n${buffered}`);
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "draht-gateway-e2e-home-"));
	port = freeLoopbackPort();
	proc = Bun.spawn(["bun", CLI, "--port", String(port), "--auth", TOKEN], {
		env: { ...process.env, HOME: home },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	}) as Bun.Subprocess<"ignore", "pipe", "pipe">;
	// Read the record back rather than trusting the request: the operator log is
	// what says which socket actually exists.
	expect(await readBoundPort(proc.stderr)).toBe(port);
	base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	proc?.kill();
	await proc?.exited;
	rmSync(home, { recursive: true, force: true });
});

describe("R32-FLEET.8 — the emitted daemon has no arbitrary-command spawn route", () => {
	test("POST /sessions with a caller-supplied command is refused and the canary is never created", async () => {
		const canary = join(home, "R32-FLEET-8-canary");
		expect(existsSync(canary)).toBe(false);

		const res = await fetch(`${base}/sessions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ command: ["/bin/sh", "-c", `touch ${canary}`] }),
		});

		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/command/i);

		// Give any process the route might still have spawned time to run.
		await Bun.sleep(500);
		expect(existsSync(canary)).toBe(false);
	});

	test("every JSON shape of `command` is refused, and none of them spawns", async () => {
		const canary = join(home, "R32-FLEET-8-canary-shapes");
		for (const command of [
			["/bin/sh", "-c", `touch ${canary}`],
			["/usr/bin/touch", canary],
			"touch canary",
			{ 0: "/usr/bin/touch" },
			null,
			[],
		]) {
			const res = await fetch(`${base}/sessions`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({ command }),
			});
			expect({ command, status: res.status }).toEqual({ command, status: 400 });
		}
		await Bun.sleep(500);
		expect(existsSync(canary)).toBe(false);
	});

	test("session listing and lifecycle still work on the same daemon", async () => {
		const created = await fetch(`${base}/sessions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(created.status).toBe(201);
		const session = (await created.json()) as { id: string; status: string };
		expect(session.status).toBe("starting");

		const listed = await fetch(`${base}/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
		expect(listed.status).toBe(200);
		const { sessions } = (await listed.json()) as { sessions: { id: string }[] };
		expect(sessions.map((s) => s.id)).toContain(session.id);

		const one = await fetch(`${base}/sessions/${session.id}`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(one.status).toBe(200);

		const destroyed = await fetch(`${base}/sessions/${session.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(destroyed.status).toBe(204);

		const gone = await fetch(`${base}/sessions/${session.id}`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(gone.status).toBe(404);
	});
});

describe("R32-FLEET.9 — the emitted daemon opens exactly one listener", () => {
	test("the spawned pid has exactly one listening socket, on loopback", () => {
		// `lsof -a -p <pid> -iTCP -sTCP:LISTEN` enumerates the listening sockets
		// the kernel actually attributes to that process — the only evidence that
		// settles "how many listeners does this daemon open".
		const out = execFileSync("lsof", ["-nP", "-a", "-p", String(proc.pid), "-iTCP", "-sTCP:LISTEN"], {
			encoding: "utf-8",
		});
		const listeners = out
			.split("\n")
			.slice(1) // header row
			.map((line) => line.trim())
			.filter((line) => line.length > 0);

		expect({ count: listeners.length, listeners }).toEqual({ count: 1, listeners });
		expect(listeners[0]).toContain(`127.0.0.1:${port}`);
	});
});
