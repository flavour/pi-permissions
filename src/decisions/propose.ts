/**
 * Ask the Decisions Model about one already-snapshotted call.
 *
 * Ordering is fixed and every early exit is a `defer` with a distinct reason
 * code, so a record can explain why the model had nothing to say:
 *
 * 1. cancelled → `cancelled`
 * 2. never-allow floor or non-visible call → `floor_never_allow` /
 *    `not_wholly_visible`; the endpoint is not called, and a floor is never an
 *    auto-allow
 * 3. payload over budget → `state_over_budget` (the call is not sent in pieces)
 * 4. endpoint failure → `endpoint_<kind>`
 * 5. aggregation → `allow` / `deny` / `defer`
 *
 * A dropped context field means the model is missing the evidence the
 * `authorized` question needs, so an `allow` is downgraded to `defer`: material
 * information loss is always human review, never a model approval.
 *
 * Returned proposals are frozen. This module has no way to run anything; it
 * produces a proposal object and nothing else.
 */

import { aggregate } from "./aggregate.js";
import {
  aggregateChoice,
  type DecisionLabel,
  decisionLabelPhrase,
} from "./choice.js";
import { floorRefusal, opaqueRefusal } from "./floor.js";
import {
  type ChoiceThresholds,
  type DecisionProfile,
  type MinruleThresholds,
  profileIdentity,
} from "./profile.js";
import { buildRequestPayload } from "./state.js";
import { askSystemOne, EndpointError, type Transport } from "./systemone.js";

export interface ModelCallInput {
  readonly command: string;
  readonly cwd: string;
  readonly toolName: string;
  readonly branch?: string | undefined;
  readonly userMessage?: string | undefined;
  readonly facts?: readonly string[] | undefined;
}

export interface ModelSettings {
  readonly profile: DecisionProfile;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxPayloadTokens: number;
}

export interface ModelDeps {
  readonly transport?: Transport;
  readonly now?: () => number;
  readonly settings: () => ModelSettings;
  /**
   * `enforce` (default) is the shipped gate: a floor hit is never sent to the
   * model. `measurement` skips floors so a comparison measures the model rather
   * than the floors in front of it. Only the live gate uses `enforce`.
   */
  readonly floors?: "enforce" | "measurement";
}

export type ProposalKind = "allow" | "deny" | "defer";

export interface ModelProposal {
  readonly kind: ProposalKind;
  readonly reasonCode: string;
  /** One sentence, display-safe: no endpoint bodies and no credentials. */
  readonly reason: string;
  readonly profileId: string;
  readonly profileIdentity: string;
  readonly questionsTextVersion: string;
  readonly stateKind: string;
  readonly aggregation: string;
  readonly thresholds: MinruleThresholds | ChoiceThresholds;
  readonly model: string;
  /** Only set when the endpoint's reported identity was verified equal. */
  readonly servedModel?: string;
  readonly latencyMs: number;
  readonly dropped: readonly string[];
  readonly tokensEstimate?: number;
  readonly readings?: Readonly<Record<string, number>>;
  readonly choices?: Readonly<Record<string, string>>;
}

export interface ProfileIdentityFields {
  readonly profileId: string;
  readonly profileIdentity: string;
  readonly questionsTextVersion: string;
  readonly stateKind: string;
  readonly aggregation: string;
  readonly model: string;
  readonly thresholds: MinruleThresholds | ChoiceThresholds;
}

export interface ModelJudge {
  propose(input: ModelCallInput, signal?: AbortSignal): Promise<ModelProposal>;
  /** The pinned profile this judge would use, for records and comparisons. */
  identity(): ProfileIdentityFields;
}

type ProposalFields = Pick<ModelProposal, "kind" | "reasonCode" | "reason"> &
  Partial<
    Pick<
      ModelProposal,
      | "latencyMs"
      | "dropped"
      | "tokensEstimate"
      | "readings"
      | "choices"
      | "servedModel"
    >
  >;

function frozen(
  settings: ModelSettings,
  fields: ProposalFields,
): ModelProposal {
  const profile = settings.profile;
  return Object.freeze({
    profileId: profile.id,
    profileIdentity: profileIdentity(profile),
    questionsTextVersion: profile.questionsTextVersion,
    stateKind: profile.stateKind,
    aggregation: profile.aggregation,
    thresholds: profile.thresholds,
    model: profile.model,
    latencyMs: 0,
    dropped: [],
    ...fields,
  });
}

