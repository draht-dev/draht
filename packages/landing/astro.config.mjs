import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import aws from "astro-sst";

export default defineConfig({
	site: "https://draht.dev",
	outDir: "./dist",
	adapter: aws(),
	integrations: [sitemap()],
});
