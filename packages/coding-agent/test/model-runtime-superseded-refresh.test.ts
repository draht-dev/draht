import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createStubProvider, STUB_PROVIDER_ID } from "../src/extensions/stub-provider/provider.ts";

/** The slice of the runtime's private model store this test steers. */
type ModelsSeam = {
	refresh(options: unknown): Promise<unknown>;
	getAvailable(providerId: unknown, options: unknown): Promise<unknown>;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const PENDING = Symbol("pending");

async function stateAfter(promise: Promise<unknown>, ms: number): Promise<"resolved" | typeof PENDING> {
	return Promise.race([
		promise.then(() => "resolved" as const),
		new Promise<typeof PENDING>((done) => setTimeout(() => done(PENDING), ms)),
	]);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ModelRuntime.refresh() when a newer availability pass supersedes it", () => {
	// The CI failure behind this: a resumed `--attachable` session restores its model only when
	// hasConfiguredAuth(provider) is true. A keyless provider registered by an extension
	// (draht-stub) becomes configured only through an availability pass. registerNativeProvider()
	// starts an UNAWAITED refresh; when that pass was queued after the awaited one, the awaited
	// one was discarded as stale and still resolved, so restore read a snapshot without the
	// provider and the session answered every prompt with "No API key found".
	it("does not resolve until the superseding pass has written the snapshot", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const models = (runtime as unknown as { models: ModelsSeam }).models;

		// Hold the unawaited refresh (A) before it queues its pass, so the awaited one (B) queues first.
		const releaseA = deferred();
		const originalRefresh = models.refresh.bind(models);
		let refreshCalls = 0;
		vi.spyOn(models, "refresh").mockImplementation(async (options) => {
			const call = ++refreshCalls;
			const result = await originalRefresh(options);
			if (call === 1) await releaseA.promise;
			return result;
		});

		// Pass order: B's pass calls getAvailable first, A's second. Hold B's until A has queued
		// (which supersedes B), and hold A's so the window where only B has finished is observable.
		const bPassStarted = deferred();
		const releaseBPass = deferred();
		const releaseAPass = deferred();
		const originalGetAvailable = models.getAvailable.bind(models);
		let availableCalls = 0;
		vi.spyOn(models, "getAvailable").mockImplementation(async (providerId, options) => {
			const call = ++availableCalls;
			if (call === 1) {
				bPassStarted.resolve();
				await releaseBPass.promise;
			} else if (call === 2) {
				await releaseAPass.promise;
			}
			return originalGetAvailable(providerId, options);
		});

		runtime.registerNativeProvider(createStubProvider({}));
		const awaited = runtime.refresh({ allowNetwork: false });

		await bPassStarted.promise;
		releaseA.resolve();
		// Let A queue its pass (bumping the sequence) before B's pass checks it.
		await vi.waitFor(() => expect(availableCalls).toBe(2));
		releaseBPass.resolve();

		// B was superseded and wrote nothing; the snapshot it would hand back is stale.
		expect(await stateAfter(awaited, 100)).toBe(PENDING);
		expect(runtime.hasConfiguredAuth(STUB_PROVIDER_ID)).toBe(false);

		releaseAPass.resolve();
		await awaited;
		expect(runtime.hasConfiguredAuth(STUB_PROVIDER_ID)).toBe(true);
	});
});
