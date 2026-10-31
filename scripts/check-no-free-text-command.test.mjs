import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	BUN_MEMBERS,
	blankNonCode,
	clientUnionMembers,
	findCommandShapedClientFields,
	findProcessCreators,
	findTrustWriters,
	findUnrefusedBodyKeyReads,
	isCommandShaped,
	isTestSource,
	PROCESS_MEMBERS,
	processScanFiles,
	SPAWN_PRIMITIVE,
	scanRepo,
	topLevelKeys,
	trustScanRoots,
} from "./check-no-free-text-command.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(ROOT, "scripts", "check-no-free-text-command.mjs");
const WIRE = join(ROOT, "packages/geist-protocol/src/wire.ts");
const SESSIONS_ROUTE = join(ROOT, "packages/gateway/src/gateway/routes/sessions.ts");
const PRIMITIVE = join(ROOT, SPAWN_PRIMITIVE);

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

/** A tree scanRepo can be pointed at, carrying one planted violation per rule and the files rule D must leave alone. */
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
	"packages/gateway/src/session/launcher.ts": `
export function start(): void {
	Bun.spawn(["cat"]);
}
`,
	"packages/gateway/src/session/spawn-primitive.ts": `
import { spawn } from "node:child_process";
export const launch = spawn;
`,
	"packages/gateway/src/__tests__/launcher.test.ts": `
import { spawnSync } from "node:child_process";
spawnSync("true");
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

const ESC = String.fromCharCode(92);
const CANNOT_READ_BUN = /uses `Bun` in a form this gate cannot read/;
const CANNOT_READ_PROCESS = /uses `process` in a form this gate cannot read/;
const NAME_UNREADABLE = /reaches any API by a name this gate cannot read/;
const NOT_ONE_LITERAL = /without one plain string literal naming it/;
const IDENT_ESCAPE = /spells an identifier with a backslash escape/;
const SPECIFIER_ESCAPE = /names the module .* with a backslash escape/;
const OUT_OF_BUN = /out of the `bun` module/;
const SPAWN_CLAUSE =
	/only session\/spawn-primitive\.ts may create a process in packages\/gateway\/src \(R36-SPAWN\.1; the daemon's git status probe lives in geist-core and is out of scope\)\. A session is started by `session_spawn`, never by a second spawn path\./;

/** Each entry is [label, source, message pattern, line]; the source sits on line 2 unless the entry says otherwise. */
function assertReported(cases) {
	for (const [label, source, expected, line = 2] of cases) {
		const found = findProcessCreators(`const before = 1;\n${source}\n`);
		const hit = found.find((v) => expected.test(v.message));
		assert.ok(hit, `${label}: nothing matches ${expected} in ${JSON.stringify(found.map((v) => v.message))}`);
		assert.equal(hit.line, line, label);
		assert.match(hit.message, SPAWN_CLAUSE, label);
	}
}

test("rule D on each way to reach a process API", () => {
	const cases = [
		['import { spawn } from "node:child_process";', /reaches `node:child_process`/],
		['import cp from "child_process";', /reaches `child_process`/],
		['import * as cp from "node:child_process";', /reaches `node:child_process`/],
		['import "node:child_process";', /reaches `node:child_process`/],
		['export { spawn } from "node:child_process";', /reaches `node:child_process`/],
		['const cp = require("node:child_process");', /reaches `node:child_process`/],
		['const cp = await import("node:child_process");', /reaches `node:child_process`/],
		['const cp = process.getBuiltinModule("node:child_process");', /reaches `node:child_process`/, 2],
		['Bun.spawn(["cat"]);', /uses `Bun.spawn`/],
		['Bun.spawnSync(["cat"]);', /uses `Bun.spawnSync`/],
		['Bun . spawn (["cat"]);', /uses `Bun.spawn`/],
		['Bun?.spawn(["cat"]);', /uses `Bun.spawn`/],
		['Bun["spawn"](["cat"]);', CANNOT_READ_BUN],
		["await Bun.$`ls`;", /uses `Bun.\$`/],
		['import { spawn } from "bun";', OUT_OF_BUN],
		['import { serve, spawnSync as run } from "bun";', OUT_OF_BUN],
		['import { $ } from "bun";', OUT_OF_BUN],
		['import * as bun from "bun";', OUT_OF_BUN],
		['const { spawn } = require("bun");', /loads the `bun` module dynamically/],
		['const { spawn } = await import("bun");', /loads the `bun` module dynamically/],
		['const b = require("bun"); b.spawn(["cat"]);', /loads the `bun` module dynamically/],
		["const b = await import(`bun`);", /loads the `bun` module dynamically/],
		["const { spawn } = Bun;", CANNOT_READ_BUN],
	];
	for (const [source, expected, count = 1] of cases) {
		const found = findProcessCreators(`const before = 1;\n${source}\n`);
		assert.equal(found.length, count, source);
		const hit = found.find((v) => expected.test(v.message));
		assert.ok(hit, `${source}: nothing matches ${expected}`);
		assert.equal(hit.line, 2, source);
		assert.match(hit.message, SPAWN_CLAUSE, source);
	}
});

test("rule D on prose, other Bun APIs and imports that create nothing", () => {
	const clean = `
