/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
	app(input) {
		return {
			name: "draht-x-markdown",
			removal: input?.stage === "production" ? "retain" : "remove",
			home: "cloudflare",
		};
	},
	async run() {
		const worker = new sst.cloudflare.Worker("XMarkdownWorker", {
			handler: "src/worker.handler",
			url: true,
			compatibility: {
				date: "2026-08-11",
				flags: ["nodejs_compat"],
			},
			environment: {
				X2MARKDOWN_API_KEY: process.env.X2MARKDOWN_API_KEY ?? "",
			},
			build: {
				install: ["@cloudflare/puppeteer"],
			},
			transform: {
				worker(args) {
					args.bindings = [...(args.bindings ?? []), { name: "BROWSER", type: "browser" }];
				},
			},
		});

		return {
			url: worker.url,
		};
	},
});
