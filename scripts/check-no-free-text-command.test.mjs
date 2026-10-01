import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	clientUnionMembers,
	findCommandShapedClientFields,
	findTrustWriters,
	findUnrefusedBodyKeyReads,
	isCommandShaped,
	isTestSource,
	scanRepo,
	topLevelKeys,
	trustScanRoots,
} from "./check-no-free-text-command.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(ROOT, "scripts", "check-no-free-text-command.mjs");
const WIRE = join(ROOT, "packages/geist-protocol/src/wire.ts");
const SESSIONS_ROUTE = join(ROOT, "packages/gateway/src/gateway/routes/sessions.ts");

function wire({ attachFields = "", serverFields = "", clientMembers = ["AttachFrameSchema", "InputFrameSchema"], preamble = "" } = {}) {
	return `${preamble}
export const AttachFrameSchema = z.object({
	type: z.literal("attach"),
	sessionId: z.string().min(1),
	${attachFields}
});
export const InputFrameSchema = z.object({
	type: z.literal("input"),
	data: z.string(),
	clientId: z.string().min(1),
});
export const PermissionRequestFrameSchema = z.object({
	type: z.literal("permission_request"),
	command: z.string(),
	cwd: z.string(),
	path: z.string(),
	${serverFields}
});
export const ClientFrameSchema = z.discriminatedUnion("type", [
${clientMembers.map((m) => `\t${m},`).join("\n")}
]);
export const ServerFrameSchema = z.discriminatedUnion("type", [
	PermissionRequestFrameSchema,
]);
`;
}

/** A tree scanRepo can be pointed at, carrying one planted violation per rule. */
function fixtureRoot(files) {
	const root = mkdtempSync(join(tmpdir(), "gate-fx-"));
	for (const [path, contents] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, contents);
	}
	mkdirSync(join(root, "scripts"), { recursive: true });
	copyFileSync(GATE, join(root, "scripts", "check-no-free-text-command.mjs"));
	return root;
}

const PLANTED = {
	"packages/geist-protocol/src/wire.ts": `
export const SpawnOptionsSchema = z.object({ argv: z.array(z.string()) });
export const AttachFrameSchema = z.object({
	type: z.literal("attach"),
	options: SpawnOptionsSchema,
});
export const ClientFrameSchema = z.discriminatedUnion("type", [AttachFrameSchema]);
`,
	"packages/gateway/src/gateway/routes/sessions.ts": `
app.post("/", async (c) => {
	const body = await c.req.json();
	return c.json(manager.create(body.command), 201);
});
`,
	"packages/gateway/src/session/trust.ts": `
export function grant(cwd: string): void {
	setProjectTrusted(true, cwd);
}
`,
	"packages/geist-core/src/writer.ts": `
const trustPath = join(agentDir, "trust.json");
await Bun.write(trustPath, "{}");
`,
};

test("rule A over the shapes the wire has", () => {
	assert.deepEqual(findCommandShapedClientFields(wire()), []);
	assert.deepEqual(findCommandShapedClientFields(wire({ serverFields: "argv: z.array(z.string())," })), []);
});

test("rule A on a command-shaped client field", () => {
	for (const field of ["command: z.array(z.string())", "argv: z.array(z.string())", "cwd: z.string()", "commandLine: z.string()", "workingDir: z.string()", "envVars: z.record(z.string())"]) {
		const found = findCommandShapedClientFields(wire({ attachFields: `${field},` }));
		assert.equal(found.length, 1, field);
		assert.match(found[0].message, /client frame `attach` declares/);
		assert.match(found[0].message, new RegExp(field.split(":")[0]));
		assert.equal(found[0].line, 5, field);
	}
});

test("rule A through a nested z.object", () => {
	const found = findCommandShapedClientFields(wire({ attachFields: "options: z.object({ argv: z.array(z.string()) })," }));
	assert.equal(found.length, 1);
	assert.match(found[0].message, /declares `argv`/);
});

test("rule A through a named sub-schema", () => {
	const found = findCommandShapedClientFields(
		wire({ preamble: "export const SpawnOptionsSchema = z.object({ argv: z.array(z.string()) });", attachFields: "options: SpawnOptionsSchema," }),
	);
	assert.equal(found.length, 1);
	assert.match(found[0].message, /client frame `attach` declares `argv`/);
	assert.equal(found[0].line, 1);
});

test("rule A through a chained .extend", () => {
	const found = findCommandShapedClientFields(`
export const AttachFrameSchema = z.object({ type: z.literal("attach") }).extend({ command: z.array(z.string()) });
export const ClientFrameSchema = z.discriminatedUnion("type", [AttachFrameSchema]);
`);
	assert.equal(found.length, 1);
	assert.match(found[0].message, /declares `command`/);
});