// Bun.spawn(["cat"]) used to live here; import cp from "node:child_process" too
/* const { spawn } = Bun; */
const doc = "call Bun.spawn(argv) after import { spawn } from 'node:child_process'";
const tpl = \`Bun.\${"spawn"} and require("child_process")\`;
const pattern = /Bun\\.spawn/;
Bun.serve({ port: 0 });
const file = Bun.file("x");
import type { FileSink } from "bun";
import { serve, type Server } from "bun";
export { serve } from "bun";
import { exec } from "node:fs";
import { helper } from "child_process_helper";
const copy = Array.from("child_process");
const holder = { from: "child_process" };
Bun?.serve({ port: 0 });
Bun . file ("y");
type Started = ReturnType<typeof Bun.serve>;
const named = \`\${Bun.file("z").name} and Bun.spawn\`;
import { serve as start, file, type Server } from "bun";
process.env.HOME;
process.exit(1);
process.on("SIGINT", stop);
const bytes = [process.argv.length, process.platform, process.execPath, process.getuid?.()];
process.stderr.write("x");
process.kill(1, "SIGTERM");
const hono = await import("hono");
const local = await import("./local.js");
const json = await import("./x.json", { with: { type: "json" } });
const quiet = await import(\`./quiet.js\`);
const other = require("hono");
const counter = { subprocess: 1, Bunny: 2, processor: 3, selfie: 4, evaluate: 5, moduleName: 6, globalThisArg: 7 };
subprocess.spawn(["x"]);
myBun.spawn(["x"]);
$Bun.spawn(["x"]);
preprocess.binding("x");
link.self.href;
link\n\t.self.href;
regexp.global;
config.module.default;
tool.eval(code);
const lazy = [reimport(name), prerequire(name), $import(name), _require(name)];
let i = 0;
const halves = [i++ / 2, i-- / 2, a / b / c];
`;
	assert.deepEqual(findProcessCreators(clean), []);
});

