// Values shared across all compiled schemas while one still uses them: leaf checks and regular expressions.
// Both caches hold their values weakly and drop an entry once its value is collected, so they keep nothing alive.

import type { Check } from "./types.ts";

/** The check shared under `key`, made by `make` when no live schema holds one. */
export function sharedCheck(key: string, make: () => Check): Check {
	const hit = checks.get(key)?.deref();
	if (hit !== undefined) return hit;
	const check = make();
	checks.set(key, new WeakRef(check));
	checkCleanup.register(check, key);
	return check;
}

const checks = new Map<string, WeakRef<Check>>();

const checkCleanup = new FinalizationRegistry<string>((key) => {
	if (checks.get(key)?.deref() === undefined) checks.delete(key);
});

/**
 * The regular expression of a `pattern` source, shared by source. Patterns are ECMAScript regular expressions with
 * the `u` flag; a source that is invalid with it (some older schemas escape characters `u` rejects) compiles
 * without it.
 */
export function sharedRegex(source: string): RegExp {
	const hit = regexes.get(source)?.deref();
	if (hit !== undefined) return hit;
	let re: RegExp;
	try {
		re = new RegExp(source, "u");
	} catch {
		re = new RegExp(source);
	}
	regexes.set(source, new WeakRef(re));
	regexCleanup.register(re, source);
	return re;
}

const regexes = new Map<string, WeakRef<RegExp>>();

const regexCleanup = new FinalizationRegistry<string>((source) => {
	if (regexes.get(source)?.deref() === undefined) regexes.delete(source);
});

/** The number of entries in both caches (for tests). */
export function sharedEntries(): { checks: number; regexes: number } {
	return { checks: checks.size, regexes: regexes.size };
}
