import { Container, Editor, getKeybindings, setKeybindings, TuiMainScreen } from "@draht/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { BugReportBundle } from "../src/core/bug-report.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ENV_BUG_REPORT_GATEWAY, ENV_RADIUS_GATEWAY } from "../src/core/radius.ts";
import { upload } from "../src/modes/interactive/bug-report.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

function makeBundle(): BugReportBundle {
	return {
		metadata: {
			schemaVersion: 1,
			id: "bug-1",
			createdAt: new Date().toISOString(),
			hint: null,
			environment: {} as never,
			session: { id: "s1", included: false, summaryIncluded: false, messageCount: 0 },
			model: null,
			provider: null,
			thinkingLevel: undefined as never,
			extensions: [],
			extensionErrors: [],
			settings: { global: {}, project: {} } as never,
		},
		diagnostics: {
			schemaVersion: 1,
			sessionId: "s1",
			entryCount: 0,
			assistantMessageCount: 0,
			assistant: [],
			crashes: [],
		},
	};
}

function makeSession(token: string): AgentSession {
	return {
		modelRuntime: {
			getProvider: vi.fn().mockReturnValue({ id: "radius" }),
			getAuth: vi.fn().mockResolvedValue({ auth: { apiKey: token } }),
		},
		sessionManager: { appendCustomEntry: vi.fn() },
	} as unknown as AgentSession;
}

function makeContext(
	session: AgentSession,
	ui: TuiMainScreen,
	editorContainer: Container,
	editor: Editor,
	keybindings: KeybindingsManager,
) {
	return { session, ui, editorContainer, editor, keybindings, showStatus: vi.fn(), showError: vi.fn() } as never;
}

describe("bug report upload: Radius credential scoped to a matching gateway origin", () => {
	const originalRadiusGateway = process.env[ENV_RADIUS_GATEWAY];
	const originalBugReportGateway = process.env[ENV_BUG_REPORT_GATEWAY];
	let previousKeybindings: ReturnType<typeof getKeybindings>;
	let ui: TuiMainScreen;
	let editorContainer: Container;
	let editor: Editor;
	let keybindings: KeybindingsManager;
	let fetchMock: ReturnType<typeof vi.fn>;
	let originalFetch: typeof fetch;

	beforeEach(() => {
		previousKeybindings = getKeybindings();
		keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		ui = new TuiMainScreen(new VirtualTerminal());
		editorContainer = new Container();
		editor = new Editor(ui, getEditorTheme());
		originalFetch = globalThis.fetch;
		fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, bug_report: { id: "r1" } })));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		setKeybindings(previousKeybindings);
		globalThis.fetch = originalFetch;
		if (originalRadiusGateway === undefined) delete process.env[ENV_RADIUS_GATEWAY];
		else process.env[ENV_RADIUS_GATEWAY] = originalRadiusGateway;
		if (originalBugReportGateway === undefined) delete process.env[ENV_BUG_REPORT_GATEWAY];
		else process.env[ENV_BUG_REPORT_GATEWAY] = originalBugReportGateway;
	});

	it("does not attach the Radius credential when the bug-report gateway is a different origin", async () => {
		process.env[ENV_RADIUS_GATEWAY] = "https://radius.pi.dev";
		process.env[ENV_BUG_REPORT_GATEWAY] = "https://radius.draht.dev";

		const session = makeSession("leaked-pi-dev-token");
		const result = await upload(makeContext(session, ui, editorContainer, editor, keybindings), makeBundle());

		expect(result).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
		const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(init.headers).toBeUndefined();
	});

	it("attaches the Radius credential when the bug-report gateway is the same origin as the Radius gateway", async () => {
		process.env[ENV_RADIUS_GATEWAY] = "https://radius.example.com";
		process.env[ENV_BUG_REPORT_GATEWAY] = "https://radius.example.com";

		const session = makeSession("scoped-token");
		const result = await upload(makeContext(session, ui, editorContainer, editor, keybindings), makeBundle());

		expect(result).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
		const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(init.headers).toEqual({ Authorization: "Bearer scoped-token" });
	});
});
