/// <reference path="./.sst/platform/config.d.ts" />

/**
 * SST config for draht.dev landing page.
 * Deploys Astro static site to AWS (S3 + CloudFront).
 */
export default $config({
	app(input) {
		return {
			name: "draht-landing",
			removal: input?.stage === "production" ? "retain" : "remove",
			home: "aws",
		};
	},
	async run() {
		new sst.aws.Astro("Landing", {
			domain: {
				name: "draht.dev",
				dns: sst.aws.dns(),
			},
		});
	},
});