test("rule D reports every Bun use that is not an allowlisted member", () => {
	const argv = '["true"]';
	assertReported([
		["c01 non-null", `export const r = Bun!.spawnSync(${argv});`, CANNOT_READ_BUN],
		["cast to any", `export const r = (Bun as any).spawnSync(${argv});`, CANNOT_READ_BUN],
		["c02 cast", `export const r = (Bun as typeof Bun).spawnSync(${argv});`, CANNOT_READ_BUN],
		["c03 satisfies", `export const r = (Bun satisfies typeof Bun).spawnSync(${argv});`, CANNOT_READ_BUN],
		["c04 optional element", `export const r = Bun?.["spawnSync"](${argv});`, CANNOT_READ_BUN],
		["c08 annotated destructuring", `const { spawnSync }: typeof Bun = Bun;\nexport const r = spawnSync(${argv});`, CANNOT_READ_BUN],
		["c09 Reflect.get", `export const r = Reflect.get(Bun, "spawnSync")(${argv});`, CANNOT_READ_BUN],
		["c12 openInEditor", 'Bun.openInEditor("/dev/null", { editor: "vscode" });', /uses `Bun.openInEditor`/],
		["c18 computed destructuring", `const { ["spawnSync"]: run } = Bun;\nexport const r = run(${argv});`, CANNOT_READ_BUN],
		["c21 parenthesised", `export const r = (Bun).spawnSync(${argv});`, CANNOT_READ_BUN],
		["c14 escaped member", `export const r = Bun.${ESC}u0073pawnSync(${argv});`, IDENT_ESCAPE],
		["escaped Bun", `export const r = B${ESC}u0075n.spawnSync(${argv});`, IDENT_ESCAPE],
		["destructuring the allowed name", "const { serve: start } = Bun;", CANNOT_READ_BUN],
		["a member that only starts like an allowed one", "const label = Bun.spawnLabel;", /uses `Bun.spawnLabel`/],
		["a member that extends an allowed one", "const label = Bun.fileSync;", /uses `Bun.fileSync`/],
		["Bun.write", 'await Bun.write("a", "b");', /uses `Bun.write`/],
		["Bun passed as a value", "run(Bun);", CANNOT_READ_BUN],
		["an alias", `const B = Bun;\nB.spawn(${argv});`, CANNOT_READ_BUN],
		["returned", "export const get = () => Bun;", CANNOT_READ_BUN],
		["spread", "export const copy = { ...Bun };", CANNOT_READ_BUN],
		["typeof in a type position", "type Spawn = typeof Bun.spawn;", /uses `Bun.spawn`/],
		["the message names the type-position cost", "type Spawn = typeof Bun.spawn;", /a type-position use such as `typeof Bun\.spawn`/],
		["a type from the Bun namespace", "let s: Bun.Subprocess;", /uses `Bun.Subprocess`/],
		["global property", `globalThis.Bun.spawnSync(${argv});`, NAME_UNREADABLE],
		["global property destructured", "const { spawnSync: run } = globalThis.Bun;", CANNOT_READ_BUN],
		["c05 global computed", `export const r = globalThis["Bun"].spawnSync(${argv});`, NAME_UNREADABLE],
		["global built name", `globalThis["Bu" + "n"].spawnSync(${argv});`, NAME_UNREADABLE],
		["global through global", `global.Bun.spawn(${argv});`, NAME_UNREADABLE],
		["global through self", `self["Bun"].spawn(${argv});`, NAME_UNREADABLE],
		["Reflect on the global", 'Reflect.get(globalThis, "Bun");', NAME_UNREADABLE],
		["hidden in a template substitution", `const t = \`\${Bun.spawnSync(${argv})}\`;`, /uses `Bun.spawnSync`/],
		["hidden in a nested template substitution", `const t = \`a \${\`b \${Bun.spawn(${argv})} c\`} d\`;`, /uses `Bun.spawn`/],
		["not hidden by a regex after return", `function f(s) {\n\treturn /\`/.test(s);\n}\nBun.spawn(${argv});\nconst t = \`x\`;`, /uses `Bun.spawn`/, 5],
	]);
});

