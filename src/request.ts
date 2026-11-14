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

export function snapshot(request: BashRequest): BashRequest {
  return Object.freeze({
    ...request,
    executionContext: Object.freeze({ ...request.executionContext }),
  });
}

export function denied(reasonCode: string, explanation: string): Assessment {
  return { kind: "deny", source: "runtime", reasonCode, explanation };
}
