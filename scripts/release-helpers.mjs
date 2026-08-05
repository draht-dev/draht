import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXPECTED_GRAPH_RELEASE_ASSETS = Object.freeze([
	"manifest.json",
	"SHA256SUMS",
	"draht-graph-darwin-arm64.tar.gz",
	"draht-graph-darwin-x64.tar.gz",
	"draht-graph-linux-x64.tar.gz",
	"draht-graph-linux-arm64.tar.gz",
	"draht-graph-windows-x64.zip",
]);

export const SCOPE_TO_PACKAGES = Object.freeze({
	ai: ["ai"],
	tui: ["tui"],
	agent: ["agent"],
	"agent-core": ["agent"],
	"coding-agent": ["coding-agent"],
	"draht-claude": ["draht-claude"],
	mom: ["mom"],
	pods: ["pods"],
	"web-ui": ["web-ui"],
	landing: ["landing"],
	infra: ["infra"],
	templates: ["templates"],
	go: ["coding-agent", "draht-claude", "draht-codex"],
});

const PLUGIN_MANIFESTS = Object.freeze([
	"packages/draht-claude/.claude-plugin/plugin.json",
	"packages/draht-codex/.codex-plugin/plugin.json",
]);

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value, indent = "\t") {
	writeFileSync(path, `${JSON.stringify(value, null, indent)}\n`);
}

export function getScopePackages(scope) {
	return SCOPE_TO_PACKAGES[scope] ? [...SCOPE_TO_PACKAGES[scope]] : [];
}

export function assertReleaseVersions(root, version) {
	const stale = [];
	const rootPackage = join(root, "package.json");
	if (readJson(rootPackage).version !== version) stale.push(`${rootPackage} is not ${version}`);
	for (const dirent of readdirSync(join(root, "packages"), { withFileTypes: true })) {
		if (!dirent.isDirectory()) continue;
		const packagePath = join(root, "packages", dirent.name, "package.json");
		if (existsSync(packagePath)) {
			const actual = readJson(packagePath).version;
			if (actual !== version) stale.push(`${packagePath} has ${actual}; expected ${version}`);
		}
	}
	for (const relativePath of PLUGIN_MANIFESTS) {
		const manifestPath = join(root, relativePath);
		const actual = readJson(manifestPath).version;
		if (actual !== version) stale.push(`${manifestPath} has ${actual}; expected ${version}`);
	}
	if (stale.length) throw new Error(`Release version surfaces are stale:\n${stale.join("\n")}`);
}

export function setVersion(root, version) {
	const packagesDir = join(root, "packages");
	const packageDirs = readdirSync(packagesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	const packages = [];
	const versionMap = {};
	for (const dir of packageDirs) {
		const packagePath = join(packagesDir, dir.name, "package.json");
		if (!existsSync(packagePath)) continue;
		const pkg = readJson(packagePath);
		pkg.version = version;
		versionMap[pkg.name] = version;
		packages.push({ packagePath, pkg });
	}
	for (const { packagePath, pkg } of packages) {
		for (const field of ["dependencies", "devDependencies"]) {
			for (const [name, current] of Object.entries(pkg[field] ?? {})) {
				if (versionMap[name] && typeof current === "string" && !current.startsWith("workspace:")) pkg[field][name] = `^${version}`;
			}
		}
		writeJson(packagePath, pkg);
	}
	const rootPackagePath = join(root, "package.json");
	const rootPackage = readJson(rootPackagePath);
	rootPackage.version = version;
	writeJson(rootPackagePath, rootPackage, 2);
	for (const relativePath of PLUGIN_MANIFESTS) {
		const manifestPath = join(root, relativePath);
		const manifest = readJson(manifestPath);
		manifest.version = version;
		writeJson(manifestPath, manifest, 2);
	}
	assertReleaseVersions(root, version);
}

export function missingReleaseAssets(assets) {
	const names = new Set(assets.map((asset) => (typeof asset === "string" ? asset : asset.name)));
	return EXPECTED_GRAPH_RELEASE_ASSETS.filter((name) => !names.has(name));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForReleaseAssets({ tag, listAssets, attempts = 60, intervalMs = 10_000, sleep = delay }) {
	let missing = [...EXPECTED_GRAPH_RELEASE_ASSETS];
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const assets = await listAssets(tag);
			missing = missingReleaseAssets(assets);
			if (missing.length === 0) return assets;
		} catch (error) {
			if (attempt === attempts) throw new Error(`Release ${tag} was not available: ${error.message}`, { cause: error });
		}
		if (attempt < attempts) await sleep(intervalMs);
	}
	throw new Error(`Release ${tag} is missing required graph assets: ${missing.join(", ")}`);
}

export function listGithubReleaseAssets(tag) {
	const output = execFileSync("gh", ["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return output.trim().split("\n").filter(Boolean);
}
