import { describe, expect, test } from "bun:test";
import type { ChangeSet, FileChange } from "../src/contract.ts";
import {
	applyContentPolicy,
	DEFAULT_DENY_GLOBS,
	isPathDenied,
	lineHasSecret,
	redactText,
	testBounded,
} from "../src/privacy.ts";

describe("isPathDenied", () => {
	test("matches the default deny-list by basename", () => {
		expect(isPathDenied(".env", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("config/.env.production", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("certs/server.pem", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("keys/id_rsa", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("keys/id_ed25519.pub", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("src/app.ts", DEFAULT_DENY_GLOBS)).toBe(false);
	});

	test("does not deny a path that merely contains 'secret' in its name, but does deny a real secrets/ directory", () => {
		expect(isPathDenied("src/secrets-utils.ts", DEFAULT_DENY_GLOBS)).toBe(false);
		expect(isPathDenied("src/secrets/manager.ts", DEFAULT_DENY_GLOBS)).toBe(true);
	});

	test("still denies a file literally named secrets.<ext> via the 'secrets.*' default", () => {
		expect(isPathDenied("src/secrets.ts", DEFAULT_DENY_GLOBS)).toBe(true);
	});

	test("denies new default globs", () => {
		expect(isPathDenied(".npmrc", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied(".netrc", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("infra/terraform.tfstate", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("infra/terraform.tfstate.backup", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("kubeconfig-prod", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied(".docker/config.json", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("home/.docker/config.json", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("gcp-service-account.json", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("notes.secret", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("secrets.yaml", DEFAULT_DENY_GLOBS)).toBe(true);
	});

	test("denies env-suffixed, tfvars, htpasswd, and secrets-directory paths", () => {
		expect(isPathDenied("config/prod.env.local", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("config/app.env.bak", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("infra/prod.tfvars", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied(".htpasswd", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("deploy/secrets/db.yaml", DEFAULT_DENY_GLOBS)).toBe(true);
		expect(isPathDenied("a/b/secrets/c/d.yaml", DEFAULT_DENY_GLOBS)).toBe(true);
	});

	test("an --include glob overrides a matching --exclude glob", () => {
		expect(isPathDenied("fixtures/secret-sample.txt", DEFAULT_DENY_GLOBS, ["secret-sample.txt"])).toBe(false);
	});

	test("fails closed on a pathological path length", () => {
		expect(isPathDenied(`a/${"b".repeat(2000)}.ts`, DEFAULT_DENY_GLOBS)).toBe(true);
	});

	describe("glob matching correctness", () => {
		test("'**/x' matches x at any depth, including the root", () => {
			expect(isPathDenied("x", ["**/x"])).toBe(true);
			expect(isPathDenied("a/b/x", ["**/x"])).toBe(true);
			expect(isPathDenied("a/b/xy", ["**/x"])).toBe(false);
		});

		test("'a/**/b' matches zero or more segments between a and b", () => {
			expect(isPathDenied("a/b", ["a/**/b"])).toBe(true);
			expect(isPathDenied("a/c/b", ["a/**/b"])).toBe(true);
			expect(isPathDenied("a/c/d/b", ["a/**/b"])).toBe(true);
			expect(isPathDenied("x/a/b", ["a/**/b"])).toBe(false);
		});

		test("'*.pem' matches only the basename, not across a slash", () => {
			expect(isPathDenied("certs/server.pem", ["*.pem"])).toBe(true);
			expect(isPathDenied("certs.pem/server.txt", ["*.pem"])).toBe(false);
		});

		test("'.env.*' matches environment-suffixed files", () => {
			expect(isPathDenied(".env.local", [".env.*"])).toBe(true);
			expect(isPathDenied(".envrc", [".env.*"])).toBe(false);
		});
	});

	describe("glob matching performance", () => {
		test("a deep path against */*/*/*.pem does not catastrophically backtrack", () => {
			const path = `${"segment/".repeat(500)}file.pem`;
			const start = performance.now();
			isPathDenied(path, ["*/*/*/*.pem"]);
			expect(performance.now() - start).toBeLessThan(50);
		});

		test("a deep path against **/*secret* does not catastrophically backtrack", () => {
			const path = `${"segment/".repeat(500)}file.txt`;
			const start = performance.now();
			isPathDenied(path, ["**/*secret*"]);
			expect(performance.now() - start).toBeLessThan(50);
		});
	});
});

describe("lineHasSecret", () => {
	test("flags high-confidence secret shapes", () => {
		expect(lineHasSecret("DB_PASSWORD=hunter2hunter2")).toBe(true);
		expect(lineHasSecret("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(true);
		expect(lineHasSecret('"apiKey": "abcd1234efgh"')).toBe(true);
		expect(lineHasSecret('"password": "with spaces in it"')).toBe(true);
		expect(lineHasSecret(`const key = "sk-proj-${"a".repeat(30)}";`)).toBe(true);
		expect(lineHasSecret(`const key = "sk-ant-api03-${"a".repeat(30)}";`)).toBe(true);
		expect(lineHasSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
		expect(lineHasSecret(`Authorization: Bearer ${"a".repeat(30)}`)).toBe(true);
		expect(lineHasSecret("https://user:hunter2hunter2@example.com/db")).toBe(true);
		expect(lineHasSecret("key = AKIAABCDEFGHIJKLMNOP")).toBe(true);
	});

	test("does not flag ordinary code", () => {
		expect(lineHasSecret("const token = getToken();")).toBe(false);
		expect(lineHasSecret("password: string;")).toBe(false);
		expect(lineHasSecret("if (token === other)")).toBe(false);
		expect(lineHasSecret("secret: z.string(),")).toBe(false);
		expect(lineHasSecret("const apiKey = process.env.API_KEY;")).toBe(false);
		expect(lineHasSecret("export function resetPassword(user: User) {")).toBe(false);
	});

	test("timing: a 100KB line of repeated PEM markers stays fast", () => {
		const line = "-----BEGIN ".repeat(10000);
		const start = performance.now();
		lineHasSecret(line);
		expect(performance.now() - start).toBeLessThan(50);
	});

	test("timing: a 100KB line of filler plus a trailing '=' stays fast", () => {
		const line = `${"a".repeat(100_000)}=`;
		const start = performance.now();
		lineHasSecret(line);
		expect(performance.now() - start).toBeLessThan(50);
	});

	test("flags an 'export KEY=value' .env-style line", () => {
		expect(lineHasSecret("export API_KEY=s3cr3tvalue123")).toBe(true);
	});

	test("flags a credential-like key with punctuation-heavy value", () => {
		expect(lineHasSecret("DB_PASSWORD=p@ss!w0rd#2024")).toBe(true);
	});

	test("flags an indented key with a trailing comment", () => {
		expect(lineHasSecret("  api_key: s3cr3tv4lue0123 # prod")).toBe(true);
	});

	test("flags extended credential key names", () => {
		expect(lineHasSecret("DB_PASS=s3cr3tvalue123")).toBe(true);
		expect(lineHasSecret("pwd=s3cr3tvalue123")).toBe(true);
		expect(lineHasSecret("credentials=s3cr3tvalue123")).toBe(true);
		expect(lineHasSecret("AUTH_TOKEN=s3cr3tvalue123")).toBe(true);
	});

	test("flags backtick- and escaped-JSON-quoted assignments", () => {
		expect(lineHasSecret("const API_KEY = `abcd1234efgh5678`;")).toBe(true);
		expect(lineHasSecret('\\"apiKey\\": \\"abcd1234efgh\\"')).toBe(true);
	});

	test("flags npm, GitLab, JWT, Slack webhook, and sk_test/rk_test tokens", () => {
		expect(lineHasSecret(`npm_${"a".repeat(36)}`)).toBe(true);
		expect(lineHasSecret(`glpat-${"a".repeat(20)}`)).toBe(true);
		expect(lineHasSecret(`eyJ${"a".repeat(10)}.eyJ${"a".repeat(10)}.${"a".repeat(10)}`)).toBe(true);
		// Assembled at runtime so the source holds no literal webhook URL for secret scanners to flag.
		const slackWebhook = ["https://hooks", "slack", "com/services/T00000000/B00000000/abcdefghijklmnopqrstuvwx"].join(
			".",
		);
		expect(lineHasSecret(slackWebhook)).toBe(true);
		expect(lineHasSecret(`sk_test_${"a".repeat(10)}`)).toBe(true);
		expect(lineHasSecret(`rk_test_${"a".repeat(10)}`)).toBe(true);
	});

	test("flags URL credentials whose password contains a slash", () => {
		expect(lineHasSecret("https://user:p4ss/w0rd@example.com/db")).toBe(true);
	});

	test("does not flag keys that merely contain a credential word mid-identifier", () => {
		expect(lineHasSecret('tokenizer: "cl100k_base"')).toBe(false);
		expect(lineHasSecret('const passwordField = "password-input";')).toBe(false);
		expect(lineHasSecret('secret_name = "prod-db-credentials"')).toBe(false);
		expect(lineHasSecret("api_key_env: OPENAI_API_KEY")).toBe(false);
		expect(lineHasSecret("TOKEN_TYPE=access_token")).toBe(false);
		expect(lineHasSecret("password_reset_url: /accounts/reset")).toBe(false);
		expect(lineHasSecret('apiKeyHeader: "x-api-key-header"')).toBe(false);
		expect(lineHasSecret('const tokenEndpoint = "https://example.com/oauth/token";')).toBe(false);
	});

	test("timing: a 100KB adversarial .env-style value stays fast", () => {
		const line = `API_KEY=${"a".repeat(100_000)}`;
		const start = performance.now();
		lineHasSecret(line);
		expect(performance.now() - start).toBeLessThan(50);
	});

	test("timing: a 100KB adversarial quoted-assignment line stays fast", () => {
		const line = `const API_KEY = \`${"a".repeat(100_000)}`;
		const start = performance.now();
		lineHasSecret(line);
		expect(performance.now() - start).toBeLessThan(50);
	});

	test("timing: a 100KB adversarial token-shaped line stays fast", () => {
		const line = `npm_${"a".repeat(100_000)} glpat-${"a".repeat(100_000)} eyJ${"a".repeat(100_000)}`;
		const start = performance.now();
		lineHasSecret(line);
		expect(performance.now() - start).toBeLessThan(50);
	});

	test("timing: a 100KB adversarial Slack-webhook-shaped line stays fast", () => {
		const line = `${["https://hooks", "slack", "com/services/"].join(".")}${"a".repeat(100_000)}`;
		const start = performance.now();
		lineHasSecret(line);
		expect(performance.now() - start).toBeLessThan(50);
	});

	test("timing: a 100KB adversarial URL-credential-shaped line stays fast", () => {
		const line = `https://user:${"a".repeat(100_000)}`;
		const start = performance.now();
		lineHasSecret(line);
		expect(performance.now() - start).toBeLessThan(50);
	});
});

describe("redactText", () => {
	test("redacts an AWS access key id", () => {
		expect(redactText("key = AKIAABCDEFGHIJKLMNOP")).toBe("key = [redacted]");
	});

	test("redacts a PEM private key block", () => {
		const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----";
		expect(redactText(text)).toBe("[redacted]");
	});

	test("redacts a GitHub token", () => {
		expect(redactText(`token: ghp_${"a".repeat(36)}`)).toBe("token: [redacted]");
	});

	test("redacts an OpenAI/Anthropic-shaped key", () => {
		expect(redactText(`key is sk-proj-${"a".repeat(30)} today`)).toBe("key is [redacted] today");
		expect(redactText(`key is sk-ant-api03-${"a".repeat(30)} today`)).toBe("key is [redacted] today");
	});

	test("redacts a generic key=value secret, replacing the whole assignment", () => {
		expect(redactText('const password = "hunter2hunter2";')).toBe("const [redacted];");
	});

	test("leaves ordinary text untouched", () => {
		expect(redactText("console.log('hi') was added")).toBe("console.log('hi') was added");
	});

	test("redacts an unquoted credential assignment in prose", () => {
		expect(redactText("rotate API_KEY=abcd1234efgh5678 before the demo")).toBe("rotate [redacted] before the demo");
		expect(redactText("set password: hunter2hunter2 for the test account")).toBe(
			"set [redacted] for the test account",
		);
	});

	test("redacts a PEM block without quadratic blowup, even unterminated", () => {
		const text = `before\n-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----\nafter`;
		expect(redactText(text)).toBe("before\n[redacted]\nafter");

		const unterminated = `-----BEGIN RSA PRIVATE KEY-----\nMIIB...`;
		expect(redactText(unterminated)).toBe("[redacted]");
	});

	test("timing: 1MB of repeated unterminated BEGIN markers stays fast", () => {
		const text = "-----BEGIN RSA PRIVATE KEY-----\n".repeat(30_000);
		const start = performance.now();
		redactText(text);
		expect(performance.now() - start).toBeLessThan(50);
	});
});

function changeSet(files: FileChange[]): ChangeSet {
	return {
		id: "a".repeat(40),
		commits: ["a".repeat(40)],
		title: "t",
		body: "",
		authors: ["A"],
		date: "2024-01-01T00:00:00Z",
		files,
	};
}

describe("applyContentPolicy", () => {
	test("withholds hunks for a denied path but keeps path and stats", () => {
		const cs = changeSet([
			{
				path: ".env",
				status: "modified",
				additions: 3,
				deletions: 1,
				hunks: [{ header: "@@ -1,1 +1,1 @@", lines: ["+SECRET=abc"] }],
			},
		]);
		const result = applyContentPolicy(cs);
		expect(result.files[0].path).toBe(".env");
		expect(result.files[0].additions).toBe(3);
		expect(result.files[0].deletions).toBe(1);
		expect(result.files[0].hunks[0].withheld).toBe(true);
		expect(result.files[0].hunks[0].lines).toEqual([]);
		expect(result.files[0].hunks[0].header).toContain("withheld");
	});

	test("also checks oldPath for renames", () => {
		const cs = changeSet([
			{
				path: "config/current.yaml",
				oldPath: ".env",
				status: "renamed",
				additions: 0,
				deletions: 0,
				hunks: [{ header: "@@ -1,1 +1,1 @@", lines: ["+SECRET=abc"] }],
			},
		]);
		const result = applyContentPolicy(cs);
		expect(result.files[0].hunks[0].withheld).toBe(true);
	});

	test("withholds only the matching hunk of an allowed path, keeping other hunks verbatim", () => {
		const cs = changeSet([
			{
				path: "src/config.ts",
				status: "modified",
				additions: 2,
				deletions: 0,
				hunks: [
					{ header: "@@ -0,0 +1 @@", lines: ["+export const greeting = 'hi';"] },
					{ header: "@@ -0,0 +2 @@", lines: ["+const apiKey = 'AKIAABCDEFGHIJKLMNOP';"] },
				],
			},
		]);
		const result = applyContentPolicy(cs);
		expect(result.files[0].hunks[0].withheld).toBeUndefined();
		expect(result.files[0].hunks[0].lines).toEqual(["+export const greeting = 'hi';"]);
		expect(result.files[0].hunks[1].withheld).toBe(true);
		expect(result.files[0].hunks[1].lines).toEqual([]);
	});

	test("never rewrites a surviving code line: it is kept byte-for-byte or the whole hunk is withheld", () => {
		const cs = changeSet([
			{
				path: "src/config.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				hunks: [{ header: "@@ -0,0 +1 @@", lines: ["+const token = getToken();"] }],
			},
		]);
		const result = applyContentPolicy(cs);
		expect(result.files[0].hunks[0].withheld).toBeUndefined();
		expect(result.files[0].hunks[0].lines).toEqual(["+const token = getToken();"]);
	});

	test("withholds a PEM private key split across multiple lines in one hunk", () => {
		const cs = changeSet([
			{
				path: "src/bootstrap.ts",
				status: "modified",
				additions: 3,
				deletions: 0,
				hunks: [
					{
						header: "@@ -0,0 +1,3 @@",
						lines: ["+-----BEGIN RSA PRIVATE KEY-----", "+MIIB...", "+-----END RSA PRIVATE KEY-----"],
					},
				],
			},
		]);
		const result = applyContentPolicy(cs);
		expect(result.files[0].hunks[0].withheld).toBe(true);
		expect(result.files[0].hunks[0].lines).toEqual([]);
	});

	test("withholds a hunk when only its header carries a secret-shaped context", () => {
		const cs = changeSet([
			{
				path: "src/auth.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				hunks: [
					{
						header: '@@ -1,2 +1,2 @@ function login(password = "hunter2hunter2")',
						lines: [" return true;"],
					},
				],
			},
		]);
		const result = applyContentPolicy(cs);
		expect(result.files[0].hunks[0].withheld).toBe(true);
	});

	test("withholds hunks with Bearer tokens and URL-embedded credentials", () => {
		const cs = changeSet([
			{
				path: "src/fetchers.ts",
				status: "modified",
				additions: 2,
				deletions: 0,
				hunks: [
					{ header: "@@ -0,0 +1 @@", lines: [`+headers.set('Authorization', 'Bearer ${"a".repeat(30)}');`] },
					{ header: "@@ -0,0 +2 @@", lines: ["+const url = 'https://user:hunter2hunter2@example.com/db';"] },
				],
			},
		]);
		const result = applyContentPolicy(cs);
		expect(result.files[0].hunks.every((h) => h.withheld)).toBe(true);
	});

	test("end-to-end: no secret substring survives serialization as a feed entry would see it", () => {
		const singleLineSecrets = [
			"DB_PASSWORD=hunter2hunter2",
			"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			`"apiKey": "abcd1234efgh"`,
			`"password": "with spaces in it"`,
			`const key = "sk-proj-${"a".repeat(30)}";`,
			`const key = "sk-ant-api03-${"a".repeat(30)}";`,
			`Authorization: Bearer ${"a".repeat(30)}`,
			"https://user:hunter2hunter2@example.com/db",
		];
		const files: FileChange[] = singleLineSecrets.map((line, i) => ({
			path: `src/file${i}.ts`,
			status: "modified" as const,
			additions: 1,
			deletions: 0,
			hunks: [{ header: "@@ -0,0 +1 @@", lines: [`+${line}`] }],
		}));
		files.push({
			path: "src/pem.ts",
			status: "modified",
			additions: 3,
			deletions: 0,
			hunks: [
				{
					header: "@@ -0,0 +1,3 @@",
					lines: ["+-----BEGIN RSA PRIVATE KEY-----", "+MIIB...", "+-----END RSA PRIVATE KEY-----"],
				},
			],
		});
		const cs = changeSet(files);
		const result = applyContentPolicy(cs);
		const serialized = JSON.stringify(result);
		for (const secret of ["hunter2hunter2", "wJalrXUtnFEMI", "abcd1234efgh", "sk-proj-", "sk-ant-api03-", "MIIB"]) {
			expect(serialized).not.toContain(secret);
		}
	});
});

describe("testBounded", () => {
	test("finds a deny term far beyond the per-run input cap", () => {
		const text = `${"a".repeat(20_000)} AcmeCustomer ${"b".repeat(20_000)}`;
		expect(testBounded(/AcmeCustomer/, text)).toBe(true);
	});

	test("finds a term that straddles a window edge", () => {
		const prefix = "x".repeat(4096 - 512 - 3);
		expect(testBounded(/AcmeCustomer/, `${prefix}AcmeCustomer${"y".repeat(10_000)}`)).toBe(true);
	});

	test("never runs a pattern on more than the cap at once", () => {
		const seen: number[] = [];
		const spy = {
			lastIndex: 0,
			test: (s: string) => {
				seen.push(s.length);
				return false;
			},
		} as unknown as RegExp;
		testBounded(spy, "z".repeat(50_000));
		expect(Math.max(...seen)).toBeLessThanOrEqual(4096);
	});
});
