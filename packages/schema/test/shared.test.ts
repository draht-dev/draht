// The caches shared across compiled schemas hold nothing alive: entries go once their schemas are collected.

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { sharedEntries } from "../src/shared.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

async function collectGarbage(): Promise<void> {
	for (let round = 0; round < 6; round++) {
		await new Promise((resolve) => setImmediate(resolve));
		gc();
	}
}

describe("shared leaf checks", () => {
	it("share one check between equal leaf schemas", () => {
		const a = compile({ type: "integer", minimum: 3, description: "a" });
		const b = compile({ type: "integer", minimum: 3, description: "b" });
		expect(a.check).toBe(b.check);
		expect(compile({ type: "integer", minimum: 4 }).check).not.toBe(a.check);
	});

	it("are collected with the last schema that uses them, and their cache entries removed", async () => {
		await collectGarbage();
		const before = sharedEntries();
		let validators: unknown[] | undefined = Array.from({ length: 50 }, (_, i) =>
			compile({ type: "string", minLength: 1000 + i, pattern: `^unique-${i}$` }),
		);
		const check = new WeakRef((validators[0] as { check: object }).check);
		expect(sharedEntries().checks).toBe(before.checks + 50);
		expect(sharedEntries().regexes).toBe(before.regexes + 50);
		validators = undefined;
		await collectGarbage();
		expect(check.deref()).toBeUndefined();
		expect(sharedEntries()).toEqual(before);
	});
});
