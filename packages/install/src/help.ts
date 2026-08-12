import type { BinName } from "./args.ts";

const INSTALL_HELP = `draht-install — transactional management of Draht components on this machine

Usage:
  draht-install <command> [components…] [options]

Commands:
  plan                 Show what install/update would change. Exits 2 when changes are pending.
  install              Apply the resolved plan transactionally.
  status               Report installed components and drift. Exits 2 with --check when changes are pending.
  doctor               Diagnose state, journal, host and legacy-layout problems.
  update               Re-resolve the channel and apply newer versions.
  uninstall            Remove components (requires selectors or --all).

Selection:
  [components…]        Explicit component ids; these replace the detection-based default set.
  --full               Select every catalog component. Cannot be combined with explicit ids.
  --fail-on-empty      Exit 3 when the resolved selection is empty (CI guard).

Options:
  --channel <name>     Release channel. Only "latest" is supported.
  --json               Machine-readable output. Read commands emit one document; install/update/uninstall emit NDJSON events.
  --yes, -y            Confirm mutating commands without a TTY prompt.
  --dry-run, -n        Report what would happen and make no writes and no host calls.
  --force              Reinstall a component that is already recorded at the desired version.
  --check              (status) Exit 2 when changes are pending.
  --all                (uninstall) Remove every installed component.
  --help, -h           Show this help.
  --version            Print the engine version.

Environment:
  DRAHT_INSTALL_DIR    Override the state root (default ~/.draht/install).
  DRAHT_REGISTRY       Override the npm registry base URL.
  DRAHT_HOME           Override the home directory used to resolve component targets.

Exit codes:
  0 ok · 1 error · 2 changes pending · 3 blocked or partially applied
`;

const INIT_HELP = `draht-init — bootstrap a Draht project in a directory

Usage:
  draht-init [directory] [options]

Ensures the requested Draht components are present, then scaffolds the project's
.planning/ tree by invoking the bundled draht-tools CLI. The directory defaults
to the current working directory and must be empty (or contain only ignorable
entries) unless --force is given.

Options:
  --component <id>     Ensure this component (repeatable). Replaces the detection-based default set.
  --full               Ensure every catalog component. Cannot be combined with --component.
  --fail-on-empty      Exit 3 when the resolved selection is empty (CI guard).
  --channel <name>     Release channel. Only "latest" is supported.
  --json               Emit NDJSON event records instead of prose.
  --yes, -y            Proceed without a TTY prompt.
  --dry-run, -n        Report what would happen and make no writes and no host calls.
  --force              Scaffold into a directory that already has unrelated contents.
  --help, -h           Show this help.
  --version            Print the engine version.

Environment:
  DRAHT_INSTALL_DIR    Override the state root (default ~/.draht/install).
  DRAHT_REGISTRY       Override the npm registry base URL.
  DRAHT_TOOLS_BIN      Override the resolved draht-tools entry script.

Exit codes:
  0 ok · 1 error · 3 blocked or partially applied
`;

export function helpText(bin: BinName): string {
	return bin === "draht-init" ? INIT_HELP : INSTALL_HELP;
}
