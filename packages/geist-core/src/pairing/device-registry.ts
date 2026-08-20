import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	watch,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * The per-device credential store behind `geist pair` and `geist devices`
 * (R33-REACH.5, R33-REACH.6 — the credential half of GSEC-04).
 *
 * The shape of the thing this closes: a QR carries a *bootstrap* token, which
 * is short-lived and single-use. The phone spends it once, on first connect,
 * and gets back a device id plus a per-device credential. That credential is
 * rotated on every reconnect, and the predecessor dies the instant the
 * successor is minted. So a credential lifted off the wire, out of a
 * screenshot or out of a backup is worth one reconnect at most — and if the
 * thief and the owner both reconnect, one of them presents a rotated-away
 * predecessor and the registry says so out loud: `credential_reuse`, with the
 * device id, is the theft signal. Nothing else in this design detects theft;
 * that outcome is the whole reason rotation is mandatory rather than nice.
 *
 * Consequences that the code below is shaped by, not decorated with:
 *
 * - **Nothing stores a secret.** Bootstrap tokens and credentials are kept as
 *   salted SHA-256 digests. `list()` returns a projection that has no field
 *   capable of carrying credential material, and the emitted events carry a
 *   device id and never a credential — a theft alarm that leaks the stolen
 *   credential into a log line would be its own finding.
 * - **The file is the source of truth, not this object.** The daemon holds a
 *   long-lived registry while `geist devices revoke` runs in a *different
 *   process*; a revocation that only the CLI's copy knows about would leave
 *   the daemon happily authenticating a revoked phone. Every public method
 *   therefore re-stats the file first and reloads when it changed
 *   (`ensureFresh()`), which is what makes R33-REACH.6's "refused at its next
 *   frame, not merely at its next connect" true across processes.
 * - **And the file pushes, because "its next frame" is not enough.** A phone
 *   that has attached and gone quiet has no next frame; on an inbound-only
 *   reading it would keep receiving a session's output forever while the
 *   operator watched `geist devices list` say `revoked`. `subscribe()` is the
 *   other half: an fs watch on the directory the store is renamed into, which
 *   degrades to a bounded poll and *says so* rather than observing nothing.
 * - **Writes are atomic and 0600.** Temp file in the same directory, then
 *   `rename(2)`. A half-written credential store is an outage or an
 *   authentication bypass depending on where the write was interrupted; a
 *   rename is neither.
 *
 * Harness-free by construction: `node:crypto` and `node:fs` only, no
 * `@draht/*` beyond nothing at all — the transport that carries these tokens
 * lives in `@draht/geist` and the boundary gate keeps it there.
 */

/** Environment variable relocating the device store, so a test (or an operator) can point the daemon and the CLI at one file. */
export const DEVICE_REGISTRY_PATH_ENV = "GEIST_DEVICES_PATH";

/**
 * Default bootstrap TTL: two minutes. Long enough to raise a phone, focus the
 * camera and let the page load over a tailnet; short enough that a QR left on
 * screen, photographed over a shoulder or captured on a call recording is
 * dead before anyone can act on it. R33-REACH.4 says "short-TTL" and this is
 * the number that word means here.
 */
export const DEFAULT_BOOTSTRAP_TTL_MS = 120_000;

/**
 * How long a *spent or expired* bootstrap record is remembered. Keeping it
 * lets a replay be refused as `bootstrap_consumed` — a distinct, alarming
 * outcome — rather than as the indistinguishable `unknown_bootstrap` a
 * mistyped token also produces. Both refuse; only one is worth waking up for.
 */
const BOOTSTRAP_RETENTION_MS = 3_600_000;

/** Ceiling on remembered spent bootstraps, so a long-lived daemon's store cannot grow without bound. */
const MAX_REMEMBERED_BOOTSTRAPS = 32;

/**
 * How many rotated-away credentials per device stay recognisable. A
 * predecessor must be recognisable to raise `credential_reuse`; more than a
 * handful buys nothing, because a thief with a credential eight rotations old
 * has been locked out for eight reconnects already.
 */
const MAX_RETIRED_CREDENTIALS = 8;

