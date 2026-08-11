import { describe, expect, it } from "vitest";
import { Uuidv7IdGenerator } from "../../src/harness/session/index.ts";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_UUID_V7_TIMESTAMP = 0xffffffffffff;
const INVALID_TIMESTAMP_MESSAGE = `UUIDv7 timestamp must be an integer between 0 and ${MAX_UUID_V7_TIMESTAMP}`;

function decodeTimestamp(uuid: string): number {
	return Number.parseInt(uuid.replaceAll("-", "").slice(0, 12), 16);
}

describe("Uuidv7IdGenerator", () => {
	it("mints an RFC 9562 UUIDv7 with the required version and variant", () => {
		const generator = new Uuidv7IdGenerator({
			now: () => 0,
			randomBytes: (bytes) => bytes.fill(0),
		});

		expect(generator.next()).toMatch(UUID_V7_PATTERN);
	});

	it("encodes the current Unix millisecond in the first 48 bits", () => {
		const timestamp = 0x0123456789ab;
		const generator = new Uuidv7IdGenerator({
			now: () => timestamp,
			randomBytes: (bytes) => bytes.fill(0),
		});

		expect(decodeTimestamp(generator.next())).toBe(timestamp);
	});

	it("mints distinct follower tails under the leader's exact timestamp prefix", () => {
		const generator = new Uuidv7IdGenerator({
			now: () => 1_700_000_000_000,
			randomBytes: (bytes) => bytes.fill(0),
		});
		const leader = generator.next();
		const leaderTimestamp = decodeTimestamp(leader);
		const followers = [generator.next(leaderTimestamp), generator.next(leaderTimestamp)];

		expect(followers.map(decodeTimestamp)).toEqual([leaderTimestamp, leaderTimestamp]);
		expect(new Set([leader, ...followers])).toHaveLength(3);
	});

	it("does not advance a follower timestamp when ordinary generation has moved ahead", () => {
		const clockValues = [1_000, 1_001];
		const generator = new Uuidv7IdGenerator({
			now: () => clockValues.shift() ?? 0,
			randomBytes: (bytes) => bytes.fill(0),
		});
		const leaderTimestamp = decodeTimestamp(generator.next());
		generator.next();

		expect(decodeTimestamp(generator.next(leaderTimestamp))).toBe(leaderTimestamp);
	});

	it("keeps ordinary same-millisecond ids unique and lexically increasing", () => {
		const generator = new Uuidv7IdGenerator({
			now: () => 1_700_000_000_000,
			randomBytes: (bytes) => bytes.fill(0),
		});
		const ids = [generator.next(), generator.next(), generator.next()];

		expect(new Set(ids)).toHaveLength(ids.length);
		expect(ids).toEqual([...ids].sort());
	});

	it("preserves ordinary ordering when the clock rolls back", () => {
		const clockValues = [1_001, 1_000, 999, 1_002];
		const generator = new Uuidv7IdGenerator({
			now: () => clockValues.shift() ?? 0,
			randomBytes: (bytes) => bytes.fill(0),
		});
		const ids = [generator.next(), generator.next(), generator.next(), generator.next()];

		expect(ids.map(decodeTimestamp)).toEqual([1_001, 1_001, 1_001, 1_002]);
		expect(ids).toEqual([...ids].sort());
	});

	it("uses fresh injected randomness for each UUID tail", () => {
		let randomByte = 0;
		const generator = new Uuidv7IdGenerator({
			now: () => 1_700_000_000_000,
			randomBytes: (bytes) => bytes.fill(++randomByte),
		});

		expect([generator.next().slice(-8), generator.next().slice(-8)]).toEqual(["01010101", "02020202"]);
	});

	it.each([0, MAX_UUID_V7_TIMESTAMP])("accepts the UUIDv7 timestamp boundary %s", (timestamp) => {
		const explicitGenerator = new Uuidv7IdGenerator({ randomBytes: (bytes) => bytes.fill(0) });
		const clockGenerator = new Uuidv7IdGenerator({
			now: () => timestamp,
			randomBytes: (bytes) => bytes.fill(0),
		});

		expect(decodeTimestamp(explicitGenerator.next(timestamp))).toBe(timestamp);
		expect(decodeTimestamp(clockGenerator.next())).toBe(timestamp);
	});

	it.each([-1, MAX_UUID_V7_TIMESTAMP + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects the impossible UUIDv7 timestamp %s before consuming randomness",
		(timestamp) => {
			let randomCalls = 0;
			const generator = new Uuidv7IdGenerator({
				now: () => timestamp,
				randomBytes: () => randomCalls++,
			});

			expect(() => generator.next()).toThrowError(new RangeError(INVALID_TIMESTAMP_MESSAGE));
			expect(() => generator.next(timestamp)).toThrowError(new RangeError(INVALID_TIMESTAMP_MESSAGE));
			expect(randomCalls).toBe(0);
		},
	);
});
