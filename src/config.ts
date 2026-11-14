import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const EXTENSION_ID = "pi-permissions";

export interface ExactRule {
  readonly id: string;
  readonly exact: string;
  readonly cwd?: string;
  readonly reason?: string;
}

export interface PolicyConfig {
  readonly version: 1;
  readonly whitelist: readonly ExactRule[];
  readonly blacklist: readonly ExactRule[];
  readonly records?: boolean;
}

export interface LoadedConfig {
  readonly config: PolicyConfig;
  readonly status: "missing" | "valid" | "invalid";
  /** Content identity, not an mtime or a claim about execution. */
  readonly revision: string;
  /** Safe to display: never includes config contents or OS error messages. */
  readonly diagnostic?: string;
}

type Schema = Readonly<{
  type: "object" | "array" | "string" | "boolean" | "integer";
  const?: number;
  minLength?: number;
  pattern?: string;
  properties?: Readonly<Record<string, Schema>>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: Schema;
}>;

const ruleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "exact"],
  properties: {
    id: {
      type: "string",
      minLength: 1,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*(?![\\s\\S])",
    },
    exact: { type: "string" },
    // POSIX absolute path; do not normalize, expand ~, resolve symlinks or trim.
    cwd: { type: "string", pattern: "^/[^\\u0000]*$" },
    reason: { type: "string", minLength: 1 },
  },
} as const satisfies Schema;

/** Validation and generated documentation share this dependency-free source. */
export const configSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "pi-permissions M1 global policy",
  $comment:
    "Rule IDs must additionally be unique across both lists (runtime check).",
  type: "object",
  additionalProperties: false,
  required: ["version", "whitelist", "blacklist"],
  properties: {
    version: { type: "integer", const: 1 },
    whitelist: { type: "array", items: ruleSchema },
    blacklist: { type: "array", items: ruleSchema },
    records: { type: "boolean" },
  },
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only the schema vocabulary used above; not a general JSON Schema engine. */
function conforms(value: unknown, schema: Schema): boolean {
  switch (schema.type) {
    case "object": {
      if (!record(value)) return false;
      const properties = schema.properties ?? {};
      return (
        (schema.required ?? []).every((key) => Object.hasOwn(value, key)) &&
        Object.keys(value).every((key) => {
          const child = Object.hasOwn(properties, key)
            ? properties[key]
            : undefined;
          return child !== undefined && conforms(value[key], child);
        })
      );
    }
    case "array":
      return (
        Array.isArray(value) &&
        value.every(
          (item) => schema.items !== undefined && conforms(item, schema.items),
        )
      );
    case "string":
      return (
        typeof value === "string" &&
        value.length >= (schema.minLength ?? 0) &&
        (schema.pattern === undefined ||
          new RegExp(schema.pattern, "u").test(value))
      );
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        Number.isInteger(value) &&
        (schema.const === undefined || value === schema.const)
      );
  }
}

export const EMPTY_CONFIG: PolicyConfig = Object.freeze({
  version: 1,
  whitelist: Object.freeze([]),
  blacklist: Object.freeze([]),
});

function freezeConfig(config: PolicyConfig): PolicyConfig {
  for (const rule of [...config.whitelist, ...config.blacklist])
    Object.freeze(rule);
  Object.freeze(config.whitelist);
  Object.freeze(config.blacklist);
  return Object.freeze(config);
}

function revision(status: LoadedConfig["status"], contents: string): string {
  return `${status}:${createHash("sha256").update(contents).digest("hex")}`;
}

/** Read exactly the supplied Pi agent directory, never cwd, HOME or a project config. */
export function loadConfig(agentDir: string): LoadedConfig {
  let contents: string;
  try {
    contents = readFileSync(
      join(agentDir, "extensions", EXTENSION_ID, "config.json"),
      "utf8",
    );
  } catch (error) {
    const missing = record(error) && error.code === "ENOENT";
    const status = missing ? "missing" : "invalid";
    return Object.freeze({
      config: EMPTY_CONFIG,
      status,
      revision: revision(status, ""),
      ...(missing
        ? {}
        : {
            diagnostic:
              "Cannot read global pi-permissions config; automatic approval is disabled.",
          }),
    });
  }
  try {
    const value: unknown = JSON.parse(contents);
    if (!conforms(value, configSchema)) throw new Error("schema");
    // Validated above. This assertion does not coerce or discard any field.
    const config = value as PolicyConfig;
    const ids = new Set<string>();
    for (const rule of [...config.whitelist, ...config.blacklist]) {
      if (ids.has(rule.id)) throw new Error("duplicate rule ID");
      ids.add(rule.id);
    }
    return Object.freeze({
      config: freezeConfig(config),
      status: "valid",
      revision: revision("valid", contents),
    });
  } catch {
    return Object.freeze({
      config: EMPTY_CONFIG,
      status: "invalid",
      revision: revision("invalid", contents),
      diagnostic:
        "Invalid global pi-permissions config: use version 1 exact rules with unique IDs; automatic approval is disabled.",
    });
  }
}