/**
 * How often a degraded registry re-stats the store.
 *
 * R33-REACH.6 gives a revocation one second to reach a live connection. A
 * quarter of that leaves room for the reload, the policy check and the close,
 * and costs one `stat(2)` per interval per daemon whether or not anything
 * changed — which is the price of not silently observing nothing.
 */
const DEFAULT_POLL_INTERVAL_MS = 250;

/** Bytes of entropy behind bootstrap tokens and device credentials (256 bits, hex-encoded). */
const SECRET_BYTES = 32;

/** Bytes of entropy behind a device id. Not a secret — an identifier that must not collide. */
const DEVICE_ID_BYTES = 9;

/** Bytes of per-record salt. Salts stop one stolen digest from being recognisable across records. */
const SALT_BYTES = 16;

/** On-disk schema version. Bumped only when the persisted shape changes incompatibly. */
const STATE_VERSION = 1;

/** What the client tells the registry about itself at exchange time — display metadata, never trusted for authorization. */
export interface DeviceMeta {
	name: string;
	platform: string;
}

/** A freshly minted bootstrap token and the instant it stops being spendable. */
export interface BootstrapToken {
	token: string;
	/** Wall-clock ms. The token is spendable while `now < expiresAt`; at `expiresAt` it is already expired. */
	expiresAt: number;
}

export type ExchangeResult =
	| { ok: true; deviceId: string; credential: string }
	| { ok: false; reason: "unknown_bootstrap" | "bootstrap_expired" | "bootstrap_consumed" };

export type VerifyResult =
	| { ok: true; outcome: "ok"; deviceId: string }
	| { ok: false; outcome: "unknown_device" | "revoked" | "credential_reuse" | "credential_mismatch" };

export type RotateResult =
	| { ok: true; deviceId: string; credential: string }
	| { ok: false; reason: "unknown_device" | "revoked" };

export type RevokeResult = { ok: true; deviceId: string } | { ok: false; reason: "unknown_device" };

/** The `geist devices list` row. Every field here is safe to print, log and ship over the wire. */
export interface DeviceSummary {
	id: string;
	name: string;
	platform: string;
	/** Wall-clock ms of the last successful `verify()`, or of the exchange that minted the device. */
	lastSeen: number;
	revoked: boolean;
}

/**
 * Audit events. `credential_reuse` is the load-bearing one — the GSEC-04
 * theft signal. By construction none of these carries credential material:
 * there is no field to put it in.
 */
export type DeviceRegistryEvent = {
	type: "device_paired" | "credential_rotated" | "device_revoked" | "credential_reuse";
	deviceId: string;
	at: number;
};

/**
 * How this registry watches its own file.
 *
 * A seam rather than a direct `fs.watch` call for one reason: the interesting
 * case is the host where watching does *not* work — an exhausted inotify
 * budget, a network filesystem that reports no events, a sandbox that refuses
 * the syscall — and that case has to be reachable from a test, because a
 * watcher that silently observes nothing turns R33-REACH.6 into theatre.
 *
 * @param directory - Directory holding the store. Watched rather than the file
 *                    itself: every write lands by `rename(2)`, and a watch on
 *                    the old inode sees none of them.
 * @param onChange  - Called with the changed entry's name, or null on a host
 *                    that does not report one.
 * @param onError   - Called when the watch dies after being established. The
 *                    registry degrades to a poll from here too.
 */
export type DeviceRegistryWatchFactory = (
	directory: string,
	onChange: (filename: string | null) => void,
	onError: (error: unknown) => void,
) => { close(): void };

/** `fs.watch`, adapted to {@link DeviceRegistryWatchFactory}. */
const defaultWatchFactory: DeviceRegistryWatchFactory = (directory, onChange, onError) => {
	// `persistent: false`: observing a credential file must never be the reason
	// a daemon refuses to exit.
	const watcher = watch(directory, { persistent: false }, (_event, filename) =>
		onChange(filename === null || filename === undefined ? null : String(filename)),
	);
	watcher.on("error", onError);
	return watcher;
};

