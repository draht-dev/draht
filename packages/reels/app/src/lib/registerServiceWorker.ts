/** Registers sw.js in production builds only; dev stays uncached so edits are always fresh. */
export function registerServiceWorker(): void {
	if (!import.meta.env.PROD) return;
	if (!("serviceWorker" in navigator)) return;

	const register = () => {
		navigator.serviceWorker.register("./sw.js", { type: "module" }).catch(() => {
			// Offline support is best-effort; a failed registration should not block the app.
		});
	};

	// This module's script tag runs after the DOM is parsed, so `load` may
	// already have fired by the time this executes — `addEventListener("load",
	// ...)` would then never call back, since it only fires once.
	if (document.readyState === "complete") {
		register();
	} else {
		window.addEventListener("load", register, { once: true });
	}
}
