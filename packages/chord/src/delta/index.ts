import type { JsonValue } from "../types.ts";

export type { JsonValue } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// chord/delta — intent-recording change tracking over plain JSON.
//
// Depends on nothing else in the harness. Session storage, the runtime and the
// facet host consume it; keep the arrows pointing that way.
// ─────────────────────────────────────────────────────────────────────────────

export type Seg = string | number;
export type Path = readonly Seg[];
export type NonEmptyPath = readonly [Seg, ...Seg[]];

/** A path inline, or an id assigned by the encoder on second use. */
export type PathRef<P extends Path = Path> = P | number;

/**
 * Tuples are the form — in memory, on the wire, on disk.
 *
 * `r` is the ONLY op that replaces a whole value. `s`/`d`/`a`/`t` cannot target
 * the root: the type forbids it. `p` may, and only because a tracked value can
 * itself be an array — but a `p` that replaces its entire target is normalised to
 * `r`/`s` at record time, so a root `p` is always a partial modification.
 *
 * `Op` knows nothing about the path dictionary. Interning, id references and
 * omitted paths live in `WireOp` and exist only between `encode` and `decode`.
 */
export type Op =
	| readonly ["r", JsonValue]
	| readonly ["s", NonEmptyPath, JsonValue]
	| readonly ["d", NonEmptyPath]
	| readonly ["a", NonEmptyPath, string]
	| readonly ["t", NonEmptyPath, number]
	| readonly ["p", Path, number, number, JsonValue[]];

/**
 * What crosses a boundary. Adds two compressions and nothing else:
 *
 *   ["#", id, path]    defines an id, emitted on a path's SECOND use
 *   a numeric PathRef  references a previously defined id
 *   a shortened tuple  reuses the previous op's path; arity disambiguates
 *
 * ["r", value] carries no path, so it encodes to itself — which is why isBase
 * works unchanged on either vocabulary.
 */
export type WireOp =
	| readonly ["r", JsonValue]
	| readonly ["s", PathRef<NonEmptyPath>, JsonValue]
	| readonly ["s", JsonValue]
	| readonly ["d", PathRef<NonEmptyPath>]
	| readonly ["d"]
	| readonly ["a", PathRef<NonEmptyPath>, string]
	| readonly ["a", string]
	| readonly ["t", PathRef<NonEmptyPath>, number]
	| readonly ["t", number]
	| readonly ["p", PathRef, number, number, JsonValue[]]
	| readonly ["p", number, number, JsonValue[]]
	| readonly ["#", number, Path];

// ─── Classification ──────────────────────────────────────────────────────────

export const isReplace = (op: Op | WireOp): boolean => op[0] === "r";

/**
 * A batch begins with a replacement. Flush guarantees `r` is at index 0 or absent,
 * so this is exact rather than a heuristic.
 */
export const isBase = (ops: readonly (Op | WireOp)[]): boolean => ops.length > 0 && ops[0]![0] === "r";

// ─── Overlap ─────────────────────────────────────────────────────────────────

/**
 * Longest suffix of `a` that is a prefix of `b`. Probes with indexOf and verifies
 * exact substring equality, so the hot loops are native. A hand-written KMP is
 * asymptotically equivalent and much slower in practice.
 *
 * Always correct: the returned n satisfies a.slice(a.length - n) === b.slice(0, n).
 */
export function overlap(a: string, b: string, scan: number, probe = 64, maxCandidates = 8): number {
	if (a.length === 0 || b.length === 0 || scan === 0) return 0;
	const tail = a.length > scan ? a.slice(a.length - scan) : a;

	// A probe of length h can only find overlaps of at least h — the head must
	// actually occur in `a`. So try a long head first (few candidates, and it
	// catches the large overlaps a rolling window produces), then fall back to one
	// character, which finds any overlap at the cost of more candidates.
	//
	// Candidates are bounded because repetitive output — a build log, or any run of
	// one character — makes a long head match at thousands of positions. Giving up
	// returns 0, which emits a set: larger, never wrong.
	for (const h of [Math.min(probe, b.length), 1]) {
		const head = b.slice(0, h);
		let tried = 0;
		for (let k = tail.indexOf(head); k !== -1; k = tail.indexOf(head, k + 1)) {
			if (++tried > maxCandidates) break;
			const n = tail.length - k;
			if (n <= b.length && tail.slice(k) === b.slice(0, n)) return n;
		}
		if (h === 1) break;
	}
	return 0;
}

// ─── Tracker ─────────────────────────────────────────────────────────────────

export interface TrackerOptions {
	maxOverlapScan?: number;
	coalesce?: boolean;
}

