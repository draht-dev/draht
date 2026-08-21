import { describe, expect, test } from "bun:test";
import {
	AuthenticateFrameSchema,
	CLIENT_FRAME_TYPES,
	ClientFrameSchema,
	DeviceCredentialFrameSchema,
	decodeClientFrame,
	decodeServerFrame,
	GEIST_PROTOCOL_VERSION,
	PairDeviceFrameSchema,
	SERVER_FRAME_TYPES,
	ServerFrameSchema,
} from "../src/wire.js";

const pairFrame = {
	type: "pair_device",
	bootstrapToken: "bootstrap-abc123",
	device: { name: "oskar-iphone", platform: "ios" },
};

const authenticateFrame = {
	type: "authenticate",
	deviceId: "device-oskar-iphone",
	credential: "rotated-credential-1",
};

const deviceCredentialFrame = {
	type: "device_credential",
	deviceId: "device-oskar-iphone",
	credential: "rotated-credential-2",
	issuedAt: "1970-01-01T00:00:00.000Z",
	expiresAt: "1970-01-31T00:00:00.000Z",
};

describe("bootstrap exchange frames (R33-REACH.5)", () => {
	test("decodeClientFrame accepts {type:'pair', bootstrapToken, device:{name, platform}} and refuses an empty bootstrapToken", () => {
		const accepted = decodeClientFrame(JSON.stringify(pairFrame));
		expect(accepted.ok).toBe(true);
		if (accepted.ok) expect(accepted.frame).toEqual(pairFrame);

		const refused = decodeClientFrame(JSON.stringify({ ...pairFrame, bootstrapToken: "" }));
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.code).toBe("invalid_frame");

		// A pair without a device is not a pair: the credential is bound to a device.
		expect(decodeClientFrame(JSON.stringify({ type: "pair_device", bootstrapToken: "t" })).ok).toBe(false);
		expect(PairDeviceFrameSchema.safeParse({ ...pairFrame, device: { name: "", platform: "ios" } }).success).toBe(
			false,
		);
	});

	test("CLIENT_FRAME_TYPES declares pair and authenticate, SERVER_FRAME_TYPES declares device_credential", () => {
		expect(CLIENT_FRAME_TYPES).toContain("pair_device");
		expect(CLIENT_FRAME_TYPES).toContain("authenticate");
		expect(SERVER_FRAME_TYPES).toContain("device_credential");

		// The unions are the source of the type lists — a schema added to one and
		// not the other would pass the assertions above and still never decode.
		expect(ClientFrameSchema.options.map((option) => option.shape.type.value)).toEqual([...CLIENT_FRAME_TYPES]);
		expect(ServerFrameSchema.options.map((option) => option.shape.type.value)).toEqual([...SERVER_FRAME_TYPES]);

		// Two directions that share no type name, still.
		for (const type of CLIENT_FRAME_TYPES) expect(SERVER_FRAME_TYPES).not.toContain(type as never);
	});

	test("authenticate carries a device id and a credential, both non-empty", () => {
		const decoded = decodeClientFrame(JSON.stringify(authenticateFrame));
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(decoded.frame).toEqual(authenticateFrame);

		expect(AuthenticateFrameSchema.safeParse({ ...authenticateFrame, credential: "" }).success).toBe(false);
		expect(AuthenticateFrameSchema.safeParse({ ...authenticateFrame, deviceId: "" }).success).toBe(false);
		expect(AuthenticateFrameSchema.safeParse({ type: "authenticate", deviceId: "device-x" }).success).toBe(false);
	});

	test("device_credential answers both, carrying the rotated value and its lifetime", () => {
		const decoded = decodeServerFrame(JSON.stringify(deviceCredentialFrame));
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(decoded.frame).toEqual(deviceCredentialFrame);

		for (const field of ["deviceId", "credential", "issuedAt", "expiresAt"] as const) {
			const { [field]: _dropped, ...without } = deviceCredentialFrame;
			expect(DeviceCredentialFrameSchema.safeParse(without).success).toBe(false);
		}
	});

	test("a device_credential is server→client only and a pair is client→server only", () => {
		expect(decodeServerFrame(JSON.stringify(pairFrame)).ok).toBe(false);
		expect(decodeClientFrame(JSON.stringify(deviceCredentialFrame)).ok).toBe(false);
		expect(decodeServerFrame(JSON.stringify(authenticateFrame)).ok).toBe(false);
	});

	test("undeclared fields do not ride along inside a valid pair or authenticate", () => {
		const smuggled = decodeClientFrame(JSON.stringify({ ...pairFrame, credential: "stolen", command: ["/bin/sh"] }));
		expect(smuggled.ok).toBe(true);
		if (smuggled.ok) expect(smuggled.frame).toEqual(pairFrame);
	});

	test("the published 0.x member is 0.3 — the permission relay frames moved it again", () => {
		expect(GEIST_PROTOCOL_VERSION).toBe("0.3");
	});
});
