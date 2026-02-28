import type { TimeEntry, TogglConfig } from "./types.js";

const TOGGL_API = "https://api.track.toggl.com/api/v9";

/**
 * Toggl Track API client for time tracking integration.
 */
export class TogglClient {
	private apiToken: string;
	private workspaceId: string;

	constructor(config: TogglConfig) {
		this.apiToken = config.apiToken;
		this.workspaceId = config.workspaceId;
	}

	private get authHeader(): string {
		return `Basic ${Buffer.from(`${this.apiToken}:api_token`).toString("base64")}`;
	}

	private async request<T>(path: string): Promise<T> {
		const response = await fetch(`${TOGGL_API}${path}`, {
			headers: {
				Authorization: this.authHeader,
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`Toggl API error ${response.status}: ${await response.text()}`);
		}

		return response.json() as Promise<T>;
	}

	/**
	 * Get time entries for a date range.
	 */
	async getTimeEntries(startDate: string, endDate: string): Promise<TimeEntry[]> {
		const entries = await this.request<TimeEntry[]>(`/me/time_entries?start_date=${startDate}&end_date=${endDate}`);
		return entries;
	}

	/**
	 * Get time entries for a specific project.
	 */
	async getProjectTime(
		projectName: string,
		startDate: string,
		endDate: string,
	): Promise<{ entries: TimeEntry[]; totalHours: number }> {
		const entries = await this.getTimeEntries(startDate, endDate);
		const filtered = entries.filter((e) => e.project?.toLowerCase() === projectName.toLowerCase());
		const totalSeconds = filtered.reduce((sum, e) => sum + e.duration, 0);
		return {
			entries: filtered,
			totalHours: Math.round((totalSeconds / 3600) * 100) / 100,
		};
	}
}