export interface Tracker<T extends object> {
	/**
	 * Mutate this. Plain TS: assignment, push, splice, delete, all of it.
	 *
	 * Assigning to it replaces the whole value: emits `["r", next]` and discards
	 * ops recorded before it, which describe a value that no longer exists.
	 *
	 * `tracker.state = tracker.target` is therefore a checkpoint — it forces a base
	 * batch without changing anything. Discarding the pending ops is correct
	 * because the proxy mutates the target directly, so the value already carries
	 * them.
	 */
	state: T;
	/** The untracked backing object. Reads only — writing here emits nothing. */
	readonly target: T;
	flush(): Op[];
	/**
	 * Clear pending ops and make the next flush a base batch, without changing
	 * the value.
	 *
	 * Recovery replays from the last base batch, so a producer that wants "at most
	 * N batches to replay" calls this every N. The pending ops are already
	 * reflected in the value — the proxy mutates the target directly — so
	 * discarding them loses nothing.
	 */
	rebase(): void;
	/** Discard without emitting. */
	discard(): void;
	readonly dirty: boolean;
}

const isObj = (v: unknown): v is object => v !== null && typeof v === "object";
const cloneJson = <T extends JsonValue>(value: T): T => {
	if (!isObj(value)) return value;
	if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
	const result = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype) as Record<
		string,
		JsonValue
	>;
	for (const [key, child] of Object.entries(value)) {
		Object.defineProperty(result, key, {
			value: cloneJson(child),
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return result as T;
};
const INDEX = /^(?:0|[1-9]\d*)$/;
const norm = (t: object, k: string | symbol): Seg | symbol =>
	typeof k === "symbol" ? k : Array.isArray(t) && INDEX.test(k) ? Number(k) : k;
const toIntegerOrInfinity = (value: unknown): number => {
	const number = Number(value);
	if (Number.isNaN(number) || number === 0) return 0;
	return Number.isFinite(number) ? Math.trunc(number) : number;
};
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
const TRACKED_PROXIES = new WeakSet<object>();

export function track<T extends object>(root: T, options: TrackerOptions = {}): Tracker<T> {
	validateJsonValue(root);
	const scan = options.maxOverlapScan ?? 65_536;
	const doCoalesce = options.coalesce ?? true;

	let ops: Op[] = [];

	const emit = (op: Op) => {
		ops.push(op);
	};

	/**
	 * Reject reserved keys at record time, not just on apply.
	 *
	 * `JSON.parse('{"__proto__":{}}')` yields an OWN property, so a producer can
	 * hold state containing one without doing anything unusual. The tracker would
	 * then emit a path the applier refuses — state that cannot be replicated. Fail
	 * where the mistake is, at the write.
	 */
	const guard = (seg: Seg | symbol): Seg => {
		if (typeof seg === "symbol") throw new UnsafePathError(String(seg));
		if (typeof seg === "string" && RESERVED_SEGMENTS.has(seg)) throw new UnsafePathError(seg);
		return seg;
	};

	/**
	 * A splice covering the whole target is a replacement written the long way.
	 * Only the interception knows the pre-splice length, so this is a record-time
	 * rewrite, not something flush can recover.
	 */
	const spliceOrReplace = (path: Path, before: number, index: number, remove: number, items: JsonValue[]) => {
		if (index === 0 && remove === before) {
			if (path.length === 0) emit(["r", items]);
			else emit(["s", path as NonEmptyPath, items]);
			return;
		}
		emit(["p", [...path], index, remove, items]);
	};

	const assertNoTrackedProxy = (value: unknown, seen = new Set<object>()): void => {
		if (!isObj(value) || seen.has(value)) return;
		if (TRACKED_PROXIES.has(value)) throw new TypeError("tracked proxies cannot be assigned as values");
		seen.add(value);
		for (const child of Array.isArray(value) ? value : Object.values(value)) assertNoTrackedProxy(child, seen);
	};

	const wrap = <V extends object>(obj: V, path: Path): V => {
		const childProxies = new Map<string | symbol, { target: object; proxy: object }>();
		const proxy = new Proxy(obj, {
			get(t, k, r) {
				if (Array.isArray(t) && typeof k === "string" && MUTATORS.has(k)) {
					return (...args: unknown[]) => {
						const before = t.length;
						const cloneItems = (values: readonly unknown[]): JsonValue[] => {
							for (const value of values) {
								assertNoTrackedProxy(value);
								assertJsonValue(value);
							}
							return values.map((value) => cloneJson(value as JsonValue));
						};
						let result: unknown;
						switch (k) {
							case "push": {
								const items = cloneItems(args);
								result = Reflect.apply(Array.prototype.push, t, items);
								spliceOrReplace(path, before, before, 0, cloneJson(items));
								break;
							}
							case "unshift": {
								const items = cloneItems(args);
								result = Reflect.apply(Array.prototype.unshift, t, items);
								spliceOrReplace(path, before, 0, 0, cloneJson(items));
								break;
							}
							case "pop":
								result = Reflect.apply(Array.prototype.pop, t, args);
								if (before > 0) spliceOrReplace(path, before, before - 1, 1, []);
								break;
							case "shift":
								result = Reflect.apply(Array.prototype.shift, t, args);
								if (before > 0) spliceOrReplace(path, before, 0, 1, []);
								break;
							case "splice": {
								const items = cloneItems(args.slice(2));
								const rawStart = args.length === 0 ? 0 : toIntegerOrInfinity(args[0]);
								const index = rawStart < 0 ? Math.max(0, before + rawStart) : Math.min(rawStart, before);
								const remove =
									args.length === 0
										? 0
										: args.length === 1
											? before - index
											: Math.max(0, Math.min(toIntegerOrInfinity(args[1]), before - index));
								result = Reflect.apply(Array.prototype.splice, t, [index, remove, ...items]);
								spliceOrReplace(path, before, index, remove, cloneJson(items));
								break;
							}
							// sort/reverse/fill/copyWithin permute wholesale; intent is not a splice.
							default: {
								let methodArgs = args;
								let fillValue: JsonValue | undefined;
								if (k === "fill") {
									assertNoTrackedProxy(args[0]);
									assertJsonValue(args[0]);
									fillValue = cloneJson(args[0]);
									methodArgs = [fillValue, ...args.slice(1)];
								}
								result = Reflect.apply(Array.prototype[k as "sort"], t, methodArgs);
								if (isObj(fillValue)) {
									for (let index = 0; index < t.length; index++) {
										if (t[index] === fillValue) t[index] = cloneJson(fillValue as JsonValue);
									}
								} else if (k === "copyWithin") {
									for (let index = 0; index < t.length; index++) {
										if (isObj(t[index])) t[index] = cloneJson(t[index] as JsonValue);
									}
								}
								assertJsonValue(t);
								if (path.length === 0) emit(["r", cloneJson(t as JsonValue)]);
								else emit(["s", path as NonEmptyPath, cloneJson(t as JsonValue)]);
							}
						}
						if (k === "pop") childProxies.delete(String(before - 1));
						else if (k !== "push") childProxies.clear();
						return k === "sort" || k === "reverse" || k === "fill" || k === "copyWithin" ? proxy : result;
					};
				}
				const value = Reflect.get(t, k, r);
				if (!isObj(value)) return value;
				const cached = childProxies.get(k);
				if (cached?.target === value) return cached.proxy;
				const child = wrap(value, [...path, guard(norm(t, k))]);
				childProxies.set(k, { target: value, proxy: child });
				return child;
			},

			set(t, k, v, r) {
				// `length` is a real mutation but not a document location.
				if (Array.isArray(t) && k === "length") {
					const before = t.length;
					const next = Number(v);
					if (!Number.isSafeInteger(next) || next < 0 || next > 4_294_967_295) return Reflect.set(t, k, v, r);
					if (next < before) {
						Reflect.set(t, k, next, r);
						childProxies.clear();
						spliceOrReplace(path, before, next, before - next, []);
					} else if (next > before) {
						const items = Array<JsonValue>(next - before).fill(null);
						t.length = next;
						t.fill(null, before);
						emit(["p", [...path], before, 0, items]);
					}
					return true;
				}

				const segment = guard(norm(t, k));
				if (Array.isArray(t)) {
					if (typeof segment !== "number") throw new UnsafePathError(segment);
					if (segment > t.length) throw new UnsafePathError(segment);
				}
				const at = [...path, segment] as unknown as NonEmptyPath;

				if (v === undefined) {
					// JSON has no undefined, and deleting an array element would create a hole.
					if (Array.isArray(t)) throw new TypeError("undefined would create a sparse array; use splice instead");
					emit(["d", at]);
					childProxies.delete(k);
					return Reflect.deleteProperty(t, k);
				}

				const prev = (t as Record<string | symbol, unknown>)[k];
				if (typeof prev === "string" && typeof v === "string") {
					if (prev === v) return true;
					if (v.length > prev.length && v.startsWith(prev)) {
						emit(["a", at, v.slice(prev.length)]); // fast path, no probe
					} else {
						const ov = overlap(prev, v, scan);
						if (ov === 0) emit(["s", at, v]);
						else {
							emit(["t", at, prev.length - ov]);
							if (v.length > ov) emit(["a", at, v.slice(ov)]);
						}
					}
				} else {
					assertNoTrackedProxy(v);
					assertJsonValue(v);
					const stored = cloneJson(v);
					emit(["s", at, cloneJson(stored)]);
					childProxies.delete(k);
					return Reflect.set(t, k, stored, r);
				}
				childProxies.delete(k);
				return Reflect.set(t, k, v, r);
			},

			deleteProperty(t, k) {
				const segment = guard(norm(t, k));
				if (Array.isArray(t)) {
					if (typeof segment !== "number") throw new UnsafePathError(segment);
					throw new TypeError("delete would create a sparse array; use splice instead");
				}
				emit(["d", [...path, segment] as unknown as NonEmptyPath]);
				childProxies.delete(k);
				return Reflect.deleteProperty(t, k);
			},
		});

		TRACKED_PROXIES.add(proxy);
		return proxy as V;
	};

	let state = wrap(root, []);
	// The first flush is always a base batch. A consumer starts with nothing, so
	// a stream that opens with deltas has nothing to apply them to — and that
	// fails at runtime, in the consumer, rather than where the mistake is.
	let forceBase = true;

	return {
		get state() {
			return state;
		},
		// A setter, so the obvious thing works. Without it `tracker.state = next`
		// silently swaps the proxy for a plain object and stops tracking.
		set state(next: T) {
			if (next === state) {
				ops = [];
				forceBase = true;
				return;
			}
			if (TRACKED_PROXIES.has(next)) throw new TypeError("tracker state cannot be replaced with a tracked proxy");
			validateJsonValue(next);
			ops = [];
			root = next;
			state = wrap(root, []);
			forceBase = true;
		},
		get target() {
			return root;
		},

		// Same effect as assigning the current value back, minus the re-wrap: the
		// value has not changed, so the proxy cache is still valid.
		rebase() {
			ops = [];
			forceBase = true;
		},

		get dirty() {
			return forceBase || ops.length > 0;
		},
		discard() {
			ops = [];
		},
		flush() {
			if (forceBase) {
				forceBase = false;
				ops = [];
				return [["r", cloneJson(root as unknown as JsonValue)]];
			}
			if (ops.length === 0) return [];
			let out = ops;
			ops = [];

			// Everything before a replacement is dead.
			let lastReplace = -1;
			for (let index = out.length - 1; index >= 0; index--) {
				if (!isReplace(out[index]!)) continue;
				lastReplace = index;
				break;
			}
			if (lastReplace > 0) out = out.slice(lastReplace);

			out = dropDead(out);
			return doCoalesce ? coalesce(out) : out;
		},
	};
}

const samePath = (a: Op, b: Op): boolean => {
	const left = pathOf(a);
	const right = pathOf(b);
	if (left === undefined || right === undefined || left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
};

function pathOf(op: Op): Path | undefined {
	return op[0] === "r" ? undefined : op[1];
}

/**
 * Drop ops that a later op makes unreachable.
 *
 * Ops apply in order, so an op is dead if a later one overwrites the whole
 * subtree it lives in. Only `s`, `d` and `r` do that — `a`, `t` and `p` modify
 * what is already there, so they never dominate.
 *
 * O(n * d): walk backwards keeping a map of overwritten paths, and for each op
 * test its own prefixes against that map. `d` is the path depth, which is small
 * and bounded. The obvious formulation — compare each op against every
 * dominator — is O(n^2 * d) and degrades on exactly the wide-flush input this
 * pass exists to clean up. Measured: 12-14 microseconds per op, flat from 100 to
 * 5000 ops, and 10001 redundant writes collapse to 2 emitted ops.
 *
 * OBJECT KEY ORDER IS NOT PRESERVED. A producer that does
 * `set c; set a; delete c; set c` leaves `c` last, because deleting and
 * reinserting moves it. The replica receives only the surviving `set c`, applies
 * it to a base where `c` never existed, and `c` lands first. Values are
 * identical — verified over 1823 randomised sequences with zero value
 * mismatches — but the serialised forms can differ.
 *
 * This is fine because nothing compares a replica against its producer: the
 * consumer holds the state and nobody diffs it back. The one visible case is a
 * consumer that iterates keys for display, where two views could order rows
 * differently. It requires a delete-and-recreate of the same key within one
 * flush. Do not hash or content-address a replicated value.
 */
function dropDead(ops: Op[]): Op[] {
	type Overwrite = { kind: "s" | "d"; path: Path };
	const overwritten = new Map<string, Overwrite>();
	const kept: Op[] = [];
	const rootKey = JSON.stringify([]);

	for (let i = ops.length - 1; i >= 0; i--) {
		const op = ops[i]!;
		if (op[0] === "r") {
			kept.push(op);
			overwritten.clear();
			overwritten.set(rootKey, { kind: "s", path: [] });
			continue;
		}

		const path = opPath(op);
		if (path === undefined) {
			kept.push(op);
			continue;
		}

		let dead = overwritten.has(rootKey);
		for (let length = 1; length <= path.length && !dead; length++) {
			const overwrite = overwritten.get(JSON.stringify(path.slice(0, length)));
			if (overwrite === undefined) continue;
			// A `d` at exactly a later `s`'s path is NOT dead. Dropping it leaves the
			// key in its original slot, while the producer's delete-then-set moved it
			// to the end: same value, different serialisation.
			if (length === path.length && op[0] === "d" && overwrite.kind === "s") break;
			dead = true;
		}
		if (dead) continue;

		kept.push(op);
		if (op[0] === "p") {
			// A splice can reindex every descendant, so path equality below it cannot
			// prove that a later overwrite dominates an earlier operation.
			for (const [key, overwrite] of overwritten) {
				if (
					overwrite.path.length > path.length &&
					path.every((segment, index) => overwrite.path[index] === segment)
				) {
					overwritten.delete(key);
				}
			}
		} else if (op[0] === "s" || op[0] === "d") {
			overwritten.set(JSON.stringify(path), { kind: op[0], path });
		}
	}
	return kept.reverse();
}

/** Total, because `Op` paths are always inline. */
function opPath(op: Op): Path | undefined {
	return op[0] === "r" ? undefined : op[1];
}

/** Merge adjacent ops describing the same path. Lossless. */
function coalesce(ops: Op[]): Op[] {
	const out: Op[] = [];
	for (const op of ops) {
		const last = out[out.length - 1];
		if (last !== undefined && samePath(last, op)) {
			if (last[0] === "a" && op[0] === "a") {
				out[out.length - 1] = ["a", last[1], `${last[2]}${op[2]}`];
				continue;
			}
			if (last[0] === "s" && op[0] === "s") {
				// later write wins
				out[out.length - 1] = op;
				continue;
			}
			if (last[0] === "s" && op[0] === "a" && typeof last[2] === "string") {
				out[out.length - 1] = ["s", last[1], `${last[2]}${op[2]}`];
				continue;
			}
		}
		out.push(op);
	}
	return out;
}

// ─── Path safety ─────────────────────────────────────────────────────────────

/**
 * Segments that reach the prototype chain.
 *
 * `JSON.parse` is safe on its own — it makes `__proto__` an own property. What is
 * not safe is `parent[key] = value`, which is exactly what an applier does, and
 * paths are data: `["s", ["__proto__", "isAdmin"], true]` pollutes
 * `Object.prototype` for the whole process.
 *
 * Ops arrive from a facet, a plugin compartment, or a tool whose details may echo
 * model output, so none of it is trusted input.
 */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export class UnsafePathError extends Error {
	// Not a parameter property: Node's --experimental-strip-types rejects those,
	// and these files are meant to run under it directly.
	readonly segment: Seg;
	constructor(segment: Seg) {
		super(`unsafe path segment: ${String(segment)}`);
		this.segment = segment;
		this.name = "UnsafePathError";
	}
}

/**
 * Rejects anything JSON.stringify would not round-trip and object aliases that
 * would lose identity when serialized. Tracked state is a JSON tree, not an
 * arbitrary object graph.
 */
export function assertJsonValue(value: unknown): asserts value is JsonValue {
	const visit = (candidate: unknown, seen: Set<unknown>): void => {
		if (candidate === null) return;
		const type = typeof candidate;
		if (type === "string" || type === "boolean") return;
		if (type === "number") {
			if (!Number.isFinite(candidate as number)) throw new TypeError("non-finite number is not JSON");
			return;
		}
		if (type !== "object") throw new TypeError(`${type} is not a JsonValue`);
		if (seen.has(candidate)) throw new TypeError("shared or cyclic object is not JSON state");
		seen.add(candidate);
		if (Array.isArray(candidate)) {
			for (const item of candidate) visit(item, seen);
		} else {
			const prototype = Object.getPrototypeOf(candidate);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new TypeError("non-plain object is not a JsonValue");
			}
			if (Object.getOwnPropertySymbols(candidate).length > 0) {
				throw new TypeError("symbol keys are not JSON");
			}
			for (const item of Object.values(candidate as object)) visit(item, seen);
		}
	};
	visit(value, new Set());
}

function validateJsonValue(value: unknown): void {
	assertJsonValue(value);
}

/**
 * Verb, arity and payload shape for a **decoded** op: paths inline, no `#`, no
 * short forms. `apply` uses this.
 *
 * Validating `Op` against the wire grammar would be laxer than the type: a
 * two-element `["s", value]` would pass, and `apply` would then read the value as
 * a path. Each vocabulary gets the validator that matches it.
 */
export function assertValidOp(op: unknown): asserts op is Op {
	if (!Array.isArray(op) || op.length === 0) throw new TypeError("op is not a tuple");
	switch (op[0]) {
		case "r":
			if (op.length !== 2) throw new TypeError("r arity");
			assertJsonValue(op[1]);
			return;
		case "s":
			if (op.length !== 3) throw new TypeError("s arity");
			assertPathArg(op[1], true);
			assertJsonValue(op[2]);
			return;
		case "d":
			if (op.length !== 2) throw new TypeError("d arity");
			assertPathArg(op[1], true);
			return;
		case "a":
			if (op.length !== 3 || typeof op[2] !== "string") throw new TypeError("a shape");
			assertPathArg(op[1], true);
			return;
		case "t":
			if (op.length !== 3 || !Number.isInteger(op[2]) || op[2] < 0) throw new TypeError("t shape");
			assertPathArg(op[1], true);
			return;
		case "p": {
			if (op.length !== 5) throw new TypeError("p arity");
			assertPathArg(op[1]);
			if (!Number.isInteger(op[2]) || op[2] < 0) throw new TypeError("p index");
			if (!Number.isInteger(op[3]) || op[3] < 0) throw new TypeError("p remove");
			if (!Array.isArray(op[4])) throw new TypeError("p items");
			for (const v of op[4]) assertJsonValue(v);
			return;
		}
		// Silently skipping an unknown verb is how a newer producer's op vanishes.
		default:
			throw new TypeError(`unknown op verb: ${String(op[0])}`);
	}
}

function assertPathArg(p: unknown, nonEmpty = false): void {
	if (!Array.isArray(p)) throw new TypeError("path is not an array");
	if (nonEmpty && p.length === 0) throw new TypeError("path is empty");
	assertSafePath(p as Path);
}

/** The same, for the wire grammar: ids and short forms are legal here. */
export function assertValidWireOp(op: unknown): asserts op is WireOp {
	if (!Array.isArray(op) || op.length === 0) throw new TypeError("op is not a tuple");
	const [verb] = op as unknown[];
	const okRef = (r: unknown): void => {
		if (typeof r === "number") {
			if (!Number.isInteger(r) || r < 0) throw new TypeError("bad path id");
			return;
		}
		// A string is not a path. Unchecked, `"a".slice(0, -1)` is `""`, so it
		// resolves to the ROOT and writes there — a path that is not a path, accepted.
		if (!Array.isArray(r)) throw new TypeError("path is not an array");
		assertSafePath(r as Path);
	};
	switch (verb) {
		case "r":
			if (op.length !== 2) throw new TypeError("r arity");
			assertJsonValue(op[1]);
			return;
		case "s":
			if (op.length === 3) {
				okRef(op[1]);
				assertJsonValue(op[2]);
			} else if (op.length === 2) assertJsonValue(op[1]);
			else throw new TypeError("s arity");
			return;
		case "d":
			if (op.length === 2) okRef(op[1]);
			else if (op.length !== 1) throw new TypeError("d arity");
			return;
		case "a":
			if (op.length === 3) {
				okRef(op[1]);
				if (typeof op[2] !== "string") throw new TypeError("a value");
			} else if (op.length === 2) {
				if (typeof op[1] !== "string") throw new TypeError("a value");
			} else throw new TypeError("a arity");
			return;
		case "t":
			if (op.length === 3) {
				okRef(op[1]);
				if (!Number.isInteger(op[2]) || (op[2] as number) < 0) throw new TypeError("t count");
			} else if (op.length === 2) {
				if (!Number.isInteger(op[1]) || (op[1] as number) < 0) throw new TypeError("t count");
			} else throw new TypeError("t arity");
			return;
		case "p": {
			const [i, r, items] = op.length === 5 ? [op[2], op[3], op[4]] : op.length === 4 ? [op[1], op[2], op[3]] : [];
			if (items === undefined) throw new TypeError("p arity");
			if (op.length === 5) okRef(op[1]);
			if (!Number.isInteger(i) || (i as number) < 0) throw new TypeError("p index");
			if (!Number.isInteger(r) || (r as number) < 0) throw new TypeError("p remove");
			if (!Array.isArray(items)) throw new TypeError("p items");
			for (const v of items) assertJsonValue(v);
			return;
		}
		case "#": {
			if (op.length !== 3 || !Number.isInteger(op[1]) || (op[1] as number) < 0 || !Array.isArray(op[2])) {
				throw new TypeError("# shape");
			}
			assertSafePath(op[2] as Path);
			return;
		}
		// Silently skipping an unknown verb is how a newer producer's op vanishes.
		default:
			throw new TypeError(`unknown op verb: ${String(verb)}`);
	}
}

export function assertSafePath(path: Path): void {
	for (const seg of path) {
		if (typeof seg === "string") {
			if (RESERVED_SEGMENTS.has(seg)) throw new UnsafePathError(seg);
		} else if (!Number.isInteger(seg) || seg < 0) {
			throw new UnsafePathError(seg);
		}
	}
}

/**
 * An index may address an existing element or append exactly one past the end.
 *
 * This is not an arbitrary cap — it is what keeps the value a `JsonValue`. A
 * sparse array does not survive a JSON round trip: holes serialise to `null` and
 * return as real properties, so `arr[7] = x` on a length-3 array already produces
 * state a replica cannot match. Rejecting the write is more honest than silently
 * diverging.
 *
 * It also removes the denial of service it would otherwise permit:
 * `["s", ["xs", 4294967290], 1]` allocates a 4.29-billion-entry array from one op.
 * Growth stays possible and stays proportional — the tracker already emits
 * `arr.length = n` as a splice of explicit nulls, whose op size grows with the
 * gap, so a large growth costs a large op rather than a small one.
 */
function assertIndexInRange(parent: readonly unknown[], index: number): void {
	if (index > parent.length) throw new UnsafePathError(index);
}

// ─── Applier ─────────────────────────────────────────────────────────────────

export class PathError extends Error {
	readonly path: Path | number;
	constructor(path: Path | number) {
		super(`unresolvable path: ${JSON.stringify(path)}`);
		this.path = path;
		this.name = "PathError";
	}
}

/**
 * Apply ops to a plain mutable value. Returns the value, because `r` replaces it
 * outright and cannot be done in place.
 *
 * Takes decoded ops. Path ids and omitted paths are a wire concern — run
 * `decode` first if the ops came from a boundary.
 */
export function apply<T>(target: T | undefined, ops: readonly Op[]): T {
	let root = target as unknown as JsonValue;

	for (const op of ops) {
		assertValidOp(op);

		if (op[0] === "r") {
			// Adopted, not copied. The consumer owns the batch it was handed.
			//
			// Fanning one batch out to several consumers in-process therefore makes
			// their replicas alias each other. That is an ownership rule, not a
			// defect: copy the batch at the fan-out point, or let each consumer
			// decode its own. A batch that crosses a real boundary is already
			// distinct, because serialisation produces fresh objects.
			root = op[1];
			continue;
		}

		const path = op[1];
		assertSafePath(path);

		if (op[0] === "p") {
			const target_ = path.length === 0 ? root : resolve(root, path);
			if (!Array.isArray(target_)) throw new PathError(path);
			target_.splice(op[2], op[3]);
			const chunkSize = 10_000;
			for (let offset = 0; offset < op[4].length; offset += chunkSize) {
				target_.splice(op[2] + offset, 0, ...op[4].slice(offset, offset + chunkSize));
			}
			continue;
		}

		// s/d/a/t can never target the root — the type forbids it.
		const parent = resolve(root, path.slice(0, -1)) as Record<Seg, JsonValue>;
		const key = path[path.length - 1]!;
		if (Array.isArray(parent)) {
			if (typeof key !== "number") throw new UnsafePathError(key);
			assertIndexInRange(parent, key);
		}
		// defineProperty rather than assignment: a setter inherited from the prototype
		// chain would otherwise run on write.
		const write = (value: JsonValue) => {
			Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true });
		};
		const read = (): unknown => (Object.hasOwn(parent, key) ? parent[key] : undefined);
		switch (op[0]) {
			case "s":
				write(op[2]);
				break;
			case "d":
				if (Array.isArray(parent)) {
					if (typeof key !== "number" || key >= parent.length) throw new PathError(path);
					(parent as unknown as JsonValue[]).splice(key, 1);
				} else delete parent[key];
				break;
			case "a": {
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(`${current}${op[2]}`);
				break;
			}
			case "t": {
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(current.slice(op[2]));
				break;
			}
		}
	}
	return root as unknown as T;
}

