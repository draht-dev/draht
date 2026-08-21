import { describe, expect, test } from "bun:test";
import {
	AttachFrameSchema,
	CLIENT_FRAME_TYPES,
	ClientFrameSchema,
	DEFAULT_TRANSPORT_LIMITS,
	decodeClientFrame,
	decodeServerFrame,
	encodeFrame,
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	HelloFrameSchema,
	PermissionRequestFrameSchema,
	PermissionResolvedFrameSchema,
	protocolError,
	SERVER_FRAME_TYPES,
	ServerFrameSchema,
	ServerHelloFrameSchema,
} from "../src/wire.js";

const helloFrame = {
	type: "hello",
	protocol: GEIST_PROTOCOL_FAMILY,
	version: GEIST_PROTOCOL_VERSION,
	client: { name: "geist-console", version: "0.1.0" },
};

const serverHelloFrame = {
	type: "server_hello",
	protocol: GEIST_PROTOCOL_FAMILY,
	version: GEIST_PROTOCOL_VERSION,
	server: { name: "geist-daemon", version: "0.1.0" },
	limits: DEFAULT_TRANSPORT_LIMITS,
};

describe("handshake", () => {
	test("the family literal is geist/0.x and the member version is a bare 0.x", () => {
		expect(GEIST_PROTOCOL_FAMILY).toBe("geist/0.x");
		expect(GEIST_PROTOCOL_VERSION).toMatch(/^0\.\d+$/);
	});

	test("hello carries the family and the version", () => {
		expect(HelloFrameSchema.parse(helloFrame)).toEqual(helloFrame);
	});

	test("server_hello answers with the family, the version and the transport limits", () => {
		expect(ServerHelloFrameSchema.parse(serverHelloFrame)).toEqual(serverHelloFrame);
	});

	test("a hello from a different protocol family is refused", () => {
		expect(HelloFrameSchema.safeParse({ ...helloFrame, protocol: "acp/1.0" }).success).toBe(false);
	});

	test("a hello naming another 0.x member is refused — 0.x members are not compatible", () => {
		expect(HelloFrameSchema.safeParse({ ...helloFrame, version: "0.999" }).success).toBe(false);
	});
});

describe("frame unions", () => {
	test("every declared client type is a member of the client union and nothing else", () => {
		const members = ClientFrameSchema.options.map((o) => o.shape.type.value).sort();
		expect(members).toEqual([...CLIENT_FRAME_TYPES].sort());
	});

	test("every declared server type is a member of the server union and nothing else", () => {
		const members = ServerFrameSchema.options.map((o) => o.shape.type.value).sort();
		expect(members).toEqual([...SERVER_FRAME_TYPES].sort());
	});

	test("the two directions do not share a type name", () => {
		const overlap = CLIENT_FRAME_TYPES.filter((t) => (SERVER_FRAME_TYPES as readonly string[]).includes(t));
		expect(overlap).toEqual([]);
	});

	test("the Phase 32 attach wire covers the socket wire it relays", () => {
		// The relayed set is frozen: these are the frames that cross to a draht
		// session's Unix socket, and the mirror clause in
		// `scripts/check-geist-protocol.mjs` checks them against the socket wire.
		// Phase 33's device-exchange frames are deliberately NOT here — they
		// terminate at the daemon (R33-REACH.5) — and Phase 34's permission frames
		// are relayed but arrived later, so both sets are asserted separately below
		// rather than being quietly folded into this list.
		const laterServerFrames = new Set(["device_credential", "permission_request", "permission_resolved"]);
		const laterClientFrames = new Set(["pair_device", "authenticate", "permission_response"]);
		expect([...SERVER_FRAME_TYPES].filter((t) => !laterServerFrames.has(t)).sort()).toEqual(
			[
				"client_joined",
				"client_left",
				"error",
				"fleet",
				"input_echo",
				"output",
				"protocol_error",
				"server_hello",
				"session_metadata",
			].sort(),
		);
		expect([...CLIENT_FRAME_TYPES].filter((t) => !laterClientFrames.has(t)).sort()).toEqual(
			["attach", "detach", "hello", "input"].sort(),
		);
	});

	test("the geist/0.3 permission frames exist and ARE relayed", () => {
		// Unlike the device exchange, these three cross to a draht session's Unix
		// socket, so each has a row in MIRRORED_FRAMES and the mirror clause holds
		// them field-for-field against `socket-server/types.ts`.
		expect([...SERVER_FRAME_TYPES]).toContain("permission_request");
		expect([...SERVER_FRAME_TYPES]).toContain("permission_resolved");
		expect([...CLIENT_FRAME_TYPES]).toContain("permission_response");
	});

	test("the geist/0.2 device-exchange frames exist and are not relayed", () => {
		// If one of these ever needs relaying it must be added to MIRRORED_FRAMES
		// in `scripts/check-geist-protocol.mjs` deliberately, not by accident.
		expect([...CLIENT_FRAME_TYPES]).toContain("pair_device");
		expect([...CLIENT_FRAME_TYPES]).toContain("authenticate");
		expect([...SERVER_FRAME_TYPES]).toContain("device_credential");
	});
});

