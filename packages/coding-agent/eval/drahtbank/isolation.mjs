import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
	readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ISOLATION_VERSION = "linux-user-mount-pid-net-ipc-chroot-v1";
const WORKER = fileURLToPath(new URL("./isolation-worker.mjs", import.meta.url));
const WORKER_PATH = "/.drahtbank/worker.mjs";
const NODE_RUNTIME_PATH = "/.drahtbank/bin/node";
const ARTIFACTS_PATH = "/.drahtbank/artifacts";
const MAX_OUTPUT = 10 * 1024 * 1024;
const MAX_FILESYSTEM_OUTPUT = Math.ceil(MAX_OUTPUT / 3) * 4 + 1024;
const RUNTIME_ROOTS = ["/nix/store", "/usr", "/bin", "/lib", "/lib64", "/run/current-system/sw"];
const SETUP = `
set -eu
root=$1
workspace=$2
worker=$3
chroot_bin=$4
setpriv_bin=$5
mount_bin=$6
mkdir_bin=$7
touch_bin=$8
shell_bin=$9
shift 9
root_count=$1
shift
artifacts=$1
shift
node_runtime=$1
shift
"$mount_bin" --make-rprivate /
"$mount_bin" -t tmpfs -o size=16m,nosuid,nodev,uid=0,gid=0 tmpfs "$root"
"$mkdir_bin" -p "$root/.drahtbank" "$root/dev" "$root$workspace"
while [ "$root_count" -gt 0 ]; do
	runtime=$1
	shift
	root_count=$((root_count - 1))
	"$mkdir_bin" -p "$root$runtime"
	"$mount_bin" --bind "$runtime" "$root$runtime"
	"$mount_bin" -o remount,bind,ro,nosuid,nodev "$root$runtime"
done
if [ -n "$node_runtime" ]; then
	"$mkdir_bin" -p "$root/.drahtbank/bin"
	"$touch_bin" "$root${NODE_RUNTIME_PATH}"
	"$mount_bin" --bind "$node_runtime" "$root${NODE_RUNTIME_PATH}"
	"$mount_bin" -o remount,bind,ro,nosuid,nodev "$root${NODE_RUNTIME_PATH}"
fi
"$touch_bin" "$root/.drahtbank/worker.mjs"
"$mount_bin" --bind "$worker" "$root/.drahtbank/worker.mjs"
"$mount_bin" -o remount,bind,ro,nosuid,nodev "$root/.drahtbank/worker.mjs"
"$mount_bin" --bind "$workspace" "$root$workspace"
"$mount_bin" -o remount,bind,rw,nosuid,nodev "$root$workspace"
if [ -n "$artifacts" ]; then
	"$mkdir_bin" -p "$root/.drahtbank/artifacts"
	"$mount_bin" --bind "$artifacts" "$root/.drahtbank/artifacts"
	"$mount_bin" -o remount,bind,ro,nosuid,nodev,noexec "$root/.drahtbank/artifacts"
fi
for device in null zero random urandom; do
	"$touch_bin" "$root/dev/$device"
	"$mount_bin" --bind "/dev/$device" "$root/dev/$device"
	"$mount_bin" -o remount,bind,nosuid,noexec "$root/dev/$device"
done
"$mount_bin" -o remount,bind,ro,nosuid,nodev "$root"
exec "$chroot_bin" "$root" "$setpriv_bin" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- "$shell_bin" --noprofile --norc -c 'cd -- "$1"; shift; exec "$@"' -- "$workspace" "$@"
`;

function contained(path, root) {
	const suffix = relative(root, path);
	return !suffix || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../"));
}

function unavailable(message) {
	return new Error(`Drahtbank isolation unavailable: ${message}`);
}

function checkedArgv(argv) {
	if (!Array.isArray(argv) || !argv.length || !argv[0] || argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
		throw new Error("Isolated command must be a nonempty literal argv array");
	}
	return argv;
}

function timeout(value = 30_000) {
	if (!Number.isInteger(value) || value < 1 || value > 3_600_000) throw new Error("Invalid isolation timeout");
	return value;
}