test("rule D reports a process-reaching global or evaluator", () => {
	assertReported([
		["c22 cast process", '// biome-ignore lint: probe\nexport const b = (process as any).binding("spawn_sync");', CANNOT_READ_PROCESS, 3],
		["process.binding", 'process.binding("spawn_sync");', /uses `process.binding`/],
		["process.dlopen", 'process.dlopen(module, "x.node");', /uses `process.dlopen`/],
		["process.execve", 'process.execve("/bin/sh", ["sh"]);', /uses `process.execve`/],
		["process.getBuiltinModule", 'process.getBuiltinModule("node:os");', /uses `process.getBuiltinModule`/],
		["process.mainModule", 'process.mainModule?.require("x");', /uses `process.mainModule`/],
		["c16 process element", 'export const r = process["getBuiltinModule"]("node:child_process").spawnSync("true");', CANNOT_READ_PROCESS],
		["process optional element", 'process?.["binding"]("spawn_sync");', CANNOT_READ_PROCESS],
		["process destructured", "const { binding } = process;", CANNOT_READ_PROCESS],
		["process passed as a value", "run(process);", CANNOT_READ_PROCESS],
		["process aliased", 'const p = process;\np.binding("spawn_sync");', CANNOT_READ_PROCESS],
		["escaped process", `pr${ESC}u006fcess.binding("spawn_sync");`, IDENT_ESCAPE],
		["eval", 'eval("Bun.spawn([\\"true\\"])");', NAME_UNREADABLE],
		["indirect eval", '(0, eval)("this");', NAME_UNREADABLE],
		["new Function", 'new Function("return process")();', NAME_UNREADABLE],
		["Function call", 'Function("return process")();', NAME_UNREADABLE],
		["Worker", "new Worker(URL.createObjectURL(new Blob([code])));", NAME_UNREADABLE],
		["module", "module.constructor._load(name);", NAME_UNREADABLE],
		["spread of the global", "const g = { ...globalThis };", NAME_UNREADABLE],
		["spread of the global with a space", "const g = { ... self };", NAME_UNREADABLE],
		["global", "global.process.binding(x);", NAME_UNREADABLE],
		["self", "self.process.binding(x);", NAME_UNREADABLE],
	]);
});

test("rule D reads a module load only when it is one plain string literal", () => {
	const child = /reaches `node:child_process`/;
	assertReported([
		["c17 concatenation", 'const cp = await import("node:" + "child_process");', NOT_ONE_LITERAL],
		["import of a variable", "const m = await import(name);", NOT_ONE_LITERAL],
		["import of a template substitution", "const m = await import(`node:${name}`);", NOT_ONE_LITERAL],
		["import of a spread", "const m = await import(...names);", NOT_ONE_LITERAL],
		["import of a literal plus", 'const m = await import("a" + b);', NOT_ONE_LITERAL],
		["import across lines", 'const m = await import(\n\t"a" +\n\tb,\n);', NOT_ONE_LITERAL],
		["require of a variable", "const m = require(name);", NOT_ONE_LITERAL],
		["require of a concatenation", 'const m = require("node:child_" + "process");', NOT_ONE_LITERAL],
		["optional require", "const m = require?.(name);", NOT_ONE_LITERAL],
		["getBuiltinModule of a variable", "const m = getBuiltinModule(name);", NOT_ONE_LITERAL],
		["import.meta.require of a variable", "const m = import.meta.require(name);", NOT_ONE_LITERAL],
		["module.require of a variable", "const m = module.require(name);", NOT_ONE_LITERAL],
		["require taken as a value", "const r = import.meta.require;\nr(name);", NOT_ONE_LITERAL],
		["getBuiltinModule taken as a value", "const g = getBuiltinModule;", NOT_ONE_LITERAL],
		["call result as the argument", 'const m = require(pick("a"));', NOT_ONE_LITERAL],
		["literal with an escape", `const m = await import("node:child${ESC}u005fprocess");`, SPECIFIER_ESCAPE],
		["require with an escape", `const m = require("b${ESC}u0075n");`, SPECIFIER_ESCAPE],
		["an innocent escape", `const m = await import("./a${ESC}x2fb.js");`, SPECIFIER_ESCAPE],
		["c13 static escape", `import { spawnSync } from "node:child${ESC}u005fprocess";`, SPECIFIER_ESCAPE],
		["c19 static escaped bun", `import { spawnSync } from "b${ESC}u0075n";`, SPECIFIER_ESCAPE],
		["side-effect import with an escape", `import "./a${ESC}u002fb.js";`, SPECIFIER_ESCAPE],
		["re-export with an escape", `export * from "./a${ESC}u002fb.js";`, SPECIFIER_ESCAPE],
		["c15 import after a postfix increment", 'let i = 1;\nexport const r = i++ / (await import("node:child_process")).spawnSync("true").status! / 1;', child, 3],
		["import after a postfix decrement", 'let i = 1;\nexport const r = i-- / (await import("node:child_process")).spawnSync("true").status! / 1;', child, 3],
		["import after a spaced postfix", 'let i = 1;\nexport const r = i ++ /* c */ / (await import("node:child_process")).spawnSync("true");', child, 3],
		["import after a keyword regex", 'function f(s) {\n\treturn /`/.test(s);\n}\nconst cp = await import("node:child_process");\nconst t = `x`;', child, 5],
	]);

	assertReported([
		["c06 createRequire", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);', /reaches `node:module`/],
		["createRequire from bare module", 'import { createRequire } from "module";', /reaches `module`/],
		["Module default", 'import Module from "node:module";', /reaches `node:module`/],
		["Module namespace", 'import * as m from "node:module";', /reaches `node:module`/],
		["Module named", 'import { Module } from "module";', /reaches `module`/],
		["module for effects", 'import "node:module";', /reaches `node:module`/],
		["module re-export", 'export { createRequire } from "node:module";', /reaches `node:module`/],
		["module loaded dynamically", 'const { createRequire } = await import("node:module");', /reaches `node:module`/],
		["module required", 'const m = require("module");', /reaches `module`/],
		["c10 cluster", 'import cluster from "node:cluster";\nconst w = cluster.fork();', /reaches `node:cluster`/],
		["bare cluster", 'import { fork } from "cluster";', /reaches `cluster`/],
		["c11 bun:ffi", 'import { dlopen, FFIType } from "bun:ffi";', /reaches `bun:ffi`/],
		["bun:ffi required", 'const ffi = require("bun:ffi");', /reaches `bun:ffi`/],
		["process module", 'import proc from "node:process";', /reaches `node:process`/],
		["bare process module", 'import { binding } from "process";', /reaches `process`/],
		["vm", 'import { runInThisContext } from "node:vm";', /reaches `node:vm`/],
		["worker_threads", 'import { Worker } from "node:worker_threads";', /reaches `node:worker_threads`/],
		["node:test", 'import { run } from "node:test";', /reaches `node:test`/],
		["repl", 'import repl from "node:repl";', /reaches `node:repl`/],
		["inspector", 'import inspector from "node:inspector";', /reaches `node:inspector`/],
		["data URL", 'await import("data:text/javascript;base64,AAAA");', /reaches `data:text\/javascript;base64,AAAA`/],
		["remote URL", 'await import("https://example.test/x.js");', /reaches `https:\/\/example.test\/x.js`/],
		["data URL statically", 'import "data:text/javascript,0";', /reaches `data:text\/javascript,0`/],
	]);

	for (const source of [
		'import type { Module } from "node:module";',
		'import type { ClusterSettings } from "node:cluster";',
		'import { type Address } from "node:cluster";',
		'import type { FFIType } from "bun:ffi";',
		'export type { WorkerOptions } from "node:worker_threads";',
	]) {
		assert.deepEqual(findProcessCreators(`${source}\n`), [], source);
	}
});

