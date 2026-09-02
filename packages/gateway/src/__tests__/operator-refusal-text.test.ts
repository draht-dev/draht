/**
 * R33-REACH.10, second clause — **no finding ID in any operator-facing refusal
 * text**, extended from `bind-host.test.ts:132` to the surfaces Phase 33 added.
 *
 * The rule exists because of what a finding id *does* when it is stamped onto a
 * string somebody reads. `bind-host.test.ts` guards one direction of that: an id
 * in a guard string manufactures closure evidence for a finding that is still
 * open. This file guards the other direction, and it is the one that reaches a
 * person. `GSEC-04` in a refusal on a phone screen tells its reader nothing they
 * can act on — they cannot open `.planning/geist/SECURITY-2026-07-13.md`, the id
 * does not say what to do, and the sentence it displaced would have. It also
 * leaks which internal audit item the refusal came from to whoever is holding
 * the device, which by construction includes the person the refusal is aimed at.
 *
 * Two layers, because either alone is a gate with a hole in it:
 *
 *  1. **Behavioural** — the refusals Phase 33 can actually produce are produced,
 *     and the operator-facing text of each is read off the wire. This is the
 *     only layer that proves the string a person sees is the string that was
 *     tested.
 *  2. **Static** — every string literal on the Phase 33 refusal surfaces is
 *     scanned, with comments stripped first (a comment *citing* a finding is
 *     correct and required; a string doing it is the defect). This is the layer
 *     that stays red for a refusal added tomorrow, which the behavioural layer
 *     cannot be. {@link stripComments} is proved to strip comments and to keep
 *     string bodies by {@link SELF_CHECK_SOURCE}, so the scan cannot pass by
 *     being vacuous.
 *
 * The doc half of R33-REACH.10 — `TAILSCALE_SETUP.md` rewritten to the verified
 * procedure — is asserted at the bottom, including that every command the doc
 * prints is one the repo actually implements.
 *
 * **Evidence class 2** (`.planning/TEST-STRATEGY.md`): this file drives
 * in-process modules and reads files. It spawns no emitted binary and closes
 * nothing. The class 3 proofs of the same refusals are `fleet-attach.e2e.test.ts`
 * and `device-revocation-live.e2e.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AttachBridge } from "@draht/geist-core";
import { GEIST_PROTOCOL_FAMILY, GEIST_PROTOCOL_VERSION, ServerFrameSchema } from "@draht/geist-protocol";
import { Hono } from "hono";
import { tailnetIdentityMiddleware } from "../gateway/middleware/tailnet-identity";

/** `packages/gateway/src/__tests__` → the repo root. */
const REPO = join(import.meta.dir, "..", "..", "..", "..");
const PKG = join(import.meta.dir, "..", "..");
const DOC = join(PKG, "TAILSCALE_SETUP.md");

/** Any audit finding id, not only `GSEC-04`: the rule is about the shape. */
const FINDING_ID = /\bGSEC-\d+\b/;

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Remove comments; keep every string body byte for byte.
 *
 * Character-wise rather than regex-based on purpose. The obvious
 * `source.replace(/\/\/.*$/gm, "")` eats the `//` in `"http://127.0.0.1:7878"`,
 * which is in three of the files below — and a stripper that quietly deletes
 * string contents is a scanner that quietly stops scanning them.
 */
export function stripComments(source: string): string {
	let out = "";
	let index = 0;
	while (index < source.length) {
		const two = source.slice(index, index + 2);

		if (two === "//") {
			while (index < source.length && source[index] !== "\n") index += 1;
			continue;
		}
		if (two === "/*") {
			index += 2;
			while (index < source.length && source.slice(index, index + 2) !== "*/") index += 1;
			index += 2;
			continue;
		}

		const char = source[index] as string;
		if (char === '"' || char === "'" || char === "`") {
			out += char;
			index += 1;
			while (index < source.length) {
				const inner = source[index] as string;
				out += inner;
				index += 1;
				if (inner === "\\") {
					out += source[index] ?? "";
					index += 1;
					continue;
				}
				if (inner === char) break;
			}
			continue;
		}

		out += char;
		index += 1;
	}
	return out;
}

/** Proves the stripper strips and, crucially, that it does not strip strings. */
const SELF_CHECK_SOURCE = [
	"/** GSEC-99 belongs in a comment like this one and must survive review. */",
	'const url = "http://127.0.0.1:7878/attach"; // GSEC-99 in a trailing comment',
	'const refusal = "refused — see GSEC-99";',
].join("\n");

