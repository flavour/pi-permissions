import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getProfile } from "./decisions/profile.js";

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
  readonly model?: ModelConfig;
}

export type ModelMode = "off" | "shadow" | "enforce";

/**
 * Operational bounds. These limit *effort spent waiting for an endpoint*; they
 * are not safety settings, they cannot approve anything, and there is no
 * `failOpen`: deterministic rules and floors run regardless of them.
 */
export interface ModelOperationalConfig {
  readonly concurrency: number;
  readonly maxQueue: number;
  readonly maxWaitMs: number;
  readonly breakerFailures: number;
  readonly breakerCooldownMs: number;
  /** Model computation only. Human approval is never deduplicated. */
  readonly dedupe: boolean;
}

export const OPERATIONAL_DEFAULTS: ModelOperationalConfig = Object.freeze({
  concurrency: 1,
  maxQueue: 2,
  maxWaitMs: 750,
  breakerFailures: 3,
  breakerCooldownMs: 60_000,
  dedupe: false,
});

export interface ModelConfig {
  readonly mode: ModelMode;
  /** A named profile from `decisions/profile.ts`; never a free-form prompt. */
  readonly profile: string;
  readonly endpoint: {
    readonly baseUrl: string;
    readonly model: string;
    readonly timeoutMs: number;
  };
  readonly maxPayloadTokens: number;
  readonly operational: ModelOperationalConfig;
}

/** Resolved model posture. `invalid` means the model is off and the reason is shown. */
export interface ModelStatus {
  readonly state: "off" | "ready" | "invalid";
  readonly mode?: ModelMode;
  readonly profile?: string;
  readonly config?: ModelConfig;
  /** Set only for a ready `enforce` posture: the operator's own acknowledgement. */
  readonly acknowledgement?: string;
  /** Safe to display: never echoes the supplied value. */
  readonly diagnostic?: string;
}

export interface LoadedConfig {
  readonly config: PolicyConfig;
  readonly status: "missing" | "valid" | "invalid";
  /** Content identity, not an mtime or a claim about execution. */
  readonly revision: string;
  /** Model posture for this exact snapshot, derived from the validated block. */
  readonly model: ModelStatus;
  /** Safe to display: never includes config contents or OS error messages. */
  readonly diagnostic?: string;
}

type Schema = Readonly<{
  type: "object" | "array" | "string" | "boolean" | "integer";
  const?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  properties?: Readonly<Record<string, Schema>>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: Schema;
}>;

/** M3 model block. `enforce` needs an acknowledgement and provisional limits. */
const modelSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "profile", "endpoint"],
  properties: {
    mode: { type: "string", pattern: "^(off|shadow|enforce)$" },
    profile: { type: "string", minLength: 1, maxLength: 80 },
    maxPayloadTokens: { type: "integer", minimum: 64, maximum: 8192 },
    // Required for an effective `enforce` posture; enforced in resolveModel, so
    // a shadow misconfiguration cannot be blamed for an unknown key.
    enforceAcknowledgement: { type: "string", minLength: 1, maxLength: 400 },
    endpoint: {
      type: "object",
      additionalProperties: false,
      required: ["baseUrl", "model"],
      properties: {
        // Absolute http(s) origin only: no path, query, fragment or userinfo.
        // Credentials in a URL are rejected outright, and a LAN host is not trust.
        baseUrl: { type: "string", pattern: "^https?://[^\\s/?#@]+$" },
        model: { type: "string", minLength: 1, maxLength: 200 },
        timeoutMs: { type: "integer", minimum: 100, maximum: 30000 },
      },
    },
    operational: {
      type: "object",
      additionalProperties: false,
      properties: {
        // One request at a time by default: reviews are serialized anyway, and a
        // queue of model calls in front of a human is pure latency.
        concurrency: { type: "integer", minimum: 1, maximum: 4 },
        maxQueue: { type: "integer", minimum: 0, maximum: 8 },
        maxWaitMs: { type: "integer", minimum: 50, maximum: 10000 },
        breakerFailures: { type: "integer", minimum: 2, maximum: 20 },
        breakerCooldownMs: { type: "integer", minimum: 1000, maximum: 600000 },
        dedupe: { type: "boolean" },
      },
    },
  },
} as const satisfies Schema;

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
  title: "pi-permissions global policy",
  $comment:
    "Rule IDs must additionally be unique across both lists (runtime check). Model authority is never implied: `enforce` requires enforceAcknowledgement, and no setting here can approve a command.",
  type: "object",
  additionalProperties: false,
  required: ["version", "whitelist", "blacklist"],
  properties: {
    version: { type: "integer", const: 1 },
    whitelist: { type: "array", items: ruleSchema },
    blacklist: { type: "array", items: ruleSchema },
    records: { type: "boolean" },
    model: modelSchema,
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
        (schema.const === undefined || value === schema.const) &&
        (schema.minimum === undefined || (value as number) >= schema.minimum) &&
        (schema.maximum === undefined || (value as number) <= schema.maximum)
      );
  }
}

export const EMPTY_CONFIG: PolicyConfig = Object.freeze({
  version: 1,
  whitelist: Object.freeze([]),
  blacklist: Object.freeze([]),
});

export const MODEL_OFF: ModelStatus = Object.freeze({ state: "off" });

