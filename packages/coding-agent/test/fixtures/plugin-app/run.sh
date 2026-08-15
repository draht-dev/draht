#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
host="${1:-127.0.0.1}"
port="${2:-7777}"
log_file="$(mktemp)"

node "$app_dir/model-app/run-session.ts" "$host" "$port" > >(tee "$log_file") &
server_pid=$!

cleanup() {
	trap - EXIT INT TERM
	kill "$server_pid" 2>/dev/null || true
	wait "$server_pid" 2>/dev/null || true
	rm -f "$log_file"
}
trap cleanup EXIT INT TERM

for ((attempt = 0; attempt < 100; attempt++)); do
	if grep -q "^Session listening on " "$log_file"; then
		node "$app_dir/model-app/run-tui.ts" "$host" "$port"
		exit
	fi
	if ! kill -0 "$server_pid" 2>/dev/null; then
		wait "$server_pid"
		exit $?
	fi
	sleep 0.05
done

echo "Timed out waiting for session server" >&2
exit 1
