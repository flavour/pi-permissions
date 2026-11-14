/**
 * Outbound request assembly for `/v1/systemone`.
 *
 * Two state representations exist because the two candidate profiles were
 * calibrated against different ones. They are never interchangeable: a reading
 * from object state is not a reading from serialized-string state, so a profile
 * pins its `stateKind` and the builder refuses a mismatch.
 *
 * Budget rule: the limit applies to the **whole POST payload** — model name,
 * every question and the state — because that is what the endpoint reads. The
 * ladder removes context (facts, then the user message as a whole) and, when the
 * call still does not fit, reports `overBudget` so the caller does not send it.
 * The command is never truncated, and neither is the user message: a tail can
 * reverse the meaning of "did the user ask for this", so loss is all-or-nothing
 * and always reported in `dropped`.
 *
 * Masking is applied to the outbound bytes only. It shapes credential *shapes*,
 * which is a privacy mitigation, not a guarantee: an unusual or encoded secret
 * passes through, and masking can change what the model reads.
 */

import type { StateKind } from "./profile.js";

export type MaskShape =
  | "pem private key"
  | "jwt"
  | "vendor api key"
  | "aws access key id"
  | "aws secret key"
  | "bearer token"
  | "credential assignment";

const SECRET_SHAPES: readonly { name: MaskShape; pattern: RegExp }[] = [
  {
    name: "pem private key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  },
  {
    name: "vendor api key",
    pattern:
      /\b(?:sk|pk|rk|ak|pat|ghp|gho|ghu|ghs|ghr|github_pat|npm|pypi|dax|glpat|xox[bpsarx]?)[-_][A-Za-z0-9_-]{10,}\b/g,
  },
  {
    name: "aws access key id",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  },
  {
    name: "aws secret key",
    pattern: /\b(?:aws)?_?secret[_-]?access[_-]?key\s*[:=]\s*\S{20,}/gi,
  },
  {
    name: "bearer token",
    pattern: /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    name: "credential assignment",
    pattern:
      /(-{1,2}[A-Za-z0-9]*(?:password|passwd|secret|token|apikey|api-key|api_key|auth|credential)s?\b[=\s]+)(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/gi,
  },
];

/** Replace credential shapes with a marker. Shape-based and deliberately blunt. */
export function maskSecretShapes(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape.pattern, `[masked:${shape.name}]`);
  }
  return out;
}

/** Rough token estimate; the endpoint's tokenizer is not exposed to us. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ContextInput {
  readonly toolName: string;
  readonly command: string;
  readonly cwd: string;
  readonly branch?: string | undefined;
  readonly userMessage?: string | undefined;
  readonly facts?: readonly string[] | undefined;
}

export interface BuildRequestInput extends ContextInput {
  readonly stateKind: StateKind;
  readonly model: string;
  readonly questions: unknown;
  /** Byte-estimate ceiling for the complete POST payload. */
  readonly maxPayloadTokens: number;
}

export interface BuiltRequest {
  readonly payload: {
    readonly model: string;
    readonly state: unknown;
    readonly questions: unknown;
  };
  /** What the ladder removed, in removal order. Empty means nothing was lost. */
  readonly dropped: readonly string[];
  /** True when the call cannot be shown whole; the caller must not send it. */
  readonly overBudget: boolean;
  /** True when any context was dropped; the proposal is then never an allow. */
  readonly informationLoss: boolean;
  readonly tokensEstimate: number;
}

/** Serialized-string state block fence. Line-anchored; see the boundary note below. */
const FENCE = "«»";

function objectState(
  input: ContextInput,
  facts: readonly string[],
  userMessage: string | undefined,
): unknown {
  const value: Record<string, unknown> = {
    tool: input.toolName,
    command: maskSecretShapes(input.command),
    cwd: input.cwd,
  };
  if (input.branch) value.git_branch = input.branch;
  const context: Record<string, unknown> = {};
  if (userMessage) context.latest_user_message = maskSecretShapes(userMessage);
  if (facts.length > 0)
    context.facts = facts.map((fact) => maskSecretShapes(fact));
  return { value, context };
}

/**
 * `string-state-v1`: fixed field order, `field: value` scalars, and fenced
 * blocks for free text.
 *
 * Boundary caveat, recorded rather than hidden: the fence is not escaped, so a
 * command containing a bare `«»` line can blur its own block boundary. It is a
 * prompt shape, not a security boundary; a command can be denied or deferred on
 * it, never allowed by it.
 */
function stringState(
  input: ContextInput,
  facts: readonly string[],
  userMessage: string | undefined,
): string {
  const lines: string[] = [`tool: ${input.toolName}`, `cwd: ${input.cwd}`];
  if (input.branch) lines.push(`git_branch: ${input.branch}`);
  if (userMessage) {
    lines.push("user_request:", FENCE, maskSecretShapes(userMessage), FENCE);
  } else {
    lines.push("user_request: UNKNOWN");
  }
  if (facts.length > 0) {
    lines.push("facts:");
    for (const fact of facts) lines.push(`- ${maskSecretShapes(fact)}`);
  }
  lines.push("command:", FENCE, maskSecretShapes(input.command), FENCE);
  return `${lines.join("\n")}\n`;
}

export function buildRequestPayload(input: BuildRequestInput): BuiltRequest {
  const dropped: string[] = [];
  let facts = [...(input.facts ?? [])];
  let userMessage = input.userMessage;

  const assemble = (): BuiltRequest["payload"] => ({
    model: input.model,
    state:
      input.stateKind === "string-state-v1"
        ? stringState(input, facts, userMessage)
        : objectState(input, facts, userMessage),
    questions: input.questions,
  });

  const measure = (payload: BuiltRequest["payload"]): number =>
    estimateTokens(JSON.stringify(payload));

  let payload = assemble();
  let tokens = measure(payload);

  if (tokens > input.maxPayloadTokens && facts.length > 0) {
    facts = [];
    dropped.push("facts");
    payload = assemble();
    tokens = measure(payload);
  }
  if (tokens > input.maxPayloadTokens && userMessage !== undefined) {
    userMessage = undefined;
    dropped.push("user_message");
    payload = assemble();
    tokens = measure(payload);
  }

  return Object.freeze({
    payload,
    dropped: Object.freeze([...dropped]),
    // Even after the ladder removed everything removable, the call does not fit:
    // we are being asked to judge something we cannot see whole.
    overBudget: tokens > input.maxPayloadTokens,
    informationLoss: dropped.length > 0,
    tokensEstimate: tokens,
  });
}
