/**
 * The only module that talks to the decision endpoint.
 *
 * Wire contract (`POST <baseUrl><path>`): `{ model, state, questions }`. The
 * response echoes question keys in `answers`; a noul answer is
 * `{ type: "noul", noul: p }` and a choice answer is
 * `{ type: "choice", choice, probabilities, confidence }`. `usage.input_tokens`
 * is accounting only — it is not a compute budget and not a sharing signal.
 *
 * Every failure is a typed `EndpointError` so callers can turn it into a defer
 * without string matching. Nothing here retries, clamps, or guesses: a reading
 * that cannot be verified is a failure, never a `0`, never a boundary value, and
 * never an `allow`.
 */

import type { DecisionProfile } from "./profile.js";

export type EndpointFailureKind =
  | "unreachable"
  | "timeout"
  | "http"
  | "parse"
  | "identity"
  | "range"
  /** Caller cancellation. Never endpoint ill-health, so never breaker fuel. */
  | "cancelled"
  /** Anything that was not a classified transport/protocol failure. */
  | "unknown";

export class EndpointError extends Error {
  readonly kind: EndpointFailureKind;
  /** Sanitized: never an endpoint response body and never a credential. */
  readonly detail: string;

  constructor(kind: EndpointFailureKind, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = "EndpointError";
    this.kind = kind;
    this.detail = detail.slice(0, 300);
  }
}

export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface AskResult {
  /** Question key → the raw in-range reading, before polarity inversion. */
  readonly readings: Readonly<Record<string, number>>;
  /** Question key → the label chosen by a `choice` answer, if any. */
  readonly choices: Readonly<Record<string, string>>;
  /** Question key → the full validated label distribution, for `choice` answers. */
  readonly distributions: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
  /** The identity the server reported, validated equal to the profile's model. */
  readonly model: string;
  readonly usage?: Usage;
  readonly latencyMs: number;
}

/**
 * Injectable seam so unit tests can drive either a fake transport or real
 * loopback HTTP. The signal is the caller's cancellation: the default transport
 * joins it with its own timeout, so an abandoned call stops spending.
 */
export type Transport = (
  url: string,
  payload: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<unknown>;

function classifyFetchError(
  error: unknown,
  caller?: AbortSignal,
): EndpointError {
  if (error instanceof EndpointError) return error;
  // Cancellation is checked before the error name: an aborted fetch and an
  // abandoned request can look identical, and only one of them is the
  // endpoint's fault. Cancellation never counts against the breaker.
  if (caller?.aborted)
    return new EndpointError("cancelled", "request cancelled");
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError")
    return new EndpointError("timeout", "request deadline exceeded");
  if (name === "AbortError")
    return new EndpointError("unreachable", "request aborted");
  return new EndpointError(
    "unreachable",
    message.slice(0, 200) || "fetch failed",
  );
}

/**
 * One deadline, two reasons. `AbortSignal.any` keeps the request's own timeout
 * (a `TimeoutError`) distinct from caller cancellation (an abort of the caller's
 * signal), because only the first counts against the breaker.
 */
function combinedSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  return AbortSignal.any([caller, timeout]);
}

async function fetchTransport(
  url: string,
  payload: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: combinedSignal(timeoutMs, signal),
    });
  } catch (error) {
    throw classifyFetchError(error, signal);
  }
  if (!response.ok) {
    // Bodies can echo request content; keep only a short status marker.
    throw new EndpointError("http", `status ${response.status}`);
  }
  const text = await response.text().catch(() => {
    throw new EndpointError("unreachable", "response body unreadable");
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EndpointError("parse", "response body is not JSON");
  }
}

export interface AskOptions {
  readonly baseUrl: string;
  readonly path: string;
  readonly profile: DecisionProfile;
  readonly state: unknown;
  readonly questions: unknown;
  readonly timeoutMs: number;
  /** Caller cancellation. Distinct from the request timeout in the failure kind. */
  readonly signal?: AbortSignal;
  readonly transport?: Transport;
  readonly now?: () => number;
}

/** One request carrying every question in the profile — batching, not per-question fan-out. */
export async function askSystemOne(options: AskOptions): Promise<AskResult> {
  const transport = options.transport ?? fetchTransport;
  const url = new URL(options.path, options.baseUrl).toString();
  const payload = {
    model: options.profile.model,
    state: options.state,
    questions: options.questions,
  };

  const now = options.now ?? Date.now;
  const started = now();
  let raw: unknown;
  try {
    if (options.signal?.aborted)
      throw new EndpointError("cancelled", "aborted before sending");
    raw = await transport(
      url,
      payload,
      options.timeoutMs,
      options.signal ?? undefined,
    );
  } catch (error) {
    if (error instanceof EndpointError) throw error;
    // A transport that does not honour cancellation still cannot deliver an
    // answer the caller has abandoned.
    if (options.signal?.aborted)
      throw new EndpointError("cancelled", "cancelled during send");
    throw new EndpointError(
      "unknown",
      error instanceof Error ? error.message.slice(0, 200) : "transport threw",
    );
  }
  const latencyMs = Math.max(0, now() - started);

  return parseAnswers(raw, options.profile, latencyMs);
}