test("rule A through a merged named schema", () => {
	const found = findCommandShapedClientFields(`
export const SpawnBaseSchema = z.object({ entrypoint: z.string() });
export const AttachFrameSchema = z.object({ type: z.literal("attach") }).merge(SpawnBaseSchema);
export const ClientFrameSchema = z.discriminatedUnion("type", [AttachFrameSchema]);
`);
	assert.equal(found.length, 1);
	assert.match(found[0].message, /declares `entrypoint`/);
});

test("rule A on a wire it cannot read", () => {
	const noUnion = findCommandShapedClientFields("export const AttachFrameSchema = z.object({ type: z.literal('attach') });");
	assert.equal(noUnion.length, 1);
	assert.match(noUnion[0].message, /ClientFrameSchema/);

	const foreignBase = findCommandShapedClientFields(`
export const AttachFrameSchema = BaseFrameSchema.extend({ clientId: z.string() });
export const ClientFrameSchema = z.discriminatedUnion("type", [AttachFrameSchema]);
`);
	assert.equal(foreignBase.length, 1);
	assert.match(foreignBase[0].message, /built from `BaseFrameSchema`/);

	const spread = findCommandShapedClientFields(`
export const AttachFrameSchema = z.object({ ...base, type: z.literal("attach") });
export const ClientFrameSchema = z.discriminatedUnion("type", [AttachFrameSchema]);
`);
	assert.equal(spread.length, 1);
	assert.match(spread[0].message, /spreads another value/);
});

test("rule A on a union member it cannot name", () => {
	const source = wire({ clientMembers: ["...EXTRA_CLIENT_FRAMES", "AttachFrameSchema", "InputFrameSchema"] });
	const { members, violations } = clientUnionMembers(source);
	assert.deepEqual(members, ["AttachFrameSchema", "InputFrameSchema"]);
	assert.equal(violations.length, 1);
	assert.match(violations[0].message, /\.\.\.EXTRA_CLIENT_FRAMES/);
	assert.equal(findCommandShapedClientFields(source).length, 1);
});

test("rule A over the real wire.ts", () => {
	const source = readFileSync(WIRE, "utf-8");
	assert.deepEqual(findCommandShapedClientFields(source), []);

	const { members } = clientUnionMembers(source);
	for (const member of ["AttachFrameSchema", "InputFrameSchema", "SessionSpawnFrameSchema", "RegistryResyncFrameSchema"]) {
		assert.ok(members.includes(member), `${member} missing from ClientFrameSchema`);
	}

	const direct = source.replace("\tharnessId: RegistryIdSchema,", "\tharnessId: RegistryIdSchema,\n\tcommand: z.array(z.string()),");
	assert.notEqual(direct, source);
	const directFound = findCommandShapedClientFields(direct);
	assert.equal(directFound.length, 1);
	assert.match(directFound[0].message, /client frame `session_spawn` declares `command`/);

	const viaSchema = source.replace(
		"export const SessionSpawnFrameSchema = z.object({",
		"export const SpawnOptionsSchema = z.object({ argv: z.array(z.string()) });\nexport const SessionSpawnFrameSchema = z.object({\n\toptions: SpawnOptionsSchema,",
	);
	assert.notEqual(viaSchema, source);
	const viaFound = findCommandShapedClientFields(viaSchema);
	assert.equal(viaFound.length, 1);
	assert.match(viaFound[0].message, /client frame `session_spawn` declares `argv`/);
});

test("rule B on a body key read and refused with 4xx", () => {
	const route = `
app.post("/", async (c) => {
	const body = await c.req.json();
	if ("command" in body) {
		return c.json({ error: COMMAND_REJECTED }, 400);
	}
	if (body.cwd !== undefined) return c.json(serialize(manager.create(undefined, body.cwd)), 201);
	return c.json(serialize(manager.create(undefined)), 201);
});
`;
	assert.deepEqual(findUnrefusedBodyKeyReads(route), []);
});

test("rule B on a key passed onward", () => {
	const route = `
app.post("/", async (c) => {
	const body = await c.req.json();
	if ("command" in body) {
		return c.json(serialize(manager.create(body.command)), 201);
	}
});
`;
	const found = findUnrefusedBodyKeyReads(route);
	assert.equal(found.length, 2);
	assert.deepEqual(
		found.map((v) => v.line),
		[4, 5],
	);
	assert.match(found[0].message, /tests for a `command` key without answering 4xx/);
	assert.match(found[1].message, /reads the value of a `command` key/);
});

