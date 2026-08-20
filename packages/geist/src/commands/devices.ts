import { DeviceRegistry, type DeviceSummary } from "@draht/geist-core";

/**
 * `geist devices list|revoke` — the enumeration and revocation surface for
 * per-device credentials (R33-REACH.6).
 *
 * This command is the operator's only view of who can reach the daemon, and
 * the only lever for cutting one of them off. Four decisions shape it.
 *
 * **Rows are built from `DeviceRegistry.list()` and nothing else.** The
 * registry's `DeviceSummary` has no field capable of carrying credential
 * material — no credential, no digest, no salt — so this command cannot
 * disclose one however it is later edited, short of someone opening the JSON
 * by hand here. That is a type-level guarantee rather than a habit, and it is
 * why the printing code below never touches the store directly. Terminal
 * scrollback gets screenshotted and pasted into issues; a stored digest in a
 * device table is a disclosure with a very long tail.
 *
 * **Revocation is a write, then a re-read by somebody else.** The CLI runs in
 * a different process from the daemon holding the live registry. What makes
 * "refused at its next frame, not merely at its next connect" true is the
 * registry's atomic 0600 write plus its inode-freshness check on every method
 * — so this command's whole job is to call `revoke()` and report honestly.
 * It deliberately does not try to signal the daemon: a revocation that
 * depended on IPC would fail silently exactly when the daemon is wedged,
 * which is one of the moments an operator most wants to revoke.
 *
 * **Revoking twice is success, not an error.** An operator who is unsure
 * whether the first invocation landed will run it again; making the second
 * call exit non-zero teaches them to distrust the first. The registry's
 * `revoke()` is already idempotent, and this command reports the no-op on
 * stdout rather than complaining on stderr.
 *
 * **An unknown id is a hard failure that changes nothing.** Exit 1 with the
 * id quoted back, because the overwhelmingly likely cause is a mistyped or
 * stale id and the operator needs to know their revocation did *not* happen.
 * The alternative — exiting 0 on "nothing to do" — means someone walks away
 * believing a device was cut off when it is still connected.
 */

/**
 * Exit codes. `2` is usage, matching the CLI's unknown-subcommand refusal and
 * `geist pair`; `1` is a well-formed command that could not be carried out.
 * Keeping the two apart is what lets a wrapping script tell "you typed the id
 * wrong" from "that device is not in this store".
 */
export const DEVICES_EXIT = Object.freeze({
	OK: 0,
	UNKNOWN_DEVICE: 1,
	USAGE: 2,
});

const USAGE = [
	"usage: geist devices <list|revoke <id>>",
	"",
	"  geist devices list         one row per paired device, including revoked ones",
	"  geist devices revoke <id>  cut a device off — refused at its next frame, not its next connect",
].join("\n");

export interface DevicesDeps {
	/** The device store. Injected so a test — or a daemon sharing one file — can supply its own. */
	registry?: DeviceRegistry;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

/** Column headers, in the order {@link formatRow} emits them. */
const HEADERS = ["DEVICE ID", "STATE", "PLATFORM", "LAST SEEN", "NAME"] as const;

/**
 * One device as five printable cells. The `revoked`/`active` cell is spelled
 * out rather than left blank: a blank cell in a revoked row reads as missing
 * data, and this is the one column an operator scans for.
 */
function cells(device: DeviceSummary): string[] {
	return [
		device.id,
		device.revoked ? "revoked" : "active",
		device.platform,
		new Date(device.lastSeen).toISOString(),
		device.name,
	];
}

/**
 * Pads every column to its widest cell so ids and states line up. The last
 * column is never padded — device names carry spaces and trailing whitespace
 * on every row is noise in a copy-paste.
 */
function toTable(rows: string[][]): string[] {
	const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
	return rows.map((row) =>
		row
			.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
			.join("  ")
			.trimEnd(),
	);
}

function runList(deps: Required<Pick<DevicesDeps, "stdout">> & { registry: DeviceRegistry }): number {
	const devices = deps.registry.list();

	if (devices.length === 0) {
		// An empty table is indistinguishable from a broken command. Say what is
		// true and what to do about it.
		deps.stdout(`no paired devices in ${deps.registry.path}`);
		deps.stdout("run `geist pair` to put a phone on this daemon.");
		return DEVICES_EXIT.OK;
	}

	for (const line of toTable([[...HEADERS], ...devices.map(cells)])) deps.stdout(line);

	const revoked = devices.filter((device) => device.revoked).length;
	deps.stdout("");
	deps.stdout(
		`${devices.length} device${devices.length === 1 ? "" : "s"} (${revoked} revoked) in ${deps.registry.path}`,
	);
	return DEVICES_EXIT.OK;
}

function runRevoke(deviceId: string, deps: DevicesDeps & { registry: DeviceRegistry }): number {
	const before = deps.registry.list().find((device) => device.id === deviceId);
	const result = deps.registry.revoke(deviceId);

	if (!result.ok) {
		deps.stderr(`geist devices revoke: no such device ${deviceId} in ${deps.registry.path}`);
		deps.stderr("run `geist devices list` for the ids this store knows.");
		return DEVICES_EXIT.UNKNOWN_DEVICE;
	}

	if (before?.revoked) {
		deps.stdout(`${deviceId} was already revoked — nothing changed.`);
		return DEVICES_EXIT.OK;
	}

	deps.stdout(`revoked ${deviceId}${before ? ` (${before.name})` : ""}.`);
	deps.stdout("Its credential is refused at its next frame, not merely at its next connect.");
	return DEVICES_EXIT.OK;
}

export async function runDevices(argv: string[], deps: DevicesDeps): Promise<number> {
	const registry = deps.registry ?? new DeviceRegistry();
	const action = argv[0] ?? "list";

	switch (action) {
		case "list":
			return runList({ stdout: deps.stdout, registry });

		case "revoke": {
			const deviceId = argv[1];
			if (deviceId === undefined) {
				deps.stderr("geist devices revoke: needs a device id");
				deps.stderr(USAGE);
				return DEVICES_EXIT.USAGE;
			}
			return runRevoke(deviceId, { ...deps, registry });
		}

		default:
			deps.stderr(`geist devices: unknown action '${action}'`);
			deps.stderr(USAGE);
			return DEVICES_EXIT.USAGE;
	}
}
