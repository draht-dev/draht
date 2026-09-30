// Test-only child executable. Keep this independent from the real worker so
// lifecycle failure paths remain deterministic as production integration evolves.
type Command = { type: "shutdown" };

const mode = process.argv[2];

if (mode === "ready") {
	process.send?.({ type: "ready", sessionId: mode, pid: process.pid });
	process.on("message", (message: Command) => {
		if (message?.type === "shutdown") process.exit(0);
	});
} else if (mode === "fail") {
	process.send?.({ type: "failed", message: "fixture startup failed" });
} else if (mode === "exit") {
	process.exit(2);
} else if (mode === "startup-hang") {
	process.on("message", () => {});
} else if (mode === "hang") {
	process.send?.({ type: "ready", sessionId: mode, pid: process.pid });
	process.on("message", () => {});
} else {
	process.send?.({ type: "ready", sessionId: mode === undefined ? "missing" : `${mode}-different`, pid: process.pid });
}
