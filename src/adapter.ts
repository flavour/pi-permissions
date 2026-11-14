/**
 * Adapter between the deterministic gate and the Decisions Model.
 *
 * It is the only place that decides whether a model call happens at all, and it
 * has no authority path: every outcome, including a model `allow`, is returned
 * as a `shadow`/`authority: none` proposal for the human reviewer. An
 * unexpected internal failure here is a recorded defer, never a fall-through to
 * execution.
 */

import type { ModelStatus } from "./config.js";
import { getProfile } from "./decisions/profile.js";
import {
  createModelJudge,
  type ModelJudge,
  type ModelProposal,
} from "./decisions/propose.js";
import type { BashRequest, ModelAssessment } from "./request.js";

export type ModelTransport = (
  url: string,
  payload: unknown,
  timeoutMs: number,
) => Promise<unknown>;

export interface ModelAdapterDeps {
  readonly transport?: ModelTransport;
  readonly getBranch?: () => string | undefined;
  readonly now?: () => number;
}

/**
 * Build the shadow consultant for a loaded configuration posture.
 *
 * Returns `undefined` when nothing should be asked (mode `off`, or no profile
 * resolution), and a consultant that reports the reason when the posture is
 * invalid, so the record still explains why the model had no say.
 */
export type ShadowConsultant = (
  request: BashRequest,
  signal?: AbortSignal,
) => Promise<ModelAssessment>;

export function createShadowConsultant(
  status: ModelStatus,
  deps: ModelAdapterDeps = {},
): ShadowConsultant | undefined {
  if (status.mode !== "shadow") return undefined;
  const profile =
    status.profile === undefined ? undefined : getProfile(status.profile);
  if (status.state !== "ready" || !profile || !status.config) {
    const reason =
      status.diagnostic ??
      "Model configuration is not usable; the model is off.";
    return async () => ({
      kind: "defer",
      mode: "shadow",
      authority: "none",
      reasonCode: "model_misconfigured",
      explanation: `${reason} Model authority is shadow-only in this build.`,
    });
  }

  const settings = status.config;
  const judge: ModelJudge = createModelJudge({
    settings: () => ({
      profile,
      baseUrl: settings.endpoint.baseUrl,
      timeoutMs: settings.endpoint.timeoutMs,
      maxPayloadTokens: settings.maxPayloadTokens,
    }),
    ...(deps.transport ? { transport: deps.transport } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });

  return async (request, signal) => {
    try {
      const proposal = await judge.propose(
        {
          toolName: "bash",
          command: request.command,
          cwd: request.cwd,
          branch: deps.getBranch?.(),
          userMessage: request.userIntent,
        },
        signal,
      );
      return toShadowAssessment(proposal);
    } catch {
      // No message text: transport detail can echo request content.
      return {
        kind: "defer",
        mode: "shadow",
        authority: "none",
        reasonCode: "model_adapter_failure",
        explanation:
          "The model step failed unexpectedly, so it proposed nothing. Model authority is shadow-only in this build.",
      };
    }
  };
}

/** A proposal always carries `authority: none`; this function has no other mode. */
export function toShadowAssessment(proposal: ModelProposal): ModelAssessment {
  return {
    kind: proposal.kind,
    mode: "shadow",
    authority: "none",
    reasonCode: proposal.reasonCode,
    explanation: proposal.reason,
    profileId: proposal.profileId,
    profileIdentity: proposal.profileIdentity,
    questionsTextVersion: proposal.questionsTextVersion,
    stateKind: proposal.stateKind,
    aggregation: proposal.aggregation,
    requestedModel: proposal.model,
    ...(proposal.servedModel === undefined
      ? {}
      : { servedModel: proposal.servedModel }),
    latencyMs: proposal.latencyMs,
    dropped: proposal.dropped,
    ...(proposal.readings === undefined ? {} : { readings: proposal.readings }),
    ...(proposal.choices === undefined ? {} : { choices: proposal.choices }),
  };
}
