import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { APIRoute } from "astro";
import satori from "satori";

interface GitHubData {
	stars: number;
	forks: number;
	openIssues: number;
	description: string;
}

async function fetchGitHubData(): Promise<GitHubData> {
	const defaults: GitHubData = {
		stars: 0,
		forks: 0,
		openIssues: 0,
		description: "AI Coding Agent for Freelancers",
	};

	try {
		const res = await fetch("https://api.github.com/repos/draht-dev/draht", {
			headers: {
				Accept: "application/vnd.github.v3+json",
				"User-Agent": "draht-landing",
				...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
			},
		});

		if (!res.ok) return defaults;

		const data = (await res.json()) as Record<string, unknown>;
		return {
			stars: (data.stargazers_count as number) ?? 0,
			forks: (data.forks_count as number) ?? 0,
			openIssues: (data.open_issues_count as number) ?? 0,
			description: (data.description as string) ?? defaults.description,
		};
	} catch {
		return defaults;
	}
}

function getLatestVersion(): string {
	try {
		const pkgPath = path.resolve(process.cwd(), "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

async function loadGoogleFont(family: string, weight: number): Promise<ArrayBuffer> {
	const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&display=swap`;
	const cssRes = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		},
	});
	const css = await cssRes.text();
	const fontUrlMatch = css.match(/src:\s*url\(([^)]+)\)/);
	if (!fontUrlMatch) throw new Error(`No font URL found for ${family}`);
	const fontRes = await fetch(fontUrlMatch[1]);
	return fontRes.arrayBuffer();
}

function tryLoadLocalFont(paths: string[]): Buffer | null {
	for (const fp of paths) {
		if (fs.existsSync(fp)) {
			return fs.readFileSync(fp);
		}
	}
	return null;
}

async function loadMonoFont(): Promise<ArrayBuffer> {
	const local = tryLoadLocalFont([
		"/System/Library/Fonts/Supplemental/Courier New Bold.ttf",
		"/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
	]);
	if (local) return local.buffer.slice(local.byteOffset, local.byteOffset + local.byteLength) as ArrayBuffer;
	return loadGoogleFont("JetBrains Mono", 700);
}

async function loadSansFont(): Promise<ArrayBuffer> {
	const local = tryLoadLocalFont([
		"/System/Library/Fonts/Supplemental/Arial.ttf",
		"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
	]);
	if (local) return local.buffer.slice(local.byteOffset, local.byteOffset + local.byteLength) as ArrayBuffer;
	return loadGoogleFont("Inter", 400);
}

export const GET: APIRoute = async () => {
	const [github, version] = await Promise.all([fetchGitHubData(), Promise.resolve(getLatestVersion())]);

	// Load logo as base64
	const logoPath = path.resolve(process.cwd(), "public/draht-logo.png");
	const logoBuffer = fs.readFileSync(logoPath);
	const logoBase64 = `data:image/png;base64,${logoBuffer.toString("base64")}`;

	const [monoFont, sansFont] = await Promise.all([loadMonoFont(), loadSansFont()]);

	// Stats to display
	const stats = [
		{ label: "Stars", value: github.stars.toLocaleString() },
		{ label: "Forks", value: github.forks.toLocaleString() },
		{ label: "Version", value: `v${version}` },
	];

	const svg = await satori(
		{
			type: "div",
			props: {
				style: {
					width: "1200px",
					height: "630px",
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					alignItems: "center",
					background: "#08080a",
					fontFamily: "Sans",
					position: "relative",
					overflow: "hidden",
				},
				children: [
					// Subtle grid pattern (decorative border lines)
					{
						type: "div",
						props: {
							style: {
								position: "absolute",
								top: "0",
								left: "0",
								right: "0",
								bottom: "0",
								borderLeft: "1px solid rgba(255,255,255,0.05)",
								borderRight: "1px solid rgba(255,255,255,0.05)",
								marginLeft: "60px",
								marginRight: "60px",
							},
						},
					},
					// Top accent line
					{
						type: "div",
						props: {
							style: {
								position: "absolute",
								top: "0",
								left: "0",
								right: "0",
								height: "3px",
								background: "linear-gradient(90deg, transparent 0%, #e8c828 50%, transparent 100%)",
							},
						},
					},
					// Logo + title row
					{
						type: "div",
						props: {
							style: {
								display: "flex",
								alignItems: "center",
								gap: "24px",
								marginBottom: "16px",
							},
							children: [
								{
									type: "img",
									props: {
										src: logoBase64,
										width: 80,
										height: 80,
										style: { borderRadius: "16px" },
									},
								},
								{
									type: "div",
									props: {
										style: {
											fontSize: "64px",
											fontWeight: 700,
											color: "#e8e8e0",
											fontFamily: "Mono",
											letterSpacing: "-0.04em",
										},
										children: "draht",
									},
								},
							],
						},
					},
					// Slogan
					{
						type: "div",
						props: {
							style: {
								fontSize: "14px",
								color: "#6a6a5e",
								letterSpacing: "0.14em",
								textTransform: "uppercase" as const,
								fontFamily: "Mono",
								marginBottom: "32px",
							},
							children: "Dynamic Routing for Agent & Task Handling",
						},
					},
					// Description
					{
						type: "div",
						props: {
							style: {
								fontSize: "22px",
								color: "#a0a098",
								maxWidth: "600px",
								textAlign: "center" as const,
								lineHeight: "1.5",
								marginBottom: "40px",
							},
							children: "The AI coding agent built for freelancers. Multi-model. TDD-first. DDD-native.",
						},
					},
					// Stats row
					{
						type: "div",
						props: {
							style: {
								display: "flex",
								gap: "48px",
								alignItems: "center",
							},
							children: stats.map((stat) => ({
								type: "div",
								props: {
									style: {
										display: "flex",
										flexDirection: "column" as const,
										alignItems: "center" as const,
										gap: "4px",
									},
									children: [
										{
											type: "div",
											props: {
												style: {
													fontSize: "28px",
													fontWeight: 700,
													color: "#e8c828",
													fontFamily: "Mono",
												},
												children: stat.value,
											},
										},
										{
											type: "div",
											props: {
												style: {
													fontSize: "13px",
													color: "#6a6a5e",
													textTransform: "uppercase" as const,
													letterSpacing: "0.1em",
												},
												children: stat.label,
											},
										},
									],
								},
							})),
						},
					},
					// URL at bottom
					{
						type: "div",
						props: {
							style: {
								position: "absolute",
								bottom: "24px",
								fontSize: "14px",
								color: "#3a3a32",
								fontFamily: "Mono",
							},
							children: "draht.dev",
						},
					},
				],
			},
		},
		{
			width: 1200,
			height: 630,
			fonts: [
				{
					name: "Mono",
					data: monoFont,
					weight: 700,
					style: "normal",
				},
				{
					name: "Sans",
					data: sansFont,
					weight: 400,
					style: "normal",
				},
			],
		},
	);

	const resvg = new Resvg(svg, {
		fitTo: { mode: "width", value: 1200 },
	});
	const pngData = resvg.render();
	const pngBuffer = pngData.asPng();

	return new Response(pngBuffer, {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": "public, max-age=86400",
		},
	});
};
