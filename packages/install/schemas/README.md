# `@draht/install` machine-readable output schemas

Every `--json` document and every NDJSON record `draht-install` / `draht-init` can
write is described by one of the JSON Schema (draft 2020-12) files in this
directory. They ship with the package (`files` in `package.json`), so a consumer
can pin against the exact contract the installed version emits.

| File | Emitted by | Shape |
| --- | --- | --- |
| `version.schema.json` | `draht-install --version --json`, `draht-init --version --json` | one document |
| `plan.schema.json` | `draht-install plan --json` | one document |
| `status.schema.json` | `draht-install status --json` | one document |
| `doctor.schema.json` | `draht-install doctor --json` | one document |
| `error.schema.json` | any command that fails with `--json` | one document (one NDJSON line on mutating verbs) |
| `apply-stream.schema.json` | `draht-install install --json`, `draht-install update --json` | NDJSON — every line matches |
| `uninstall-stream.schema.json` | `draht-install uninstall --json` | NDJSON — every line matches |
| `init-stream.schema.json` | `draht-init --json` | NDJSON — every line matches |

Every document carries `schemaVersion`. It changes only when an existing field's
meaning or presence changes; new optional fields do not bump it.

Each schema is strict: `additionalProperties` is `false` everywhere, so a
document with an unexpected key fails validation rather than being accepted with
the extra ignored.

## These files are generated

The single source of truth is [`../src/json-schema.ts`](../src/json-schema.ts).
These files are its JSON Schema rendering, maintained as file snapshots by
`../test/json-contract.test.ts`, which also validates real CLI output against the
same definitions. Do not hand-edit them — change `src/json-schema.ts` and
regenerate:

```sh
cd packages/install && ./node_modules/.bin/vitest run json-contract -u
```
