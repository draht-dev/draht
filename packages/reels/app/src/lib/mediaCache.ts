const requested = new Set<string>();

/**
 * Fire-and-forget request to let the service worker cache a media file for
 * offline replay, once per URL per session. Issues a plain GET with no Range
 * header (unlike the `<video>`/`<audio>` element itself, which always
 * ranges), so the worker sees a cacheable 200 it can store whole.
 *
 * Two conditions keep this from doubling every video's download:
 *  - it only runs when a service worker already controls the page. On an
 *    uncontrolled first visit there is nothing to cache into, so skipping it
 *    avoids a second full download alongside the element's own `preload`.
 *  - callers pass an `AbortSignal` tied to the card's active lifetime, so
 *    scrolling away cancels an in-flight background fetch instead of letting
 *    it run uncancellably to completion off-screen.
 */
export function cacheMediaInBackground(url: string | undefined, signal: AbortSignal | undefined): void {
	if (!url || requested.has(url)) return;
	if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;
	requested.add(url);
	fetch(url, { signal }).catch(() => {
		requested.delete(url);
	});
}
