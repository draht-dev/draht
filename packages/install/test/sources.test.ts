import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { materializeFromCache, payloadCachePath } from "../src/sources/cache.ts";
import { createLocalRegistryClient } from "../src/sources/local.ts";
import { createNpmRegistryClient } from "../src/sources/npm.ts";
import { DEFAULT_TAR_LIMITS, extractTarGz } from "../src/sources/tar.ts";
import { SourceError } from "../src/sources/types.ts";
import { tempRoot } from "./helpers/cli.ts";
import { type FixtureRegistry, ssriIntegrity, startFixtureRegistry, writeLocalRegistry } from "./helpers/registry.ts";
import { createPackageTarGz, createTar, createTarGz } from "./helpers/tar-fixture.ts";

const openRegistries: FixtureRegistry[] = [];

afterEach(async () => {
	while (openRegistries.length > 0) {
		await openRegistries.pop()?.close();
	}
});

async function registry(...args: Parameters<typeof startFixtureRegistry>): Promise<FixtureRegistry> {
	const started = await startFixtureRegistry(...args);
	openRegistries.push(started);
	return started;
}

describe("safe tar extraction", () => {
	it("extracts an npm-shaped payload, stripping the package/ prefix", () => {
		const tmp = tempRoot("tar");
		try {
			const dest = join(tmp.path, "out");
			const result = extractTarGz(createPackageTarGz("draht-claude", "1.2.3", { "a/b.md": "hello" }), dest);

			expect(result.files.sort()).toEqual(["a/b.md", "package.json"]);
			expect(readFileSync(join(dest, "a", "b.md"), "utf8")).toBe("hello");
		} finally {
			tmp.dispose();
		}
	});

	it("rejects a traversal entry", () => {
		const tmp = tempRoot("tar");
		try {
			const archive = createTarGz([{ path: "package/../../escape.txt", content: "x" }]);
			expect(() => extractTarGz(archive, join(tmp.path, "out"))).toThrow(SourceError);
		} finally {
			tmp.dispose();
		}
	});

	it("rejects an absolute entry", () => {
		const tmp = tempRoot("tar");
		try {
			const archive = createTarGz([{ path: "/etc/passwd", content: "x" }]);
			expect(() => extractTarGz(archive, join(tmp.path, "out"))).toThrow(SourceError);
		} finally {
			tmp.dispose();
		}
	});

	it("rejects an entry outside the package/ root", () => {
		const tmp = tempRoot("tar");
		try {
			const archive = createTarGz([{ path: "other/file.txt", content: "x" }]);
			expect(() => extractTarGz(archive, join(tmp.path, "out"))).toThrow(/package\//);
		} finally {
			tmp.dispose();
		}
	});

	it.each([
		["symlink", "2"],
		["hardlink", "1"],
		["character device", "3"],
		["block device", "4"],
		["fifo", "6"],
	])("rejects a %s entry", (_label, typeflag) => {
		const tmp = tempRoot("tar");
		try {
			const archive = createTarGz([{ path: "package/evil", typeflag, linkname: "/etc/passwd" }]);
			expect(() => extractTarGz(archive, join(tmp.path, "out"))).toThrow(SourceError);
		} finally {
			tmp.dispose();
		}
	});

	it("rejects GNU long-name extension records rather than guessing the real name", () => {
		const tmp = tempRoot("tar");
		try {
			const archive = createTarGz([{ path: "././@LongLink", typeflag: "L", content: "package/x" }]);
			expect(() => extractTarGz(archive, join(tmp.path, "out"))).toThrow(SourceError);
		} finally {
			tmp.dispose();
		}
	});

	it("rejects two entries that resolve to the same path", () => {
		const tmp = tempRoot("tar");
		try {
			const archive = createTarGz([
				{ path: "package/dup.txt", content: "first" },
				{ path: "package/dup.txt", content: "second" },
			]);
			expect(() => extractTarGz(archive, join(tmp.path, "out"))).toThrow(/duplicate/i);
		} finally {
			tmp.dispose();
		}
	});

	it("rejects an archive with too many members", () => {
		const tmp = tempRoot("tar");
		try {
			const entries = Array.from({ length: 12 }, (_unused, index) => ({
				path: `package/f${index}.txt`,
				content: "x",
			}));
			expect(() =>
				extractTarGz(createTarGz(entries), join(tmp.path, "out"), { ...DEFAULT_TAR_LIMITS, maxEntries: 10 }),
			).toThrow(/member/i);
		} finally {
			tmp.dispose();
		}
	});

	it("rejects an archive whose expanded size exceeds the bound", () => {
		const tmp = tempRoot("tar");
		try {
			const archive = createTarGz([{ path: "package/big.bin", content: "x".repeat(4096) }]);
			expect(() =>
				extractTarGz(archive, join(tmp.path, "out"), { ...DEFAULT_TAR_LIMITS, maxTotalBytes: 1024 }),
			).toThrow(/byte/i);
		} finally {
			tmp.dispose();
		}
	});

	it("rejects a decompression bomb before writing anything", () => {
		const tmp = tempRoot("tar");
		try {
			const dest = join(tmp.path, "out");
			const bomb = gzipSync(createTar([{ path: "package/big.bin", content: "0".repeat(200_000) }]));
			expect(() => extractTarGz(bomb, dest, { ...DEFAULT_TAR_LIMITS, maxTotalBytes: 4096 })).toThrow(SourceError);
			expect(existsSync(dest) && readdirSync(dest).length > 0).toBe(false);
		} finally {
			tmp.dispose();
		}
	});

	it("rejects data that is not gzip at all", () => {
		const tmp = tempRoot("tar");
		try {
			expect(() => extractTarGz(Buffer.from("not a tarball"), join(tmp.path, "out"))).toThrow(SourceError);
		} finally {
			tmp.dispose();
		}
	});

	it("rejects an archive whose header checksum is invalid before writing", () => {
		const tmp = tempRoot("tar");
		try {
			const dest = join(tmp.path, "out");
			const tar = createTar([{ path: "package/file.txt", content: "payload" }]);
			tar[0] ^= 0x01;
			expect(() => extractTarGz(gzipSync(tar), dest)).toThrow(/checksum|malformed/i);
			expect(existsSync(dest)).toBe(false);
		} finally {
			tmp.dispose();
		}
	});

	it("rejects a truncated member before writing", () => {
		const tmp = tempRoot("tar");
		try {
			const dest = join(tmp.path, "out");
			const tar = createTar([{ path: "package/file.txt", content: "payload" }]);
			const truncated = tar.subarray(0, 512 + 3);
			expect(() => extractTarGz(gzipSync(truncated), dest)).toThrow(/truncated|malformed/i);
			expect(existsSync(dest)).toBe(false);
		} finally {
			tmp.dispose();
		}
	});
});

describe("npm registry client", () => {
	const tarball = createPackageTarGz("draht-claude", "2026.8.1-1", { "plugin.json": "{}" });

	it("resolves the latest dist-tag against DRAHT_REGISTRY", async () => {
		const fixture = await registry([
			{ name: "draht-claude", distTags: { latest: "2026.8.1-1" }, versions: [{ version: "2026.8.1-1", tarball }] },
		]);
		const client = createNpmRegistryClient({ DRAHT_REGISTRY: fixture.url });

		const resolved = await client.resolve("draht-claude", "latest");

		expect(resolved.version).toBe("2026.8.1-1");
		expect(resolved.integrity).toBe(ssriIntegrity(tarball));
		expect(resolved.tarballUrl.startsWith(fixture.url)).toBe(true);
	});

	it("url-encodes a scoped package name", async () => {
		const scoped = createPackageTarGz("@draht/install", "1.0.0");
		const fixture = await registry([
			{ name: "@draht/install", distTags: { latest: "1.0.0" }, versions: [{ version: "1.0.0", tarball: scoped }] },
		]);
		const client = createNpmRegistryClient({ DRAHT_REGISTRY: fixture.url });

		expect((await client.resolve("@draht/install", "latest")).version).toBe("1.0.0");
	});

	it("fails when the requested dist-tag does not exist", async () => {
		const fixture = await registry([
			{ name: "draht-claude", distTags: { beta: "2026.8.1-1" }, versions: [{ version: "2026.8.1-1", tarball }] },
		]);
		const client = createNpmRegistryClient({ DRAHT_REGISTRY: fixture.url });

		await expect(client.resolve("draht-claude", "latest")).rejects.toThrow(SourceError);
	});

	it("fails on an unknown package", async () => {
		const fixture = await registry([]);
		const client = createNpmRegistryClient({ DRAHT_REGISTRY: fixture.url });

		await expect(client.resolve("nope", "latest")).rejects.toThrow(SourceError);
	});

	it("downloads a tarball and verifies the registry-served integrity", async () => {
		const fixture = await registry([
			{ name: "draht-claude", distTags: { latest: "2026.8.1-1" }, versions: [{ version: "2026.8.1-1", tarball }] },
		]);
		const client = createNpmRegistryClient({ DRAHT_REGISTRY: fixture.url });

		const bytes = await client.fetchTarball(await client.resolve("draht-claude", "latest"));

		expect(bytes.equals(tarball)).toBe(true);
	});

	it("refuses registry metadata that omits dist.integrity", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "1.0.0" },
					versions: { "1.0.0": { dist: { tarball: "https://registry.invalid/pkg.tgz" } } },
				}),
				{ status: 200 },
			);
		const client = createNpmRegistryClient({ DRAHT_REGISTRY: "https://registry.invalid" }, { fetchImpl });

		await expect(client.resolve("draht-claude", "latest")).rejects.toThrow(/integrity/i);
	});

	it("rejects a tarball whose bytes do not match the served integrity", async () => {
		const fixture = await registry([
			{
				name: "draht-claude",
				distTags: { latest: "2026.8.1-1" },
				versions: [{ version: "2026.8.1-1", tarball, integrity: ssriIntegrity(Buffer.from("different")) }],
			},
		]);
		const client = createNpmRegistryClient({ DRAHT_REGISTRY: fixture.url });

		await expect(client.fetchTarball(await client.resolve("draht-claude", "latest"))).rejects.toThrow(/integrity/i);
	});

	it("refuses a tarball larger than the configured bound", async () => {
		const fixture = await registry([
			{ name: "draht-claude", distTags: { latest: "2026.8.1-1" }, versions: [{ version: "2026.8.1-1", tarball }] },
		]);
		const client = createNpmRegistryClient({ DRAHT_REGISTRY: fixture.url }, { maxTarballBytes: 8 });

		await expect(client.fetchTarball(await client.resolve("draht-claude", "latest"))).rejects.toThrow(/limit|bytes/i);
	});

	it("defaults to the public registry when DRAHT_REGISTRY is unset, without contacting it", () => {
		const client = createNpmRegistryClient({});
		expect(client.registryUrl).toBe("https://registry.npmjs.org");
	});

	it("rejects a non-http registry override instead of reading a local file", async () => {
		expect(() => createNpmRegistryClient({ DRAHT_REGISTRY: "file:///etc" })).toThrow(SourceError);
	});
});

