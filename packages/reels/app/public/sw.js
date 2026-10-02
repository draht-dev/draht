// Hand-written service worker (no workbox). Registered only in production
// builds, as an ES module, so it can import ./sw-cache.js directly.
//
// Strategy:
//  - navigations (HTML): network-first, falling back to the cached shell
//    offline. Other shell assets (hashed JS/CSS from the build): cache-first,
//    which is safe because their filenames change with their content.
//  - feed.json / repos.json: network-first, falling back to cache when
//    offline or the network fails.
//  - media (video/audio/poster referenced by a feed): a `<video>`/`<audio>`
//    element always issues ranged GETs, and a cache.put of a 206 response
//    throws (the Cache API only accepts whole, 200 responses), so ranged
//    requests are never cached here and go straight to the network. The app
//    separately issues a single plain (non-Range) GET per reel when it
//    becomes active (see lib/mediaCache.ts); that request is what this
//    worker actually caches, as a full 200. Once cached, a later ranged
//    request (e.g. replaying offline) is served by slicing the cached body
//    into a correct 206 with a Content-Range header.
//
// BUILD_ID is substituted at build time (see vite.config.ts's swBuildId
// plugin) so the shell cache is versioned per deploy and the service worker's
// own bytes change on every build, which is what makes the browser notice
// and install an update at all — identical bytes are a no-op install.
// During `vite dev` this file is never registered, so the literal
// placeholder below is harmless.

import { parseRangeHeader, reconcileAndTouch } from "./sw-cache.js";

const BUILD_ID = "__BUILD_ID__";
// Several reels sites can share one origin (owner.github.io/repoA/ and
// /repoB/), and Cache Storage is per origin, not per scope. Tag every cache
// name with a hash of this worker's scope so sites never evict each other.
function scopeTag(scope) {
	let hash = 5381;
	for (let i = 0; i < scope.length; i++) hash = ((hash << 5) + hash + scope.charCodeAt(i)) >>> 0;
	return hash.toString(36);
}
const OWN_CACHE_PREFIX = `reels-${scopeTag(self.registration.scope)}-`;
const SHELL_CACHE = `${OWN_CACHE_PREFIX}shell-${BUILD_ID}`;
const DATA_CACHE = `${OWN_CACHE_PREFIX}data`;
const MEDIA_CACHE = `${OWN_CACHE_PREFIX}media`;
const MEDIA_ORDER_KEY = "media-order";
const MEDIA_CACHE_CAP = 20;

// `caches.keys()` lists every cache on the origin, including other apps'
// caches; activate only ever deletes names carrying OWN_CACHE_PREFIX.

self.addEventListener("install", (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keep = new Set([SHELL_CACHE, DATA_CACHE, MEDIA_CACHE]);
			const names = await caches.keys();
			const stale = names.filter((name) => name.startsWith(OWN_CACHE_PREFIX) && !keep.has(name));
			await Promise.all(stale.map((name) => caches.delete(name)));
			await self.clients.claim();
		})(),
	);
});

function isDataRequest(url) {
	return url.pathname.endsWith("/repos.json") || url.pathname.endsWith("/feed.json");
}

function isMediaRequest(url) {
	return /\.(mp4|webm|mp3|m4a|png|jpg|jpeg|webp)$/i.test(url.pathname);
}

// A navigation Request's `.url` can carry the page's current hash fragment
// (this SW observed it doing so for an SPA's `#/...` route), even though the
// fragment is never actually sent over the wire. Every hash is still the
// same app shell response, so the cache key is normalized to drop it —
// otherwise each hash the user happened to be on when the shell was last
// cached gets its own cache entry, and an offline reload on any other hash
// misses entirely.
function shellCacheKey(request) {
	const url = new URL(request.url);
	url.hash = "";
	return url.href;
}

async function networkFirstWithShellFallback(request) {
	const cache = await caches.open(SHELL_CACHE);
	const key = shellCacheKey(request);
	try {
		const response = await fetch(request);
		if (response.ok) await cache.put(key, response.clone());
		return response;
	} catch (error) {
		const cached = await cache.match(key);
		if (cached) return cached;
		throw error;
	}
}

