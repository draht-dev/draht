import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const ISOLATION_VERSION: "linux-user-mount-pid-net-ipc-chroot-v1";
export interface IsolationProcessOptions {
	stdin?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	onData?: (chunk: Buffer) => void;
}
export interface IsolationProcessResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error: string | null;
	timedOut: boolean;
	elapsedMs: number;
}
export interface IsolationStat {
	isDirectory: boolean;
	isFile: boolean;
	isSymbolicLink: boolean;
}
export interface Isolation {
	workspace: string;
	nodePath: string;
	shellPath: string;
	workerPath: string;
	evidence: {
		policy: typeof ISOLATION_VERSION;
		workspace: string;
		runtimeRoots: string[];
		workerSha256: string;
		network: string;
		hostProc: false;
		inheritedEnvironment: false;
		readonlyArtifactsPath: "/.drahtbank/artifacts";
	};
	retainReadOnlyFile(hostPath: string): string;
	dispose(): void;
	resolveExecutable(name: string): string;
	spawn(argv: string[], options?: { signal?: AbortSignal }): ChildProcessWithoutNullStreams;
	run(argv: string[], options?: IsolationProcessOptions): Promise<IsolationProcessResult>;
	runSync(argv: string[], options?: Omit<IsolationProcessOptions, "signal">): IsolationProcessResult;
	fs(request: { op: "read"; path: string }, options?: IsolationProcessOptions): Promise<string>;
	fs(request: { op: "stat"; path: string }, options?: IsolationProcessOptions): Promise<IsolationStat>;
	fs(request: { op: "readdir"; path: string }, options?: IsolationProcessOptions): Promise<string[]>;
	fs(request: { op: "write"; path: string; content: string; encoding?: "utf8" | "base64" }, options?: IsolationProcessOptions): Promise<null>;
	fs(request: { op: "access"; path: string; mode?: number } | { op: "mkdir"; path: string }, options?: IsolationProcessOptions): Promise<null>;
}
export function createIsolation(workspace: string): Promise<Isolation>;