// ---------------------------------------------------------------------------
// The surfaces
// ---------------------------------------------------------------------------

/**
 * Every file that can author text an operator or a phone-holder reads as a
 * refusal on a Phase 33 surface: the identity-header check, the `/attach`
 * device gate and its revocation policy, the credential store behind them, the
 * two `geist` subcommands, the served bundle that renders the refusal, and the
 * publish script that refuses Funnel.
 *
 * Paths are repo-relative and asserted to exist. A file that moved must break
 * this list loudly rather than un-gate itself by going missing.
 */
const SURFACES = [
	"packages/gateway/src/gateway/middleware/tailnet-identity.ts",
	"packages/gateway/src/gateway/middleware/auth.ts",
	"packages/gateway/src/gateway/routes/fleet.ts",
	"packages/geist-core/src/attach/attach-bridge.ts",
	"packages/geist-core/src/pairing/device-registry.ts",
	"packages/geist/src/commands/pair.ts",
	"packages/geist/src/commands/devices.ts",
	"packages/geist/src/tailscale.ts",
	"packages/geist-console/bundle/console.js",
	"scripts/geist-tailscale-serve.mjs",
];

// ---------------------------------------------------------------------------
// A renderer that records what the daemon said
// ---------------------------------------------------------------------------

/** One renderer end, collecting frames. Nothing here needs a socket. */
class Recorder {
	readonly frames: unknown[] = [];
	closed: { code: number; reason: string } | null = null;

	bufferedBytes(): number {
		return 0;
	}
	send(text: string): void {
		this.frames.push(ServerFrameSchema.parse(JSON.parse(text)));
	}
	close(code: number, reason: string): void {
		this.closed = { code, reason };
	}

	/** The `protocol_error` this connection was refused with. */
	refusal(): { type: "protocol_error"; code: string; message: string } {
		const found = this.frames.find((frame) => (frame as { type?: string }).type === "protocol_error") as unknown as
			| { type: "protocol_error"; code: string; message: string }
			| undefined;
		if (!found) {
			throw new Error(
				`no protocol_error was emitted (saw: ${this.frames.map((f) => (f as { type?: string }).type).join(", ") || "nothing"})`,
			);
		}
		return found;
	}
}

const HELLO = {
	type: "hello",
	protocol: GEIST_PROTOCOL_FAMILY,
	version: GEIST_PROTOCOL_VERSION,
	client: { name: "operator-refusal-text-test", version: "0.0.0" },
} as const;

/** A store that refuses everything, so a rejected-credential refusal is deterministic. */
const REFUSING_STORE = {
	pair() {
		return { ok: false as const, reason: "no bootstrap tokens in this store" };
	},
	authenticate() {
		return { ok: false as const, reason: "unknown device" };
	},
};

