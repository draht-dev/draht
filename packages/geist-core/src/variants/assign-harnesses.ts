/**
 * Round-robin harness assignment for a `variants n` comparison (spec §9.2's
 * `variants_new` row: "+ harnesses?: [name] (round-robins across members when
 * set)"; §2/§16 M6 "variants, optionally mixed" — the compare row becomes an
 * agent shoot-out). Pure: no git, no ACP, no fleet — it only decides which
 * harness each of the `count` sibling slots should run.
 */

/**
 * Assigns a harness to each of the `count` variant slots.
 *
 * When `harnesses` names one or more configured agents (the grammar's `with
 * <harness>[, <harness>…]` list, already parsed into `ResolvedBoardVariants.
 * harnesses`), the slots cycle through that list round-robin — e.g.
 * `assignHarnessesRoundRobin(5, ["claude", "codex"], "draht")` →
 * `["claude", "codex", "claude", "codex", "claude"]`. When the list is omitted
 * (`undefined`) or empty (the grammar yields `[]` for a bare `variants n`),
 * every slot gets `defaultHarness` — a homogeneous comparison, spec §17.3
 * "draht stays harness.default".
 *
 * @throws {RangeError} if `count` is not a positive integer.
 */
export function assignHarnessesRoundRobin(
	count: number,
	harnesses: readonly string[] | undefined,
	defaultHarness: string,
): string[] {
	if (!Number.isInteger(count) || count < 1) {
		throw new RangeError(`variants count must be a positive integer, got ${count}`);
	}

	// An omitted or empty `with` list means a homogeneous comparison: pool of
	// one (the default) makes every `i % pool.length` land on `defaultHarness`.
	const pool = harnesses && harnesses.length > 0 ? harnesses : [defaultHarness];
	return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
}
