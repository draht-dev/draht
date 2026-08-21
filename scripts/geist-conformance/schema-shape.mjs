/**
 * Structural introspection of the geist wire, used by both the drift gate and
 * the corpus generator (R32-FLEET.4, R32-FLEET.5).
 *
 * Three jobs:
 *   - `describeSchema` turns a zod schema into a canonical, order-stable
 *     descriptor. The hash of every wire schema's descriptor is the fingerprint
 *     committed alongside the corpus, so a field-level change to any schema is
 *     detectable without diffing source.
 *   - `mirrorShape` reduces that descriptor to the vocabulary the socket wire
 *     can also be expressed in (name, optionality, literal/enum/primitive), so
 *     the two can be compared field for field.
 *   - `parseSocketWireTypes` reads the socket wire's TypeScript declarations
 *     into the same vocabulary. It parses rather than imports because the point
 *     is to compare against what `types.ts` *says*, including the union
 *     membership a runtime import would erase.
 */

import { readFileSync } from "node:fs";

/** Canonical, order-stable structural descriptor of a zod schema. */
export function describeSchema(schema) {
	const def = schema?._def;
	if (!def) return { kind: "unknown" };
	switch (def.typeName) {
		case "ZodString":
			return { kind: "string", checks: describeChecks(def.checks) };
		case "ZodNumber":
			return { kind: "number", checks: describeChecks(def.checks) };
		case "ZodBoolean":
			return { kind: "boolean" };
		case "ZodLiteral":
			return { kind: "literal", value: def.value };
		case "ZodEnum":
			return { kind: "enum", values: [...def.values] };
		case "ZodArray":
			return { kind: "array", element: describeSchema(def.type) };
		case "ZodOptional":
			return { kind: "optional", inner: describeSchema(def.innerType) };
		case "ZodNullable":
			return { kind: "nullable", inner: describeSchema(def.innerType) };
		case "ZodRecord":
			return { kind: "record", key: describeSchema(def.keyType), value: describeSchema(def.valueType) };
		case "ZodObject": {
			const fields = {};
			for (const name of Object.keys(schema.shape).sort()) fields[name] = describeSchema(schema.shape[name]);
			return { kind: "object", fields };
		}
		case "ZodDiscriminatedUnion":
			return {
				kind: "discriminatedUnion",
				discriminator: def.discriminator,
				options: def.options.map((option) => describeSchema(option)),
			};
		case "ZodUnion":
			return { kind: "union", options: def.options.map((option) => describeSchema(option)) };
		default:
			return { kind: def.typeName };
	}
}

function describeChecks(checks) {
	if (!checks) return [];
	return checks.map(describeCheck).sort();
}

/**
 * One check, as a string that carries everything the check ENFORCES.
 *
 * Most checks put their value in `check.value` (`min:1`, `max:4000`). A regex check does not: its
 * value is the pattern, and `check.value` is `undefined`, so recording `check.kind` alone reduced
 * every regex check to the bare word `regex`. That is not a cosmetic loss — the wire's `safeText`
 * fields fold BOTH their neutralization table and their length bound into one regex check, so nine
 * descriptors that read `max:200` / `max:4000` / `max:1024` / `max:128` collapsed into an identical
 * `regex`, and the version gate could no longer tell `toolName` from `message`, nor notice a
 * neutralization range being deleted.
 *
 * So a regex is described by its source, its flags, and any own enumerable property it carries: a
 * `RegExp` subclass whose `test` is parameterized (the wire's grapheme bound is one) hides its bound
 * nowhere else, and a plain `RegExp` has no such properties, so this costs nothing anywhere else.
 */
function describeCheck(check) {
	if (check.kind === "regex" && check.regex instanceof RegExp) {
		const parameters = Object.keys(check.regex)
			.sort()
			.map((key) => ` ${key}=${JSON.stringify(check.regex[key])}`)
			.join("");
		return `regex:/${check.regex.source}/${check.regex.flags}${parameters}`;
	}
	return check.value === undefined ? check.kind : `${check.kind}:${check.value}`;
}

/** True when the value is a zod schema rather than a constant or a function. */
export function isZodSchema(value) {
	return typeof value === "object" && value !== null && "_def" in value && typeof value._def?.typeName === "string";
}

