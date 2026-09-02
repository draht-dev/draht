/**
 * Self-test for the headless browser harness (R32-FLEET.12).
 *
 * Every renderer acceptance from Phase 32 on is a DOM assertion against a page a
 * local daemon serves, so this proves the harness can do exactly that against a
 * trivial fixture: spawn a real daemon (a Bun server on an ephemeral loopback
 * port, the same runtime the geist daemon uses), load the page it serves, click,
 * type, read the resulting DOM text back, and re-lay the page out at a second
 * viewport — including the 390x844 phone target.
 *
 * Run: node --test scripts/browser-harness.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { launchHeadlessBrowser, textOf, VIEWPORTS, waitForServer, waitForText } from "./browser-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = join(HERE, "fixtures/browser-harness-server.mjs");

let daemon;
let origin;
let harness;

/** Resolve once the spawned daemon reports the origin it bound. */
function readOrigin(child, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			reject(new Error(`Fixture daemon never reported a port.\nstdout: ${stdout}\nstderr: ${stderr}`));
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			const match = stdout.match(/LISTENING (\S+)/);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

before(async () => {
	daemon = spawn("bun", [FIXTURE_SERVER], { stdio: ["ignore", "pipe", "pipe"] });
	origin = await readOrigin(daemon);
	await waitForServer(origin);
	harness = await launchHeadlessBrowser();
});

after(async () => {
	await harness?.close();
	daemon?.kill("SIGKILL");
});

describe("headless browser harness", () => {
	it("loads a page served by a running local daemon and reads its DOM text", async () => {
		const { page, close } = await harness.newPage();
		try {
			await page.goto(origin);
			assert.equal(await textOf(page, "#title"), "Draht browser harness fixture");
		} finally {
			await close();
		}
	});

	it("clicks and types, and sees the DOM the interaction produced", async () => {
		const { page, close } = await harness.newPage();
		try {
			await page.goto(origin);

			await page.click("#ping");
			await waitForText(page, "#log", "pong 1");

			await page.fill("#prompt", "hello from the harness");
			await page.click("#send");
			await waitForText(page, "#echo", "echo: hello from the harness");
		} finally {
			await close();
		}
	});

	it("renders the same page differently at desktop and at 390x844", async () => {
		const desktop = await harness.newPage(VIEWPORTS.desktop);
		try {
			await desktop.page.goto(origin);
			assert.equal(await textOf(desktop.page, "#layout"), "wide");
			assert.deepEqual(desktop.page.viewportSize(), { width: 1280, height: 800 });
		} finally {
			await desktop.close();
		}

		const phone = await harness.newPage(VIEWPORTS.mobile);
		try {
			await phone.page.goto(origin);
			assert.equal(await textOf(phone.page, "#layout"), "narrow");
			assert.deepEqual(phone.page.viewportSize(), { width: 390, height: 844 });
		} finally {
			await phone.close();
		}
	});

	it("records console and page errors so a broken bundle cannot pass quietly", async () => {
		const { page, errors, close } = await harness.newPage();
		try {
			await page.goto(origin);
			assert.deepEqual(errors, []);
			await page.evaluate(() => {
				console.error("boom");
			});
			await waitForCondition(() => errors.length > 0);
			assert.match(errors[0], /boom/);
		} finally {
			await close();
		}
	});
});

async function waitForCondition(predicate, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Timed out waiting for condition");
}
