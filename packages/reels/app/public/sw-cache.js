/**
 * Pure cache bookkeeping for the service worker: LRU-by-count eviction and
 * byte-range parsing for serving a `Range` request out of a fully-cached
 * response. Kept dependency-free and free of `self`/`caches` so it is
 * testable outside a service worker, and imported by sw.js as a plain
 * static ES module (not bundled).
 */

/**
 * Returns the new access order after touching `key` (moved/added to the most
 * recently used end) and the keys that fall off the front once `cap` is
 * exceeded.
 *
 * @param {string[]} order oldest-first list of cached keys
 * @param {string} key the key just written or read
 * @param {number} cap maximum number of entries to keep
 * @returns {{ order: string[], evicted: string[] }}
 */
export function touchCacheOrder(order, key, cap) {
	const next = order.filter((existing) => existing !== key);
	next.push(key);
	const evicted = [];
	while (next.length > cap) {
		const oldest = next.shift();
		if (oldest !== undefined) evicted.push(oldest);
	}
	return { order: next, evicted };
}

/**
 * Reconciles a possibly-stale order list against the cache's actual keys
 * before touching it, so a dropped/raced update can never let an entry
 * escape the cap: entries the order list doesn't know about are treated as
 * the oldest (evicted first), and entries the order list remembers but the
 * cache no longer has are dropped from bookkeeping.
 *
 * @param {string[]} order oldest-first list of cached keys, as last recorded
 * @param {string[]} actualKeys every key currently present in the cache
 * @param {string} touchedKey the key just written or read
 * @param {number} cap maximum number of entries to keep
 * @returns {{ order: string[], evicted: string[] }}
 */
export function reconcileAndTouch(order, actualKeys, touchedKey, cap) {
	const actual = new Set(actualKeys);
	const known = new Set(order);
	const unlisted = actualKeys.filter((key) => !known.has(key) && key !== touchedKey);
	const reconciled = [...unlisted, ...order.filter((key) => actual.has(key))];
	return touchCacheOrder(reconciled, touchedKey, cap);
}

/**
 * Parses a single-range `Range` header (`bytes=start-end`, `bytes=start-`,
 * or the suffix form `bytes=-N`) against a known total size. Returns `null`
 * for a missing/malformed/unsatisfiable range (multi-range requests are not
 * supported and also return `null`, falling back to serving the whole body).
 *
 * @param {string | null | undefined} rangeHeader
 * @param {number} totalSize
 * @returns {{ start: number, end: number } | null}
 */
export function parseRangeHeader(rangeHeader, totalSize) {
	if (!rangeHeader || totalSize <= 0) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
	if (!match) return null;

	const [, startText, endText] = match;
	if (startText === "" && endText === "") return null;

	let start;
	let end;
	if (startText === "") {
		const suffixLength = Number(endText);
		start = Math.max(totalSize - suffixLength, 0);
		end = totalSize - 1;
	} else {
		start = Number(startText);
		end = endText === "" ? totalSize - 1 : Math.min(Number(endText), totalSize - 1);
	}

	if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= totalSize) return null;
	return { start, end };
}
