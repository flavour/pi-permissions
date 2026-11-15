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
 *
 * `authority` on the returned assessment is the whole contract: `none` in
 * shadow mode, where the proposal only informs the human, and
 * `selected_profile` only on the explicit enforce path, where a model `deny` is
 * terminal. An allow is *never* effective on its own in either mode — the
 * reviewer's assertion below is what enforces that, not a convention.
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
  /** The model's proposal and its authority, kept separate from the decision. */
  readonly model: ModelAssessment | undefined;
  readonly effective: Assessment;
  readonly configRevision: string;
  readonly modelProfileIdentity?: string;
  /** Always `not_observed`: this package never observes whether a shell ran. */
  readonly execution: "not_observed";
}

/** Pure policy first; a `defer` must resolve to human approval or an explicit denial. */
export class Handler {
  private last?: string;

  constructor(private readonly reviewer = new HumanReviewer()) {}

  /** Inspectable posture for the operator, without reading raw records. */
  get pendingReviews(): number {
    return this.reviewer.pendingCount;
  }

  get lastDecision(): string | undefined {
    return this.last;
  }

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
      /**
       * Authority the *resolved configuration* grants the model for this call.
       * The Handler will not act on more than this, whatever the assessment
       * claims, and it can only ever be a terminal deny rather than an allow.
       */
      modelAuthority?: "none" | "selected_profile" | undefined;
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
      // Authority is granted by configuration, never claimed by the model.
      // `context.modelAuthority` comes from the resolved posture; an assessment
      // that asserts more than the operator configured is treated as a proposal
      // and the mismatch stays visible in the record.
      const granted =
        context.modelAuthority === "selected_profile" &&
        model?.authority === "selected_profile" &&
        model?.mode === "enforce"
          ? "selected_profile"
          : "none";
      if (model && granted === "selected_profile") {
        // Enforce mode. `policy.kind === "defer"` above is what preserves the
        // order that matters: a blacklist deny never reaches the model, and a
        // whitelist allow never consults it. A model deny is terminal here; a
        // model defer reaches the human; a model allow is still provisional.
        if (model.kind === "deny") effective = modelDenial(model);
        else effective = await this.review(request, policy, context, model);
      } else {
        // Shadow mode, or an enforce claim the configuration does not back:
        // the proposal is shown and recorded, and decides nothing.
        effective = await this.review(request, policy, context, model);
      }
      // The last line of authority on the model-consulted path, not a
      // restatement of the design. Whitelist allows never enter this branch at
      // all (policy returned `allow`, not `defer`), so the only allows possible
      // here are human ones: a model outcome in any mode, including a shadow
      // proposal beside a review, cannot survive this assertion.
      if (effective.kind === "allow" && effective.source !== "human")
        effective = denied(
          "authority_violation",
          "An automatic approval arrived from outside the operator's exact whitelist and human review, so it was refused.",
        );
    }
    if (context.signal?.aborted)
      effective = denied("request_cancelled", "The request was cancelled.");
    if (context.valid && !context.valid())
      effective = denied(
        "request_changed",
        "The invocation or execution context changed during review; approval is invalid.",
      );
    this.last = `${effective.kind} (${effective.reasonCode}${
      effective.ruleId ? ` rule ${effective.ruleId}` : ""
    })`;
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

  private review(
    request: BashRequest,
    policy: Assessment,
    context: {
      confirm: Confirm;
      signal?: AbortSignal | undefined;
    },
    model?: ModelAssessment,
  ): Promise<Assessment> {
    return this.reviewer.review(
      request,
      policy,
      context.confirm,
      context.signal,
      model,
    );
  }
}

/**
 * A terminal model denial in enforce mode. The reason names the profile and the
 * evidence, because "the model said no" is not reviewable: the operator needs to
 * know which profile, on which identity, with which readings, and that a
 * matching exact whitelist or an interactive human is the only way forward.
 */
function modelDenial(model: ModelAssessment): Assessment {
  const profile = model.profileId ?? "unknown profile";
  const identity =
    model.servedModel ?? model.requestedModel ?? "identity unverified";
  const evidence: string[] = [];
  if (model.readings && Object.keys(model.readings).length > 0)
    evidence.push(
      `readings ${Object.entries(model.readings)
        .map(([key, value]) => `${key}=${value.toFixed(2)}`)
        .join(" ")}`,
    );
  if (model.choices && Object.keys(model.choices).length > 0)
    evidence.push(
      `answers ${Object.entries(model.choices)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")}`,
    );
  const detail =
    evidence.length > 0
      ? `${model.explanation} (${evidence.join("; ")})`
      : model.explanation;
  return {
    kind: "deny",
    source: "decisions-model",
    reasonCode: `model_deny_${model.reasonCode}`,
    explanation:
      `Decisions model profile "${profile}" (${identity}) denied this call: ${detail}. ` +
      `Model authority is provisional; this deny is terminal for this call. To run it, an interactive human must approve a fresh request or the exact command must be added to the global whitelist — a blacklist match can never be overridden.`,
  };
}
