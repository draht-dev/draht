import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DEFAULT_CONFIG, type GatewaySettings, normalizeConfig } from "../config/config";
import {
	DEFAULT_TAILNET_IDENTITY_HEADER,
	type TailnetFrontingSettings,
	tailnetIdentityMiddleware,
} from "../gateway/middleware/tailnet-identity";
import { createServer } from "../gateway/server";

/**
 * The tailnet identity header is deny-only (R33-REACH.8, spec §6.6).
 *
 * The daemon listens on loopback and cannot tell a request that came through
 * `tailscale serve` from one a local process wrote by hand, so *anything that
 * can reach the listener can forge this header*. It therefore may only ever
 * subtract: a value naming somebody other than the configured owner is refused,
 * and every other outcome is "carry on to the credential check that was going
 * to happen anyway". There is no path through this middleware that authorizes
 * anything, and `no authenticated marker` below asserts that structurally
 * rather than trusting the prose.
 */

const OWNER = "owner@example.com";
const TEST_HEADER = "X-Test-Tailnet-User";
const TOKEN = "test-secret";

const temps: string[] = [];

/** A throwaway socket dir so `/fleet` never reads this machine's real sessions. */
function socketDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "draht-tailnet-identity-"));
	temps.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A gateway whose config declares the deployment tailnet-fronted. */
function frontedGateway(tailnet: TailnetFrontingSettings | undefined): Hono {
	const config: GatewaySettings = { ...DEFAULT_CONFIG, ...(tailnet ? { tailnet } : {}) };
	return createServer({ port: 7878, authToken: TOKEN, config, socketDir: socketDir() }).app;
}

const FRONTED: TailnetFrontingSettings = { fronted: true, owner: OWNER, header: TEST_HEADER };

