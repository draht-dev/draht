import { ProcessTerminal } from "@draht/tui";
import { SessionClient } from "./client.ts";
import { TcpClientTransport } from "./transport.ts";
import { MinimalCodingAgentTui } from "./tui/app.ts";
import { modelSelectorTui } from "./tui/model-selector.ts";

async function main(): Promise<void> {
	const host = process.argv[2] ?? "127.0.0.1";
	const port = Number(process.argv[3] ?? "7777");
	const transport = await TcpClientTransport.connect({ host, port, clientId: "tui" });
	const client = new SessionClient(transport);
	await client.ready;
	const app = new MinimalCodingAgentTui(new ProcessTerminal(), client, [modelSelectorTui]);
	const stop = () => app.stop();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	app.start();
	await app.done;
	process.removeListener("SIGINT", stop);
	process.removeListener("SIGTERM", stop);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