test("rule D reads a bun import only when it names allowlisted members", () => {
	assertReported([
		["c07 quoted name", 'import { "spawnSync" as run } from "bun";\nexport const r = run(["true"]);', OUT_OF_BUN],
		["c20 quoted dollar", 'import { "$" as sh } from "bun";', OUT_OF_BUN],
		["quoted allowed name", 'import { "serve" as start } from "bun";', OUT_OF_BUN],
		["c23 escaped name", `import { ${ESC}u0073pawnSync as run } from "bun";`, OUT_OF_BUN],
		["escaped name is also an identifier escape", `import { ${ESC}u0073pawnSync as run } from "bun";`, IDENT_ESCAPE],
		["default-as", 'import { default as b } from "bun";', OUT_OF_BUN],
		["default import", 'import bun from "bun";', OUT_OF_BUN],
		["default and named", 'import bun, { serve } from "bun";', OUT_OF_BUN],
		["namespace import", 'import * as bun from "bun";', OUT_OF_BUN],
		["star re-export", 'export * from "bun";', OUT_OF_BUN],
		["namespace re-export", 'export * as bun from "bun";', OUT_OF_BUN],
		["one bad name among good ones", 'import { serve, file, Glob } from "bun";', /takes `Glob` out of the `bun` module/],
		["a quoted name beside an allowed one", 'import { serve, "file" as f } from "bun";', OUT_OF_BUN],
		["type modifier on a name that is not a type", 'import { type as run } from "bun";', OUT_OF_BUN],
		["re-export of a process API", 'export { spawn } from "bun";', OUT_OF_BUN],
		["dynamic bun", 'const b = await import("bun");', /loads the `bun` module dynamically/],
		["bun required", 'const b = require("bun");', /loads the `bun` module dynamically/],
	]);

	for (const source of [
		'import { serve, file } from "bun";',
		'import { serve as start } from "bun";',
		'import { file as spawn } from "bun";',
		'import { serve, type Server } from "bun";',
		'export { serve } from "bun";',
		'import {} from "bun";',
		'import "bun";',
		'import type { Subprocess } from "bun";',
		'import type * as bun from "bun";',
		'import type bun from "bun";',
	]) {
		assert.deepEqual(findProcessCreators(`${source}\n`), [], source);
	}
});

