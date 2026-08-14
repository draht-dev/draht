import { TestAppRuntime } from "./kernel.ts";
import { createCodingAgentApp } from "./plugins.ts";
import { SessionTcpServer } from "./transport.ts";

async function main(): Promise<void> {
	const host = process.argv[2] ?? "127.0.0.1";
	const port = Number(process.argv[3] ?? "7777");
	const runtime = new TestAppRuntime(
		createCodingAgentApp(async (signal) => {
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
		}),
	);
	await runtime.start();
	const server = new SessionTcpServer(runtime.driver, { host, port });
	const address = await server.start();
	process.stdout.write(`Session listening on ${address.host}:${address.port}\n`);

	await new Promise<void>((resolve) => {
		const stop = () => resolve();
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
	await server.close();
	runtime.close();
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