describe("tailnet identity header — deny-only (R33-REACH.8)", () => {
	test("a forged identity header naming the configured owner, with no credential, is still refused", async () => {
		const app = frontedGateway(FRONTED);

		// Exactly the attack the loopback listener cannot detect: a local process
		// writes the header a proxy would have written, names the owner, and
		// presents nothing else.
		const res = await app.request("/fleet", { headers: { [TEST_HEADER]: OWNER } });

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Unauthorized" });
	});

	test("a value naming somebody other than the owner is refused with 403", async () => {
		const app = frontedGateway(FRONTED);

		const res = await app.request("/fleet", {
			headers: { [TEST_HEADER]: "intruder@example.com", Authorization: `Bearer ${TOKEN}` },
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		// Operator-facing text carries no finding id (R33-REACH.10).
		expect(body.error).not.toMatch(/GSEC-\d+/);
		expect(body.error).toMatch(/tailnet identity/i);
	});

	test("an absent header falls through to full credential auth — 401 without, 200 with", async () => {
		const app = frontedGateway(FRONTED);

		expect((await app.request("/fleet")).status).toBe(401);
		expect((await app.request("/fleet", { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
	});

	test("a forged owner value alongside an invalid credential is still 401", async () => {
		const app = frontedGateway(FRONTED);

		const res = await app.request("/fleet", {
			headers: { [TEST_HEADER]: OWNER, Authorization: "Bearer wrong" },
		});

		expect(res.status).toBe(401);
	});

	test("fronted: false ignores the header entirely", async () => {
		const app = frontedGateway({ fronted: false, owner: OWNER, header: TEST_HEADER });

		// Not 403: with fronting undeclared the header is not a signal at all, so
		// a non-owner value neither refuses nor grants.
		expect(
			(
				await app.request("/fleet", {
					headers: { [TEST_HEADER]: "intruder@example.com", Authorization: `Bearer ${TOKEN}` },
				})
			).status,
		).toBe(200);
		// And it still cannot grant: no credential is no credential.
		expect((await app.request("/fleet", { headers: { [TEST_HEADER]: OWNER } })).status).toBe(401);
	});

	test("no tailnet block at all leaves every route exactly as it was", async () => {
		const app = frontedGateway(undefined);

		expect((await app.request("/fleet", { headers: { [TEST_HEADER]: OWNER } })).status).toBe(401);
		expect((await app.request("/fleet", { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
	});

	test("no code path writes an authenticated marker into the context", async () => {
		const seen: string[][] = [];
		const app = new Hono();
		app.use("*", tailnetIdentityMiddleware(FRONTED));
		app.get("/probe", (c) => {
			seen.push(Object.keys(c.var));
			return c.json({ ok: true });
		});

		// Every shape that reaches `next()`: owner-valued, absent, empty.
		await app.request("/probe", { headers: { [TEST_HEADER]: OWNER } });
		await app.request("/probe");
		await app.request("/probe", { headers: { [TEST_HEADER]: "" } });

		expect(seen).toEqual([[], [], []]);

		// Structural, not behavioural: the module has no vocabulary for granting.
		// `c.set(...)` is the only way a Hono middleware hands a downstream handler
		// a decision, and a 2xx is the only way it answers one itself.
		const source = readFileSync(join(import.meta.dir, "..", "gateway", "middleware", "tailnet-identity.ts"), "utf-8");
		const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		expect(code).not.toMatch(/\.set\s*\(/);
		expect(code).not.toMatch(/\bc\.(json|text|html|body|redirect)\s*\([^)]*,\s*(?!403)\d{3}/);
		// One status literal in the whole module, and it is a refusal.
		expect([...code.matchAll(/\b[1-5]\d\d\b/g)].map((match) => match[0])).toEqual(["403"]);
	});
});

describe("tailnet config validation", () => {
	test("a well-formed tailnet block survives normalizeConfig", () => {
		const config = normalizeConfig({ tailnet: { fronted: true, owner: OWNER, header: TEST_HEADER } }, "test.json");
		expect(config.tailnet).toEqual({ fronted: true, owner: OWNER, header: TEST_HEADER });
	});

	test("an absent tailnet block leaves the settings untouched", () => {
		expect(normalizeConfig({}, "test.json")).toEqual(DEFAULT_CONFIG);
	});

	test("a malformed tailnet block is a config error, never a silently-off check", () => {
		expect(() => normalizeConfig({ tailnet: "yes" }, "test.json")).toThrow(/tailnet/);
		expect(() => normalizeConfig({ tailnet: { fronted: true } }, "test.json")).toThrow(/owner/);
		expect(() => normalizeConfig({ tailnet: { fronted: "true", owner: OWNER } }, "test.json")).toThrow(/fronted/);
		expect(() => normalizeConfig({ tailnet: { fronted: true, owner: OWNER, header: 7 } }, "test.json")).toThrow(
			/header/,
		);
	});

	test("omitting the header name falls back to the pinned one", () => {
		const config = normalizeConfig({ tailnet: { fronted: true, owner: OWNER } }, "test.json");
		expect(config.tailnet?.header).toBeUndefined();

		// Resolution happens in the middleware, so the default is one constant and
		// not a value copied into config-loading as well.
		const app = new Hono();
		app.use("*", tailnetIdentityMiddleware(config.tailnet));
		app.get("/probe", (c) => c.json({ ok: true }));

		return (async () => {
			const res = await app.request("/probe", {
				headers: { [DEFAULT_TAILNET_IDENTITY_HEADER]: "intruder@example.com" },
			});
			expect(res.status).toBe(403);
		})();
	});
});

describe("the pinned identity-header contract", () => {
	const PIN_PATH = join(import.meta.dir, "fixtures", "tailnet-identity.captured.json");
	const CAPTURE_COMMAND =
		"node scripts/geist-tailscale-serve.mjs --capture-identity --peer NODE " +
		"--out packages/gateway/src/__tests__/fixtures/tailnet-identity.captured.json";

	interface CapturedIdentity {
		placeholder?: boolean;
		capturedAt: string | null;
		tailscaleVersion: string | null;
		identityHeaders: Record<string, string>;
	}

	function readPin(): CapturedIdentity {
		return JSON.parse(readFileSync(PIN_PATH, "utf-8")) as CapturedIdentity;
	}

	/** The header the default must name, read out of the capture. */
	function pinnedHeaderName(pin: CapturedIdentity): string {
		const names = Object.keys(pin.identityHeaders);
		const login = names.find((name) => /^tailscale-user-login$/i.test(name));
		if (login) return login;
		if (names.length === 1) return names[0] as string;
		throw new Error(
			`${PIN_PATH} records ${names.length} identity headers (${names.join(", ")}) and none is ` +
				"tailscale-user-login. Pick the one the deployment trusts and set " +
				"DEFAULT_TAILNET_IDENTITY_HEADER in gateway/middleware/tailnet-identity.ts to it by hand.",
		);
	}

	// INTENDED FAILING TEST. The real tailnet identity header has never been
	// observed on this machine, so the pin ships as a placeholder and this test
	// is red until somebody captures the real one. A phase that closed with a
	// guessed header name would have pinned fiction.
	test("is a real capture, not the placeholder this repo ships", () => {
		const pin = readPin();

		const stillPlaceholder = pin.placeholder === true || pin.capturedAt === null;
		expect(
			stillPlaceholder,
			`\n\n  ${PIN_PATH}\n  is still the placeholder this repo ships. The real tailnet identity header has\n` +
				"  never been observed on this machine, so nothing here was captured and nothing\n" +
				"  here may be trusted as a contract. Capture the real one with:\n\n" +
				`    ${CAPTURE_COMMAND}\n\n` +
				"  then set DEFAULT_TAILNET_IDENTITY_HEADER in\n" +
				"  packages/gateway/src/gateway/middleware/tailnet-identity.ts to the header it records.\n",
		).toBe(false);

		expect(
			pin.tailscaleVersion,
			`${PIN_PATH} must record the tailscale version it came from. Re-capture: ${CAPTURE_COMMAND}`,
		).toBeString();

		// And the shipped default must name what was actually observed.
		expect(DEFAULT_TAILNET_IDENTITY_HEADER.toLowerCase()).toBe(pinnedHeaderName(pin).toLowerCase());
	});

	test("the shipped default matches the pin as it stands, whatever it says", () => {
		// Independent of whether the pin is real: the constant and the file must
		// never disagree, so replacing the file is a one-step operation with a
		// visible failure when the constant is left behind.
		expect(DEFAULT_TAILNET_IDENTITY_HEADER.toLowerCase()).toBe(pinnedHeaderName(readPin()).toLowerCase());
	});
});
