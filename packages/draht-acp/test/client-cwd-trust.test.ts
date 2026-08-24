import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyMessage, client, methods, PROTOCOL_VERSION, type Stream } from "@agentclientprotocol/sdk";
import { registerFauxProvider } from "@draht/ai/compat";
import {
	AuthStorage,
	type CreateAgentSessionOptions,
	ModelRuntime,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
} from "@draht/coding-agent";

import { buildDrahtAcpAgent } from "../src/draht-acp-agent.ts";

const MARKER = "extension-executed";

let root: string;
let agentDir: string;
let trusted: string;
let plain: string;
let attacker: string;
let marker: string;
const originalHome = process.env.HOME;

/** Loading a project extension is code execution, so the marker is proof of the trust decision. */
function plantExtension(dir: string): void {
	mkdirSync(join(dir, ".draht", "extensions"), { recursive: true });
	writeFileSync(
		join(dir, ".draht", "extensions", "evil.js"),
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, ${JSON.stringify(MARKER)});\nexport default function () { return { name: "evil" }; }\n`,
	);
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "acp-client-cwd-")));
	agentDir = join(root, "agent");
	trusted = join(root, "trusted");
	plain = join(root, "plain");
	attacker = join(root, "attacker");
	marker = join(root, "pwned.txt");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(root, "home"), { recursive: true });
	mkdirSync(join(root, "out", "x"), { recursive: true });
	mkdirSync(join(root, "out", "evil"), { recursive: true });
	mkdirSync(join(trusted, "sub"), { recursive: true });
	plantExtension(plain);
	// Lexically `<trusted>/O/../evil` is THIS directory; physically it is `<root>/out/evil`.
	plantExtension(join(trusted, "evil"));
	symlinkSync(join(root, "out", "x"), join(trusted, "O"));
	// `<attacker>/O/..` is lexically `<attacker>` but physically `<trusted>`, a directory a user
	// may well have trusted. The attacker owns the first; the trust store is asked about the second.
	plantExtension(attacker);
	symlinkSync(join(trusted, "sub"), join(attacker, "O"));
	symlinkSync(plain, join(root, "link"));
	process.env.HOME = join(root, "home");
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(root, { recursive: true, force: true });
});

async function keylessSessionOptions(settingsManager?: SettingsManager): Promise<CreateAgentSessionOptions> {
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "faux-key" } });
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	return { model, agentDir, modelRuntime, sessionManager: SessionManager.inMemory(), settingsManager };
}

/** Drives the real shim over an in-process ACP stream: `initialize`, then `session/new`. */
async function openAcpSession(clientCwd: string, settingsManager?: SettingsManager): Promise<void> {
	const toAgent = new TransformStream<AnyMessage, AnyMessage>();
	const fromAgent = new TransformStream<AnyMessage, AnyMessage>();
	const agentStream: Stream = { writable: fromAgent.writable, readable: toAgent.readable };
	const clientStream: Stream = { writable: toAgent.writable, readable: fromAgent.readable };
	const options = await keylessSessionOptions(settingsManager);
	buildDrahtAcpAgent({ name: "draht-acp-test", sessionOptions: () => options }).connect(agentStream);
	const ctx = client({ name: "test-client" }).connect(clientStream).agent;
	await ctx.request(methods.agent.initialize, {
		protocolVersion: PROTOCOL_VERSION,
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
	});
	await ctx.buildSession(clientCwd).start();
}

test("a recorded trust decision lets the client cwd's extension run", async () => {
	new ProjectTrustStore(agentDir).set(plain, true);
	await openAcpSession(plain);
	expect(existsSync(marker)).toBe(true);
});

test("an untrusted client cwd's extension never runs", async () => {
	await openAcpSession(plain);
	expect(existsSync(marker)).toBe(false);
});

// Handing in `SettingsManager.inMemory()` is a storage choice, not a trust decision.
test("a settings manager the embedder supplied does not carry trust for the client's cwd", async () => {
	await openAcpSession(plain, SettingsManager.inMemory());
	expect(existsSync(marker)).toBe(false);
});

// `sessionOptions` may hand every session the same manager, and every session keeps its reference.
test("a supplied settings manager an untrusted cwd revoked is not re-trusted by a later session", async () => {
	const shared = SettingsManager.inMemory();
	new ProjectTrustStore(agentDir).set(join(trusted, "evil"), true);

	await openAcpSession(plain, shared);
	expect(existsSync(marker)).toBe(false);

	await openAcpSession(join(trusted, "evil"), shared);
	expect(existsSync(marker)).toBe(false);
});

test("a supplied settings manager still honours a recorded trust decision", async () => {
	new ProjectTrustStore(agentDir).set(plain, true);
	await openAcpSession(plain, SettingsManager.inMemory());
	expect(existsSync(marker)).toBe(true);
});

// One spelling, one extension file, two places the trust could have been recorded. Split into two
// tests because a module already imported in this process is not re-executed on a second load.
test("a `..` that leaves a trusted root across a symlink does not inherit its trust", async () => {
	new ProjectTrustStore(agentDir).set(trusted, true);
	await openAcpSession(`${trusted}/O/../evil`);
	expect(existsSync(marker)).toBe(false);
});

test("that same spelling stays refused even once the directory it physically lands in is recorded", async () => {
	new ProjectTrustStore(agentDir).set(join(root, "out", "evil"), true);
	await openAcpSession(`${trusted}/O/../evil`);
	expect(existsSync(marker)).toBe(false);
});

// The trust store is keyed by the resolved spelling, so `<attacker>/O/..` asks about `<trusted>`.
// The extension that would run is the attacker's own, and nobody was ever asked about that one.
test("a decision recorded for a trusted directory does not carry to an attacker's own directory", async () => {
	new ProjectTrustStore(agentDir).set(trusted, true);
	await openAcpSession(`${attacker}/O/..`);
	expect(existsSync(marker)).toBe(false);
});

test("a plain symlinked cwd still runs the extension its trusted target holds", async () => {
	new ProjectTrustStore(agentDir).set(plain, true);
	await openAcpSession(join(root, "link"));
	expect(existsSync(marker)).toBe(true);
});

test("a `..` that crossed no symlink still runs the trusted cwd's extension", async () => {
	new ProjectTrustStore(agentDir).set(plain, true);
	await openAcpSession(`${plain}/../plain`);
	expect(existsSync(marker)).toBe(true);
});
