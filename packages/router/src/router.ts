import { loadConfig } from "./config.js";
import type { ModelRef, RouterConfig, RouterRole } from "./types.js";

/**
 * Model router with role-based resolution and automatic fallback.
 */
export class ModelRouter {
	private config: RouterConfig;

	constructor(config?: RouterConfig) {
		this.config = config ?? loadConfig();
	}

	/**
	 * Resolve the primary model for a role.
	 */
	resolve(role: RouterRole): ModelRef {
		const roleConfig = this.config[role];
		if (!roleConfig) {
			throw new Error(`Unknown role: ${role}`);
		}
		return roleConfig.primary;
	}

	/**
	 * Resolve all models for a role: [primary, ...fallbacks].
	 */
	resolveWithFallbacks(role: RouterRole): ModelRef[] {
		const roleConfig = this.config[role];
		if (!roleConfig) {
			throw new Error(`Unknown role: ${role}`);
		}
		return [roleConfig.primary, ...roleConfig.fallbacks];
	}

	/**
	 * Execute a function with automatic fallback on retryable errors.
	 */
	async route<T>(role: RouterRole, fn: (model: ModelRef) => Promise<T>): Promise<T> {
		const models = this.resolveWithFallbacks(role);
		let lastError: unknown;

		for (const model of models) {
			try {
				return await fn(model);
			} catch (error) {
				lastError = error;
				if (!this.isRetryableError(error)) {
					throw error;
				}
				// Continue to next fallback
			}
		}

		throw lastError;
	}

	/**
	 * Check if an error is retryable (rate limit, timeout, server error).
	 */
	isRetryableError(error: unknown): boolean {
		if (error instanceof Error) {
			const msg = error.message.toLowerCase();
			if (msg.includes("rate limit") || msg.includes("429")) return true;
			if (msg.includes("timeout") || msg.includes("timed out")) return true;
			if (msg.includes("500") || msg.includes("502") || msg.includes("503")) return true;
			if (msg.includes("server error")) return true;
		}
		if (
			error &&
			typeof error === "object" &&
			"status" in error &&
			typeof (error as Record<string, unknown>).status === "number"
		) {
			const status = (error as Record<string, unknown>).status as number;
			if (status === 429 || (status >= 500 && status < 600)) return true;
		}
		return false;
	}

	/**
	 * Get current config.
	 */
	getConfig(): RouterConfig {
		return this.config;
	}
}
