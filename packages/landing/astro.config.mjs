import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import aws from "astro-sst";

export default defineConfig({
	site: "https://draht.dev",
	outDir: "./dist",
	adapter: aws(),
	integrations: [sitemap()],
	redirects: {
		"/domain": "https://spaceship.sjv.io/c/7450244/1794549/21274",
	},
});
