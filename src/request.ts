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
  readonly source: "policy" | "human" | "runtime";
  readonly reasonCode: string;
  readonly explanation: string;
  readonly ruleId?: string;
}

/**
 * What the Decisions Model proposed, recorded separately from what the gate
 * did. `authority` is `none` while model authority is shadow: no code path turns
 * a shadow proposal into an allow or a block.
 */
export interface ModelAssessment {
  readonly kind: "allow" | "deny" | "defer";
  readonly mode: "off" | "shadow" | "enforce";
  readonly authority: "none";
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