test("rule B on a read that hides behind a 4xx in the same statement", () => {
	const cases = [
		'const chosen = bodyObj.command ? bodyObj.command : c.json({ error: COMMAND_REJECTED }, 400);',
		'const argv = bodyObj.command ?? (c.json({ error: COMMAND_REJECTED }, 400) as never);',
		'return "command" in bodyObj ? manager.create(bodyObj["command"]) : c.json({ e: 1 }, 400);',
	];
	for (const line of cases) {
		const found = findUnrefusedBodyKeyReads(`app.post("/", async (c) => {\n\t${line}\n});\n`);
		assert.ok(found.length >= 1, line);
		assert.ok(
			found.some((v) => /reads the value of a `command` key/.test(v.message)),
			line,
		);
	}
});

test("rule B on a key reached indirectly", () => {
	const viaAlias = findUnrefusedBodyKeyReads(`const key = "command";\napp.post("/", (c) => { manager.create(bodyObj[key]); });`);
	assert.equal(viaAlias.length, 1);
	assert.match(viaAlias[0].message, /reads the value of a `command` key/);

	const viaEntries = findUnrefusedBodyKeyReads(`for (const [k, v] of Object.entries(bodyObj)) {\n\tif (k === "command") manager.create(v);\n}`);
	assert.equal(viaEntries.length, 1);
	assert.match(viaEntries[0].message, /tests for a `command` key without answering 4xx/);
});

test("rule B on the other spawn-selecting key names", () => {
	for (const [line, expected] of [
		['const argv = body["argv"];', /reads the value of a `argv` key/],
		["const { cmd } = body;", /reads the value of a `cmd` key/],
		["const bin = body.executable;", /reads the value of a `executable` key/],
		["spawn(body.entrypoint);", /reads the value of a `entrypoint` key/],
		["const rest = body.args;", /reads the value of a `args` key/],
		["const sh = req.body.shell;", /reads the value of a `shell` key/],
	]) {
		const found = findUnrefusedBodyKeyReads(`app.post("/", (c) => {\n\t${line}\n});\n`);
		assert.equal(found.length, 1, line);
		assert.match(found[0].message, expected);
	}
});

test("rule B on prose and on a method named exec", () => {
	const route = `
// a body still carrying .command is refused
const COMMAND_REJECTED = "command is not accepted. command selection is the gateway's. argv too";
const bearer = /^Bearer (.+)$/i.exec(authorization);
app.post("/", (c) => c.json({ ok: true }, 201));
`;
	assert.deepEqual(findUnrefusedBodyKeyReads(route), []);
});

test("rule B over the real sessions route", () => {
	const source = readFileSync(SESSIONS_ROUTE, "utf-8");
	assert.deepEqual(findUnrefusedBodyKeyReads(source), []);

	const refusal = 'return c.json({ error: COMMAND_REJECTED }, 400);';
	assert.ok(source.includes(refusal));
	const found = findUnrefusedBodyKeyReads(source.replace(refusal, "return c.json(serializeSession(manager.create(bodyObj.command)), 201);"));
	assert.ok(found.some((v) => /reads the value of a `command` key/.test(v.message)));
	assert.ok(found.some((v) => /tests for a `command` key without answering 4xx/.test(v.message)));
});

test("rule C on each writer shape", () => {
	const cases = [
		["settingsManager.setProjectTrusted(false);", /setProjectTrusted/],
		["trustStore.setMany([{ path: cwd, decision: true }]);", /setMany/],
		['const trustPath = join(agentDir, "trust.json");\nwriteFileSync(trustPath, JSON.stringify(data));', /`writeFileSync` targets the project-trust file/],
		['writeFileSync(join(agentDir, "trust.json"), "{}");', /`writeFileSync` targets the project-trust file/],
		['const trustPath = join(agentDir, "trust.json");\nawait Bun.write(trustPath, "{}");', /`write` targets the project-trust file/],
		['const trustPath = join(agentDir, "trust.json");\nappendFileSync(trustPath, "{}");', /`appendFileSync` targets the project-trust file/],
		['const trustPath = join(agentDir, "trust.json");\nconst fh = await open(trustPath, "w");', /`open` targets the project-trust file/],
		['const trustPath = join(agentDir, "trust.json");\ncreateWriteStream(trustPath).end("{}");', /`createWriteStream` targets the project-trust file/],
		['class Store {\n\tconstructor(dir) {\n\t\tthis.#path = join(dir, "trust.json");\n\t}\n\tsave(data) {\n\t\twriteFileSync(this.#path, data);\n\t}\n}', /`writeFileSync` targets the project-trust file/],
		['class Store {\n\tconstructor(dir) {\n\t\tthis.trustPath = join(dir, "trust.json");\n\t}\n\tsave(data) {\n\t\twriteTrustFile(this.trustPath, data);\n\t}\n}', /`writeTrustFile` targets the project-trust file/],
		["function grant(store: ProjectTrustStore) {\n\tstore.set(cwd, true);\n}", /mutates a ProjectTrustStore/],
		["const store = getProjectTrustStore();\nstore.set(cwd, true);", /mutates a ProjectTrustStore via `store.set\(`/],
		["const store = new ProjectTrustStore(agentDir);\nstore.delete(cwd);", /mutates a ProjectTrustStore via `store.delete\(`/],
		["getProjectTrustStore(agentDir).set(cwd, true);", /mutates a ProjectTrustStore via `.set\(`/],
	];
	for (const [source, expected] of cases) {
		const found = findTrustWriters(source);
		assert.equal(found.length, 1, source);
		assert.match(found[0].message, expected);
	}
});

