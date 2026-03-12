import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type MapCodebaseResult, mapCodebase } from "../src/gsd/index.js";

const domainFixtureDir = path.join(import.meta.dirname, "fixtures", "domain-fixture");

function readStructuredResult(cwd: string): MapCodebaseResult {
	return mapCodebase(cwd);
}

function createTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFixtureCodebase(): string {
	const cwd = createTempDir("gsd-map-codebase-fixture-");
	const srcDir = path.join(cwd, "src");

	fs.mkdirSync(srcDir, { recursive: true });
	fs.cpSync(domainFixtureDir, srcDir, { recursive: true });
	fs.writeFileSync(
		path.join(cwd, "package.json"),
		JSON.stringify({ name: "domain-fixture-codebase", type: "module" }),
		"utf-8",
	);

	return cwd;
}

describe("mapCodebase integration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	it("extracts deterministic structured domain terms from the fixture codebase", () => {
		const cwd = createFixtureCodebase();
		tempDirs.push(cwd);

		const result = readStructuredResult(cwd);

		expect(result.entities).toEqual(expect.arrayContaining(["Customer", "Order", "OrderItem"]));
		expect(result.valueObjects).toEqual([]);
	});

	it("returns defined empty extraction arrays for an empty input", () => {
		const cwd = createTempDir("gsd-map-codebase-empty-");
		tempDirs.push(cwd);

		const result = readStructuredResult(cwd);

		expect(result.entities).toEqual([]);
		expect(result.valueObjects).toEqual([]);
	});

	it("fails in a defined way when the input path is missing", () => {
		const cwd = path.join(os.tmpdir(), `gsd-map-codebase-missing-${Date.now()}-${Math.random()}`);

		expect(() => mapCodebase(cwd)).toThrowError(/codebase path does not exist/i);
	});
});
