import { SessionRuntime, SessionTcpServer } from "../lib/index.ts";
import { createCodingAgentPlugins } from "./plugins.ts";

async function main(): Promise<void> {
	const host = process.argv[2] ?? "127.0.0.1";
	const port = Number(process.argv[3] ?? "7777");
	const plugins = createCodingAgentPlugins(async (signal) => {
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(resolve, 750);
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timeout);
					reject(signal.reason);
				},
				{ once: true },
			);
		});
		return [
			{ provider: "acme", modelId: "fresh", name: "Fresh from catalogue", reasoning: false },
			{ provider: "acme", modelId: "reasoning", name: "Reasoning model", reasoning: true },
		];
	});
	const runtime = new SessionRuntime(plugins);
	await runtime.start();
	const server = new SessionTcpServer(runtime.driver, { host, port });
	const address = await server.start();
	process.stdout.write(`Session listening on ${address.host}:${address.port}\n`);
	await new Promise<void>((resolve) => {
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});
	await server.close();
	runtime.close();
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