test("rule D allowlists are exactly what non-test gateway source uses", () => {
	assert.deepEqual([...BUN_MEMBERS].sort(), ["file", "serve"]);
	assert.deepEqual([...PROCESS_MEMBERS].sort(), ["argv", "env", "execPath", "exit", "getuid", "kill", "on", "platform", "stderr"]);

	for (const member of BUN_MEMBERS) {
		assert.deepEqual(findProcessCreators(`Bun.${member}(x);\n`), [], member);
		assert.equal(findProcessCreators(`Bun.${member}Sync(x);\n`).length, 1, `${member}Sync`);
		assert.equal(findProcessCreators(`Bun.${member.slice(0, -1)}(x);\n`).length, 1, member.slice(0, -1));
	}
	for (const member of PROCESS_MEMBERS) {
		assert.deepEqual(findProcessCreators(`process.${member}(x);\n`), [], member);
		assert.equal(findProcessCreators(`process.${member}s(x);\n`).length, 1, `${member}s`);
	}

	const used = (name) =>
		new Set(
			processScanFiles(ROOT).flatMap((file) => [...blankNonCode(readFileSync(file, "utf-8")).matchAll(new RegExp(`(?<![\\w$])${name}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`, "g"))].map((m) => m[1])),
		);
	assert.deepEqual([...used("Bun")].sort(), [...BUN_MEMBERS].sort(), "a Bun member nobody uses is on the allowlist, or one in use is not");
	assert.deepEqual([...used("process")].sort(), [...PROCESS_MEMBERS].sort(), "a process member nobody uses is on the allowlist, or one in use is not");
});

test("blankNonCode keeps template substitutions and reads a slash after ++ or -- as division", () => {
	assert.equal(blankNonCode("const t = `a ${Bun.file(x)} b`;"), "const t = `  ${Bun.file(x)}  `;");
	assert.equal(blankNonCode("const t = `a ${`b ${c} d`} e`;"), "const t = `  ${`  ${c}  `}  `;");
	assert.equal(blankNonCode("const t = `a \\${b} c ${d}`;"), `const t = \`${" ".repeat(10)}\${d}\`;`);
	assert.equal(blankNonCode("const t = `a ${ {x: 1}.x } b`; const u = 'y';"), "const t = `  ${ {x: 1}.x }  `; const u = ' ';");

	assert.equal(blankNonCode('i++ / x; "quoted"'), 'i++ / x; "      "');
	assert.equal(blankNonCode('i-- / x; "quoted"'), 'i-- / x; "      "');
	assert.equal(blankNonCode('a + +b / x; "quoted"'), 'a + +b / x; "      "');
	assert.equal(blankNonCode('x = a++ + /re"/.test(s); "q"'), 'x = a++ + /   /.test(s); " "');
	assert.equal(blankNonCode('return /`/.test(s); `q`'), 'return / /.test(s); ` `');
	assert.equal(blankNonCode('typeof /"/; "q"'), 'typeof / /; " "');
	assert.equal(blankNonCode('a.in / b / c; "q"'), 'a.in / b / c; " "');
});

