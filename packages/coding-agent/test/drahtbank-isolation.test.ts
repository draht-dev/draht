import { spawn } from "node:child_process";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Isolation } from "../eval/drahtbank/isolation.mjs";
import { createIsolation, ISOLATION_VERSION } from "../eval/drahtbank/isolation.mjs";

describe.skipIf(process.platform !== "linux")("Drahtbank kernel filesystem boundary", () => {
	let root: string;
	let workspace: string;
	let outside: string;
	let isolation: Isolation;

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "drahtbank-isolation-test-"));
		workspace = join(root, "workspace");
		outside = join(root, "control");
		mkdirSync(workspace);
		mkdirSync(outside);
		writeFileSync(join(outside, "manifest.json"), '{"hidden":"control"}\n');
		symlinkSync(outside, join(workspace, "escape"));
		isolation = await createIsolation(workspace);
	}, 30_000);

	afterAll(() => {
		isolation?.dispose();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("preflights and preserves ordinary file operations in the fixture", async () => {
		expect(isolation.evidence.policy).toBe(ISOLATION_VERSION);
		expect(isolation.evidence.workerSha256).toMatch(/^[a-f0-9]{64}$/);
		await isolation.fs({ op: "mkdir", path: "src/nested" });
		await isolation.fs({ op: "write", path: "src/nested/file.txt", content: "first\nsecond\n" });
		expect(Buffer.from(await isolation.fs({ op: "read", path: "src/nested/file.txt" }), "base64").toString()).toBe(
			"first\nsecond\n",
		);
		expect(await isolation.fs({ op: "stat", path: "src/nested" })).toMatchObject({ isDirectory: true });
		expect(await isolation.fs({ op: "readdir", path: "src/nested" })).toEqual(["file.txt"]);
		expect(await isolation.fs({ op: "access", path: "src/nested/file.txt", mode: 6 })).toBeNull();
	});

	it("rejects absolute and parent paths before direct filesystem access", async () => {
		await expect(isolation.fs({ op: "read", path: join(outside, "manifest.json") })).rejects.toThrow(
			"outside the fixture",
		);
		await expect(isolation.fs({ op: "write", path: "../control/modified", content: "outside" })).rejects.toThrow(
			"outside the fixture",
		);
		expect(existsSync(join(outside, "modified"))).toBe(false);
	});

	it("blocks symlink escape for direct reads, edits, and directory creation", async () => {
		await expect(isolation.fs({ op: "read", path: "escape/manifest.json" })).rejects.toThrow();
		await expect(isolation.fs({ op: "write", path: "escape/manifest.json", content: "changed" })).rejects.toThrow();
		await expect(isolation.fs({ op: "mkdir", path: "escape/created" })).rejects.toThrow();
		expect(readFileSync(join(outside, "manifest.json"), "utf8")).toBe('{"hidden":"control"}\n');
		expect(existsSync(join(outside, "created"))).toBe(false);
	});

	it("prevents temporary outside writes even when the same shell would delete them", async () => {
		const result = await isolation.run([
			isolation.nodePath,
			"-e",
			`const fs=require("node:fs"); const p=process.argv[1]; fs.writeFileSync(p,"escape"); fs.unlinkSync(p)`,
			join(outside, "temporary"),
		]);
		expect(result.exitCode).not.toBe(0);
		expect(existsSync(join(outside, "temporary"))).toBe(false);
		const symlink = await isolation.run([
			isolation.nodePath,
			"-e",
			`require("node:fs").writeFileSync("escape/manifest.json","escape")`,
		]);
		expect(symlink.exitCode).not.toBe(0);
		expect(readFileSync(join(outside, "manifest.json"), "utf8")).toBe('{"hidden":"control"}\n');
	});

	it("does not mount controls, the host proc, or writable temporary directories", async () => {
		const result = await isolation.run([
			isolation.nodePath,
			"-e",
			`const fs=require("node:fs"),assert=require("node:assert/strict");
for(const p of [process.argv[1],"/proc/self/environ","/proc/1/root"]) assert.throws(()=>fs.readFileSync(p));
assert.throws(()=>fs.writeFileSync("/tmp/outside-temporary","escape"));
assert.throws(()=>fs.writeFileSync("/.drahtbank/worker.mjs","escape"));
console.log("denied");`,
			join(outside, "manifest.json"),
		]);
		expect(result).toMatchObject({ exitCode: 0, stdout: "denied\n", error: null });
	});

	it("drops capabilities and cannot remount the readonly root", async () => {
		const result = await isolation.run([isolation.resolveExecutable("setpriv"), "--dump"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("no_new_privs: 1");
		expect(result.stdout).toContain("Capability bounding set: [none]");
		expect(result.stdout).toContain("Ambient capabilities: [none]");
		const remount = await isolation.run([isolation.resolveExecutable("mount"), "-o", "remount,bind,rw", "/"]);
		expect(remount.exitCode).not.toBe(0);
	});

	it("does not inherit provider credentials or shell startup configuration", async () => {
		const original = process.env.DRAHTBANK_TEST_SECRET;
		process.env.DRAHTBANK_TEST_SECRET = "test-only-value";
		try {
			const result = await isolation.run([
				isolation.nodePath,
				"-e",
				`const assert=require("node:assert/strict");assert.equal(process.env.DRAHTBANK_TEST_SECRET,undefined);assert.equal(process.env.NODE_OPTIONS,undefined);assert.equal(process.env.BASH_ENV,undefined);`,
			]);
			expect(result).toMatchObject({ exitCode: 0, error: null });
		} finally {
			if (original === undefined) delete process.env.DRAHTBANK_TEST_SECRET;
			else process.env.DRAHTBANK_TEST_SECRET = original;
		}
	});

	it("isolates TCP networking and does not expose host pathname sockets", async () => {
		let connections = 0;
		const tcp = createServer((socket) => {
			connections++;
			socket.destroy();
		});
		const unix = createServer((socket) => {
			connections++;
			socket.destroy();
		});
		await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
		const socketPath = join(outside, "host.sock");
		await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
		try {
			const address = tcp.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP address");
			const result = await isolation.run([
				isolation.nodePath,
				"-e",
				`const net=require("node:net");let denied=0;
for(const target of [{host:"127.0.0.1",port:Number(process.argv[1])},{path:process.argv[2]}]){
const s=net.connect(target);s.on("connect",()=>{s.destroy();process.exitCode=1});s.on("error",()=>{if(++denied===2)console.log("denied")});s.setTimeout(1000,()=>{s.destroy();process.exitCode=1})}`,
				String(address.port),
				socketPath,
			]);
			expect(result).toMatchObject({ exitCode: 0, stdout: "denied\n" });
			expect(connections).toBe(0);
		} finally {
			await Promise.all([
				new Promise<void>((resolve) => tcp.close(() => resolve())),
				new Promise<void>((resolve) => unix.close(() => resolve())),
			]);
		}
	});

	it("kills detached descendants when the command exits", async () => {
		const marker = join(workspace, "late-child-write");
		const childSource = `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"late"),200)`;
		const result = await isolation.run([
			isolation.nodePath,
			"-e",
			`require("node:child_process").spawn(process.execPath,["-e",process.argv[1]],{detached:true,stdio:"ignore"}).unref()`,
			childSource,
		]);
		expect(result.exitCode).toBe(0);
		await delay(350);
		expect(existsSync(marker)).toBe(false);
	});

	it("times out both async and synchronous commands without leaving descendants", async () => {
		const marker = join(workspace, "timed-out-child");
		const script = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(`setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"late"),500)`)}],{detached:true,stdio:"ignore"}).unref();setInterval(()=>{},1000)`;
		const asyncResult = await isolation.run([isolation.nodePath, "-e", script], { timeoutMs: 200 });
		expect(asyncResult).toMatchObject({ timedOut: true, exitCode: null });
		const syncResult = isolation.runSync([isolation.nodePath, "-e", script], { timeoutMs: 200 });
		expect(syncResult).toMatchObject({ timedOut: true, exitCode: null });
		await delay(650);
		expect(existsSync(marker)).toBe(false);
	});

	it("terminates the namespace when a streaming caller kills its child", async () => {
		const marker = join(workspace, "cancelled-child");
		const source = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(`setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"late"),300)`)}],{detached:true,stdio:"ignore"}).unref();console.log("started");setInterval(()=>{},1000)`;
		const child = isolation.spawn([isolation.nodePath, "-e", source]);
		child.stdin.end();
		let didClose = false;
		const closed = new Promise<void>((resolve) =>
			child.on("close", () => {
				didClose = true;
				resolve();
			}),
		);
		await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
		child.kill();
		await Promise.race([closed, delay(1_000)]);
		const cancelled = didClose;
		if (!didClose) child.kill("SIGKILL");
		await closed;
		expect(cancelled).toBe(true);
		await delay(450);
		expect(existsSync(marker)).toBe(false);
	});

	it("terminates worker namespaces when the outer provider process group is killed", async () => {
		const marker = join(workspace, "outer-kill-child");
		const grandchild = `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"late"),800)`;
		const worker = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{detached:true,stdio:"ignore"}).unref();console.log("started");setInterval(()=>{},1000)`;
		const helper = new URL("../eval/drahtbank/isolation.mjs", import.meta.url).href;
		const source = `import {createIsolation} from ${JSON.stringify(helper)};
const isolation=await createIsolation(process.argv[1]);
const worker=isolation.spawn([isolation.nodePath,"-e",${JSON.stringify(worker)}]);
worker.stdin.end();worker.stderr.resume();worker.stdout.once("data",()=>console.log(worker.pid));setInterval(()=>{},1000);`;
		const provider = spawn(process.execPath, ["--input-type=module", "-e", source, workspace], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let supervisor: number | undefined;
		let diagnostic = "";
		provider.stderr.on("data", (data: Buffer) => {
			diagnostic += data.toString();
		});
		const closed = new Promise<void>((resolve) => provider.on("close", () => resolve()));
		try {
			supervisor = await Promise.race([
				new Promise<number>((resolve) =>
					provider.stdout.once("data", (data: Buffer) => resolve(Number(data.toString().trim()))),
				),
				delay(5_000).then(() => {
					throw new Error(`Outer provider did not start: ${diagnostic}`);
				}),
			]);
			expect(Number.isSafeInteger(supervisor)).toBe(true);
			if (!provider.pid) throw new Error("Outer provider has no PID");
			process.kill(-provider.pid, "SIGKILL");
			await Promise.race([
				closed,
				delay(1_000).then(() => {
					throw new Error("Outer provider did not close after group termination");
				}),
			]);
			await delay(1_000);
			let state: string | undefined;
			try {
				state = /\) ([A-Z]) /.exec(readFileSync(`/proc/${supervisor}/stat`, "utf8"))?.[1];
			} catch {}
			expect(state === undefined || state === "Z").toBe(true);
			expect(existsSync(marker)).toBe(false);
		} finally {
			if (provider.pid)
				try {
					process.kill(-provider.pid, "SIGKILL");
				} catch {}
			if (supervisor)
				try {
					process.kill(supervisor, "SIGKILL");
				} catch {}
		}
	});

	it("provides a streaming child for grep and keeps literal arguments", async () => {
		const child = isolation.spawn([isolation.resolveExecutable("rg"), "--fixed-strings", "--", "second", workspace]);
		child.stdin.end();
		let output = "";
		child.stdout.on("data", (data: Buffer) => {
			output += data.toString();
		});
		const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
		expect(status).toBe(0);
		expect(output).toContain("file.txt:second");
		const literal = await isolation.run([
			isolation.nodePath,
			"-e",
			"console.log(JSON.stringify(process.argv.slice(1)))",
			"",
			"$(literal)",
		]);
		expect(literal).toMatchObject({ exitCode: 0, stdout: '["","$(literal)"]\n' });
	});

	it("fails closed for protected roots and unavailable executables", async () => {
		await expect(createIsolation("/")).rejects.toThrow("protected root");
		await expect(createIsolation(tmpdir())).rejects.toThrow("protected root");
		expect(() => isolation.resolveExecutable("drahtbank-nonexistent-executable")).toThrow("isolation unavailable");
		const unavailable = await isolation.run(["/missing/command"]);
		expect(unavailable.exitCode).not.toBe(0);
		expect(unavailable.stderr).toContain("No such file");
	});

	it.each(["/.drahtbank", "/.drahtbank/artifacts", "/.drahtbank/artifacts/fixture"])(
		"rejects reserved namespace paths before filesystem setup: %s",
		async (path) => {
			await expect(createIsolation(path)).rejects.toThrow("protected root /.drahtbank");
		},
	);

	it("rejects hardlinked inputs that would alias a writable outside inode", async () => {
		const linked = join(workspace, "outside-inode");
		linkSync(join(outside, "manifest.json"), linked);
		try {
			await expect(createIsolation(workspace)).rejects.toThrow("hardlinked file");
		} finally {
			rmSync(linked);
		}
	});

	it("rejects preexisting sockets inside the fixture", async () => {
		const socketPath = join(workspace, "inside-host.sock");
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		try {
			await expect(createIsolation(workspace)).rejects.toThrow("special file");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("retains trusted shell output at a readable, readonly virtual path", async () => {
		const source = join(outside, "full-output.txt");
		writeFileSync(source, "complete output\n");
		const publicPath = isolation.retainReadOnlyFile(source);
		expect(publicPath).toMatch(/^\/\.drahtbank\/artifacts\/[a-f0-9-]+\.txt$/);
		expect(publicPath).not.toContain(outside);
		expect(Buffer.from(await isolation.fs({ op: "read", path: publicPath }), "base64").toString()).toBe(
			"complete output\n",
		);
		expect(await isolation.fs({ op: "stat", path: publicPath })).toMatchObject({ isFile: true });
		await expect(isolation.fs({ op: "write", path: publicPath, content: "overwrite" })).rejects.toThrow(
			"outside the fixture",
		);
		await expect(isolation.fs({ op: "mkdir", path: publicPath })).rejects.toThrow("outside the fixture");
		const shell = await isolation.run([
			isolation.nodePath,
			"-e",
			`const fs=require("node:fs"),assert=require("node:assert/strict");assert.equal(fs.readFileSync(process.argv[1],"utf8"),"complete output\\n");assert.throws(()=>fs.writeFileSync(process.argv[1],"overwrite"));assert.throws(()=>fs.readFileSync(process.argv[2]));`,
			publicPath,
			source,
		]);
		expect(shell).toMatchObject({ exitCode: 0, error: null });
		writeFileSync(source, "host capture changed");
		expect(Buffer.from(await isolation.fs({ op: "read", path: publicPath }), "base64").toString()).toBe(
			"complete output\n",
		);
	});

	it("does not accept model fixture files, symlinks, or directories as trusted output captures", () => {
		const target = join(outside, "capture");
		const symlink = join(outside, "capture-link");
		writeFileSync(target, "capture");
		symlinkSync(target, symlink);
		expect(() => isolation.retainReadOnlyFile(symlink)).toThrow("nonsymlink");
		expect(() => isolation.retainReadOnlyFile(outside)).toThrow("nonsymlink");
		expect(() => isolation.retainReadOnlyFile(join(workspace, "src/nested/file.txt"))).toThrow("outside the fixture");
	});

	it("allows base64 transport overhead when reading a large retained capture", async () => {
		const source = join(outside, "large-capture.txt");
		const bytes = Buffer.alloc(8 * 1024 * 1024, "x");
		writeFileSync(source, bytes);
		const publicPath = isolation.retainReadOnlyFile(source);
		const restored = Buffer.from(await isolation.fs({ op: "read", path: publicPath }), "base64");
		expect(restored.equals(bytes)).toBe(true);
	});

	it("disposes owned captures and refuses subsequent execution", async () => {
		const fixture = join(root, "disposable");
		mkdirSync(fixture);
		const isolated = await createIsolation(fixture);
		const source = join(outside, "disposable-capture.txt");
		writeFileSync(source, "capture");
		isolated.retainReadOnlyFile(source);
		isolated.dispose();
		isolated.dispose();
		await expect(isolated.fs({ op: "read", path: "anything" })).rejects.toThrow("disposed");
		expect(() => isolated.spawn([isolated.nodePath, "-e", ""])).toThrow("disposed");
		expect(readFileSync(source, "utf8")).toBe("capture");
	});
});
