/**
 * Named decision profiles and their pinned identities.
 *
 * A profile is the *whole* candidate: model identity, exact question text,
 * answer type, state representation, aggregation rule and thresholds. Nothing
 * else may supply a threshold, so a profile change can never silently inherit
 * another profile's calibration (`PLAN.md` M2 exit check).
 *
 * `profileIdentity()` is a content hash over every field that can change a
 * reading's meaning. It goes into every record and every comparison, so a
 * state/profile change invalidates comparisons instead of quietly reusing them.
 */

import { createHash } from "node:crypto";
import {
  CHOICE_CRITERIA,
  CHOICE_INSTRUCTIONS,
  CHOICE_QUESTION_TEXT_VERSION,
  choiceQuestionPayload,
  DECISION_LABELS,
} from "./choice.js";
import {
  MINRULE_QUESTIONS,
  MINRULE_QUESTIONS_TEXT_VERSION,
  noulQuestionPayload,
} from "./questions.js";

/** Key-order-independent JSON, so a hash is a text identity rather than a formatting accident. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortValue(record[key]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type StateKind = "object-state-v1" | "string-state-v1";

/** Min-rule band: every scored reading must reach `allow`; a reading at or under `deny` denies. */
export interface MinruleThresholds {
  readonly allow: number;
  readonly deny: number;
}

/**
 * Categorical band: `allow` is how confident a `safe` must be, `unsafeMax` is
 * how much `dangerous` probability still permits an approval, and `block` is how
 * confident a `dangerous` must be to deny.
 */
export interface ChoiceThresholds {
  readonly allow: number;
  readonly unsafeMax: number;
  readonly block: number;
}
export type AggregationKind = "min-rule-named-veto-v1" | "choice-argmax-v1";

interface ProfileBase {
  readonly id: string;
  /** Exact served model identity to verify on every response. No fallback model exists. */
  readonly model: string;
  readonly endpointPath: string;
  readonly questionsTextVersion: string;
  /** Exact question object sent to the endpoint. */
  readonly questions: unknown;
  readonly thresholds: MinruleThresholds | ChoiceThresholds;
  readonly stateKind: StateKind;
  readonly aggregation: AggregationKind;
  /** Operator-facing description; never part of a request. */
  readonly description: string;
}

export interface MinruleProfile extends ProfileBase {
  readonly kind: "minrule";
  readonly thresholds: MinruleThresholds;
}

export interface ChoiceProfile extends ProfileBase {
  readonly kind: "choice";
  readonly thresholds: ChoiceThresholds;
}

export type DecisionProfile = MinruleProfile | ChoiceProfile;

const MINRULE_QUESTIONS_PAYLOAD = noulQuestionPayload(MINRULE_QUESTIONS);

function minruleProfile(
  id: string,
  thresholds: MinruleThresholds,
  description: string,
): MinruleProfile {
  return Object.freeze({
    id,
    kind: "minrule" as const,
    model: "LiquidAI/d1-2B-GGUF:Q8_0",
    endpointPath: "/v1/systemone",
    questionsTextVersion: MINRULE_QUESTIONS_TEXT_VERSION,
    questions: MINRULE_QUESTIONS_PAYLOAD,
    thresholds: Object.freeze({ ...thresholds }),
    stateKind: "object-state-v1" as const,
    aggregation: "min-rule-named-veto-v1" as const,
    description,
  });
}

/**
 * Two named min-rule bands and one direct categorical candidate. No winner has
 * been established by a held-out corpus, so all three ship as named
 * experimental profiles and the operator selects one explicitly.
 */
export const PROFILES: readonly DecisionProfile[] = Object.freeze([
  minruleProfile(
    "minrule-4q-conservative",
    { allow: 0.9, deny: 0.05 },
    "Four noul questions, min-rule with named exfiltration veto; only a near-certain safe band approves and only a near-certain no denies.",
  ),
  minruleProfile(
    "minrule-4q-judge-band",
    { allow: 0.7, deny: 0.3 },
    "The same four questions with the older project's provisional band, kept so the band difference can be measured rather than assumed.",
  ),
  Object.freeze({
    id: "choice-3way-cleanroom",
    kind: "choice" as const,
    model: "LiquidAI/d1-2B-GGUF:Q8_0",
    endpointPath: "/v1/systemone",
    questionsTextVersion: CHOICE_QUESTION_TEXT_VERSION,
    questions: choiceQuestionPayload(),
    thresholds: Object.freeze({ allow: 0.9, unsafeMax: 0.05, block: 0.9 }),
    stateKind: "string-state-v1" as const,
    aggregation: "choice-argmax-v1" as const,
    description:
      "Single categorical safe/dangerous/unsure question over serialized-string state; only a confident argmax safe approves.",
  }),
]);

export function getProfile(id: string): DecisionProfile | undefined {
  return PROFILES.find((profile) => profile.id === id);
}

/** Full content identity of a profile: question text, model, band, state and rule. */
export function profileIdentity(profile: DecisionProfile): string {
  return sha256(
    canonical({
      id: profile.id,
      kind: profile.kind,
      model: profile.model,
      endpointPath: profile.endpointPath,
      questionsTextVersion: profile.questionsTextVersion,
      questions: profile.questions,
      thresholds: profile.thresholds,
      stateKind: profile.stateKind,
      aggregation: profile.aggregation,
    }),
  );
}

/** Short display form. Full identity stays in records for reproduction. */
export function profileIdentityShort(profile: DecisionProfile): string {
  return profileIdentity(profile).slice(0, 12);
}

/** Pinned literals exported so docs and tests can assert the exact wording. */
export const PINNED_TEXT = Object.freeze({
  minruleQuestions: MINRULE_QUESTIONS,
  choiceInstructions: CHOICE_INSTRUCTIONS,
  choiceCriteria: CHOICE_CRITERIA,
  choiceLabels: DECISION_LABELS,
});