test("rule D exempts a type-only child_process import and still reports a value one", () => {
	const typeOnly = [
		'import type { ChildProcess } from "node:child_process";',
		'import type { ChildProcess } from "child_process"',
		'import type * as cp from "node:child_process";',
		'import type Cp from "node:child_process";',
		'export type { ChildProcess } from "node:child_process";',
		'import type {\n\tChildProcess,\n} from "node:child_process";',
		'import type\n{ ChildProcess } from "node:child_process";',
		'import type /* c */ { ChildProcess } from "node:child_process";',
		'export type * from "node:child_process";',
		'export type * as cp from "node:child_process";',
		'import { type ChildProcess } from "node:child_process";',
		'import {\n\ttype ChildProcess as Child,\n\ttype Serializable,\n} from "child_process";',
		'import type { Subprocess } from "bun";',
		'import { type Subprocess } from "bun";',
	];
	for (const source of typeOnly) {
		assert.deepEqual(findProcessCreators(`${source}\n`), [], source);
	}

	const child = /reaches `node:child_process`/;
	const fromBun = /out of the `bun` module/;
	const valueImports = [
		['import { spawn } from "node:child_process";', child],
		['import { type ChildProcess, spawn } from "node:child_process";', child],
		['export { spawn } from "node:child_process";', child],
		// A default binding that happens to be called `type` is a value import, not a type-only one.
		['import type from "node:child_process";', child],
		['import type, { spawn } from "node:child_process";', child],
		['import type, { spawnSync } from "bun";\nspawnSync(["true"]);', fromBun],
		['import type from "bun";', fromBun],
		// A binding that merely starts with `type` is not the modifier either.
		['import types from "node:child_process";\ntypes.spawnSync(["true"]);', child],
		['import typed from "node:child_process";', child],
		['import * as typeX from "node:child_process";', child],
		['import typeof Cp from "node:child_process";', child],
		['import type Cp, { spawn } from "node:child_process";', child],
		['import { type as run } from "node:child_process";', child],
		['import {} from "node:child_process";', child],
		// Without semicolons a type statement's tokens must not run on into the next statement's `from`.
		['export type T = { a: number }\nimport { spawnSync } from "node:child_process"', child],
		['export type { A }\nimport { spawn } from "node:child_process"', child],
		['export type { A }\nexport { spawn } from "node:child_process"', child],
		['export type T = { a: number }\r\nimport { spawnSync } from "node:child_process"', child],
		['export { a }\nimport { spawn } from "bun"', fromBun],
		['import { type Subprocess, spawn } from "bun";', fromBun],
		['import /* type */ { spawn } from "node:child_process";', child],
		['import type /* c */ , { spawn } from "node:child_process";', child],
		['import {\n\ttype ChildProcess,\n\tspawn,\n} from "node:child_process";', child],
	];
	for (const [source, expected] of valueImports) {
		const found = findProcessCreators(`${source}\n`);
		assert.equal(found.length, 1, source);
		assert.match(found[0].message, expected, source);
	}

	// The exemption is per statement: a type import above does not shelter the value import below it.
	const mixed = findProcessCreators(
		'import type { ChildProcess } from "node:child_process";\nimport { spawn } from "node:child_process";\n',
	);
	assert.equal(mixed.length, 1);
	assert.equal(mixed[0].line, 2);

	const swallowed = findProcessCreators('export type T = { a: number }\nimport { spawnSync } from "node:child_process"\n');
	assert.equal(swallowed.length, 1);
	assert.equal(swallowed[0].line, 2);
});