function rejectReservedWorkspace(workspace) {
	if (contained(workspace, "/.drahtbank") || contained("/.drahtbank", workspace)) {
		throw unavailable("workspace overlaps protected root /.drahtbank");
	}
}

function createExecutor(workspace) {
	if (process.platform !== "linux") throw unavailable(`unsupported platform ${process.platform}`);
	if (isAbsolute(workspace)) rejectReservedWorkspace(workspace);
	workspace = realpathSync(workspace);
	rejectReservedWorkspace(workspace);
	if (!statSync(workspace).isDirectory()) throw unavailable("workspace is not a directory");
	const runtimeRoots = RUNTIME_ROOTS.filter((path) => existsSync(path) && statSync(path).isDirectory());
	for (const root of ["/", homedir(), tmpdir(), ...runtimeRoots]) {
		if (contained(realpathSync(root), workspace) || (runtimeRoots.includes(root) && contained(workspace, realpathSync(root)))) {
			throw unavailable("workspace overlaps a protected root");
		}
	}
	const inspect = (directory) => {
		for (const name of readdirSync(directory)) {
			const path = join(directory, name);
			const entry = lstatSync(path);
			if (entry.isDirectory()) inspect(path);
			else if (entry.isFile()) {
				if (entry.nlink !== 1) throw unavailable("fixture contains a hardlinked file");
			} else if (!entry.isSymbolicLink()) {
				throw unavailable("fixture contains a socket, device, or other special file");
			}
		}
	};
	inspect(workspace);
	const runtimeAllows = (path) => runtimeRoots.some((root) => contained(path, realpathSync(root)));
	const resolveExecutable = (name) => {
		if (typeof name !== "string" || !/^[a-zA-Z0-9._+-]+$/.test(name)) throw unavailable("invalid executable name");
		const candidates = ["/run/current-system/sw/bin", "/usr/bin", "/bin", ...(process.env.PATH ?? "").split(delimiter)];
		for (const directory of candidates) {
			try {
				// Preserve the executable's basename: Nix coreutils uses symlinks to a
				// multicall binary whose real path does not identify the requested tool.
				const candidate = join(realpathSync(directory), name);
				if (!runtimeAllows(realpathSync(candidate)) || !statSync(candidate).isFile()) continue;
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {}
		}
		throw unavailable(`${name} is not available in a readonly runtime root`);
	};
	const bins = Object.fromEntries(["unshare", "bash", "chroot", "setpriv", "mount", "mkdir", "touch", "rg", "fd"].map((name) => [name, resolveExecutable(name)]));
	const sourceNodePath = realpathSync(process.execPath);
	if (contained(sourceNodePath, workspace)) throw unavailable("workspace overlaps Node executable");
	if (!statSync(sourceNodePath).isFile()) throw unavailable("Node executable is not a regular file");
	accessSync(sourceNodePath, constants.X_OK);
	const runtimeFiles = runtimeAllows(sourceNodePath) ? [] : [{ source: sourceNodePath, target: NODE_RUNTIME_PATH }];
	const nodePath = runtimeFiles[0]?.target ?? sourceNodePath;
	const paths = new Set([dirname(nodePath), ...Object.values(bins).map(dirname)]);
	for (const entry of (process.env.PATH ?? "").split(delimiter)) {
		try {
			const path = realpathSync(entry);
			if (runtimeAllows(path) && statSync(path).isDirectory()) paths.add(path);
		} catch {}
	}
	const env = {
		PATH: [...paths].join(delimiter), HOME: workspace, TMPDIR: workspace, TMP: workspace, TEMP: workspace,
		SHELL: bins.bash, PWD: workspace, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb",
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: dirname(workspace),
	};
	let artifactDirectory;
	let disposed = false;
	const children = new Set();
	const requireActive = () => {
		if (disposed) throw new Error("Drahtbank isolation has been disposed");
	};
	const retainReadOnlyFile = (source) => {
		requireActive();
		if (typeof source !== "string" || !isAbsolute(source) || contained(realpathSync(source), workspace)) {
			throw new Error("Readonly artifacts must be trusted capture files outside the fixture");
		}
		if (!lstatSync(source).isFile()) throw new Error("Readonly artifact must be a regular nonsymlink file");
		const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const entry = fstatSync(fd);
			if (!entry.isFile() || entry.size > MAX_OUTPUT) throw new Error("Readonly artifact must be a regular file of at most 10 MiB");
			const bytes = Buffer.alloc(MAX_OUTPUT + 1);
			let length = 0;
			for (;;) {
				const count = readSync(fd, bytes, length, bytes.length - length, null);
				length += count;
				if (length > MAX_OUTPUT) throw new Error("Readonly artifact exceeded 10 MiB");
				if (count === 0) break;
			}
			artifactDirectory ??= mkdtempSync(join(tmpdir(), "drahtbank-artifacts-"));
			const name = `${randomUUID()}.txt`;
			writeFileSync(join(artifactDirectory, name), bytes.subarray(0, length), { flag: "wx", mode: 0o600 });
			return `${ARTIFACTS_PATH}/${name}`;
		} finally {
			closeSync(fd);
		}
	};
	const invocation = (argv) => {
		requireActive();
		checkedArgv(argv);
		const root = mkdtempSync(join(tmpdir(), "drahtbank-root-"));
		const args = [
			"--user", "--map-root-user", "--mount", "--net", "--ipc", "--pid", "--fork", "--kill-child=KILL", "--",
			bins.bash, "--noprofile", "--norc", "-c", SETUP, "--",
			root, workspace, WORKER, bins.chroot, bins.setpriv, bins.mount, bins.mkdir, bins.touch, bins.bash,
			String(runtimeRoots.length), artifactDirectory ?? "", runtimeFiles[0]?.source ?? "", ...runtimeRoots, ...argv,
		];
		return { root, command: bins.unshare, args };
	};
	const spawn = (argv, options = {}) => {
		const built = invocation(argv);
		let child;
		try {
			child = spawnProcess(built.command, built.args, {
				cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"],
				signal: options.signal, killSignal: "SIGKILL",
			});
		} catch (error) {
			rmSync(built.root, { recursive: true, force: true });
			throw error;
		}
		children.add(child);
		// unshare ignores SIGTERM while waiting. Its death signal tears down PID 1,
		// which kills even detached descendants; ordinary tool cancellation must
		// therefore kill this supervisor rather than leave a namespace behind.
		const kill = child.kill.bind(child);
		child.kill = (signal) => kill(signal === undefined || signal === "SIGTERM" || signal === 15 ? "SIGKILL" : signal);
		child.once("close", () => {
			children.delete(child);
			rmSync(built.root, { recursive: true, force: true });
		});
		return child;
	};
	const runWithLimit = (argv, options, outputLimit) => new Promise((finish) => {
		const timeoutMs = timeout(options.timeoutMs);
		const started = performance.now();
		const child = spawn(argv);
		let stdout = "", stderr = "", error = null, timedOut = false, total = 0;
		const kill = () => {
			child.kill("SIGKILL");
		};
		const onAbort = () => { error = "Isolated process aborted"; kill(); };
		const timer = setTimeout(() => { timedOut = true; error = "Isolated process timed out"; kill(); }, timeoutMs);
		for (const [stream, key] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
			stream.setEncoding("utf8");
			stream.on("data", (chunk) => {
				total += Buffer.byteLength(chunk);
				if (total > outputLimit) { error = "Isolated process output exceeded its capture limit"; kill(); return; }
				options.onData?.(Buffer.from(chunk));
				if (key === "stdout") stdout += chunk; else stderr += chunk;
			});
		}
		child.once("error", (cause) => { error = cause.message; });
		child.stdin.on("error", () => {});
		child.once("close", (exitCode, signal) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			finish({ exitCode, signal, stdout, stderr, error, timedOut, elapsedMs: Math.round(performance.now() - started) });
		});
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin.end(options.stdin ?? "");
	});
	const run = (argv, options = {}) => runWithLimit(argv, options, MAX_OUTPUT);
	const runSync = (argv, options = {}) => {
		const started = performance.now();
		const timeoutMs = timeout(options.timeoutMs);
		const built = invocation(argv);
		try {
			const result = spawnSync(built.command, built.args, {
				cwd: workspace, env, encoding: "utf8", input: options.stdin ?? "",
				timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT,
			});
			return { exitCode: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
				error: result.error?.message ?? null, timedOut: result.error?.code === "ETIMEDOUT", elapsedMs: Math.round(performance.now() - started) };
		} finally {
			rmSync(built.root, { recursive: true, force: true });
		}
	};
	const fs = async (request, options = {}) => {
		const result = await runWithLimit([nodePath, WORKER_PATH], { ...options, stdin: JSON.stringify(request) }, MAX_FILESYSTEM_OUTPUT);
		if (result.error || result.exitCode !== 0) throw new Error(result.error ?? (result.stderr.trim() || "Isolated filesystem worker failed"));
		let response;
		try { response = JSON.parse(result.stdout); } catch { throw new Error("Invalid isolated filesystem response"); }
		if (response?.ok !== true) {
			const error = new Error(typeof response?.message === "string" ? response.message : "Isolated filesystem operation failed");
			if (typeof response?.code === "string") error.code = response.code;
			throw error;
		}
		return response.value;
	};
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		for (const child of children) child.kill("SIGKILL");
		if (artifactDirectory) rmSync(artifactDirectory, { recursive: true, force: true });
	};
	return {
		workspace, nodePath, shellPath: bins.bash, workerPath: WORKER_PATH, spawn, run, runSync, fs, resolveExecutable,
		retainReadOnlyFile, dispose,
		evidence: {
			policy: ISOLATION_VERSION, workspace, runtimeRoots, runtimeFiles,
			workerSha256: createHash("sha256").update(readFileSync(WORKER)).digest("hex"),
			network: "private namespace", hostProc: false, inheritedEnvironment: false,
			readonlyArtifactsPath: ARTIFACTS_PATH,
		},
	};
}