function resolveValue(root: JsonValue, path: Path): JsonValue {
	let node: JsonValue = root;
	for (const seg of path) {
		if (!isObj(node)) throw new PathError(path);
		if (Array.isArray(node) && typeof seg !== "number") throw new UnsafePathError(seg);
		// Own properties only: an inherited getter must not run, and a walk must not
		// escape the value into the prototype chain.
		if (!Object.hasOwn(node, seg as PropertyKey)) throw new PathError(path);
		node = (node as Record<Seg, JsonValue>)[seg]!;
	}
	return node;
}

function resolve(root: JsonValue, path: Path): JsonValue {
	const node = resolveValue(root, path);
	if (!isObj(node)) throw new PathError(path);
	return node;
}

// ─── Codec ───────────────────────────────────────────────────────────────────
//
// Path interning and arity omission live between the tracker and a boundary;
// `Op` and `apply` know nothing about them.
//
// ONE PAIR PER STREAM. The table spans an entire subscription or file: a path
// interned in batch 3 is referenced in batch 40. A second consumer that
// subscribes at batch 40 has never seen the definition, so it needs its own
// encoder — sharing one across consumers hands the late subscriber ids it cannot
// resolve. A base batch does not rescue it, because `["r", value]` carries no
// path refs and leaves the table empty.

