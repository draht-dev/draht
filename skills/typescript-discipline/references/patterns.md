# Boundary and totality patterns

## Parse into a concrete value

Construct the checked shape instead of casting partially checked external input:

```ts
type User = { id: string; active: boolean };

function parseUser(input: unknown): User {
  if (typeof input !== "object" || input === null) throw new Error("expected user");
  if (!("id" in input) || typeof input.id !== "string") throw new Error("expected id");
  if (!("active" in input) || typeof input.active !== "boolean") throw new Error("expected active");
  return { id: input.id, active: input.active };
}
```

Use the project's schema parser when available. Domain validation may be stricter than the TypeScript shape. A duration represented as `number` can still be negative, infinite, or NaN; validate those constraints before constructing a duration type when they matter.

## Strengthen only the needed operation

```ts
type NonEmpty<T> = readonly [T, ...T[]];

function first<T>(values: NonEmpty<T>): T {
  return values[0];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
```

A `NonEmpty<T>` proves index zero exists. A random or computed index still needs bounds reasoning; a tuple does not make every numeric lookup safe. Returning `T | undefined` is appropriate when absence is part of the caller's contract.

## Exhaustiveness

```ts
type Result = { kind: "ok"; value: string } | { kind: "error"; message: string };

function describe(result: Result): string {
  switch (result.kind) {
    case "ok": return result.value;
    case "error": return result.message;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
```

The `never` assignment makes a newly added unhandled variant a compile error. Match the repository's existing exhaustive-switch convention.
