import { describe, expect, test } from "bun:test";
import { SessionProcess } from "../session/session-process";

describe("SessionProcess", () => {
	test('constructor sets status === "starting" synchronously', () => {
		const proc = new SessionProcess(["echo", "hello"]);
		expect(proc.status).toBe("starting");
		proc.kill();
	});

	test('await proc.ready → status === "running"', async () => {
		const proc = new SessionProcess(["echo", "hello"]);
		await proc.ready;
		expect(proc.status).toBe("running");
		await proc.exited;
	});

	test('onOutput(cb) delivers decoded stdout chunks — echo hello → callback receives "hello\\n"', async () => {
		const proc = new SessionProcess(["echo", "hello"]);
		const chunks: string[] = [];
		proc.onOutput((data) => chunks.push(data));
		await proc.exited;
		expect(chunks.join("")).toContain("hello\n");
	});

	test("multiple onOutput subscribers each receive the same chunk independently", async () => {
		const proc = new SessionProcess(["echo", "world"]);
		const chunks1: string[] = [];
		const chunks2: string[] = [];
		proc.onOutput((data) => chunks1.push(data));
		proc.onOutput((data) => chunks2.push(data));
		await proc.exited;
		expect(chunks1.join("")).toContain("world\n");
		expect(chunks2.join("")).toContain("world\n");
	});

	test("unsubscribe function stops future delivery", async () => {
		const proc = new SessionProcess(["cat"]);
		const received: string[] = [];
		const unsub = proc.onOutput((data) => received.push(data));
		await proc.ready;
		proc.write("first\n");
		await Bun.sleep(50);
		unsub();
		proc.write("second\n");
		await Bun.sleep(50);
		proc.kill();
		await proc.exited;
		const joined = received.join("");
		expect(joined).toContain("first\n");
		expect(joined).not.toContain("second\n");
	});

	test('write("ping\\n") on cat process → onOutput receives "ping\\n" within 50ms', async () => {
		const proc = new SessionProcess(["cat"]);
		const chunks: string[] = [];
		proc.onOutput((data) => chunks.push(data));
		await proc.ready;
		proc.write("ping\n");
		await Bun.sleep(50);
		proc.kill();
		await proc.exited;
		expect(chunks.join("")).toContain("ping\n");
	});

	test('after process exits (await proc.exited) → status === "stopped"', async () => {
		const proc = new SessionProcess(["echo", "done"]);
		await proc.exited;
		expect(proc.status).toBe("stopped");
	});

	test('kill() terminates the process; after await proc.exited → status === "stopped"', async () => {
		const proc = new SessionProcess(["cat"]);
		await proc.ready;
		proc.kill();
		await proc.exited;
		expect(proc.status).toBe("stopped");
	});
});
