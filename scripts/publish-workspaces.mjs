#!/usr/bin/env node
/** Publish public workspaces dependency-first, with an all-package reversible preflight. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

export function loadWorkspaces(root = process.cwd()) {
  const packages = new Map();
  for (const dirent of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const packagePath = join(root, "packages", dirent.name, "package.json");
    if (!existsSync(packagePath)) continue;
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    packages.set(pkg.name, { dir: dirent.name, packagePath, pkg });
  }
  return packages;
}

export function topologicallySortPublicPackages(packages) {
  const publicPackages = new Map([...packages].filter(([, entry]) => !entry.pkg.private));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (name) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Workspace dependency cycle contains ${name}`);
    visiting.add(name);
    const entry = publicPackages.get(name);
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependencyName of Object.keys(entry.pkg[field] ?? {})) {
        const dependency = packages.get(dependencyName);
        if (dependency?.pkg.private) throw new Error(`${name} (${field}) depends on private workspace ${dependencyName}`);
        if (publicPackages.has(dependencyName)) visit(dependencyName);
      }
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(entry);
  };
  for (const name of [...publicPackages.keys()].sort()) visit(name);
  return ordered;
}

function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: options.inherit ? "inherit" : "pipe" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function check(result, phase, name) {
  if (result.status !== 0) throw new Error(`${phase} failed for ${name}: ${(result.stderr || result.stdout).trim()}`);
}

export async function publishWorkspaces({
  root = process.cwd(), packages = loadWorkspaces(root), tag, access = "public", dryRun = false,
  run = defaultRun, rewrite, restore,
} = {}) {
  const ordered = topologicallySortPublicPackages(packages);
  const originals = new Map();
  const versionMap = new Map([...packages].map(([name, entry]) => [name, entry.pkg.version]));
  const rewritePackage = rewrite ?? ((entry) => {
    const packagePath = entry.packagePath ?? join(root, "packages", entry.dir, "package.json");
    const raw = readFileSync(packagePath, "utf8");
    const pkg = JSON.parse(raw);
    for (const field of [...DEPENDENCY_FIELDS, "devDependencies"]) {
      for (const [name, specifier] of Object.entries(pkg[field] ?? {})) {
        if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
          if (!versionMap.has(name)) throw new Error(`Cannot resolve workspace dependency ${name}`);
          pkg[field][name] = versionMap.get(name);
        }
      }
    }
    originals.set(packagePath, raw);
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, "\t")}\n`);
  });
  const restorePackages = restore ?? (() => {
    for (const [path, raw] of originals) writeFileSync(path, raw);
  });

  try {
    for (const entry of ordered) rewritePackage(entry);
    // No irreversible registry write occurs until every package can both pack and publish.
    for (const entry of ordered) {
      const cwd = join(root, "packages", entry.dir);
      check(await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd }), "Prepack", entry.pkg.name);
      const args = ["publish", "--dry-run", "--access", access];
      if (tag) args.push("--tag", tag);
      check(await run("bun", args, { cwd }), "Publish preflight", entry.pkg.name);
    }
    if (dryRun) return ordered.map(({ pkg }) => pkg.name);

    for (const entry of ordered) {
      const identity = `${entry.pkg.name}@${entry.pkg.version}`;
      const existing = await run("npm", ["view", identity, "version", "--json"], { cwd: root });
      if (existing.status === 0) {
        let published;
        try { published = JSON.parse(existing.stdout); } catch { throw new Error(`Registry returned malformed version for ${identity}`); }
        if (published !== entry.pkg.version) throw new Error(`Registry identity mismatch for ${identity}: ${published}`);
        console.log(`Skipping already-published exact version ${identity}`);
        continue;
      }
      const args = ["publish", "--access", access];
      if (tag) args.push("--tag", tag);
      check(await run("bun", args, { cwd: join(root, "packages", entry.dir), inherit: true }), "Publish", entry.pkg.name);
    }
    return ordered.map(({ pkg }) => pkg.name);
  } finally {
    restorePackages();
  }
}

const isMain = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  try {
    const names = await publishWorkspaces({ dryRun: args.includes("--dry-run"), tag: valueAfter("--tag"), access: valueAfter("--access") ?? "public" });
    console.log(`\n${args.includes("--dry-run") ? "Preflighted" : "Published"} ${names.length} packages dependency-first.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
