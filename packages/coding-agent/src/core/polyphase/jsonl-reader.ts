import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Bounded LF-only line reader for child JSON streams.
 *
 * Unlike `modes/rpc/jsonl.ts` (which buffers whole lines and is not reused here), this
 * reader discards known-noisy record prefixes before they are fully buffered, so a
 * multi-megabyte `agent_end`/`tool_execution_update` line never grows the retained
 * buffer past a small, bounded size.
 */
export interface ChildLineReaderOptions {
	/** Lines longer than this (chars) enter discard mode and call `onOversize`. Default 8 MiB. */
	maxLineChars: number;
	/** Known-noisy prefixes that are dropped without ever being handed to `onLine`. */
	skipPrefixes: readonly string[];
	onSkipped?: (prefix: string) => void;
	onOversize?: () => void;
}

export const DEFAULT_SKIP_PREFIXES: readonly string[] = [
	'{"type":"agent_end"',
	'{"type":"turn_end"',
	'{"type":"tool_execution_update"',
	'{"type":"entry_appended"',
	'{"type":"message_start","message":{"role":"toolResult"',
	'{"type":"message_end","message":{"role":"toolResult"',
	'{"type":"message_start","message":{"role":"user"',
	'{"type":"message_end","message":{"role":"user"',
	'{"type":"message_start","message":{"role":"system"',
	'{"type":"message_end","message":{"role":"system"',
];

const DEFAULT_MAX_LINE_CHARS = 8 * 1024 * 1024;

/** Chars of a still-open line needed before a skip-prefix match is attempted. */
const PREFIX_CHECK_THRESHOLD = 64;

export interface ChildLineReader {
	detach(): void;
	readonly maxBufferedChars: number;
	readonly skippedLines: number;
}

/**
 * Attach a bounded LF-only line reader to a child process stream.
 *
 * Framing is LF-only; a single trailing `\r` is stripped. U+2028/U+2029 are left
 * untouched inside lines. Handlers run synchronously and this function never throws.
 */
export function attachChildLineReader(
	stream: Readable,
	onLine: (line: string) => void,
	options?: Partial<ChildLineReaderOptions>,
): ChildLineReader {
	const maxLineChars = options?.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
	const skipPrefixes = options?.skipPrefixes ?? DEFAULT_SKIP_PREFIXES;
	const onSkipped = options?.onSkipped;
	const onOversize = options?.onOversize;
	// A caller-supplied prefix longer than the default threshold would otherwise never match while
	// the line is still streaming (the check only runs once the buffer reaches this many chars).
	const prefixCheckThreshold = skipPrefixes.reduce(
		(max, prefix) => Math.max(max, prefix.length),
		PREFIX_CHECK_THRESHOLD,
	);

	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let discarding = false;
	let skippedLines = 0;
	let maxBufferedChars = 0;

	function matchSkipPrefix(line: string): string | undefined {
		for (const prefix of skipPrefixes) {
			if (line.startsWith(prefix)) return prefix;
		}
		return undefined;
	}

	function recordBufferSize(): void {
		if (buffer.length > maxBufferedChars) maxBufferedChars = buffer.length;
	}

	function callHandler(handler: (() => void) | undefined): void {
		if (!handler) return;
		try {
			handler();
		} catch {
			// A bad onSkipped/onOversize/onLine handler must never break framing of the rest of the chunk.
		}
	}

	function enterDiscard(prefix: string | undefined): void {
		discarding = true;
		buffer = "";
		if (prefix !== undefined) {
			skippedLines++;
			callHandler(onSkipped ? () => onSkipped(prefix) : undefined);
		} else {
			callHandler(onOversize);
		}
	}

	function emit(rawLine: string): void {
		const prefix = matchSkipPrefix(rawLine);
		if (prefix !== undefined) {
			skippedLines++;
			callHandler(onSkipped ? () => onSkipped(prefix) : undefined);
			return;
		}
		if (rawLine.length > maxLineChars) {
			callHandler(onOversize);
			return;
		}
		callHandler(() => onLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine));
	}

	// Amortised O(bytes): each incoming chunk is scanned once with index arithmetic into
	// the chunk itself. The persisted `buffer` only ever holds an in-progress partial line,
	// and while that partial line is being grown toward the skip-prefix check threshold we
	// slice the chunk in small increments so a long skip-prefixed line never buffers more
	// than `prefixCheckThreshold` chars before `discarding` kicks in.
	function processChunk(chunk: string): void {
		let idx = 0;
		while (idx <= chunk.length) {
			if (discarding) {
				const nl = chunk.indexOf("\n", idx);
				if (nl === -1) return;
				discarding = false;
				idx = nl + 1;
				continue;
			}

			const nl = chunk.indexOf("\n", idx);
			if (nl === -1) {
				if (buffer.length < prefixCheckThreshold) {
					const need = prefixCheckThreshold - buffer.length;
					const take = Math.min(need, chunk.length - idx);
					if (take > 0) {
						buffer += chunk.slice(idx, idx + take);
						idx += take;
						recordBufferSize();
					}
					if (buffer.length >= prefixCheckThreshold) {
						const prefix = matchSkipPrefix(buffer);
						if (prefix !== undefined) {
							enterDiscard(prefix);
							continue;
						}
					}
				}
				if (idx < chunk.length) {
					buffer += chunk.slice(idx);
					idx = chunk.length;
					recordBufferSize();
					if (buffer.length > maxLineChars) {
						enterDiscard(undefined);
					}
				}
				return;
			}

			const rawLine = buffer + chunk.slice(idx, nl);
			buffer = "";
			emit(rawLine);
			idx = nl + 1;
		}
	}

	const onData = (chunk: string | Buffer) => {
		const decoded = typeof chunk === "string" ? chunk : decoder.write(chunk);
		if (decoded.length > 0) processChunk(decoded);
	};

	const onEnd = () => {
		const tail = decoder.end();
		if (tail.length > 0) processChunk(tail);
		if (!discarding && buffer.length > 0) {
			const rawLine = buffer;
			buffer = "";
			emit(rawLine);
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return {
		detach(): void {
			stream.off("data", onData);
			stream.off("end", onEnd);
		},
		get maxBufferedChars(): number {
			return maxBufferedChars;
		},
		get skippedLines(): number {
			return skippedLines;
		},
	};
}