test("rule C on reads, comments and string literals", () => {
	const reader = `
// ProjectTrustStore.setMany writes canonicalizePath(resolvePath(path))
/* a mirror of setProjectTrusted(false) lives in the store, not here */
const doc = "call trustStore.setMany([]) to record a decision";
const trustPath = join(agentDir, "trust.json");
const parsed = JSON.parse(readFileSync(trustPath, "utf8"));
const handle = await open(trustPath, "r");
const store = getProjectTrustStore();
const decision = store.get(cwd);
`;
	assert.deepEqual(findTrustWriters(reader), []);
});

test("rule C scope excludes test sources", () => {
	assert.equal(isTestSource("packages/gateway/src/__tests__/session-resume.e2e.test.ts"), true);
	assert.equal(isTestSource("packages/geist-core/test/attach/socket-sessions.test.ts"), true);
	assert.equal(isTestSource("packages/gateway/src/session/spawn-primitive.ts"), false);
});

test("field names read as tokens, not substrings", () => {
	assert.deepEqual(
		topLevelKeys("{ a: 1, b: z.object({ c: 2 }) }").map((f) => f.name),
		["a", "b"],
	);
	for (const name of ["command", "CMD", "cmd", "argv", "args", "exec", "execPath", "executable", "shell", "entrypoint", "interpreter", "path", "cwd", "dir", "working_dir", "env", "envVars", "environment", "commandLine"]) {
		assert.equal(isCommandShaped(name), true, name);
	}
	for (const name of ["capabilities", "harnessId", "projectId", "sessionId", "data", "pathname", "directory"]) {
		assert.equal(isCommandShaped(name), false, name);
	}
});

test("scanRepo reports a planted violation for every rule", () => {
	const root = fixtureRoot(PLANTED);
	try {
		const found = scanRepo(root);
		const byFile = new Map(found.map((v) => [v.file, v]));

		assert.deepEqual([...new Set(found.map((v) => v.rule))].sort(), ["A", "B", "C"]);
		assert.match(byFile.get("packages/geist-protocol/src/wire.ts").message, /client frame `attach` declares `argv`/);
		assert.match(byFile.get("packages/gateway/src/gateway/routes/sessions.ts").message, /reads the value of a `command` key/);
		assert.match(byFile.get("packages/gateway/src/session/trust.ts").message, /setProjectTrusted/);
		assert.match(byFile.get("packages/geist-core/src/writer.ts").message, /targets the project-trust file/);
		for (const v of found) assert.ok(v.line > 0, v.file);

		assert.ok(trustScanRoots(root).includes(join(root, "packages/gateway/src")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scanRepo reports a scan target that moved", () => {
	const root = fixtureRoot({ "packages/gateway/src/keep.ts": "export const x = 1;\n" });
	try {
		const rules = scanRepo(root).map((v) => v.rule);
		assert.ok(rules.includes("A"), "missing wire.ts is not reported");
		assert.ok(rules.includes("B"), "missing routes/ is not reported");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the gate exits 1 on a tree with violations", () => {
	const root = fixtureRoot(PLANTED);
	try {
		const run = spawnSync(process.execPath, [join(root, "scripts", "check-no-free-text-command.mjs")], { encoding: "utf-8" });
		assert.equal(run.status, 1, run.stdout);
		assert.match(run.stderr, /\[rule A\] packages\/geist-protocol\/src\/wire\.ts:\d+/);
		assert.match(run.stderr, /\[rule B\] packages\/gateway\/src\/gateway\/routes\/sessions\.ts:\d+/);
		assert.match(run.stderr, /\[rule C\] packages\/gateway\/src\/session\/trust\.ts:\d+/);
		assert.match(run.stderr, /\[rule C\] packages\/geist-core\/src\/writer\.ts:\d+/);
		assert.doesNotMatch(run.stdout, /ok/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the gate is green on the real tree", () => {
	assert.deepEqual(scanRepo(ROOT), []);

	const run = spawnSync(process.execPath, [GATE], { encoding: "utf-8" });
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /check:no-free-text-command: ok/);
});

test("importing the gate without an entry path", () => {
	const run = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(GATE).href)});`], { encoding: "utf-8" });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.stdout, "");
});