/**
 * Reduce a descriptor to the vocabulary the socket wire also speaks. String and
 * number refinements (`.min(1)`) are dropped on purpose: they tighten a field,
 * they do not move it, and the socket wire has no way to express them. The
 * fingerprint still carries them, so loosening one is a version-bump change
 * even though it is not a mirror break.
 */
export function mirrorShape(descriptor) {
	switch (descriptor.kind) {
		case "optional":
			return { ...mirrorShape(descriptor.inner), optional: true };
		case "string":
			return { type: "string", optional: false };
		case "number":
			return { type: "number", optional: false };
		case "boolean":
			return { type: "boolean", optional: false };
		case "literal":
			return { type: "literal", value: descriptor.value, optional: false };
		case "enum":
			return { type: "enum", values: [...descriptor.values].sort(), optional: false };
		default:
			return { type: `opaque:${descriptor.kind}`, optional: false };
	}
}

/** Field-for-field mirror view of a zod object schema. */
export function mirrorFields(schema) {
	const described = describeSchema(schema);
	if (described.kind !== "object") throw new Error(`expected an object schema, got ${described.kind}`);
	const fields = {};
	for (const [name, field] of Object.entries(described.fields)) fields[name] = mirrorShape(field);
	return fields;
}

function stripComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Parse the socket wire's `types.ts` into `{ interfaces, aliases, unions }`.
 *
 * `interfaces` maps an interface name to its fields in `mirrorShape`
 * vocabulary; `aliases` maps a string-union type alias (e.g. `ClientMode`) to
 * its members; `unions` maps a type alias over other named types (e.g.
 * `ServerMessage`) to its members, which is what makes "a socket message type
 * was added and nothing mirrors it" detectable.
 */
export function parseSocketWireTypes(path) {
	const source = stripComments(readFileSync(path, "utf8"));
	const interfaces = {};
	const aliases = {};
	const unions = {};

	for (const match of source.matchAll(/export\s+interface\s+([A-Za-z0-9_$]+)\s*\{([\s\S]*?)\n\}/g)) {
		const [, name, body] = match;
		const fields = {};
		for (const line of body.split("\n")) {
			const field = line.match(/^\s*(?:readonly\s+)?([A-Za-z0-9_$]+)(\??)\s*:\s*(.+?);\s*$/);
			if (!field) continue;
			fields[field[1]] = { raw: field[3].trim(), optional: field[2] === "?" };
		}
		interfaces[name] = fields;
	}

	for (const match of source.matchAll(/export\s+type\s+([A-Za-z0-9_$]+)\s*=\s*([\s\S]*?);/g)) {
		const [, name, rhs] = match;
		const members = rhs
			.split("|")
			.map((member) => member.trim())
			.filter(Boolean);
		if (members.every((member) => /^"[^"]*"$/.test(member))) {
			aliases[name] = members.map((member) => member.slice(1, -1));
		} else if (members.every((member) => /^[A-Za-z0-9_$]+$/.test(member))) {
			unions[name] = members;
		}
	}

	// Resolve each interface field's declared TypeScript type into the shared
	// vocabulary, following string-union aliases one level (`mode: ClientMode`).
	const resolved = {};
	for (const [name, fields] of Object.entries(interfaces)) {
		resolved[name] = {};
		for (const [field, { raw, optional }] of Object.entries(fields)) {
			resolved[name][field] = { ...resolveTsType(raw, aliases), optional };
		}
	}
	return { interfaces: resolved, aliases, unions };
}

function resolveTsType(raw, aliases) {
	const members = raw
		.split("|")
		.map((member) => member.trim())
		.filter(Boolean);
	if (members.length === 1) {
		const only = members[0];
		if (/^"[^"]*"$/.test(only)) return { type: "literal", value: only.slice(1, -1) };
		if (only === "string") return { type: "string" };
		if (only === "number") return { type: "number" };
		if (only === "boolean") return { type: "boolean" };
		if (aliases[only]) return { type: "enum", values: [...aliases[only]].sort() };
		return { type: `opaque:${only}` };
	}
	if (members.every((member) => /^"[^"]*"$/.test(member))) {
		return { type: "enum", values: members.map((member) => member.slice(1, -1)).sort() };
	}
	return { type: `opaque:${raw}` };
}