function finiteUnit(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new EndpointError(
      "range",
      `answer \`${key}\` is not a finite number`,
    );
  if (value < 0 || value > 1)
    throw new EndpointError(
      "range",
      `answer \`${key}\` is outside 0..1 (${value}); readings are never clamped`,
    );
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the entire response: reported identity, answer key set, answer types,
 * finite in-range readings, declared labels, and distribution sums. A malformed
 * or unverifiable response is a failure that defers to a human.
 */
export function parseAnswers(
  raw: unknown,
  profile: DecisionProfile,
  latencyMs: number,
): AskResult {
  if (!isRecord(raw))
    throw new EndpointError("parse", "response is not an object");

  const reported = raw.model;
  if (typeof reported !== "string")
    throw new EndpointError(
      "identity",
      "response does not report a model identity, so it cannot be verified",
    );
  if (reported !== profile.model)
    throw new EndpointError(
      "identity",
      `served model "${reported.slice(0, 120)}" is not the profile's "${profile.model}"; no fallback model is applied`,
    );

  if (!isRecord(raw.answers))
    throw new EndpointError("parse", "response has no `answers` object");
  const answers = raw.answers;

  const expected = expectedQuestions(profile.questions);
  for (const key of Object.keys(answers)) {
    if (!expected.types[key])
      throw new EndpointError(
        "parse",
        `unexpected answer key \`${key}\`; the response is not the profile's question set`,
      );
  }

  const readings: Record<string, number> = {};
  const choices: Record<string, string> = {};
  const distributions: Record<string, Record<string, number>> = {};

  for (const key of expected.order) {
    const answer = answers[key];
    if (!isRecord(answer))
      throw new EndpointError("parse", `answer \`${key}\` is missing`);
    const type = answer.type;
    if (type !== expected.types[key])
      throw new EndpointError(
        "parse",
        `answer \`${key}\` has type \`${String(type)}\`, not \`${expected.types[key]}\``,
      );

    if (type === "noul") {
      readings[key] = finiteUnit(answer.noul, key);
      continue;
    }

    const labels = expected.labels[key] ?? [];
    const chosen = answer.choice;
    if (typeof chosen !== "string" || !labels.includes(chosen))
      throw new EndpointError(
        "parse",
        `answer \`${key}\` chose an undeclared label`,
      );
    if (!isRecord(answer.probabilities))
      throw new EndpointError(
        "parse",
        `answer \`${key}\` has no probability distribution`,
      );
    const distribution: Record<string, number> = {};
    let total = 0;
    for (const [label, value] of Object.entries(answer.probabilities)) {
      if (!labels.includes(label))
        throw new EndpointError(
          "parse",
          `answer \`${key}\` reports an undeclared label \`${label}\``,
        );
      const probability = finiteUnit(value, `${key}.${label}`);
      distribution[label] = probability;
      total += probability;
    }
    if (Math.abs(total - 1) > 0.02)
      throw new EndpointError(
        "range",
        `answer \`${key}\` probabilities sum to ${total.toFixed(3)}, not 1`,
      );
    if (answer.confidence !== undefined)
      finiteUnit(answer.confidence, `${key}.confidence`);
    distributions[key] = distribution;
    choices[key] = chosen;
  }

  let usage: Usage | undefined;
  if (raw.usage !== undefined) {
    if (!isRecord(raw.usage))
      throw new EndpointError("parse", "`usage` is not an object");
    const input = raw.usage.input_tokens;
    const output = raw.usage.output_tokens;
    if (
      !Number.isInteger(input) ||
      !Number.isInteger(output) ||
      (input as number) < 0 ||
      (output as number) < 0
    )
      throw new EndpointError("parse", "`usage` token counts are invalid");
    usage = { input_tokens: input as number, output_tokens: output as number };
  }
  return {
    readings,
    choices,
    distributions,
    model: reported,
    latencyMs,
    ...(usage ? { usage } : {}),
  };
}

interface ExpectedQuestions {
  readonly order: readonly string[];
  readonly types: Readonly<Record<string, "noul" | "choice">>;
  readonly labels: Readonly<Record<string, readonly string[]>>;
}

function expectedQuestions(questions: unknown): ExpectedQuestions {
  if (!isRecord(questions))
    throw new EndpointError("parse", "profile questions are not an object");
  const order: string[] = [];
  const types: Record<string, "noul" | "choice"> = {};
  const labels: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(questions)) {
    if (!isRecord(value))
      throw new EndpointError(
        "parse",
        `profile question \`${key}\` is invalid`,
      );
    const type = value.type;
    if (type !== "noul" && type !== "choice")
      throw new EndpointError(
        "parse",
        `profile question \`${key}\` has an unknown type`,
      );
    order.push(key);
    types[key] = type;
    if (type === "choice")
      labels[key] = isRecord(value.criteria) ? Object.keys(value.criteria) : [];
  }
  if (order.length === 0)
    throw new EndpointError("parse", "profile declares no questions");
  return { order, types, labels };
}