describe("local fixture registry client", () => {
	it("resolves and serves tarballs entirely from disk", async () => {
		const tmp = tempRoot("local-registry");
		try {
			const tarball = createPackageTarGz("draht-codex", "3.0.0", { "a.txt": "a" });
			const dir = join(tmp.path, "registry");
			writeLocalRegistry(dir, [
				{ name: "draht-codex", distTags: { latest: "3.0.0" }, versions: [{ version: "3.0.0", tarball }] },
			]);
			const client = createLocalRegistryClient(dir);

			const resolved = await client.resolve("draht-codex", "latest");
			expect(resolved.version).toBe("3.0.0");
			expect((await client.fetchTarball(resolved)).equals(tarball)).toBe(true);
		} finally {
			tmp.dispose();
		}
	});

	it("verifies integrity of local tarballs too", async () => {
		const tmp = tempRoot("local-registry");
		try {
			const tarball = createPackageTarGz("draht-codex", "3.0.0");
			const dir = join(tmp.path, "registry");
			writeLocalRegistry(dir, [
				{
					name: "draht-codex",
					distTags: { latest: "3.0.0" },
					versions: [{ version: "3.0.0", tarball, integrity: ssriIntegrity(Buffer.from("nope")) }],
				},
			]);
			const client = createLocalRegistryClient(dir);

			await expect(client.fetchTarball(await client.resolve("draht-codex", "latest"))).rejects.toThrow(/integrity/i);
		} finally {
			tmp.dispose();
		}
	});
});