test("rule D over the real tree", () => {
	const scanned = processScanFiles(ROOT).map((file) => file.slice(ROOT.length + 1));
	for (const file of [
		SPAWN_PRIMITIVE,
		"packages/gateway/src/gateway/routes/sessions.ts",
		"packages/gateway/src/gateway/routes/ws.ts",
		"packages/gateway/src/session/session.ts",
		"packages/gateway/src/session/session-manager.ts",
	]) {
		assert.ok(scanned.includes(file), `${file} is not in the set rule D scans`);
	}
	assert.deepEqual(
		scanned.filter((file) => file.startsWith("packages/gateway/src/__tests__/")),
		[],
	);
	assert.deepEqual(
		scanRepo(ROOT).filter((v) => v.rule === "D"),
		[],
	);

	const primitive = findProcessCreators(readFileSync(PRIMITIVE, "utf-8"));
	assert.ok(primitive.length > 0, "the detector reads nothing in the one file that creates a process");
	assert.match(primitive[0].message, /reaches `node:child_process`/);

	const route = readFileSync(SESSIONS_ROUTE, "utf-8");
	assert.deepEqual(findProcessCreators(route), []);
	const planted = findProcessCreators(`${route}\nBun.spawn(["cat"]);\n`);
	assert.equal(planted.length, 1);
	assert.equal(planted[0].line, route.split("\n").length + 1);
	assert.match(planted[0].message, /uses `Bun.spawn`/);
});

test("rule D scans every gateway source file outside src/__tests__", () => {
	const planted = 'Bun.spawn(["true"]);\n';
	const exempt = [
		"packages/gateway/src/__tests__/launcher.test.ts",
		"packages/gateway/src/__tests__/helpers/harness.ts",
		"packages/gateway/src/__tests__/fixtures/child.js",
	];
	const scanned = [
		"packages/gateway/src/fixtures/f.ts",
		"packages/gateway/src/test/t.ts",
		"packages/gateway/src/tests/t.ts",
		"packages/gateway/src/__mocks__/m.ts",
		"packages/gateway/src/build/b.ts",
		"packages/gateway/src/dist/d.ts",
		"packages/gateway/src/coverage/c.ts",
		"packages/gateway/src/node_modules/n/index.js",
		"packages/gateway/src/session/__tests__/z.ts",
		"packages/gateway/src/__tests__-old/z.ts",
		"packages/gateway/src/session/a.e2e.ts",
		"packages/gateway/src/session/a.test.ts",
		"packages/gateway/src/session/a.spec.ts",
		"packages/gateway/src/deep/er/fixtures/f.mjs",
	];
	const root = fixtureRoot(Object.fromEntries([...exempt, ...scanned, SPAWN_PRIMITIVE].map((file) => [file, planted])));
	try {
		assert.deepEqual(
			processScanFiles(root).map((file) => file.slice(root.length + 1)).sort(),
			[...scanned, SPAWN_PRIMITIVE].sort(),
		);
		assert.deepEqual(
			scanRepo(root)
				.filter((v) => v.rule === "D")
				.map((v) => v.file)
				.sort(),
			[...scanned].sort(),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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

		assert.deepEqual([...new Set(found.map((v) => v.rule))].sort(), ["A", "B", "C", "D"]);
		assert.match(byFile.get("packages/geist-protocol/src/wire.ts").message, /client frame `attach` declares `argv`/);
		assert.match(byFile.get("packages/gateway/src/gateway/routes/sessions.ts").message, /reads the value of a `command` key/);
		assert.match(byFile.get("packages/gateway/src/session/trust.ts").message, /setProjectTrusted/);
		assert.match(byFile.get("packages/geist-core/src/writer.ts").message, /targets the project-trust file/);
		assert.match(byFile.get("packages/gateway/src/session/launcher.ts").message, /uses `Bun.spawn`/);
		assert.deepEqual(
			found.filter((v) => v.rule === "D").map((v) => v.file),
			["packages/gateway/src/session/launcher.ts"],
		);
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

	const bare = fixtureRoot({ "packages/elsewhere/src/keep.ts": "export const x = 1;\n" });
	try {
		const moved = scanRepo(bare).filter((v) => v.rule === "D");
		assert.equal(moved.length, 1, "a missing gateway src is not reported");
		assert.match(moved[0].message, /packages\/gateway\/src is missing or holds no source .* rule D enforces nothing/);
	} finally {
		rmSync(bare, { recursive: true, force: true });
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
		assert.match(run.stderr, /\[rule D\] packages\/gateway\/src\/session\/launcher\.ts:\d+/);
		assert.doesNotMatch(run.stderr, /\] packages\/gateway\/src\/(?:session\/spawn-primitive|__tests__\/launcher\.test)\.ts/);
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
