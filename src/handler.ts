import { type Confirm, HumanReviewer } from "./ask.js";
import type { LoadedConfig } from "./config.js";
import { evaluatePolicy } from "./policy.js";
import {
  type Assessment,
  type BashRequest,
  denied,
  type ModelAssessment,
} from "./request.js";

/**
 * Asks the Decisions Model about a call that deterministic policy deferred.
 * Implementations must never return an authorization: the result is a proposal
 * the reviewer sees, and `enforce`/`allow` authority does not exist here.
 */
export type ModelConsultant = (
  request: BashRequest,
  signal?: AbortSignal,
) => Promise<ModelAssessment | undefined>;

export interface DecisionRecord {
  readonly type: "decision";
  readonly timestamp: string;
  readonly request: BashRequest;
  readonly policy: Assessment;
  /** The model's proposal, kept separate from the effective decision. */
  readonly model: ModelAssessment | undefined;
  readonly effective: Assessment;
  readonly configRevision: string;
  readonly modelProfileIdentity?: string;
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
      model?: ModelConsultant | undefined;
    },
  ): Promise<Assessment> {
    const policy = evaluatePolicy(request, config);
    let effective = policy;
    let model: ModelAssessment | undefined;
    // Unsupported modes cannot inherit a rule/preset allow, and cannot pay a
    // model round trip for a call that will be blocked anyway.
    if (context.signal?.aborted)
      effective = denied("request_cancelled", "The request was cancelled.");
    else if (context.mode !== "tui" || !context.hasUI)
      effective = denied(
        "no_review_ui",
        "Bash requires a supported interactive Pi TUI. Print/JSON and RPC review are unsupported; open an interactive session.",
      );
    else if (policy.kind === "defer") {
      model = await context.model?.(request, context.signal);
      effective = await this.reviewer.review(
        request,
        policy,
        context.confirm,
        context.signal,
        model,
      );
    }
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
      model,
      effective,
      configRevision: config.revision,
      ...(model?.profileIdentity === undefined
        ? {}
        : { modelProfileIdentity: model.profileIdentity }),
      execution: "not_observed",
    });
    return effective;
  }
}
