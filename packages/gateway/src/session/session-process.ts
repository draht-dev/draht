/**
 * ProcessStatus — value object representing the lifecycle state of a SessionProcess.
 *
 * - 'starting' : process has been spawned but not yet confirmed running
 * - 'running'  : process is active and accepting I/O
 * - 'stopped'  : process has exited (naturally or via kill)
 */
export type ProcessStatus = "starting" | "running" | "stopped";

/** Callback signature for stdout output subscribers. */
export type OutputCallback = (data: string) => void;

/** Unsubscribe function returned by onOutput(). */
export type Unsubscribe = () => void;

/**
 * SessionProcess — a process-owning value object wrapping a Bun.spawn subprocess.
 *
 * Manages the full `starting → running → stopped` lifecycle and provides a
 * subscriber-based stdout fan-out mechanism. Stdin is forwarded synchronously
 * via write().
 *
 * ## THIS IS NOT AN EXEC SURFACE, AND THAT IS NOW A PROPERTY RATHER THAN A HOPE
 *
 * It takes a command array and hands it to `Bun.spawn`, which resolves a bare
 * name through the inherited `PATH`. That was reachable from the wire until
 * R35-ALWAYS.9: `POST /sessions/:id/input` lazily ran `["draht", "start"]`
 * through here. That call site is gone (see `gateway/routes/sessions.ts`), and
 * `POST /sessions` has refused a caller-supplied `command` since R32-FLEET.8,
 * so no HTTP request now reaches this constructor.
 *
 * The one place this daemon deliberately creates a process is
 * `session/spawn-primitive.ts` — canonical absolute executable, argv array,
 * allowlisted environment, deadlines and TERM→KILL of the process tree — and it
 * does not use this class, because none of those properties can be added to a
 * constructor whose contract is "run this command array".
 *
 * `env` exists so a caller that DOES construct one can decline to hand the child
 * its own environment. It is optional, and omitting it inherits, because the
 * remaining callers are tests that spawn `echo` and `cat`; a required argument
 * would be a change with no security value and a lot of churn.
 */
export class SessionProcess {
	/** The underlying Bun subprocess. */
	readonly #proc: ReturnType<typeof Bun.spawn>;

	/** Current lifecycle state. */
	#status: ProcessStatus = "starting";

	/** Registered stdout output subscribers. */
	#subscribers = new Set<OutputCallback>();

	/** Buffer of all output for replay to new subscribers */
	#outputBuffer: string[] = [];

	/** Maximum buffer size (lines) */
	readonly #maxBufferLines = 10000;

	/**
	 * Resolves when status transitions to 'running' (next microtick after spawn).
	 */
	readonly ready: Promise<void>;

	/**
	 * Resolves when the process exits and status transitions to 'stopped'.
	 */
	readonly exited: Promise<void>;

	/**
	 * Spawn a new subprocess with the given command.
	 *
	 * @param command - Command and arguments array, e.g. ['cat'] or ['echo', 'hello'].
	 * @param cwd - Optional working directory for the process. Defaults to gateway's cwd.
	 * @param env - Optional complete environment for the child. Omitted means the
	 *              child inherits this process's, which is what every remaining
	 *              caller wants and what none of them is reachable from the wire by.
	 */
	constructor(command: string[], cwd?: string, env?: Record<string, string>) {
		this.#proc = Bun.spawn(command, {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			cwd,
			...(env === undefined ? {} : { env }),
		});

		// ready resolves on next microtick — process is considered running immediately
		// after spawn returns. Status is set to 'starting' synchronously in the field
		// initialiser above, then flipped to 'running' in the microtask.
		this.ready = Promise.resolve().then(() => {
			this.#status = "running";
		});

		// exited resolves when the native process exit promise settles, then marks stopped.
		this.exited = this.#proc.exited.then(() => {
			this.#status = "stopped";
		});

		// Start pumping stdout asynchronously — do not await here.
		void this.#pumpStdout();
	}

	/**
	 * Current lifecycle state of the process.
	 */
	get status(): ProcessStatus {
		return this.#status;
	}

	/**
	 * Register a subscriber to receive decoded stdout chunks.
	 *
	 * Each chunk is a UTF-8 decoded string segment. Subscribers are called in
	 * registration order. A subscriber added after process exit will never fire.
	 *
	 * NEW: Immediately replays all buffered output to the new subscriber before
	 * subscribing to live output.
	 *
	 * @param callback - Function invoked with each decoded stdout chunk.
	 * @returns An unsubscribe function; calling it removes the subscriber immediately.
	 */
	onOutput(callback: OutputCallback): Unsubscribe {
		// Replay buffered output to new subscriber
		for (const chunk of this.#outputBuffer) {
			callback(chunk);
		}

		this.#subscribers.add(callback);
		return () => {
			this.#subscribers.delete(callback);
		};
	}

	/**
	 * Write a string to the process stdin.
	 *
	 * Uses the Bun FileSink API: `.write()` + `.flush()` to ensure the data is
	 * delivered to the child process promptly.
	 *
	 * @param data - String to write to stdin.
	 */
	write(data: string): void {
		const stdin = this.#proc.stdin;
		if (stdin && typeof stdin === "object" && "write" in stdin) {
			(stdin as import("bun").FileSink).write(data);
			(stdin as import("bun").FileSink).flush();
		}
	}

	/**
	 * The exit code of the process, or `null` if the process has not yet exited.
	 *
	 * Delegates directly to the underlying Bun subprocess handle.
	 */
	get exitCode(): number | null {
		return this.#proc.exitCode;
	}

	/**
	 * Send SIGTERM to the process, initiating shutdown.
	 *
	 * After calling kill(), await `this.exited` to confirm the process has stopped.
	 */
	kill(): void {
		this.#proc.kill();
	}

	/**
	 * Pump stdout continuously, broadcasting decoded chunks to all subscribers.
	 *
	 * Runs as a fire-and-forget async loop; exits when the stdout stream is
	 * exhausted or an error occurs. On error, all subscribers are cleared to
	 * avoid dangling callbacks receiving no further output.
	 *
	 * NEW: Also buffers all output for replay to future subscribers.
	 */
	async #pumpStdout(): Promise<void> {
		const decoder = new TextDecoder();

		if (!this.#proc.stdout) return;

		const reader = (this.#proc.stdout as ReadableStream<Uint8Array>).getReader();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const text = decoder.decode(value, { stream: true });
				if (text.length > 0) {
					// Buffer the output for replay
					this.#outputBuffer.push(text);

					// Trim buffer if it gets too large
					if (this.#outputBuffer.length > this.#maxBufferLines) {
						this.#outputBuffer.shift();
					}

					// Fan out to current subscribers
					for (const cb of this.#subscribers) {
						cb(text);
					}
				}
			}
		} catch {
			// The stdout stream encountered an unexpected error (e.g. an internal
			// Bun stream failure). Clear subscribers so they are not left waiting
			// for output that will never arrive.
			this.#subscribers.clear();
		} finally {
			reader.releaseLock();
		}
	}
}