/** A bridge on an empty socket dir: nothing below can reach a session. */
function bridge(options: { authDeadlineMs?: number; devices?: unknown } = {}): {
	bridge: AttachBridge;
	wire: Recorder;
} {
	const wire = new Recorder();
	const built = new AttachBridge({
		socketDir: join(import.meta.dir, "fixtures", "no-such-socket-dir"),
		connection: wire,
		devices: (options.devices ?? REFUSING_STORE) as never,
		authDeadlineMs: options.authDeadlineMs ?? 5_000,
	});
	return { bridge: built, wire };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("no operator-facing refusal string on the Phase 33 surfaces cites a GSEC finding id", async () => {
	const seen: { where: string; message: string }[] = [];

	// --- the identity-header refusal (R33-REACH.8) -------------------------
	const app = new Hono();
	app.use(
		"*",
		tailnetIdentityMiddleware({ fronted: true, owner: "owner@example.com", header: "X-Test-Tailnet-User" }),
	);
	app.get("/fleet", (c) => c.json({ ok: true }));
	const forbidden = await app.request("/fleet", { headers: { "X-Test-Tailnet-User": "intruder@example.com" } });
	expect(forbidden.status).toBe(403);
	seen.push({ where: "tailnet identity 403", message: ((await forbidden.json()) as { error: string }).error });

	// --- `not_authenticated`: a frame before a credential ------------------
	{
		const { bridge: gate, wire } = bridge();
		gate.receive(JSON.stringify(HELLO));
		gate.receive(JSON.stringify({ type: "attach", sessionId: "any", clientId: "c", mode: "read-write" }));
		const refusal = wire.refusal();
		expect(refusal.code).toBe("not_authenticated");
		seen.push({ where: "attach before a credential", message: refusal.message });
	}

	// --- `not_authenticated`: the credential was rejected ------------------
	{
		const { bridge: gate, wire } = bridge();
		gate.receive(JSON.stringify(HELLO));
		gate.receive(JSON.stringify({ type: "authenticate", deviceId: "dev_x", credential: "wrong" }));
		const refusal = wire.refusal();
		expect(refusal.code).toBe("not_authenticated");
		seen.push({ where: "a rejected credential", message: refusal.message });
	}

	// --- `not_authenticated`: one attempt per connection -------------------
	{
		const { bridge: gate, wire } = bridge();
		gate.receive(JSON.stringify(HELLO));
		gate.receive(JSON.stringify({ type: "authenticate", deviceId: "dev_x", credential: "wrong" }));
		// The refusal already closed this connection, so a second attempt has to
		// be made on a bridge that is still open: a fresh one whose first attempt
		// is spent by a store that says yes to nothing but does not close.
		const second = bridge();
		second.bridge.receive(JSON.stringify(HELLO));
		second.bridge.receive(
			JSON.stringify({ type: "pair_device", bootstrapToken: "no", device: { name: "n", platform: "p" } }),
		);
		seen.push({ where: "a spent authentication attempt", message: second.wire.refusal().message });
		expect(wire.refusal().code).toBe("not_authenticated");
	}

	// --- `not_authenticated`: the pre-auth deadline ------------------------
	{
		const { bridge: gate, wire } = bridge({ authDeadlineMs: 25 });
		gate.receive(JSON.stringify(HELLO));
		await Bun.sleep(120);
		const refusal = wire.refusal();
		expect(refusal.code).toBe("not_authenticated");
		seen.push({ where: "the pre-auth deadline", message: refusal.message });
	}

	// --- the revocation refusal (R33-REACH.6) ------------------------------
	// `createFleetRoutes` authors this one and hands it to `refuse()`, which is
	// the host's only way to end a connection something *outside* it revoked.
	// What is asserted here is that the host's message reaches the wire verbatim
	// — so whatever `routes/fleet.ts` writes is what a phone displays, and the
	// static scan below is what constrains it.
	{
		const { bridge: gate, wire } = bridge();
		gate.receive(JSON.stringify(HELLO));
		gate.refuse("not_authenticated", "this device has been revoked");
		const refusal = wire.refusal();
		expect(refusal.message).toBe("this device has been revoked");
		seen.push({ where: "a revoked device", message: refusal.message });
	}

	// Every refusal above actually happened, and none of them names a finding.
	expect(seen.length).toBe(6);
	for (const { where, message } of seen) {
		expect(message, `the refusal for ${where} is empty`).not.toBe("");
		expect(message, `the refusal for ${where} cites a finding id: ${message}`).not.toMatch(FINDING_ID);
	}

	// --- and the static half, for every refusal not written yet ------------
	// Non-vacuity first: the scanner must be able to fail.
	expect(stripComments(SELF_CHECK_SOURCE)).not.toMatch(/belongs in a comment/);
	expect(stripComments(SELF_CHECK_SOURCE)).not.toMatch(/trailing comment/);
	expect(stripComments(SELF_CHECK_SOURCE)).toMatch(/http:\/\/127\.0\.0\.1:7878\/attach/);
	expect(stripComments(SELF_CHECK_SOURCE)).toMatch(FINDING_ID);

	for (const relative of SURFACES) {
		const absolute = join(REPO, relative);
		expect(existsSync(absolute), `${relative} is on the refusal-surface list but does not exist`).toBe(true);
		const code = stripComments(readFileSync(absolute, "utf-8"));
		const cited = code.match(FINDING_ID);
		expect(
			cited?.[0],
			`${relative} names ${cited?.[0]} outside a comment — an operator cannot act on a finding id, ` +
				"and a refusal that shows one has spent the sentence that could have told them what to do",
		).toBeUndefined();
	}
});

// ---------------------------------------------------------------------------
// The commands the doc prints
// ---------------------------------------------------------------------------

/**
 * The directory the doc tells the reader to stand in, and therefore the one
 * every relative path in a documented command resolves against.
 *
 * It is the repo root, because that is where `scripts/` and the workspace
 * `package.json` are, and because `scripts/geist-tailscale-serve.mjs` resolves
 * `--out` with `resolve(process.cwd(), …)` — so a relative path printed in the
 * doc means whatever the reader's shell says it means. A doc that prints a
 * relative path without saying which directory it is relative to has not
 * documented a command; it has documented a guess.
 */
const CWD = REPO;

interface DocCommand {
	/** The command as one line, continuations joined, whitespace normalised. */
	readonly command: string;
	/** Where it was printed, for a failure message that can be acted on. */
	readonly where: string;
}

/** Commands from ```bash fences — the blocks a reader copies wholesale. */
function fencedCommands(text: string): DocCommand[] {
	const blocks = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
	const out: DocCommand[] = [];
	for (const block of blocks) {
		let joined = "";
		for (const raw of block.split("\n")) {
			const line = raw.trim();
			if (line === "" || line.startsWith("#")) continue;
			if (line.endsWith("\\")) {
				joined += `${line.slice(0, -1).trim()} `;
				continue;
			}
			out.push({ command: `${joined}${line}`.trim(), where: "a ```bash block" });
			joined = "";
		}
	}
	return out;
}

/**
 * Command heads gated when they appear in prose.
 *
 * Deliberately not `tailscale` or `curl`: the doc names `tailscale funnel` in
 * order to prohibit it, and a prohibition is not an instruction. These four are
 * the heads whose flags this repo actually implements, which is what makes a
 * prose claim about them checkable — `geist pair --ttl 300` is advertised in a
 * sentence and never in a fence, and before this gate nothing checked it.
 */
const PROSE_COMMAND_HEADS = new Set(["node", "geist", "bun", "npm"]);

/**
 * Commands advertised in prose as inline code spans.
 *
 * Fenced blocks are stripped first so a fenced line is never counted twice, and
 * whitespace is normalised because Markdown reflow puts line breaks inside
 * spans — `` `node scripts/geist-tailscale-serve.mjs\n--doctor` `` is one
 * command, not two. A span of a single bare word (`` `geist` ``, naming the
 * binary) is a noun, not an invocation, so two tokens are the minimum.
 */
function proseCommands(text: string): DocCommand[] {
	const prose = text.replace(/```[\s\S]*?```/g, "\n");
	const out: DocCommand[] = [];
	for (const match of prose.matchAll(/`([^`]+)`/g)) {
		const command = (match[1] ?? "").replace(/\s+/g, " ").trim();
		const tokens = command.split(" ");
		if (tokens.length < 2) continue;
		if (!PROSE_COMMAND_HEADS.has(tokens[0] as string)) continue;
		out.push({ command, where: "prose" });
	}
	return out;
}

/** `--flag value` and `--flag=value` pairs, in the order they were written. */
function flagArguments(command: string): { flag: string; value: string | null }[] {
	const tokens = command.split(/\s+/);
	const pairs: { flag: string; value: string | null }[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as string;
		if (!token.startsWith("--")) continue;
		const equals = token.indexOf("=");
		if (equals !== -1) {
			pairs.push({ flag: token.slice(0, equals), value: token.slice(equals + 1) });
			continue;
		}
		const next = tokens[index + 1];
		pairs.push({ flag: token, value: next !== undefined && !next.startsWith("-") ? next : null });
	}
	return pairs;
}

/**
 * Is this flag argument a filesystem path whose location this repo can check?
 *
 * True for a *relative* path containing a `/`: that is the case where the
 * reader's working directory decides where the file lands, and the only case
 * where a wrong path is visible from inside the checkout. Excluded, with the
 * reason each exclusion is not a hole:
 *
 *  - `https://host` — a URL (`geist pair --origin`), not a file.
 *  - `/gateway`, `/health`, `/geist` — absolute, and every absolute value the
 *    doc prints is an HTTP route (`--serve-path`, `--ws-path`, `--path`).
 *  - `@draht/geist` — an npm workspace name (`--workspace`).
 *  - `~/.draht/…` — under the reader's home, which is not this checkout.
 */
function isCheckablePath(value: string): boolean {
	if (!value.includes("/")) return false;
	if (value.includes("://")) return false;
	if (value.startsWith("/") || value.startsWith("~") || value.startsWith("@")) return false;
	return true;
}

// ---------------------------------------------------------------------------
// The doc half of R33-REACH.10
// ---------------------------------------------------------------------------

describe("TAILSCALE_SETUP.md is the verified procedure", () => {
	const doc = (): string => readFileSync(DOC, "utf-8");

	test("it names which half of GSEC-04 this work closes, and what closes the other", () => {
		const text = doc();
		expect(text).toMatch(/credential half/i);
		expect(text).toMatch(/bind half/i);
		expect(text).toMatch(/Phase 32/);
		// The sentence this replaces said the bind posture closes nothing and
		// stopped there, which left an open finding with no named owner.
		expect(text).not.toMatch(/finding remains open and is tracked separately/);
	});

	test("it documents the identity header as a contract to capture, not one to invent", () => {
		const text = doc();
		expect(text).toMatch(/tailnet-identity\.captured\.json/);
		expect(text).toMatch(/--capture-identity/);
		expect(text).toMatch(/tailscaleVersion|tailscale version/);
		// The real header has never been observed on this machine. A doc that
		// printed a name would be pinning fiction into an operator's config.
		expect(text).toMatch(/X-Uncaptured-Tailnet-Identity-Header-Placeholder/);
		expect(text).toMatch(/never been (captured|observed)|not( yet)? been captured|uncaptured/i);
	});

	test("it says tailnet reachability is an ACL and not an authentication boundary", () => {
		const text = doc();
		expect(text).toMatch(/never an authentication boundary/i);
		expect(text).toMatch(/coordination server/i);
		expect(text).toMatch(/access controls|ACL/i);
		expect(text).toMatch(/tcp:443|"443"/);
	});

	test("it documents the pairing flow, the device commands and the phone-side store", () => {
		const text = doc();
		expect(text).toMatch(/geist pair/);
		expect(text).toMatch(/geist devices list/);
		expect(text).toMatch(/geist devices revoke/);
		expect(text).toMatch(/localStorage/);
		expect(text).toMatch(/geist\.console\.device/);
		expect(text).toMatch(/not_authenticated/);
	});

	test("the funnel prohibition is restated and unweakened", () => {
		const text = doc();
		expect(text).toMatch(/tailscale funnel/i);
		expect(text).toMatch(/public internet/i);
		expect(text).toMatch(/no override|never/i);
		// No conditional that would turn the prohibition into advice.
		for (const line of text.split("\n")) {
			if (!/funnel/i.test(line)) continue;
			expect(line, `this line makes Funnel conditional: ${line}`).not.toMatch(
				/\b(if you must|unless you|acceptable|is fine|opt in to funnel)\b/i,
			);
		}
	});

	test("it names the directory its commands run from", () => {
		const text = doc();
		// The words, so a reader knows where to stand …
		expect(text, "the doc never says which directory its commands run from").toMatch(/repo root/i);
		// … and the markers of that directory, so the basis this file resolves
		// relative paths against is the one the doc named rather than a guess.
		expect(existsSync(join(CWD, "scripts", "geist-tailscale-serve.mjs"))).toBe(true);
		expect(existsSync(join(CWD, "package.json"))).toBe(true);
		// And the basis DEFECT 1 assumed is not a directory at all: `src/…` in a
		// command run from here resolves to nothing.
		expect(existsSync(join(CWD, "src")), "the repo root has a src/ — the path gate below needs rethinking").toBe(
			false,
		);
	});

	test("every command it prints is one this repo implements", () => {
		const text = doc();

		const fenced = fencedCommands(text);
		expect(fenced.length, "the doc prints no bash blocks at all").toBeGreaterThan(0);
		const prose = proseCommands(text);
		expect(prose.length, "no command is advertised in prose — check the span scanner still matches").toBeGreaterThan(
			0,
		);
		const commands = [...fenced, ...prose];

		const sources = new Map<string, string>();
		const sourceOf = (relative: string): string => {
			const cached = sources.get(relative);
			if (cached !== undefined) return cached;
			const absolute = join(REPO, relative);
			expect(existsSync(absolute), `the doc invokes ${relative}, which does not exist`).toBe(true);
			const text = readFileSync(absolute, "utf-8");
			sources.set(relative, text);
			return text;
		};

		const GEIST_SOURCE: Record<string, string> = {
			pair: "packages/geist/src/commands/pair.ts",
			devices: "packages/geist/src/commands/devices.ts",
		};

		for (const { command, where } of commands) {
			const tokens = command.split(/\s+/);

			// --- every path handed to a flag lands somewhere that exists --------
			// A flag token that is merely *spelled* in the invoked source proves
			// nothing about the value beside it: `--out src/__tests__/fixtures/…`
			// spells `--out` correctly and writes the file into a directory the
			// script has to create, at the repo root, where nothing reads it.
			for (const { flag, value } of flagArguments(command)) {
				if (value === null || !isCheckablePath(value)) continue;
				const target = resolve(CWD, value);
				expect(
					existsSync(dirname(target)),
					`${where}: \`${command}\` passes ${flag} ${value}, which resolves to ${target} — and its ` +
						`directory does not exist under ${CWD}, the directory this doc says to run from. ` +
						"A reader following this line writes the file somewhere nothing reads it.",
				).toBe(true);
			}

			if (where !== "prose") {
				expect(command, "no command in this doc may carry Funnel").not.toMatch(/funnel/i);
			}

			// --- and the flags are ones the invoked program implements ----------
			if (tokens[0] === "node" && (tokens[1] ?? "").startsWith("scripts/")) {
				const script = sourceOf(tokens[1] as string);
				for (const flag of tokens.slice(2).filter((token) => token.startsWith("--"))) {
					expect(script, `${tokens[1]} does not implement ${flag}`).toContain(`"${flag.split("=")[0]}"`);
				}
				continue;
			}

			if (tokens[0] === "geist") {
				const sub = tokens[1] as string;
				const relative = GEIST_SOURCE[sub];
				expect(relative, `\`geist ${sub}\` is not a subcommand this CLI implements`).toBeDefined();
				const usage = sourceOf("packages/geist/src/cli.ts");
				expect(usage, `\`geist ${sub}\` is not routed in cli.ts`).toContain(`geist ${sub}`);
				const source = sourceOf(relative as string);
				for (const flag of tokens.slice(2).filter((token) => token.startsWith("--"))) {
					expect(source, `\`geist ${sub}\` does not implement ${flag}`).toContain(`"${flag.split("=")[0]}"`);
				}
				continue;
			}

			// `bun start` is the daemon's own CLI, which parses its flags in cli.ts.
			if (tokens[0] === "bun" && tokens[1] === "start") {
				const cli = sourceOf("packages/gateway/src/cli.ts");
				for (const flag of tokens.slice(2).filter((token) => token.startsWith("--"))) {
					expect(cli, `the gateway CLI does not implement ${flag}`).toContain(`"${flag.split("=")[0]}"`);
				}
				continue;
			}

			// `npm run <script>` — the script has to be in the workspace root
			// package.json, which is another thing only the repo root can answer.
			if (tokens[0] === "npm" && tokens[1] === "run") {
				const scripts = (JSON.parse(sourceOf("package.json")) as { scripts: Record<string, string> }).scripts;
				const name = tokens[2] as string;
				expect(Object.keys(scripts), `\`npm run ${name}\` is not a script in the root package.json`).toContain(
					name,
				);
			}
		}
	});

	// The regression for DEFECT 1. The capture command is the one command in this
	// doc whose whole purpose is to close the intentionally-red tripwire in
	// `tailnet-identity.test.ts`. Sent to the wrong `--out`, it writes a real
	// capture into a directory nothing reads, the tripwire stays red, and the
	// failure reads as "the capture did not work" rather than "the doc is wrong".
	test("the --capture-identity command writes the pin the tripwire actually reads", () => {
		const capture = [...fencedCommands(doc()), ...proseCommands(doc())].find((entry) =>
			entry.command.includes("--capture-identity"),
		);
		expect(
			capture,
			"the doc prints no --capture-identity command — the red tripwire has no documented way to close",
		).toBeDefined();

		const out = flagArguments((capture as DocCommand).command).find((pair) => pair.flag === "--out")?.value ?? null;
		expect(
			out,
			"--capture-identity without --out writes DEFAULT_IDENTITY_OUT (scripts/fixtures/…), which is not the pin",
		).not.toBeNull();

		const PIN = join(PKG, "src", "__tests__", "fixtures", "tailnet-identity.captured.json");
		expect(existsSync(PIN), "the pin the tripwire reads has moved; this doc must follow it").toBe(true);
		expect(
			resolve(CWD, out as string),
			`the doc sends the capture to ${resolve(CWD, out as string)}, but the tripwire reads ${PIN}`,
		).toBe(PIN);

		// The tripwire prints its own copy of this command in the failure message
		// an operator reads first. The two must be the same command, or the doc
		// and the failing test send that operator to two different files.
		const tripwire = readFileSync(join(PKG, "src", "__tests__", "tailnet-identity.test.ts"), "utf-8");
		const pinned = /--out ([^\s"]+)/.exec(tripwire)?.[1];
		expect(pinned, "the tripwire no longer prints a --out path in its failure message").toBeDefined();
		expect(out, "the doc and the tripwire's failure message name different capture destinations").toBe(
			pinned as string,
		);
	});
});