export interface DeviceRegistryOptions {
	/** Store location. Defaults to `resolveDeviceRegistryPath()`. */
	path?: string;
	/** Clock injection, for deterministic TTL tests. Defaults to `Date.now`. */
	now?: () => number;
	/** Audit sink. Never receives credential material. A throwing sink cannot break authentication. */
	onEvent?: (event: DeviceRegistryEvent) => void;
	/** How {@link DeviceRegistry.subscribe} watches the store. Defaults to `fs.watch`. */
	watchFactory?: DeviceRegistryWatchFactory;
	/** Interval of the fallback poll, in ms. Defaults to 250. */
	pollIntervalMs?: number;
	/**
	 * Where a degraded observation is reported. Defaults to `console.warn`.
	 *
	 * Not optional in effect, only in configuration: a store that cannot watch
	 * itself has lost the mechanism R33-REACH.6 depends on, and an operator who
	 * is not told has a revocation control that looks like it works.
	 */
	onDegraded?: (message: string) => void;
}

/** Thrown when the store exists but cannot be understood — see `load()` for why this is not degraded away. */
export class DeviceRegistryError extends Error {}

/**
 * Where this machine's device credentials live — a sibling of spec §6's
 * `~/.geist/config.yaml`. Exported so the daemon and `geist devices` resolve
 * the same path from the same code rather than agreeing by coincidence.
 *
 * @param env - Environment to read. Defaults to this process's.
 */
export function resolveDeviceRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[DEVICE_REGISTRY_PATH_ENV];
	if (override) return override;
	const home = env.HOME ?? homedir();
	return join(home, ".geist", "devices.json");
}

/** A salted digest of a secret. The secret itself is never persisted, held or logged. */
interface Digest {
	salt: string;
	hash: string;
}

interface BootstrapRecord extends Digest {
	createdAt: number;
	expiresAt: number;
	/** Wall-clock ms the token was spent, or `null` while it is still spendable. Set exactly once. */
	consumedAt: number | null;
	consumedByDeviceId: string | null;
}

interface DeviceRecord {
	id: string;
	name: string;
	platform: string;
	pairedAt: number;
	lastSeen: number;
	revoked: boolean;
	/** Salt for this device's credential digests. Stable for the device's life so retired digests stay comparable. */
	salt: string;
	/** Digest of the credential currently in force. */
	hash: string;
	/** Digests of credentials this device has rotated away from — presenting one is theft, not error. */
	retiredHashes: string[];
}

interface RegistryState {
	version: number;
	devices: DeviceRecord[];
	bootstraps: BootstrapRecord[];
}

function emptyState(): RegistryState {
	return { version: STATE_VERSION, devices: [], bootstraps: [] };
}

function randomSecret(): string {
	return randomBytes(SECRET_BYTES).toString("hex");
}

function digest(secret: string, salt: string): string {
	return createHash("sha256").update(salt).update(":").update(secret).digest("hex");
}

/**
 * Constant-time digest comparison. Both operands are hex SHA-256, so they are
 * always 64 characters and `timingSafeEqual`'s length precondition holds —
 * but the guard stays, because the *inputs* that produced `presented` are
 * attacker-controlled and a future caller passing a raw credential here would
 * otherwise turn a wrong guess into a thrown exception (and a length oracle).
 */