describe("integrity-keyed payload cache", () => {
	it("extracts once and reuses the cached tree on a second call", async () => {
		const tmp = tempRoot("cache");
		try {
			const tarball = createPackageTarGz("draht-codex", "3.0.0", { "a.txt": "a" });
			const dir = join(tmp.path, "registry");
			writeLocalRegistry(dir, [
				{ name: "draht-codex", distTags: { latest: "3.0.0" }, versions: [{ version: "3.0.0", tarball }] },
			]);
			const client = createLocalRegistryClient(dir);
			const resolved = await client.resolve("draht-codex", "latest");

			let fetches = 0;
			const counting = {
				...client,
				fetchTarball: async (pkg: typeof resolved) => {
					fetches += 1;
					return client.fetchTarball(pkg);
				},
			};

			const root = join(tmp.path, "install");
			const first = await materializeFromCache(root, resolved, counting);
			const second = await materializeFromCache(root, resolved, counting);

			expect(first).toBe(second);
			expect(fetches).toBe(1);
			expect(readFileSync(join(first, "a.txt"), "utf8")).toBe("a");
		} finally {
			tmp.dispose();
		}
	});

	it("keys the cache by integrity, so two versions never collide", async () => {
		const a = { name: "x", version: "1.0.0", tarballUrl: "u", integrity: "sha512-AAAA" };
		const b = { name: "x", version: "1.0.0", tarballUrl: "u", integrity: "sha512-BBBB" };

		expect(payloadCachePath("/root", a)).not.toBe(payloadCachePath("/root", b));
	});

	it("re-extracts when a previous extraction was interrupted before completion", async () => {
		const tmp = tempRoot("cache");
		try {
			const tarball = createPackageTarGz("draht-codex", "3.0.0", { "a.txt": "a" });
			const dir = join(tmp.path, "registry");
			writeLocalRegistry(dir, [
				{ name: "draht-codex", distTags: { latest: "3.0.0" }, versions: [{ version: "3.0.0", tarball }] },
			]);
			const client = createLocalRegistryClient(dir);
			const resolved = await client.resolve("draht-codex", "latest");
			const root = join(tmp.path, "install");

			const path = await materializeFromCache(root, resolved, client);
			// Simulate a torn extraction: content present, completion marker gone.
			writeFileSync(join(path, "a.txt"), "corrupted");
			rmSync(join(path, ".complete"), { force: true });

			const again = await materializeFromCache(root, resolved, client);
			expect(readFileSync(join(again, "a.txt"), "utf8")).toBe("a");
		} finally {
			tmp.dispose();
		}
	});

	it("revalidates completed cache bytes and re-extracts modified content", async () => {
		const tmp = tempRoot("cache");
		try {
			const tarball = createPackageTarGz("draht-codex", "3.0.0", { "a.txt": "a" });
			const dir = join(tmp.path, "registry");
			writeLocalRegistry(dir, [
				{ name: "draht-codex", distTags: { latest: "3.0.0" }, versions: [{ version: "3.0.0", tarball }] },
			]);
			const client = createLocalRegistryClient(dir);
			const resolved = await client.resolve("draht-codex", "latest");
			let fetches = 0;
			const counting = {
				...client,
				fetchTarball: async (pkg: typeof resolved) => {
					fetches += 1;
					return client.fetchTarball(pkg);
				},
			};
			const root = join(tmp.path, "install");
			const path = await materializeFromCache(root, resolved, counting);
			writeFileSync(join(path, "a.txt"), "modified-under-intact-marker");

			const again = await materializeFromCache(root, resolved, counting);

			expect(fetches).toBe(2);
			expect(readFileSync(join(again, "a.txt"), "utf8")).toBe("a");
		} finally {
			tmp.dispose();
		}
	});
});