export const DEFAULT_MODEL_TIMEOUT_MS = 1500;
export const DEFAULT_MAX_PAYLOAD_TOKENS = 1024;

/**
 * Acknowledgement the operator must type to grant the model any authority. It is
 * a prompt gate, not a capability: it makes a dangerous mode a deliberate act of
 * reading a sentence, and it is stored in the record path's config revision.
 */
export const ENFORCE_ACKNOWLEDGEMENT =
  "I understand this profile is provisional and its allows may be wrong";

/**
 * Turn a schema-valid model block into a posture. Schema shape is already
 * checked here; this enforces the things JSON Schema cannot: the profile must
 * exist, the configured served identity must equal the profile's pinned
 * identity, and `enforce` needs an explicit acknowledgement. A rejected block
 * switches the model off; it never disables deterministic policy and never
 * silently inherits another profile's calibration.
 */
function resolveModel(value: unknown): ModelStatus {
  if (!record(value)) return MODEL_OFF;
  const mode = value.mode as ModelMode;
  if (mode === "off") return MODEL_OFF;
  const endpoint = record(value.endpoint) ? value.endpoint : undefined;
  if (!endpoint) return MODEL_OFF;
  const operationalValue = record(value.operational) ? value.operational : {};
  const operational: ModelOperationalConfig = Object.freeze({
    concurrency:
      typeof operationalValue.concurrency === "number"
        ? operationalValue.concurrency
        : OPERATIONAL_DEFAULTS.concurrency,
    maxQueue:
      typeof operationalValue.maxQueue === "number"
        ? operationalValue.maxQueue
        : OPERATIONAL_DEFAULTS.maxQueue,
    maxWaitMs:
      typeof operationalValue.maxWaitMs === "number"
        ? operationalValue.maxWaitMs
        : OPERATIONAL_DEFAULTS.maxWaitMs,
    breakerFailures:
      typeof operationalValue.breakerFailures === "number"
        ? operationalValue.breakerFailures
        : OPERATIONAL_DEFAULTS.breakerFailures,
    breakerCooldownMs:
      typeof operationalValue.breakerCooldownMs === "number"
        ? operationalValue.breakerCooldownMs
        : OPERATIONAL_DEFAULTS.breakerCooldownMs,
    dedupe: operationalValue.dedupe === true,
  });
  const config: ModelConfig = Object.freeze({
    mode,
    profile: String(value.profile),
    endpoint: Object.freeze({
      baseUrl: String(endpoint.baseUrl),
      model: String(endpoint.model),
      timeoutMs:
        typeof endpoint.timeoutMs === "number"
          ? endpoint.timeoutMs
          : DEFAULT_MODEL_TIMEOUT_MS,
    }),
    maxPayloadTokens:
      typeof value.maxPayloadTokens === "number"
        ? value.maxPayloadTokens
        : DEFAULT_MAX_PAYLOAD_TOKENS,
    operational,
  });
  const profile = getProfile(config.profile);
  if (mode === "enforce") {
    const invalid = (diagnostic: string): ModelStatus =>
      Object.freeze({
        state: "invalid",
        mode,
        profile: config.profile,
        diagnostic,
      });
    if (value.enforceAcknowledgement !== ENFORCE_ACKNOWLEDGEMENT)
      return invalid(
        `model mode "enforce" is not active: set model.enforceAcknowledgement to exactly "${ENFORCE_ACKNOWLEDGEMENT}" to grant the model authority, or use mode "shadow". The model is off and every call still needs an exact whitelist or a human.`,
      );
    if (!profile)
      return invalid(
        'model mode "enforce" needs a known profile; the model is off. Use one of the documented profile IDs.',
      );
    if (profile.model !== config.endpoint.model)
      return invalid(
        "model.endpoint.model does not match the profile's pinned model identity; enforce is off rather than borrowing another profile's calibration.",
      );
    if (config.endpoint.timeoutMs > 5000 || config.maxPayloadTokens > 2048)
      return invalid(
        "model enforcement needs a bounded request: endpoint.timeoutMs must be <= 5000 and maxPayloadTokens <= 2048. The model is off.",
      );
    return Object.freeze({
      state: "ready",
      mode,
      profile: config.profile,
      config,
      acknowledgement: ENFORCE_ACKNOWLEDGEMENT,
    });
  }
  if (!profile)
    return Object.freeze({
      state: "invalid",
      mode,
      profile: config.profile,
      diagnostic:
        "unknown model profile; the model is off. Use one of the documented profile IDs.",
    });
  if (profile.model !== config.endpoint.model)
    return Object.freeze({
      state: "invalid",
      mode,
      profile: config.profile,
      diagnostic:
        "model.endpoint.model does not match the profile's pinned model identity; the model is off.",
    });
  return Object.freeze({
    state: "ready",
    mode,
    profile: config.profile,
    config,
  });
}

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
      model: MODEL_OFF,
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
      model: resolveModel(config.model),
    });
  } catch {
    return Object.freeze({
      config: EMPTY_CONFIG,
      status: "invalid",
      revision: revision("invalid", contents),
      model: MODEL_OFF,
      diagnostic:
        "Invalid global pi-permissions config: use version 1 exact rules with unique IDs; automatic approval is disabled.",
    });
  }
}