function digestsMatch(presented: string, stored: string): boolean {
	const a = Buffer.from(presented, "utf-8");
	const b = Buffer.from(stored, "utf-8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** An error, as a log line. Never interpolated into anything a caller is told. */
function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Identity of the file we last read, used to notice an out-of-process write. */
interface FileIdentity {
	ino: string;
	size: string;
	mtimeNs: string;
}

function readIdentity(filePath: string): FileIdentity | null {
	try {
		const stats = statSync(filePath, { bigint: true });
		return { ino: String(stats.ino), size: String(stats.size), mtimeNs: String(stats.mtimeNs) };
	} catch {
		return null;
	}
}

function sameIdentity(a: FileIdentity | null, b: FileIdentity | null): boolean {
	if (a === null || b === null) return a === b;
	return a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

export class DeviceRegistry {
	private readonly filePath: string;
	private readonly now: () => number;
	private readonly onEvent: ((event: DeviceRegistryEvent) => void) | undefined;

	private readonly watchFactory: DeviceRegistryWatchFactory;
	private readonly pollIntervalMs: number;
	private readonly onDegraded: (message: string) => void;

	private state: RegistryState | null = null;
	private loadedFrom: FileIdentity | null = null;

	/** Everyone waiting to hear that the store changed underneath them. */
	private readonly listeners = new Set<() => void>();
	/** The live watch, or null while nobody is subscribed or the watch is dead. */
	private watcher: { close(): void } | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	/** How the store is being observed right now. */
	private observing: "idle" | "watch" | "poll" = "idle";
	/** Identity of the file as of the last notification, so a change is told from a re-read. */
	private observed: FileIdentity | null = null;

	constructor(options: DeviceRegistryOptions = {}) {
		this.filePath = options.path ?? resolveDeviceRegistryPath();
		this.now = options.now ?? Date.now;
		this.onEvent = options.onEvent;
		this.watchFactory = options.watchFactory ?? defaultWatchFactory;
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.onDegraded = options.onDegraded ?? ((message: string) => console.warn(message));
	}

	/** Where this registry persists. Exposed so an operator-facing command can print it. */
	get path(): string {
		return this.filePath;
	}

	/**
	 * Mints a single-use, short-TTL bootstrap token — the secret behind
	 * `geist pair`'s QR and deep link (R33-REACH.4). The token is returned
	 * here and nowhere else: only its salted digest is written to disk, so a
	 * reader of the store cannot pair with it.
	 */
	mintBootstrap(options: { ttlMs?: number } = {}): BootstrapToken {
		this.ensureFresh();
		const ttlMs = options.ttlMs ?? DEFAULT_BOOTSTRAP_TTL_MS;
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
			throw new DeviceRegistryError(`bootstrap ttlMs must be a positive number, got ${String(ttlMs)}`);
		}

		const token = randomSecret();
		const salt = randomBytes(SALT_BYTES).toString("hex");
		const createdAt = this.now();
		const expiresAt = createdAt + ttlMs;

		this.mutableState().bootstraps.push({
			salt,
			hash: digest(token, salt),
			createdAt,
			expiresAt,
			consumedAt: null,
			consumedByDeviceId: null,
		});
		this.save();

		return { token, expiresAt };
	}

	/**
	 * Spends a bootstrap token for a device id and its first credential
	 * (R33-REACH.5). The token is invalidated in the same write that mints the
	 * device, so the exchange and the invalidation cannot come apart: a replay
	 * is refused as `bootstrap_consumed` and — the clause that matters for
	 * R33-REACH.7 — the device minted by the *first* exchange is not touched
	 * by the refusal.
	 */
	exchange(bootstrapToken: string, deviceMeta: DeviceMeta): ExchangeResult {
		this.ensureFresh();
		const state = this.mutableState();
		const record = state.bootstraps.find((candidate) =>
			digestsMatch(digest(bootstrapToken, candidate.salt), candidate.hash),
		);

		if (!record) return { ok: false, reason: "unknown_bootstrap" };
		if (record.consumedAt !== null) return { ok: false, reason: "bootstrap_consumed" };

		const at = this.now();
		if (at >= record.expiresAt) return { ok: false, reason: "bootstrap_expired" };

		const deviceId = `dev_${randomBytes(DEVICE_ID_BYTES).toString("hex")}`;
		const credential = randomSecret();
		const salt = randomBytes(SALT_BYTES).toString("hex");

		record.consumedAt = at;
		record.consumedByDeviceId = deviceId;
		state.devices.push({
			id: deviceId,
			name: deviceMeta.name,
			platform: deviceMeta.platform,
			pairedAt: at,
			lastSeen: at,
			revoked: false,
			salt,
			hash: digest(credential, salt),
			retiredHashes: [],
		});
		this.save();
		this.emit({ type: "device_paired", deviceId, at });

		return { ok: true, deviceId, credential };
	}

	/**
	 * Authenticates one frame from one device. Ordering is deliberate:
	 * revocation is checked before the credential, so a revoked device is
	 * refused even while holding a credential that is otherwise perfectly
	 * valid — that is what "refused at its next frame" means. A rotated-away
	 * predecessor is distinguished from a wrong guess and reported as
	 * `credential_reuse` with an event; a wrong guess is `credential_mismatch`
	 * and raises no alarm, because a typo must not cry theft.
	 */
	verify(deviceId: string, credential: string): VerifyResult {
		this.ensureFresh();
		const state = this.mutableState();
		const device = state.devices.find((candidate) => candidate.id === deviceId);
		if (!device) return { ok: false, outcome: "unknown_device" };
		if (device.revoked) return { ok: false, outcome: "revoked" };

		const presented = digest(credential, device.salt);
		if (digestsMatch(presented, device.hash)) {
			device.lastSeen = this.now();
			this.save();
			return { ok: true, outcome: "ok", deviceId };
		}

		if (device.retiredHashes.some((retired) => digestsMatch(presented, retired))) {
			this.emit({ type: "credential_reuse", deviceId, at: this.now() });
			return { ok: false, outcome: "credential_reuse" };
		}

		return { ok: false, outcome: "credential_mismatch" };
	}

	/**
	 * Rotates a device's credential — called on every reconnect
	 * (R33-REACH.5). The predecessor is retired in the same write that
	 * installs the successor, so there is no instant at which both are valid
	 * and no instant at which neither is. Retiring rather than forgetting is
	 * what lets `verify()` tell theft from typo afterwards.
	 */
	rotate(deviceId: string): RotateResult {
		this.ensureFresh();
		const state = this.mutableState();
		const device = state.devices.find((candidate) => candidate.id === deviceId);
		if (!device) return { ok: false, reason: "unknown_device" };
		if (device.revoked) return { ok: false, reason: "revoked" };

		const credential = randomSecret();
		device.retiredHashes = [device.hash, ...device.retiredHashes].slice(0, MAX_RETIRED_CREDENTIALS);
		device.hash = digest(credential, device.salt);
		device.lastSeen = this.now();
		this.save();
		this.emit({ type: "credential_rotated", deviceId, at: this.now() });

		return { ok: true, deviceId, credential };
	}

	/**
	 * Revokes a device (`geist devices revoke`, R33-REACH.6). The record is
	 * kept rather than deleted: a deleted device would be `unknown_device` on
	 * its next frame, which is indistinguishable from a stale id, and the
	 * operator would lose the row that says a device was cut off and when.
	 * Revocation is terminal — `rotate()` refuses a revoked device, so a
	 * reconnect cannot launder it back into service.
	 */
	revoke(deviceId: string): RevokeResult {
		this.ensureFresh();
		const state = this.mutableState();
		const device = state.devices.find((candidate) => candidate.id === deviceId);
		if (!device) return { ok: false, reason: "unknown_device" };

		if (!device.revoked) {
			device.revoked = true;
			// A revoked device's credentials are worthless; keeping the digests
			// would only widen what a stolen store discloses.
			device.retiredHashes = [];
			this.save();
			this.emit({ type: "device_revoked", deviceId, at: this.now() });
		}

		return { ok: true, deviceId };
	}

	/**
	 * The `geist devices list` projection, in pairing order. The return type
	 * is the guarantee: `DeviceSummary` has no field that could carry
	 * credential material, so no future edit to this method can leak one by
	 * accident.
	 */
	list(): DeviceSummary[] {
		this.ensureFresh();
		return this.mutableState().devices.map((device) => ({
			id: device.id,
			name: device.name,
			platform: device.platform,
			lastSeen: device.lastSeen,
			revoked: device.revoked,
		}));
	}

	/**
	 * Whether this device is currently barred, according to the file.
	 *
	 * The question {@link verify} answers as a side effect, asked on its own —
	 * because R33-REACH.6's hard half is a connection that presents no
	 * credential at all. A device that has already authenticated is not going to
	 * present one again, and the frames it is *receiving* carry nothing to
	 * verify, so the authorization hook in front of every emit needs a question
	 * it can ask about an identity rather than about a secret.
	 *
	 * A device id this store has never heard of answers `true`. That is the fail
	 * closed reading and the only safe one: the caller is holding a live
	 * connection that authenticated as this id, so an id that has since vanished
	 * from the store is a connection whose authority cannot be established, and
	 * "cannot be established" must not read as "allowed".
	 *
	 * Re-stats the file first, like every other public method, so a revocation
	 * written by `geist devices revoke` in another process is visible here on the
	 * very next call.
	 */
	isRevoked(deviceId: string): boolean {
		this.ensureFresh();
		const device = this.mutableState().devices.find((candidate) => candidate.id === deviceId);
		return device === undefined ? true : device.revoked;
	}

	/**
	 * Be told when the store changes underneath this process (R33-REACH.6).
	 *
	 * `ensureFresh()` makes every *asked* question current. This makes the
	 * question get asked: a phone that has attached and gone quiet sends nothing
	 * and, on a silent session, receives nothing, so there is no frame on which
	 * anything would think to look. Without a push it keeps its socket until it
	 * next speaks — which a thief has no reason to do — and "revoked" in the CLI
	 * would mean nothing at all to the connection it was meant to cut.
	 *
	 * The observation is a watch on the *directory*, because the store is
	 * replaced by `rename(2)` and a watch on the file follows the old inode into
	 * oblivion. If the watch cannot be established, or dies later, this falls
	 * back to a bounded poll and **says so** through
	 * {@link DeviceRegistryOptions.onDegraded}. Falling back silently would be
	 * the worse failure of the two: a control that is visibly absent gets fixed,
	 * and one that is invisibly absent gets trusted.
	 *
	 * Listeners are told that *something* changed, not what: the store is the
	 * authority, and a listener that acts on a diff computed here would be acting
	 * on this object's opinion rather than on the file. They call
	 * {@link isRevoked} (or {@link list}) and get the file's answer.
	 *
	 * @param listener - Called after each observed change. A listener that throws
	 *                   is swallowed: one broken subscriber must not stop the
	 *                   others being told, nor kill the watch for everybody.
	 * @returns an idempotent unsubscribe. The watch stops with the last listener.
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		if (this.observing === "idle") this.startObserving();
		let live = true;
		return () => {
			if (!live) return;
			live = false;
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.stopObserving();
		};
	}

	/** How the store is being observed. `"idle"` when nobody is subscribed. */
	get observationMode(): "idle" | "watch" | "poll" {
		return this.observing;
	}

	private startObserving(): void {
		this.observed = readIdentity(this.filePath);
		const directory = dirname(this.filePath);
		const target = basename(this.filePath);
		try {
			// The directory has to exist to be watched, and on a daemon that has
			// never been paired with it does not yet. Creating it at 0700 is the
			// same posture `save()` establishes.
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			this.watcher = this.watchFactory(
				directory,
				(filename) => {
					// Every write lands as `<file>.tmp-<pid>-<hex>` and then a rename,
					// so the temp names are noise; a host that reports no name at all
					// is taken at face value and the identity check below filters it.
					if (filename !== null && filename !== target) return;
					this.notify();
				},
				(error) => this.degradeToPoll(`its fs watch failed: ${describe(error)}`),
			);
			this.observing = "watch";
		} catch (error) {
			this.degradeToPoll(`its fs watch could not be established: ${describe(error)}`);
		}
	}

	/**
	 * Give up on the watch and poll instead, loudly.
	 *
	 * Called both when the watch cannot be established and when an established
	 * one dies. Idempotent: a watcher that errors repeatedly reports once.
	 */
	private degradeToPoll(reason: string): void {
		if (this.observing === "poll") return;
		this.observing = "poll";
		try {
			this.watcher?.close();
		} catch {
			// A watcher that failed may also fail to close; the poll below is what matters.
		}
		this.watcher = null;
		this.onDegraded(
			`device registry ${this.filePath}: ${reason}. Falling back to a ${this.pollIntervalMs}ms poll — ` +
				"a revoked device is still cut off, up to one poll interval later.",
		);
		const timer = setInterval(() => this.notify(), this.pollIntervalMs);
		// Like the watch: never the reason a daemon refuses to exit.
		timer.unref?.();
		this.pollTimer = timer;
	}

	private stopObserving(): void {
		try {
			this.watcher?.close();
		} catch {
			// Already gone.
		}
		this.watcher = null;
		if (this.pollTimer !== null) clearInterval(this.pollTimer);
		this.pollTimer = null;
		this.observing = "idle";
	}

	/**
	 * Tell the listeners, if the file really is a different file.
	 *
	 * Both observation modes are noisy — `fs.watch` fires more than once per
	 * `rename(2)`, and the poll fires whether or not anything happened — so the
	 * identity comparison, not the event, is what decides. It also means this
	 * object's own `save()` costs the listeners one harmless call rather than a
	 * special case that could be got wrong.
	 */
	private notify(): void {
		const identity = readIdentity(this.filePath);
		if (sameIdentity(identity, this.observed)) return;
		this.observed = identity;
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// One broken subscriber must not silence the rest, or the watch.
			}
		}
	}

	private emit(event: DeviceRegistryEvent): void {
		if (!this.onEvent) return;
		try {
			this.onEvent(event);
		} catch {
			// An audit sink that throws must not become an authentication outage.
		}
	}

	private mutableState(): RegistryState {
		if (this.state === null) this.state = emptyState();
		return this.state;
	}

	/**
	 * Reloads when the file on disk is not the one we last read. Identity is
	 * (inode, size, mtime) — and inode alone is decisive here, because every
	 * writer replaces the file by `rename(2)` rather than writing in place, so
	 * an out-of-process write always lands on a new inode. Comparing mtime at
	 * nanosecond resolution as well keeps this honest if a future writer ever
	 * does write in place.
	 */
	private ensureFresh(): void {
		const identity = readIdentity(this.filePath);
		if (this.state !== null && sameIdentity(identity, this.loadedFrom)) return;

		if (identity === null) {
			this.state = emptyState();
			this.loadedFrom = null;
			return;
		}

		this.state = this.load();
		this.loadedFrom = identity;
	}

	/**
	 * Reads the store. A store that exists but cannot be parsed throws rather
	 * than degrading to empty: "empty" would silently discard the revocation
	 * list, and a revoked phone quietly becoming pairable again is exactly the
	 * failure this module exists to prevent. Loud beats convenient here.
	 */
	private load(): RegistryState {
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf-8");
		} catch {
			return emptyState();
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new DeviceRegistryError(`device registry at ${this.filePath} is not valid JSON: ${String(error)}`);
		}

		if (typeof parsed !== "object" || parsed === null) {
			throw new DeviceRegistryError(`device registry at ${this.filePath} is not an object`);
		}

		const candidate = parsed as Partial<RegistryState>;
		if (!Array.isArray(candidate.devices) || !Array.isArray(candidate.bootstraps)) {
			throw new DeviceRegistryError(`device registry at ${this.filePath} is missing devices/bootstraps`);
		}

		return {
			version: typeof candidate.version === "number" ? candidate.version : STATE_VERSION,
			devices: candidate.devices,
			bootstraps: candidate.bootstraps,
		};
	}

	/**
	 * Persists atomically at 0600: temp file in the same directory (so the
	 * rename stays within one filesystem and is therefore atomic), explicit
	 * `chmod` because the write mode is masked by the process umask, then
	 * `rename(2)` over the target. A reader either sees the whole previous
	 * store or the whole new one — never a truncated credential store, which
	 * would authenticate nobody or, worse, half of somebody.
	 */
	private save(): void {
		const state = this.mutableState();
		state.bootstraps = pruneBootstraps(state.bootstraps, this.now());

		mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
		const tempPath = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
		try {
			writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
			chmodSync(tempPath, 0o600);
			renameSync(tempPath, this.filePath);
		} finally {
			if (existsSync(tempPath)) rmSync(tempPath, { force: true });
		}

		this.loadedFrom = readIdentity(this.filePath);
	}
}

/**
 * Drops bootstrap records that can no longer teach anyone anything: spent or
 * expired ones past the retention window, and the oldest spent ones beyond
 * `MAX_REMEMBERED_BOOTSTRAPS`. Retention is what keeps a prompt replay
 * answerable with `bootstrap_consumed` instead of the vaguer
 * `unknown_bootstrap`; the cap is what keeps a long-lived daemon's store
 * bounded.
 */
function pruneBootstraps(bootstraps: BootstrapRecord[], now: number): BootstrapRecord[] {
	const live: BootstrapRecord[] = [];
	const remembered: BootstrapRecord[] = [];

	for (const record of bootstraps) {
		if (record.consumedAt === null && now < record.expiresAt) {
			live.push(record);
		} else if (now < (record.consumedAt ?? record.expiresAt) + BOOTSTRAP_RETENTION_MS) {
			remembered.push(record);
		}
	}

	remembered.sort((a, b) => b.createdAt - a.createdAt);
	return [...live, ...remembered.slice(0, MAX_REMEMBERED_BOOTSTRAPS)];
}
