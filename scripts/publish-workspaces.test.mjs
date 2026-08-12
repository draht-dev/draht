import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishWorkspaces, topologicallySortPublicPackages } from "./publish-workspaces.mjs";

const packages = new Map([
  ["app", { dir: "app", pkg: { name: "app", version: "1.0.0", dependencies: { lib: "workspace:*" } } }],
  ["lib", { dir: "lib", pkg: { name: "lib", version: "1.0.0", dependencies: { core: "workspace:*" } } }],
  ["core", { dir: "core", pkg: { name: "core", version: "1.0.0" } }],
]);

test("public workspaces are topologically sorted dependency-first", () => {
  assert.deepEqual(topologicallySortPublicPackages(packages).map(({ pkg }) => pkg.name), ["core", "lib", "app"]);
});

test("installer staging rewrites @draht/tools exactly and restores the source manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "draht-install-publish-"));
  try {
    const toolsDir = join(root, "packages", "draht-tools");
    const installDir = join(root, "packages", "install");
    mkdirSync(toolsDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(toolsDir, "package.json"), `${JSON.stringify({ name: "@draht/tools", version: "2026.8.12-1" })}\n`);
    const original = `${JSON.stringify({
      name: "@draht/install",
      version: "2026.8.12-1",
      dependencies: { "@draht/tools": "workspace:*", zod: "^3.25.0" },
    }, null, 2)}\n`;
    const installManifest = join(installDir, "package.json");
    writeFileSync(installManifest, original);
    let staged;

    await publishWorkspaces({
      root,
      dryRun: true,
      run: async (command, args, options) => {
        if (command === "npm" && args[0] === "pack" && options.cwd === installDir) {
          staged = JSON.parse(readFileSync(installManifest, "utf8"));
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(staged.dependencies["@draht/tools"], "2026.8.12-1");
    assert.doesNotMatch(JSON.stringify(staged), /workspace:/);
    assert.equal(readFileSync(installManifest, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all packages prepack and preflight before the first publish", async () => {
  const calls = [];
  await publishWorkspaces({ packages, run: async (command, args, options) => {
    calls.push([command, ...args]);
    if (command === "npm" && args[0] === "view") return { status: 1, stdout: "", stderr: "E404" };
    return { status: 0, stdout: "", stderr: "" };
  }, rewrite: () => {}, restore: () => {} });
  const firstPublish = calls.findIndex((call) => call[0] === "bun" && call[1] === "publish" && !call.includes("--dry-run"));
  assert.ok(firstPublish > 0);
  assert.equal(calls.slice(0, firstPublish).filter((call) => call[0] === "npm" && call[1] === "pack").length, 3);
  assert.equal(calls.slice(0, firstPublish).filter((call) => call[0] === "bun" && call[1] === "publish" && call.includes("--dry-run")).length, 3);
});

test("preflight failure prevents every publication", async () => {
  const calls = [];
  await assert.rejects(publishWorkspaces({ packages, run: async (command, args, options) => {
    calls.push([command, ...args]);
    if (command === "npm" && args[0] === "pack" && options.cwd.endsWith("/lib")) return { status: 1, stdout: "", stderr: "bad pack" };
    if (command === "npm" && args[0] === "view") return { status: 1, stdout: "", stderr: "E404" };
    return { status: 0, stdout: "", stderr: "" };
  }, rewrite: () => {}, restore: () => {} }), /prepack.*lib/i);
  assert.equal(calls.some((call) => call[0] === "bun" && call[1] === "publish" && !call.includes("--dry-run")), false);
});

test("publishing stops at first failure and exact existing versions are skipped on resume", async () => {
  const calls = [];
  await assert.rejects(publishWorkspaces({ packages, run: async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (command === "npm" && args[0] === "view") {
      return args[1] === "core@1.0.0" ? { status: 0, stdout: '"1.0.0"', stderr: "" } : { status: 1, stdout: "", stderr: "E404" };
    }
    if (command === "bun" && args[0] === "publish" && !args.includes("--dry-run") && options.cwd.endsWith("/lib")) return { status: 1, stdout: "", stderr: "denied" };
    return { status: 0, stdout: "", stderr: "" };
  }, rewrite: () => {}, restore: () => {} }), /publish.*lib/i);
  const realPublishes = calls.filter((call) => call.command === "bun" && call.args[0] === "publish" && !call.args.includes("--dry-run"));
  assert.equal(realPublishes.some((call) => call.cwd.endsWith("/core")), false);
  assert.equal(realPublishes.some((call) => call.cwd.endsWith("/app")), false);
});
