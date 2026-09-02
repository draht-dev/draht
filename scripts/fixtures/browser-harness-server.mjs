/**
 * Trivial Bun daemon that serves the browser-harness fixture page on loopback.
 *
 * Bun rather than node:http on purpose: the surfaces this harness will drive from
 * Phase 32 on are served by a Bun daemon, so the self-test proves the harness can
 * reach a separately spawned Bun server — not merely an in-process node server.
 *
 * Prints `LISTENING <origin>` on stdout once bound; the port is ephemeral.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "browser-harness-page.html"), "utf-8");

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch() {
		return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
	},
});

process.stdout.write(`LISTENING http://127.0.0.1:${server.port}\n`);
