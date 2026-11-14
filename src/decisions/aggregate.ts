/**
 * Aggregation: readings → one verdict (SPEC §7.3, D-24).
 *
 * A min-rule with named vetoes, not a weighted sum: weights cannot be estimated
 * before a calibration corpus exists, and a min-rule is explainable in the
 * one-sentence teaching reason a denial carries. Polarity is declared per
 * question, so aggregation always reasons in terms of `unsafe` — the
 * probability the bad thing is true.
 */

import { MINRULE_QUESTIONS, questionLabel } from "./questions.js";

/** Always supplied by a pinned profile. There is no default threshold set. */
export interface Thresholds {
  readonly allow: number;
  readonly deny: number;
}

export type Aggregate =
  | { kind: "allow"; minReading: number }
  | { kind: "deny"; key: string; reading: number; label: string }
  | { kind: "defer"; reason: string; key?: string; reading?: number };

/** Probability that the unsafe condition holds, after polarity conversion. */
export function unsafeReading(key: string, raw: number): number {
  const question = MINRULE_QUESTIONS.find((q) => q.key === key);
  return question?.unsafeWhenHigh ? raw : 1 - raw;
}

export function aggregate(
  readings: Readonly<Record<string, number>>,
  thresholds: Thresholds,
): Aggregate {
  const allow = thresholds.allow;
  const deny = thresholds.deny;

  // Veto first: a confident bad reading denies; an uncertain one defers.
  for (const question of MINRULE_QUESTIONS) {
    if (!question.veto) {
      continue;
    }
    const raw = readings[question.key];
    if (typeof raw !== "number") {
      return { kind: "defer", reason: "missing_answer", key: question.key };
    }
    const unsafe = unsafeReading(question.key, raw);
    if (unsafe >= allow) {
      return {
        kind: "deny",
        key: question.key,
        reading: raw,
        label: questionLabel(question.key),
      };
    }
    if (unsafe > 1 - allow) {
      return {
        kind: "defer",
        reason: "veto_uncertain",
        key: question.key,
        reading: raw,
      };
    }
  }

  const scored: { key: string; reading: number }[] = [];
  for (const question of MINRULE_QUESTIONS) {
    if (question.veto) {
      continue;
    }
    const raw = readings[question.key];
    if (typeof raw !== "number") {
      return { kind: "defer", reason: "missing_answer", key: question.key };
    }
    scored.push({ key: question.key, reading: raw });
  }

  // A confident "no" on any scored question is a teaching denial.
  const failing = scored.find((entry) => entry.reading <= deny);
  if (failing) {
    return {
      kind: "deny",
      key: failing.key,
      reading: failing.reading,
      label: questionLabel(failing.key),
    };
  }

  const minReading = Math.min(...scored.map((entry) => entry.reading));
  if (minReading >= allow) {
    return { kind: "allow", minReading };
  }
  return { kind: "defer", reason: "below_allow", reading: minReading };
}
