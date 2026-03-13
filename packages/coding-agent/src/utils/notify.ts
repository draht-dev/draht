/**
 * Terminal notification utility.
 *
 * Sends a native notification when the agent finishes its turn.
 * Detection order:
 * - cmux: `cmux notify` CLI
 * - Windows Terminal (WSL): PowerShell toast
 * - Kitty: OSC 99
 * - Fallback: OSC 777 (Ghostty, iTerm2, WezTerm, rxvt-unicode)
 */

import { execFile } from "child_process";

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

export function sendTerminalNotification(title: string, body: string): void {
	if (process.env.CMUX_BUNDLE_ID) {
		execFile("cmux", ["notify", "--title", title, "--body", body]);
	} else if (process.env.WT_SESSION) {
		execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
	} else if (process.env.KITTY_WINDOW_ID) {
		// Kitty OSC 99
		process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
		process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
	} else {
		// OSC 777 (Ghostty, iTerm2, WezTerm, rxvt-unicode)
		process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
	}
}
