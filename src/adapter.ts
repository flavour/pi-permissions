/**
 * Adapter between the deterministic gate and the Decisions Model.
 *
 * It is the only place that decides whether a model call happens at all, and it
 * owns the two properties the rest of the gate depends on:
 *
 * 1. Every outcome is a `ModelAssessment` whose `authority` matches the mode the
 *    consultant was built for — `none` for shadow, `selected_profile` for
 *    enforce — and nothing here returns an *allow* with authority. Only the
 *    enforce path can produce an effective model **deny**.
 * 2. No failure inside the model step escapes as an exception, a fall-through,
 *    or an implicit allow. Operational refusals (breaker, queue) are recorded
 *    defers, so the review path never depends on the model layer succeeding.
 */

import type { ModelStatus } from "./config.js";
import type { InflightShare } from "./decisions/inflight.js";
import { canonical, getProfile } from "./decisions/profile.js";
import type { EndpointControls } from "./decisions/propose.js";
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
  signal?: AbortSignal,
) => Promise<unknown>;

export interface ModelAdapterDeps {
  readonly transport?: ModelTransport;
  readonly getBranch?: () => string | undefined;
  readonly now?: () => number;
  /** Bounded concurrency and breaker state; absent means unbounded (offline only). */
  readonly controls?: EndpointControls;
  /** Shared in-flight registry for model-only deduplication. */
  readonly share?: InflightShare;
  /** Configuration snapshot identity, part of a deduplication key. */
  readonly configRevision?: string;
}

export type ModelAdapter = (
  request: BashRequest,
  signal?: AbortSignal,
) => Promise<ModelAssessment>;

/** The mode a consultant is built to serve. `off` builds nothing at all. */
export type ConsultantMode = "shadow" | "enforce";

/**
 * Build the consultant for a loaded configuration posture.
 *
 * Returns `undefined` when nothing should be asked (mode `off`, or a posture
 * with no usable profile that this mode could report on), and a consultant that
 * reports the reason when the posture is invalid, so the record still explains
 * why the model had no say.
 */
export function createModelConsultant(
  status: ModelStatus,
  mode: ConsultantMode,
  deps: ModelAdapterDeps = {},
): ModelAdapter | undefined {
  if (status.mode !== mode) return undefined;
  const profile =
    status.profile === undefined ? undefined : getProfile(status.profile);
  if (status.state !== "ready" || !profile || !status.config) {
    const reason =
      status.diagnostic ??
      "Model configuration is not usable; the model is off.";
    return async () => ({
      kind: "defer",
      mode,
      // A model that is off has no authority even when enforce was requested.
      authority: "none",
      reasonCode: "model_misconfigured",
      explanation:
        mode === "shadow"
          ? `${reason} Model authority is shadow-only in this build.`
          : `${reason} Enforcement was requested but the model is off, so no model outcome applies and the call still needs a human or an exact whitelist.`,
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
    ...(deps.controls ? { controls: deps.controls } : {}),
  });

  const ask = (request: BashRequest, signal?: AbortSignal) =>
    judge.propose(
      {
        toolName: "bash",
        command: request.command,
        cwd: request.cwd,
        branch: deps.getBranch?.(),
        userMessage: request.userIntent,
      },
      signal,
    );

  return async (request, signal) => {
    try {
      let proposal: ModelProposal;
      let shared = false;
      const share = deps.share;
      if (share) {
        const key = deduplicationKey(
          request,
          profile.id,
          settings.endpoint.baseUrl,
          mode,
          deps.configRevision,
        );
        const sharedWork = share.run(
          key,
          (joinedSignal) => ask(request, joinedSignal),
          signal,
        );
        proposal = await sharedWork.promise;
        shared = sharedWork.joined || sharedWork.joiners() > 1;
      } else {
        proposal = await ask(request, signal);
      }
      return toAssessment(proposal, mode, shared);
    } catch {
      // No message text: transport detail can echo request content.
      return {
        kind: "defer",
        mode,
        // An internal failure grants nothing, in either mode.
        authority: "none",
        reasonCode: "model_adapter_failure",
        explanation:
          mode === "shadow"
            ? "The model step failed unexpectedly, so it proposed nothing. Model authority is shadow-only in this build."
            : "The model step failed unexpectedly, so it produced no outcome. Enforcement is provisional: the call still needs a human or an exact whitelist.",
      };
    }
  };
}

/**
 * Key for sharing model computation only: the whole snapshot, the profile
 * content identity, the endpoint origin, the configuration snapshot and the
 * session/turn. `requestId`/`toolCallId` are excluded because the whole point is
 * that two distinct calls in one turn may share a *reading*. Approval is never
 * in scope here — this returns model computation, and review happens per request.
 */
export function deduplicationKey(
  request: BashRequest,
  profileId: string,
  baseUrl: string,
  mode: ConsultantMode,
  configRevision?: string,
): string {
  return canonical({
    sessionId: request.sessionId,
    turnId: request.turnId,
    command: request.command,
    cwd: request.cwd,
    timeout: request.timeout ?? null,
    userIntent: request.userIntent ?? null,
    executionContext: request.executionContext,
    profileId,
    baseUrl,
    mode,
    configRevision: configRevision ?? null,
  });
}

/** A shadow proposal never has authority; an enforce proposal only ever denies. */
export function toAssessment(
  proposal: ModelProposal,
  mode: ConsultantMode,
  shared = false,
): ModelAssessment {
  // Only a reading the endpoint actually produced can carry authority. An
  // operational bound or a failed send is not a model opinion, so it grants
  // nothing even in enforce mode.
  const authority =
    mode === "enforce" && proposal.answered ? "selected_profile" : "none";
  return {
    kind: proposal.kind,
    mode,
    authority,
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
    ...(proposal.usage === undefined ? {} : { usage: proposal.usage }),
    ...(proposal.breaker === undefined ? {} : { breaker: proposal.breaker }),
    ...(proposal.queue === undefined ? {} : { queue: proposal.queue }),
    ...(shared || proposal.shared ? { shared: true } : {}),
  };
}

/** Compatibility name for the shadow-only call sites and tests. */
export const createShadowConsultant = (
  status: ModelStatus,
  deps: ModelAdapterDeps = {},
): ModelAdapter | undefined => createModelConsultant(status, "shadow", deps);

/** A proposal always carries `authority: none`; kept for existing shadow tests. */
export function toShadowAssessment(proposal: ModelProposal): ModelAssessment {
  return {
    ...toAssessment(proposal, "shadow"),
    authority: "none",
  };
}