const pathKey = (path: Path): string => JSON.stringify(path);

export interface Encoder {
	encode(ops: readonly Op[]): WireOp[];
}

/**
 * Intern on SECOND use. A definition costs more than the path it replaces, so
 * interning on first use loses on the many paths written exactly once.
 */
export function encoder(): Encoder {
	const seen = new Set<string>();
	const ids = new Map<string, number>();
	let nextId = 0;
	let previous: string | undefined; // last path in THIS batch

	return {
		encode(ops) {
			// Arity omission is scoped to a batch. Letting it span batches would make
			// a batch's first op depend on the previous batch's last one, so a reader
			// that skips or reorders a batch decodes into the wrong path. Ids are the
			// only cross-batch state, and the dictionary makes those explicit.
			previous = undefined;
			const out: WireOp[] = [];
			for (const op of ops) {
				if (op[0] === "r") {
					out.push(op);
					// A base batch is a RECOVERY POINT: a reader replays from the last one
					// with a fresh decoder. So everything after it must be self-contained.
					// Keeping ids across a replacement emits references to definitions the
					// reader never saw — recovery fails with an unresolvable path id.
					seen.clear();
					ids.clear();
					nextId = 0;
					previous = undefined;
					continue;
				}
				const path = op[1];
				const key = pathKey(path);

				// Same path as the previous op: drop the ref entirely.
				if (key === previous) {
					switch (op[0]) {
						case "s":
							out.push(["s", op[2]]);
							break;
						case "d":
							out.push(["d"]);
							break;
						case "a":
							out.push(["a", op[2]]);
							break;
						case "t":
							out.push(["t", op[2]]);
							break;
						case "p":
							out.push(["p", op[2], op[3], op[4]]);
							break;
					}
					continue;
				}

				let ref: PathRef = path;
				const existing = ids.get(key);
				if (existing !== undefined) {
					ref = existing;
				} else if (seen.has(key)) {
					const id = nextId++;
					ids.set(key, id);
					out.push(["#", id, path]); // second use: define, then reference
					ref = id;
				} else {
					seen.add(key); // first use: inline
				}

				switch (op[0]) {
					case "s":
						out.push(["s", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "d":
						out.push(["d", ref as PathRef<NonEmptyPath>]);
						break;
					case "a":
						out.push(["a", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "t":
						out.push(["t", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "p":
						out.push(["p", ref, op[2], op[3], op[4]]);
						break;
				}
				previous = key;
			}
			return out;
		},
	};
}

export interface Decoder {
	decode(wire: readonly WireOp[]): Op[];
}

export function decoder(): Decoder {
	const paths = new Map<number, Path>();

	return {
		decode(wire) {
			let previous: Path | undefined; // scoped to the batch, as in encode
			const out: Op[] = [];
			for (const op of wire) {
				assertValidWireOp(op);
				if (op[0] === "#") {
					assertSafePath(op[2]);
					paths.set(op[1], op[2]);
					continue;
				}
				if (op[0] === "r") {
					out.push(op);
					paths.clear();
					previous = undefined;
					continue;
				}

				// Arity tells us whether a ref is present: the short forms omit it.
				const short =
					(op[0] === "d" && op.length === 1) ||
					(op[0] !== "d" && op[0] !== "p" && op.length === 2) ||
					(op[0] === "p" && op.length === 4);

				let path: Path;
				if (short) {
					if (previous === undefined) throw new PathError([]);
					path = previous;
				} else {
					const ref = op[1] as PathRef;
					if (typeof ref === "number") {
						const resolved = paths.get(ref);
						if (resolved === undefined) throw new PathError(ref);
						path = resolved;
					} else {
						path = ref;
					}
					previous = path;
				}

				if (op[0] !== "p" && path.length === 0) throw new PathError(path);
				switch (op[0]) {
					case "s":
						out.push(["s", path as NonEmptyPath, (short ? op[1] : op[2]) as JsonValue]);
						break;
					case "d":
						out.push(["d", path as NonEmptyPath]);
						break;
					case "a":
						out.push(["a", path as NonEmptyPath, (short ? op[1] : op[2]) as string]);
						break;
					case "t":
						out.push(["t", path as NonEmptyPath, (short ? op[1] : op[2]) as number]);
						break;
					case "p": {
						const [i, r, items] = short
							? [op[1] as number, op[2] as number, op[3] as JsonValue[]]
							: [op[2] as number, op[3] as number, op[4] as JsonValue[]];
						out.push(["p", path, i, r, items]);
						break;
					}
				}
			}
			return out;
		},
	};
}
