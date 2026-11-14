import { type Confirm, HumanReviewer } from "./ask.js";
import type { LoadedConfig } from "./config.js";
import { evaluatePolicy } from "./policy.js";
import { type Assessment, type BashRequest, denied } from "./request.js";

export interface DecisionRecord {
  readonly type: "decision";
  readonly timestamp: string;
  readonly request: BashRequest;
  readonly policy: Assessment;
  readonly effective: Assessment;
  readonly configRevision: string;
  readonly execution: "not_observed";
}

/** Pure policy first; a defer must resolve to human approval or an explicit denial. */
export class Handler {
  constructor(private readonly reviewer = new HumanReviewer()) {}

  async decide(
    request: BashRequest,
    config: LoadedConfig,
    context: {
      mode: string;
      hasUI: boolean;
      confirm: Confirm;
      signal?: AbortSignal | undefined;
      record: (record: DecisionRecord) => void;
      valid?: () => boolean;
    },
  ): Promise<Assessment> {
    const policy = evaluatePolicy(request, config);
    let effective = policy;
    // Unsupported modes cannot inherit a rule/preset allow.
    if (context.signal?.aborted)
      effective = denied("request_cancelled", "The request was cancelled.");
    else if (context.mode !== "tui" || !context.hasUI)
      effective = denied(
        "no_review_ui",
        "Bash requires a supported interactive Pi TUI. Print/JSON and RPC review are unsupported; open an interactive session.",
      );
    else if (policy.kind === "defer")
      effective = await this.reviewer.review(
        request,
        policy,
        context.confirm,
        context.signal,
      );
    if (context.signal?.aborted)
      effective = denied("request_cancelled", "The request was cancelled.");
    if (context.valid && !context.valid())
      effective = denied(
        "request_changed",
        "The invocation or execution context changed during review; approval is invalid.",
      );
    context.record({
      type: "decision",
      timestamp: new Date().toISOString(),
      request,
      policy,
      effective,
      configRevision: config.revision,
      execution: "not_observed",
    });
    return effective;
  }
}
