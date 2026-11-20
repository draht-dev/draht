import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import aws from "astro-sst";

export default defineConfig({
	site: "https://draht.dev",
	outDir: "./dist",
	adapter: aws(),
	// Astro 7 defaults to JSX whitespace rules, which drop the line break between an
	// element and the text after it ("</span>\n· built in Dortmund" lost its space).
	// `true` keeps the lossless compression the templates were written against.
	compressHTML: true,
	integrations: [sitemap()],
	redirects: {
		"/domain": "https://spaceship.sjv.io/c/7450244/1794549/21274",
	},
});