describe("decodeClientFrame", () => {
	test("accepts a well-formed frame", () => {
		const result = decodeClientFrame(JSON.stringify(helloFrame));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.frame).toEqual(helloFrame);
	});

	test("refuses a frame larger than the per-frame byte cap", () => {
		const huge = JSON.stringify({
			type: "input",
			clientId: "a",
			data: "x".repeat(DEFAULT_TRANSPORT_LIMITS.maxFrameBytes),
		});
		const result = decodeClientFrame(huge);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("frame_too_large");
	});

	test("refuses bytes that are not JSON", () => {
		const result = decodeClientFrame("{not json");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("invalid_frame");
	});

	test("refuses a JSON frame carrying no known discriminator", () => {
		const result = decodeClientFrame(JSON.stringify({ type: "spawn", command: ["/bin/sh"] }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("unknown_type");
	});

	test("refuses a server type sent in the client direction", () => {
		const result = decodeClientFrame(JSON.stringify({ type: "output", data: "x", stream: "stdout" }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("unknown_type");
	});

	test("a hello from another protocol family is refused as version_mismatch, not as noise", () => {
		const result = decodeClientFrame(JSON.stringify({ ...helloFrame, protocol: "acp/1.0" }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("version_mismatch");
	});

	test("a hello naming another 0.x member is refused as version_mismatch", () => {
		const result = decodeClientFrame(JSON.stringify({ ...helloFrame, version: "0.999" }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("version_mismatch");
	});

	test("refuses a known type whose fields do not validate, and names the field", () => {
		const result = decodeClientFrame(JSON.stringify({ type: "attach", sessionId: "s", clientId: "c", mode: "god" }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("invalid_frame");
			expect(result.message).toContain("mode");
		}
	});

	test("an unknown extra field is not silently carried onto the wire", () => {
		const result = decodeClientFrame(JSON.stringify({ ...helloFrame, command: ["/bin/sh", "-c", "touch $CANARY"] }));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.frame).not.toHaveProperty("command");
	});
});

describe("decodeServerFrame", () => {
	test("accepts a well-formed server frame", () => {
		const result = decodeServerFrame(JSON.stringify(serverHelloFrame));
		expect(result.ok).toBe(true);
	});

	test("refuses a client type sent in the server direction", () => {
		const result = decodeServerFrame(JSON.stringify(helloFrame));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("unknown_type");
	});
});

describe("protocolError", () => {
	test("builds a frame that validates as a server frame", () => {
		const frame = protocolError("frame_too_large", "frame exceeds 65536 bytes");
		expect(ServerFrameSchema.safeParse(frame).success).toBe(true);
	});

	test("refuses an undeclared code", () => {
		// @ts-expect-error — the code set is closed on purpose
		expect(() => protocolError("teapot", "nope")).toThrow();
	});
});

describe("encodeFrame", () => {
	test("round-trips through the decoder", () => {
		const encoded = encodeFrame(
			AttachFrameSchema.parse({ type: "attach", sessionId: "s", clientId: "c", mode: "read-only" }),
		);
		const result = decodeClientFrame(encoded);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.frame).toEqual({ type: "attach", sessionId: "s", clientId: "c", mode: "read-only" });
	});

	test("emits no trailing newline — WS frames are already delimited", () => {
		expect(encodeFrame(helloFrame as never)).not.toContain("\n");
	});
});

describe("safeText bounds count grapheme clusters, like the producer does", () => {
	// ONE extended grapheme cluster that survives neutralization untouched: an astral base
	// (U+1F642 SLIGHTLY SMILING FACE) plus seven U+0334 COMBINING TILDE OVERLAY. Nothing in it
	// is listed in `NEUTRALIZED_FORBIDDEN_RANGES` - no ZWJ, no variation selector, no bidi
	// control - and it is NFC-stable, so `boundedSafeText` in
	// `packages/coding-agent/src/core/socket-server/safe-text.ts` emits it VERBATIM and counts
	// it as one. Nine UTF-16 code units, eighteen UTF-8 bytes.
	//
	// A ZWJ family emoji would NOT do here, however tempting: U+200D is in the forbidden table,
	// so the producer replaces it and such a frame could never legitimately reach this schema.
	// Every code point below is written as an escape on purpose: an invisible character pasted
	// into a test is exactly the hazard this suite is about.
	const COMBINING_TILDE_OVERLAY = String.fromCodePoint(0x0334);
	const CLUSTER = `${String.fromCodePoint(0x1f642)}${COMBINING_TILDE_OVERLAY.repeat(7)}`;
	const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
	const graphemes = (value: string) => [...segmenter.segment(value)].length;

	/** The producer's single budget for every attacker-influenced permission string. */
	const PRODUCER_MAX_GRAPHEMES = 512;

	const permissionRequest = (overrides: Record<string, unknown>) => ({
		type: "permission_request",
		requestId: "req-1",
		method: "confirm",
		toolCallId: "call-1",
		toolName: "bash",
		cwd: "/repo",
		title: "Approve tool call?",
		message: "bash wants to run a command",
		truncated: false,
		options: [{ id: "approve", label: "Yes" }],
		requestedAt: "2026-08-21T00:00:00.000Z",
		deadline: null,
		...overrides,
	});

	test("the cluster this suite is built on really is one grapheme and many code units", () => {
		expect(graphemes(CLUSTER)).toBe(1);
		expect(CLUSTER.length).toBe(9);
		expect(CLUSTER.normalize("NFC")).toBe(CLUSTER);
	});

	test("a command of exactly the producer's 512 grapheme clusters encodes and decodes cleanly", () => {
		// The defect this pins: the producer bounds by grapheme clusters and the wire bounded by
		// UTF-16 code units, so a frame the producer considered valid came back `invalid_frame` -
		// and the bridge answers an invalid frame by closing the connection with 1008.
		const command = CLUSTER.repeat(PRODUCER_MAX_GRAPHEMES);
		expect(graphemes(command)).toBe(PRODUCER_MAX_GRAPHEMES);
		expect(command.length).toBeGreaterThan(4000);

		const frame = PermissionRequestFrameSchema.parse(permissionRequest({ command }));
		const result = decodeServerFrame(encodeFrame(frame));
		expect(result.ok).toBe(true);
		if (result.ok && result.frame.type === "permission_request") expect(result.frame.command).toBe(command);
	});

	// Every attacker-influenced field on `permission_request`, with the budget `wire.ts`
	// declares for it. This table is load-bearing: the conformance fingerprint records a bound
	// carried inside a regex check as a bare `regex`, WITHOUT its value, so these assertions are
	// the only thing left that notices a budget being quietly moved.
	const REQUEST_BUDGETS: readonly (readonly [string, number])[] = [
		["toolName", 128],
		["cwd", 1024],
		["title", 200],
		["message", 4000],
		["command", 4000],
		["path", 1024],
		["operation", 128],
	];

	for (const [field, budget] of REQUEST_BUDGETS) {
		test(`permission_request.${field} holds ${budget} grapheme clusters and refuses one more`, () => {
			expect(
				PermissionRequestFrameSchema.safeParse(permissionRequest({ [field]: CLUSTER.repeat(budget) })).success,
			).toBe(true);
			expect(
				PermissionRequestFrameSchema.safeParse(permissionRequest({ [field]: CLUSTER.repeat(budget + 1) })).success,
			).toBe(false);
		});
	}

	test("an option label holds 200 grapheme clusters and refuses one more", () => {
		const withLabel = (label: string) => permissionRequest({ options: [{ id: "approve", label }] });
		expect(PermissionRequestFrameSchema.safeParse(withLabel(CLUSTER.repeat(200))).success).toBe(true);
		expect(PermissionRequestFrameSchema.safeParse(withLabel(CLUSTER.repeat(201))).success).toBe(false);
	});

	test("permission_resolved.surface holds 64 grapheme clusters and refuses one more", () => {
		const resolved = (surface: string) => ({
			type: "permission_resolved",
			requestId: "req-1",
			decision: "approved",
			chosenOptionId: "approve",
			surface,
			clientId: "client-1",
		});
		expect(PermissionResolvedFrameSchema.safeParse(resolved(CLUSTER.repeat(64))).success).toBe(true);
		expect(PermissionResolvedFrameSchema.safeParse(resolved(CLUSTER.repeat(65))).success).toBe(false);
	});

	test("a bound counted in ASCII is the same bound", () => {
		// One grapheme is one code unit is one byte here, so this is the one case where the old
		// code-unit cap and the new cluster bound agree - and it still has to hold.
		expect(PermissionRequestFrameSchema.safeParse(permissionRequest({ command: "x".repeat(4000) })).success).toBe(
			true,
		);
		expect(PermissionRequestFrameSchema.safeParse(permissionRequest({ command: "x".repeat(4001) })).success).toBe(
			false,
		);
	});

	test("the neutralization predicate still refuses a control, bidi or invisible code point", () => {
		// Widening the bound must not widen the alphabet: these are exactly the code points
		// `safe-text.ts` replaces before the wire, so one arriving here means something bypassed it.
		const forbidden = [0x0007, 0x00ad, 0x200d, 0x202e, 0xfe0f, 0xfeff, 0xe0041];
		for (const codePoint of forbidden) {
			const command = `rm -rf${String.fromCodePoint(codePoint)} /`;
			expect(PermissionRequestFrameSchema.safeParse(permissionRequest({ command })).success).toBe(false);
		}
	});

	test("a frame that is small in clusters but huge in bytes is still refused by the frame cap", () => {
		// A grapheme bound does not cap bytes - combining marks per cluster are unbounded - so the
		// per-frame byte cap in `decode` is what keeps a permission frame small on the wire.
		const command = `${String.fromCodePoint(0x1f642)}${COMBINING_TILDE_OVERLAY.repeat(4000)}`.repeat(20);
		expect(graphemes(command)).toBe(20);
		const result = decodeServerFrame(JSON.stringify(permissionRequest({ command })));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("frame_too_large");
	});
});
