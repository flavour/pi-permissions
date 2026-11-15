import type { BreakerSnapshot } from "./decisions/breaker.js";
import type { LimiterSnapshot } from "./decisions/limiter.js";

export interface BashRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly command: string;
  readonly timeout?: number;
  readonly cwd: string;
  readonly userIntent?: string;
  readonly executionContext: Readonly<{
    prefix: string;
    verified: boolean;
    shellPath?: string;
  }>;
}

export interface Assessment {
  readonly kind: "allow" | "deny" | "defer";
  /** Who decided. `decisions-model` only ever appears on the enforce path. */
  readonly source: "policy" | "decisions-model" | "human" | "runtime";
  readonly reasonCode: string;
  readonly explanation: string;
  readonly ruleId?: string;
}

/**
 * What the Decisions Model proposed, recorded separately from what the gate
 * did. `authority` is the whole safety question in one field: `none` means the
 * proposal cannot move a decision, and `selected_profile` is only ever set by
 * the explicit enforce path, where a model `deny` is terminal and a model
 * `allow` is provisional. Deterministic blacklist precedence and whitelist
 * authority are never weakened by a model outcome in either mode.
 */
export interface ModelAssessment {
  readonly kind: "allow" | "deny" | "defer";
  readonly mode: "off" | "shadow" | "enforce";
  readonly authority: "none" | "selected_profile";
  readonly reasonCode: string;
  /** One display-safe sentence: no endpoint bodies, no credentials. */
  readonly explanation: string;
  readonly profileId?: string;
  /** Content hash of the whole profile: text, model, band, state and rule. */
  readonly profileIdentity?: string;
  readonly questionsTextVersion?: string;
  readonly stateKind?: string;
  readonly aggregation?: string;
  readonly requestedModel?: string;
  /** Only present when the endpoint's reported identity was verified equal. */
  readonly servedModel?: string;
  readonly latencyMs?: number;
  /** Context the payload ladder had to omit; empty means nothing was lost. */
  readonly dropped?: readonly string[];
  readonly readings?: Readonly<Record<string, number>>;
  readonly choices?: Readonly<Record<string, string>>;
  /** Endpoint token accounting, when reported. Never a compute budget. */
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
  /** Operational bounds observed for this attempt. */
  readonly breaker?: BreakerSnapshot;
  readonly queue?: LimiterSnapshot;
  /** Shared with a concurrent identical model computation (never approval). */
  readonly shared?: boolean;
}

export function snapshot(request: BashRequest): BashRequest {
  return Object.freeze({
    ...request,
    executionContext: Object.freeze({ ...request.executionContext }),
  });
}

export function denied(reasonCode: string, explanation: string): Assessment {
  return { kind: "deny", source: "runtime", reasonCode, explanation };
}
