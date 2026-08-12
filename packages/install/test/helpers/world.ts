import {
	chmodSync,
	type Dirent,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type RunCliOptions, runCli } from "../../src/run-cli.ts";
import { createLocalRegistryClient } from "../../src/sources/local.ts";
import type { RegistryClient } from "../../src/sources/types.ts";
import { writeLocalRegistry } from "./registry.ts";
import { createStubHost, type StubHost, type StubRule } from "./stub-host.ts";
import { createPackageTarGz } from "./tar-fixture.ts";

export const CLAUDE_MARKETPLACE_EMPTY = JSON.stringify([]);
export const CLAUDE_MARKETPLACE_REGISTERED = JSON.stringify([{ name: "draht" }]);
export const CLAUDE_PLUGIN_ABSENT = JSON.stringify([]);
export const CLAUDE_PLUGIN_INSTALLED = JSON.stringify([{ name: "draht", marketplace: "draht", enabled: true }]);
export const CODEX_MARKETPLACE_EMPTY = JSON.stringify({ marketplaces: [] });
export const CODEX_PLUGIN_ABSENT = JSON.stringify({ installed: [] });
export const CODEX_PLUGIN_INSTALLED = JSON.stringify({ installed: [{ name: "draht", marketplace: "draht" }] });

/** Host answers for a first install that then verifies as installed — the common case. */
export function claudeHappyPath(): StubRule[] {
	return [
		{ match: "plugin marketplace list --json", respond: [{ stdout: CLAUDE_MARKETPLACE_EMPTY }] },
		{ match: "plugin list --json", respond: [{ stdout: CLAUDE_PLUGIN_ABSENT }, { stdout: CLAUDE_PLUGIN_INSTALLED }] },
	];
}

/** Host answers for an uninstall the host genuinely honours. */
export function claudeCleanUninstall(): StubRule[] {
	return [
		{ match: "plugin list --json", respond: { stdout: CLAUDE_PLUGIN_ABSENT } },
		{ match: "plugin marketplace list --json", respond: { stdout: CLAUDE_MARKETPLACE_EMPTY } },
	];
}

export interface World {
	home: string;
	root: string;
	binDir: string;
	registryDir: string;
	registry: RegistryClient;
	/** Every registry metadata resolution — strict dry-run proof reads this. */
	registryResolves: string[];
	/** Tarball fetches the engine performed — dry-run proof reads this. */
	tarballFetches: string[];
	host: StubHost;
	env: NodeJS.ProcessEnv;
	claudeTarget: string;
	dispose: () => void;
	/** Runs the CLI against this world, capturing output. */
	run: (
		argv: string[],
		overrides?: Partial<RunCliOptions> & { isTTY?: boolean; confirm?: () => Promise<boolean> },
	) => Promise<{
		code: number;
		stdout: string;
		stderr: string;
	}>;
	/** Every file under HOME with its sha256 — used to prove dry-run writes nothing. */
	snapshotHome: () => Record<string, string>;
}

function stubExecutable(dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
}

export interface WorldOptions {
	/** Executables to place on the controlled PATH. */
	hosts?: string[];
	/** Stub host responses. */
	responses?: StubRule[];
	/** Package versions the fixture registry serves. */
	versions?: Record<string, string>;
	/** Extra files inside each served package payload. */
	payloadFiles?: Record<string, string>;
	/** Replaces the generated tarball for a package, e.g. with a malicious archive. */
	tarballs?: Record<string, Buffer>;
}

const PACKAGES = ["draht-claude", "draht-codex", "@draht/coding-agent", "@draht/install"];

/**
 * A complete hermetic installation environment: fake HOME, controlled PATH,
 * an on-disk fixture registry, and a recording host runner. Nothing here
 * touches the real home directory, the real PATH, or any network.
 */
export function createWorld(options: WorldOptions = {}): World {
	const base = mkdtempSync(join(tmpdir(), "draht-world-"));
	const home = join(base, "home");
	const binDir = join(base, "bin");
	const registryDir = join(base, "registry");
	mkdirSync(home, { recursive: true });
	mkdirSync(binDir, { recursive: true });

	for (const host of options.hosts ?? ["claude", "npm", "node"]) {
		stubExecutable(binDir, host);
	}

	const versions = options.versions ?? {};
	writeLocalRegistry(
		registryDir,
		PACKAGES.map((name) => {
			const version = versions[name] ?? "2026.8.1-1";
			return {
				name,
				distTags: { latest: version },
				versions: [
					{
						version,
						tarball:
							options.tarballs?.[name] ??
							createPackageTarGz(name, version, { "plugin.md": `payload for ${name}`, ...options.payloadFiles }),
					},
				],
			};
		}),
	);

	const inner = createLocalRegistryClient(registryDir);
	const registryResolves: string[] = [];
	const tarballFetches: string[] = [];
	const registry: RegistryClient = {
		resolve: (name, channel) => {
			registryResolves.push(`${name}:${channel}`);
			return inner.resolve(name, channel);
		},
		fetchTarball: (pkg) => {
			tarballFetches.push(`${pkg.name}@${pkg.version}`);
			return inner.fetchTarball(pkg);
		},
	};

	const host = createStubHost(options.responses ?? claudeHappyPath());
	const root = join(home, ".draht", "install");
	const env: NodeJS.ProcessEnv = { HOME: home, DRAHT_HOME: home, PATH: binDir };

	return {
		home,
		root,
		binDir,
		registryDir,
		registry,
		registryResolves,
		tarballFetches,
		host,
		env,
		claudeTarget: join(home, ".draht", "claude-marketplace"),
		dispose: () => rmSync(base, { recursive: true, force: true }),

		async run(argv, overrides = {}) {
			let stdout = "";
			let stderr = "";
			const { isTTY = false, confirm, ...rest } = overrides;
			const code = await runCli({
				argv,
				binName: "draht-install",
				env,
				cwd: home,
				registry,
				hostRunner: host.runner,
				...rest,
				io: {
					stdout: (chunk) => {
						stdout += chunk;
					},
					stderr: (chunk) => {
						stderr += chunk;
					},
					isTTY,
					confirm,
				},
			});
			return { code, stdout, stderr };
		},

		snapshotHome() {
			const result: Record<string, string> = {};
			const walk = (dir: string): void => {
				let entries: Dirent[];
				try {
					entries = readdirSync(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const entry of entries) {
					const full = join(dir, entry.name);
					if (entry.isDirectory()) {
						walk(full);
					} else if (entry.isFile()) {
						result[relative(home, full)] = `${statSync(full).size}:${readFileSync(full, "utf8").length}`;
					}
				}
			};
			walk(home);
			return result;
		},
	};
}