async function cacheFirst(request) {
	const cache = await caches.open(SHELL_CACHE);
	const cached = await cache.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok) await cache.put(request, response.clone());
	return response;
}

async function networkFirst(request) {
	const cache = await caches.open(DATA_CACHE);
	try {
		const response = await fetch(request);
		if (response.ok) await cache.put(request, response.clone());
		return response;
	} catch (error) {
		const cached = await cache.match(request);
		if (cached) return cached;
		throw error;
	}
}

// Serialized so concurrent cache writes (e.g. several posters loading at
// once) can't interleave a read-modify-write of the order record and lose an
// update; each call waits for the previous one to finish before reading.
let mediaOrderQueue = Promise.resolve();

function recordMediaAccess(cache, dataCache, key) {
	mediaOrderQueue = mediaOrderQueue.then(async () => {
		const [orderResponse, actualKeys] = await Promise.all([
			dataCache.match(MEDIA_ORDER_KEY),
			cache.keys().then((requests) => requests.map((request) => request.url)),
		]);
		const order = orderResponse ? await orderResponse.json() : [];
		const { order: nextOrder, evicted } = reconcileAndTouch(order, actualKeys, key, MEDIA_CACHE_CAP);
		await Promise.all(evicted.map((evictedKey) => cache.delete(evictedKey)));
		await dataCache.put(MEDIA_ORDER_KEY, new Response(JSON.stringify(nextOrder)));
	});
	return mediaOrderQueue;
}

function sliceCachedResponse(cached, rangeHeader) {
	return cached
		.clone()
		.arrayBuffer()
		.then((buffer) => {
			const range = parseRangeHeader(rangeHeader, buffer.byteLength);
			if (!range) {
				return new Response(buffer, {
					status: 200,
					headers: {
						"Content-Type": cached.headers.get("Content-Type") ?? "application/octet-stream",
						"Content-Length": String(buffer.byteLength),
						"Accept-Ranges": "bytes",
					},
				});
			}
			const slice = buffer.slice(range.start, range.end + 1);
			return new Response(slice, {
				status: 206,
				headers: {
					"Content-Type": cached.headers.get("Content-Type") ?? "application/octet-stream",
					"Content-Range": `bytes ${range.start}-${range.end}/${buffer.byteLength}`,
					"Content-Length": String(slice.byteLength),
					"Accept-Ranges": "bytes",
				},
			});
		});
}

async function handleMediaRequest(request, event) {
	const cache = await caches.open(MEDIA_CACHE);
	const dataCache = await caches.open(DATA_CACHE);
	const cached = await cache.match(request.url);

	if (cached) {
		// A hit is still an access: record it (in the background, via
		// waitUntil, so it never delays serving the response) so eviction
		// stays LRU by actual use, not just FIFO by insertion order.
		event.waitUntil(recordMediaAccess(cache, dataCache, request.url));
		const rangeHeader = request.headers.get("range");
		return rangeHeader ? sliceCachedResponse(cached, rangeHeader) : cached.clone();
	}

	// Not cached. A `<video>`/`<audio>` element's own ranged request must
	// never be intercepted for caching: `cache.put` rejects a 206, and
	// awaiting a whole-file fetch before responding would stall playback
	// until the entire file downloaded. Let the browser handle it natively.
	if (request.headers.has("range")) return fetch(request);

	// A plain GET with no Range header: either a non-media-element fetch (see
	// lib/mediaCache.ts's background "cache this reel" request) or a browser
	// that chose not to range a first request. Cache only a clean 200.
	const response = await fetch(request);
	if (response.status === 200) {
		await cache.put(request.url, response.clone());
		event.waitUntil(recordMediaAccess(cache, dataCache, request.url));
	}
	return response;
}

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin) return;
	if (event.request.method !== "GET") return;

	if (event.request.mode === "navigate") {
		event.respondWith(networkFirstWithShellFallback(event.request));
		return;
	}
	if (isDataRequest(url)) {
		event.respondWith(networkFirst(event.request));
		return;
	}
	if (isMediaRequest(url)) {
		event.respondWith(handleMediaRequest(event.request, event));
		return;
	}
	event.respondWith(cacheFirst(event.request));
});
