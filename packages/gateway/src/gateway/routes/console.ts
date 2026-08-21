import { CONSOLE_BUNDLE_ASSETS } from "@draht/geist-console";
import { GEIST_PROTOCOL_FAMILY, GEIST_PROTOCOL_VERSION } from "@draht/geist-protocol";
import { Hono, type MiddlewareHandler } from "hono";

/**
 * The one daemon-served surface (R32-FLEET.10).
 *
 * Decision record: `.planning/specs/2026-08-19-geist-served-surface-decision.md`.
 *
 *   GET /ui                the console — one document, desktop and phone
 *   GET /ui/console.css    its stylesheet
 *   GET /ui/console.js     its script
 *   GET /ui/tokens.css     geist-glass itself, not a copy
 *   GET /ui/protocol.json  the handshake constants, so the bundle repeats none
 *
 * This file is wiring. What the console is made of is `CONSOLE_BUNDLE_ASSETS` in
 * `@draht/geist-console`; the daemon only hands the named bytes over.
 *
 * **These five routes are deliberately unauthenticated**, and `createServer`
 * carves them out of the bearer middleware explicitly. A browser cannot put an
 * `Authorization` header on a document navigation, so an authenticated `/ui`
 * would be a page nobody can open. Nothing here is a secret: the assets are
 * static, the daemon is loopback-bound, and the surface that carries session
 * data — `GET /fleet` and the `/attach` upgrade — still answers 401 without a
 * credential. The console obtains one from the URL fragment and presents it as
 * a header on both.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
	html: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
};

function contentType(name: string): string {
	return CONTENT_TYPES[name.slice(name.lastIndexOf(".") + 1)] ?? "application/octet-stream";
}

/**
 * The policy every `/ui*` response carries (R33-REACH.9, GSEC-04 sign-off #5).
 *
 * The console keeps its device credential in origin-scoped storage (P33-T12).
 * That is the right place for it — it survives a tab restart and never travels
 * in a URL — but it also means script running on this origin can read it. An
 * XSS in the bundle is therefore not a defacement, it is credential theft: the
 * attacker walks away with a paired device's identity and steers the daemon
 * from anywhere on the tailnet. This header is what makes injected bytes inert.
 *
 * Read it directive by directive:
 *
 *   default-src 'self'          nothing loads from anywhere but this daemon
 *   script-src  'self'          no inline `<script>`, no `onclick=`, no eval —
 *                               the omission of 'unsafe-inline'/'unsafe-eval'
 *                               is the whole point, so neither may be added
 *                               back without re-arguing the credential story
 *   style-src   'self'          the two stylesheets are linked, never inlined
 *   connect-src 'self' wss:     `/fleet` and the `/attach` upgrade; `wss:` and
 *                               not `ws:` because a tailnet-fronted deployment
 *                               is TLS-terminated and a plaintext socket would
 *                               carry the credential in the clear
 *   img-src     'self' data:    for the `data:` favicon in index.html, which
 *                               exists so the browser stops asking for one
 *   frame-ancestors 'none'      no page may frame the console — clickjacking a
 *                               prompt composer is a remote-execution primitive
 *   base-uri    'none'          an injected `<base>` cannot repoint the
 *                               relative asset and API paths at another origin
 *
 * Asserted on the document, the CSS, the JS, `protocol.json` and the 404 path
 * by `src/__tests__/console-csp.test.ts`.
 */
export const CONSOLE_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

export function createConsoleRoutes(): Hono {
	const app = new Hono();

	// Scoped to `/ui` and `/ui/*` rather than `*`: this router is mounted at the
	// gateway root, so a wildcard here would stamp the policy onto `/health`,
	// `/sessions` and every other API response too. Registered as middleware
	// rather than set inside each handler so that a route added later — or the
	// 404 that `asset()` returns for an unknown name — cannot be served bare.
	const withCsp: MiddlewareHandler = async (c, next) => {
		await next();
		c.res.headers.set("Content-Security-Policy", CONSOLE_CSP);
	};
	app.use("/ui", withCsp);
	app.use("/ui/*", withCsp);

	/**
	 * Serve one named asset.
	 *
	 * The name indexes a frozen table of four absolute paths, so `..` and
	 * absolute-path requests are not rejected — they simply do not name anything.
	 * `Object.hasOwn` rather than a bare lookup, so `constructor` and `__proto__`
	 * are names too.
	 */
	async function asset(name: string): Promise<Response> {
		if (!Object.hasOwn(CONSOLE_BUNDLE_ASSETS, name)) {
			return new Response("not found", { status: 404 });
		}
		const file = Bun.file(CONSOLE_BUNDLE_ASSETS[name] as string);
		if (!(await file.exists())) {
			return new Response("not found", { status: 404 });
		}
		return new Response(file, {
			headers: {
				"Content-Type": contentType(name),
				// The bundle is read off disk on every request and never revalidated
				// by hash, so a cached copy would outlive the daemon that served it.
				"Cache-Control": "no-store",
			},
		});
	}

	app.get("/ui", () => asset("index.html"));
	app.get("/ui/", () => asset("index.html"));

	// Rendered from the same constants the daemon validates frames with, so the
	// served bundle cannot be left speaking a superseded 0.x member. Registered
	// before the asset route because Hono matches in registration order.
	app.get("/ui/protocol.json", (c) =>
		c.json({ protocol: GEIST_PROTOCOL_FAMILY, version: GEIST_PROTOCOL_VERSION }, 200, {
			"Cache-Control": "no-store",
		}),
	);

	app.get("/ui/:asset", (c) => asset(c.req.param("asset")));

	return app;
}