export function createModelJudge(deps: ModelDeps): ModelJudge {
  const skipFloors = deps.floors === "measurement";
  return {
    identity() {
      const profile = deps.settings().profile;
      return {
        profileId: profile.id,
        profileIdentity: profileIdentity(profile),
        questionsTextVersion: profile.questionsTextVersion,
        stateKind: profile.stateKind,
        aggregation: profile.aggregation,
        model: profile.model,
        thresholds: profile.thresholds,
      };
    },

    async propose(input, signal) {
      const settings = deps.settings();
      const profile = settings.profile;

      if (signal?.aborted)
        return frozen(settings, {
          kind: "defer",
          reasonCode: "cancelled",
          reason: "the request was cancelled before the model was asked",
        });

      if (input.command.length === 0)
        return frozen(settings, {
          kind: "defer",
          reasonCode: "no_command",
          reason: "there is no command to judge",
        });

      const floor = skipFloors ? undefined : floorRefusal(input.command);
      if (floor)
        return frozen(settings, {
          kind: "defer",
          reasonCode: "floor_never_allow",
          reason: `a deterministic safety floor matched "${floor.rule}", so the model was not asked`,
        });

      const opaque = skipFloors ? undefined : opaqueRefusal(input.command);
      if (opaque)
        return frozen(settings, {
          kind: "defer",
          reasonCode: "not_wholly_visible",
          reason: `the call is not wholly visible to the model (${opaque.rule}), so it was not asked`,
        });

      const built = buildRequestPayload({
        stateKind: profile.stateKind,
        model: profile.model,
        questions: profile.questions,
        maxPayloadTokens: settings.maxPayloadTokens,
        toolName: input.toolName,
        command: input.command,
        cwd: input.cwd,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.userMessage === undefined
          ? {}
          : { userMessage: input.userMessage }),
        ...(input.facts === undefined ? {} : { facts: input.facts }),
      });

      if (built.overBudget)
        return frozen(settings, {
          kind: "defer",
          reasonCode: "state_over_budget",
          reason: `the whole call does not fit the ${settings.maxPayloadTokens}-token payload budget (it estimates ${built.tokensEstimate} tokens even after context was removed), so it was not sent and never sent in pieces`,
          dropped: built.dropped,
          tokensEstimate: built.tokensEstimate,
        });

      let result: Awaited<ReturnType<typeof askSystemOne>> | undefined;
      try {
        result = await askSystemOne({
          baseUrl: settings.baseUrl,
          path: profile.endpointPath,
          profile,
          state: built.payload.state,
          questions: built.payload.questions,
          timeoutMs: settings.timeoutMs,
          ...(deps.transport ? { transport: deps.transport } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        });
      } catch (error) {
        if (!(error instanceof EndpointError))
          return frozen(settings, {
            kind: "defer",
            reasonCode: "endpoint_unknown",
            reason: "the model request failed unexpectedly",
            dropped: built.dropped,
            tokensEstimate: built.tokensEstimate,
          });
        return frozen(settings, {
          kind: "defer",
          reasonCode: `endpoint_${error.kind}`,
          reason: `the model could not answer (${error.kind}: ${error.detail})`,
          dropped: built.dropped,
          tokensEstimate: built.tokensEstimate,
        });
      }

      const base: Partial<ProposalFields> = {
        servedModel: result.model,
        latencyMs: result.latencyMs,
        dropped: built.dropped,
        tokensEstimate: built.tokensEstimate,
      };

      if (profile.kind === "choice") {
        const label = result.choices.decision as DecisionLabel | undefined;
        if (!label)
          return frozen(settings, {
            ...base,
            kind: "defer",
            reasonCode: "missing_answer",
            reason: "the model returned no categorical answer",
            choices: result.choices,
          });
        const distribution = result.distributions.decision ?? {};
        const verdict = aggregateChoice(label, distribution, {
          allow: profile.thresholds.allow,
          unsafeMax: profile.thresholds.unsafeMax,
          block: profile.thresholds.block,
        });
        const probability = distribution[label] ?? 0;
        return downgradeOnContextLoss(
          frozen(settings, {
            ...base,
            kind: verdict.kind,
            reasonCode: verdict.reasonCode,
            reason: `the model answered \`${label}\` with probability ${probability.toFixed(2)}: ${decisionLabelPhrase(label)}`,
            readings: distribution,
            choices: result.choices,
          }),
          built,
        );
      }

      const thresholds = profile.thresholds;
      const verdict = aggregate(result.readings, thresholds);
      let reasonCode = "unusable_verdict";
      let reason = "the model gave no usable verdict";
      if (verdict.kind === "allow") {
        reasonCode = "allow";
        reason = `every scored reading is at or above ${thresholds.allow} and the exfiltration veto is clean (minimum ${verdict.minReading.toFixed(2)})`;
      } else if (verdict.kind === "deny") {
        reasonCode = `deny_${verdict.key}`;
        reason = `${verdict.label} (reading ${verdict.reading.toFixed(2)}, deny band ${thresholds.deny})`;
      } else {
        reasonCode = verdict.reason;
        reason = `the model deferred (${verdict.reason}${
          verdict.key ? ` on ${verdict.key}` : ""
        })`;
      }
      return downgradeOnContextLoss(
        frozen(settings, {
          ...base,
          kind: verdict.kind,
          reasonCode,
          reason,
          readings: result.readings,
        }),
        built,
      );
    },
  };
}

/** An approval built on omitted context becomes a defer; other kinds pass through. */
function downgradeOnContextLoss(
  decided: ModelProposal,
  built: { informationLoss: boolean; dropped: readonly string[] },
): ModelProposal {
  if (!built.informationLoss || decided.kind !== "allow") return decided;
  return Object.freeze({
    ...decided,
    kind: "defer" as const,
    reasonCode: "context_omitted",
    reason: `the model would have allowed this, but ${built.dropped.join(", ")} had to be dropped from its context, so the reading is not trustworthy enough to act on`,
  });
}
