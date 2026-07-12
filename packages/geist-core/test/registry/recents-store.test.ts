import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../../src/project.js";
import { FileRecentsStore, InMemoryRecentsStore, RECENTS_CAP, touchRecents } from "../../src/registry/recents-store.js";

const fr3n: Project = { slug: "fr3n", name: "fr3n", root: "/dev/fr3n" };
const kintura: Project = { slug: "kintura", name: "Kintura", root: "/dev/kintura" };
const draht: Project = { slug: "draht", name: "draht", root: "/dev/draht" };

describe("InMemoryRecentsStore", () => {
	test("starts empty", () => {
		const store = new InMemoryRecentsStore();
		expect(store.load()).toEqual([]);
	});

	test("save() then load() round-trips", () => {
		const store = new InMemoryRecentsStore();
		store.save([fr3n, kintura]);
		expect(store.load()).toEqual([fr3n, kintura]);
	});

	test("load() returns a fresh copy, not the live internal array", () => {
		const store = new InMemoryRecentsStore();
		store.save([fr3n]);
		const loaded = store.load();
		loaded.push(kintura);
		expect(store.load()).toEqual([fr3n]);
	});
});

describe("touchRecents", () => {
	test("prepends a new project as most-recently-used", () => {
		const result = touchRecents([kintura], fr3n);
		expect(result).toEqual([fr3n, kintura]);
	});

	test("bumps an existing entry to the front instead of duplicating it", () => {
		const result = touchRecents([fr3n, kintura], kintura);
		expect(result).toEqual([kintura, fr3n]);
	});

	test("caps the result at the given cap, dropping the oldest entries", () => {
		const result = touchRecents([kintura, draht], fr3n, 2);
		expect(result).toEqual([fr3n, kintura]);
	});

	test("defaults to RECENTS_CAP when no cap is given", () => {
		const existing = Array.from({ length: RECENTS_CAP }, (_, i) => ({
			slug: `p${i}`,
			name: `p${i}`,
			root: `/dev/p${i}`,
		}));

		const result = touchRecents(existing, fr3n);

		expect(result.length).toBe(RECENTS_CAP);
		expect(result[0]).toEqual(fr3n);
	});
});

describe("FileRecentsStore", () => {
	let dir: string;
	let filePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "recents-store-test-"));
		filePath = join(dir, "nested", "recents.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("load() returns an empty list when the file does not exist yet", () => {
		const store = new FileRecentsStore(filePath);
		expect(store.load()).toEqual([]);
	});

	test("save() creates parent directories and writes real JSON to disk", () => {
		const store = new FileRecentsStore(filePath);
		store.save([fr3n, kintura]);

		const raw = readFileSync(filePath, "utf-8");
		expect(JSON.parse(raw)).toEqual([fr3n, kintura]);
	});

	test("save() then load() round-trips through a real file", () => {
		const store = new FileRecentsStore(filePath);
		store.save([fr3n, kintura]);

		const reopened = new FileRecentsStore(filePath);
		expect(reopened.load()).toEqual([fr3n, kintura]);
	});

	test("load() degrades to an empty list for malformed JSON content", () => {
		const store = new FileRecentsStore(filePath);
		store.save([]); // creates the parent dir
		writeFileSync(filePath, "{not valid json", "utf-8");

		expect(store.load()).toEqual([]);
	});

	test("load() degrades to an empty list when the JSON is valid but not a Project array", () => {
		const store = new FileRecentsStore(filePath);
		store.save([]); // creates the parent dir
		writeFileSync(filePath, JSON.stringify({ oops: "not an array" }), "utf-8");

		expect(store.load()).toEqual([]);
	});

	test("load() filters out array entries that don't look like a Project", () => {
		const store = new FileRecentsStore(filePath);
		store.save([]); // creates the parent dir
		writeFileSync(filePath, JSON.stringify([fr3n, { slug: "bad" }, 42, kintura]), "utf-8");

		expect(store.load()).toEqual([fr3n, kintura]);
	});
});
