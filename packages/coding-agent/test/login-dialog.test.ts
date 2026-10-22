import type * as OsModule from "node:os";
import { setKeybindings, type TUI, TuiMainScreen } from "@draht/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import * as clipboard from "../src/utils/clipboard.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof OsModule>()),
	platform: () => "linux",
}));

describe("LoginDialogComponent URL copying", () => {
	let terminal: VirtualTerminal;
	let tui: TUI;
	let dialog: LoginDialogComponent;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "TERMUX_VERSION", "WSL_DISTRO_NAME", "WSLENV"]) {
			vi.stubEnv(name, "");
		}
		vi.stubEnv("SSH_CONNECTION", "192.0.2.1 50000 192.0.2.2 22");
		terminal = new VirtualTerminal(60, 24);
		tui = new TuiMainScreen(terminal);
		dialog = new LoginDialogComponent(tui, "test-provider", () => {});
		tui.addChild(dialog);
		tui.setFocus(dialog);
		tui.start();
	});

	afterEach(() => {
		tui.stop();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	test("copies the complete wrapped login URL over SSH without newlines", async () => {
		const url = `https://example.invalid/authorize?client_id=draht&state=${"a".repeat(160)}&redirect_uri=http%3A%2F%2Flocalhost`;
		dialog.showAuth(url);
		const prompt = dialog.showManualInput("Paste callback URL:");
		await terminal.waitForRender();
		const rendered = terminal.getViewport().join("\n");
		expect(rendered).toContain("https://example.invalid/authorize");
		expect(rendered).not.toContain(url);
		terminal.sendInput("callback-value");
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		terminal.sendInput("\x18");

		await vi.waitFor(() => {
			expect(write).toHaveBeenCalledWith(`\x1b]52;c;${Buffer.from(url).toString("base64")}\x07`);
		});
		terminal.sendInput("\r");
		await expect(prompt).resolves.toBe("callback-value");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Login URL sent to clipboard");
	});

	test("shows the copy shortcut and follows a custom binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.login.copyUrl": "ctrl+g" }));
		const url = "https://example.invalid/login";
		const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue();
		dialog.showAuth(url);
		expect(stripAnsi(dialog.render(120).join("\n"))).toContain("ctrl+g to copy URL");

		terminal.sendInput("\x18");
		expect(copy).not.toHaveBeenCalled();
		terminal.sendInput("\x07");
		await vi.waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith(url));
	});

	test("copies the current device verification URL while waiting", async () => {
		const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue();
		dialog.showAuth("https://example.invalid/previous-login");
		const verificationUri = "https://example.invalid/device";
		dialog.showDeviceCode({ verificationUri, userCode: "ABCD-EFGH" });
		dialog.showWaiting("Waiting for authentication...");

		terminal.sendInput("\x18");

		await vi.waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith(verificationUri));
		const rendered = stripAnsi(dialog.render(120).join("\n"));
		expect(rendered).toContain("ctrl+x to copy URL");
		expect(rendered).toContain("Enter code: ABCD-EFGH");
	});

	test("shows clipboard failures without losing the pending prompt", async () => {
		vi.spyOn(clipboard, "copyToClipboard").mockRejectedValue(new Error("Clipboard unavailable"));
		dialog.showAuth("https://example.invalid/login");
		const prompt = dialog.showPrompt("Paste authorization code:");
		terminal.sendInput("code-value");

		terminal.sendInput("\x18");

		await vi.waitFor(() => {
			expect(stripAnsi(dialog.render(120).join("\n"))).toContain("Could not copy URL: Clipboard unavailable");
		});
		expect(dialog.signal.aborted).toBe(false);
		terminal.sendInput("\r");
		await expect(prompt).resolves.toBe("code-value");
	});

	test("allows disabling the shortcut and hides its hint", () => {
		setKeybindings(new KeybindingsManager({ "app.login.copyUrl": [] }));
		const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue();
		dialog.showAuth("https://example.invalid/login");

		terminal.sendInput("\x18");

		expect(copy).not.toHaveBeenCalled();
		expect(stripAnsi(dialog.render(120).join("\n"))).not.toContain("to copy URL");
	});

	test("does not copy a previous URL after the dialog switches to setup details", () => {
		const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue();
		dialog.showAuth("https://example.invalid/previous-login");
		dialog.showDetails(["Configure an API key"]);

		terminal.sendInput("\x18");

		expect(copy).not.toHaveBeenCalled();
	});

	test("keeps cancellation available while a login URL is shown", async () => {
		const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue();
		dialog.showAuth("https://example.invalid/login");
		const prompt = dialog.showManualInput("Paste callback URL:");
		const cancelled = expect(prompt).rejects.toThrow("Login cancelled");

		terminal.sendInput("\x03");

		await cancelled;
		expect(dialog.signal.aborted).toBe(true);
		expect(copy).not.toHaveBeenCalled();
	});
});
