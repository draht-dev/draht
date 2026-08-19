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
		expect([...SERVER_FRAME_TYPES].sort()).toEqual(
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
		expect([...CLIENT_FRAME_TYPES].sort()).toEqual(["attach", "detach", "hello", "input"].sort());
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
