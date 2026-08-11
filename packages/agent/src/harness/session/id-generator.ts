import type { IdGenerator } from "./types.ts";

const MAX_UUID_V7_TIMESTAMP = 0xffffffffffff;
const MAX_SEQUENCE = (1n << 41n) - 1n;

export interface Uuidv7IdGeneratorOptions {
	readonly now?: () => number;
	readonly randomBytes?: (bytes: Uint8Array<ArrayBuffer>) => void;
}

/** Session-scoped UUIDv7 generator with exact follower timestamps and monotonic ordinary ids. */
export class Uuidv7IdGenerator implements IdGenerator {
	private readonly now: () => number;
	private readonly randomBytes: (bytes: Uint8Array<ArrayBuffer>) => void;
	private sequence: bigint | undefined;
	private lastOrdinaryTimestamp = -1;

	constructor(options: Uuidv7IdGeneratorOptions = {}) {
		this.now = options.now ?? Date.now;
		this.randomBytes = options.randomBytes ?? ((bytes) => globalThis.crypto.getRandomValues(bytes));
	}

	next(timestampMs?: number): string {
		const requestedTimestamp = timestampMs ?? this.now();
		if (
			!Number.isInteger(requestedTimestamp) ||
			requestedTimestamp < 0 ||
			requestedTimestamp > MAX_UUID_V7_TIMESTAMP
		) {
			throw new RangeError(`UUIDv7 timestamp must be an integer between 0 and ${MAX_UUID_V7_TIMESTAMP}`);
		}

		const effectiveTimestamp =
			timestampMs === undefined ? Math.max(requestedTimestamp, this.lastOrdinaryTimestamp) : timestampMs;
		if (timestampMs === undefined) this.lastOrdinaryTimestamp = effectiveTimestamp;

		const bytes = new Uint8Array(16);
		this.randomBytes(bytes);
		// Seed 40 of 41 counter bits, leaving at least 2^40 ordered values before exhaustion.
		// The remaining 33 UUID random-field bits are refreshed on every call.
		if (this.sequence === undefined) {
			this.sequence =
				(BigInt(bytes[1]) << 32n) |
				(BigInt(bytes[2]) << 24n) |
				(BigInt(bytes[3]) << 16n) |
				(BigInt(bytes[4]) << 8n) |
				BigInt(bytes[5]);
		} else {
			if (this.sequence === MAX_SEQUENCE) throw new RangeError("UUIDv7 generator sequence exhausted");
			this.sequence++;
		}

		const timestamp = BigInt(effectiveTimestamp);
		for (let index = 5; index >= 0; index--) {
			bytes[index] = Number(timestamp >> BigInt((5 - index) * 8)) & 0xff;
		}
		bytes[6] = 0x70 | Number((this.sequence >> 37n) & 0x0fn);
		bytes[7] = Number((this.sequence >> 29n) & 0xffn);
		bytes[8] = 0x80 | Number((this.sequence >> 23n) & 0x3fn);
		bytes[9] = Number((this.sequence >> 15n) & 0xffn);
		bytes[10] = Number((this.sequence >> 7n) & 0xffn);
		bytes[11] = Number((this.sequence & 0x7fn) << 1n) | (bytes[11] & 0x01);

		const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
		return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
	}
}
