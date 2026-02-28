import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
	site: "https://draht.dev",
	outDir: "./dist",
	integrations: [sitemap()],
});
