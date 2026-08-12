/**
 * The adjudicated exit-code table (spec §2 row 5). Every CLI path resolves to
 * exactly one of these — no other numeric code is ever returned.
 */

/** Command succeeded and there is nothing outstanding. */
export const EXIT_OK = 0;

/** The command failed: bad usage, corrupt state, a failed transaction, an unusable host. */
export const EXIT_ERROR = 1;

/** Changes are pending. Only `plan` and `status --check` report this. */
export const EXIT_CHANGES_PENDING = 2;

/** The command was blocked or only partially applied — including an empty resolved profile under `--fail-on-empty`. */
export const EXIT_PARTIAL = 3;