export async function createIsolation(workspace) {
	const executor = createExecutor(workspace);
	const probeRoot = mkdtempSync(join(tmpdir(), "drahtbank-isolation-probe-"));
	const probe = join(executor.workspace, `.drahtbank-isolation-${randomUUID()}`);
	const marker = join(probeRoot, "outside");
	const forbiddenWrite = join(probeRoot, "forbidden-write");
	mkdirSync(probe);
	writeFileSync(marker, "outside marker");
	symlinkSync(marker, join(probe, "escape"));
	try {
		const source = `
const fs = require("node:fs");
const assert = require("node:assert/strict");
const [probe, outside, forbidden] = process.argv.slice(1);
const local = probe + "/local";
fs.writeFileSync(local, "inside");
assert.equal(fs.readFileSync(local, "utf8"), "inside");
for (const path of [outside, probe + "/escape", "/proc/self/environ"]) {
	assert.throws(() => fs.readFileSync(path));
}
for (const path of [forbidden, probe + "/escape", "/.drahtbank/forbidden"]) {
	assert.throws(() => fs.writeFileSync(path, "escaped"));
}
const environment = new Set(${JSON.stringify(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SHELL", "PWD", "LANG", "LC_ALL", "TERM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CEILING_DIRECTORIES", "_", "SHLVL", "OLDPWD"])});
assert.ok(Object.keys(process.env).every((name) => environment.has(name)));
fs.unlinkSync(local);
process.stdout.write("confined");
`;
		const result = await executor.run([executor.nodePath, "-e", source, probe, marker, forbiddenWrite], { timeoutMs: 15_000 });
		if (result.exitCode !== 0 || result.error || result.stdout !== "confined") {
			throw unavailable(result.error ?? (result.stderr.trim() || `preflight exited ${result.exitCode}`));
		}
		if (readFileSync(marker, "utf8") !== "outside marker" || existsSync(forbiddenWrite)) {
			throw unavailable("outside filesystem changed during preflight");
		}
		await executor.fs({ op: "access", path: executor.workspace });
		return executor;
	} finally {
		rmSync(probe, { recursive: true, force: true });
		rmSync(probeRoot, { recursive: true, force: true });
	}
}
