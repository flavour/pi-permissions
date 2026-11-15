/**
 * Decision records in, reviewable label templates out.
 *
 * `PLAN.md` M3 needs *new reviewed examples*, and the only honest source of
 * those is the operator's own recorded decisions. This module does not guess
 * labels and does not contact anything: it turns each recorded decision into a
 * template row carrying everything a human needs to adjudicate — the command, the
 * deterministic verdict, the model's readings and profile identity, and what the
 * gate finally did — with an empty `label` field for the human to fill in.
 *
 * Two rules keep this useful rather than misleading:
 *
 * - A record can only be labelled `safe`/`dangerous`/`unsure` by a human, so the
 *   exported `label` is always `null` and `reviewed` is always `false` here.
 *   `parseLabelled()` accepts a row as reviewed only once a human has filled in a
 *   label *and* named who adjudicated it, which is what makes a held-out rate
 *   quotable at all.
 * - The export never claims to know whether a command ran. Records carry
 *   `execution: not_observed`; the template repeats that, because "approved" is
 *   not evidence the command was safe in hindsight.
 */

import { readFileSync } from "node:fs";
import type { SafetyFamily } from "./decisions/corpus.js";

export interface LabelTemplate {
  readonly id: string;
  readonly timestamp: string;
  readonly command: string;
  readonly cwd: string;
  readonly userIntent: string | null;
  /** What deterministic policy said, before any model. */
  readonly policy: { readonly kind: string; readonly reasonCode: string };
  /** What the model proposed, with the identity it was proposed under. */
  readonly model: {
    readonly kind: string | null;
    readonly reasonCode: string | null;
    readonly authority: string | null;
    readonly profileId: string | null;
    readonly profileIdentity: string | null;
    readonly authorizedReading: number | null;
    /**
     * Every reading the endpoint gave, not just the headline one. A profile's
     * verdict depends on all of them (min-rule, named veto), so dropping the rest
     * would make a later re-scoring impossible.
     */
    readonly readings: Record<string, number> | null;
  };
  /** What the gate did, and who decided it. */
  readonly effective: {
    readonly kind: string;
    readonly source: string;
    readonly reasonCode: string;
  };
  readonly execution: "not_observed";
  /** Filled in by a human. Always null on export. */
  readonly label: SafetyFamily | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly note: string | null;
}

/** A record as written by `records.ts`; unknown shapes are reported, not repaired. */
export interface RawRecord {
  readonly [key: string]: unknown;
}

export interface ParseResult {
  readonly templates: readonly LabelTemplate[];
  readonly rejected: readonly {
    readonly line: number;
    readonly reason: string;
  }[];
}

function text(value: unknown, fallback: string | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nested(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const inner = record[key];
  return inner && typeof inner === "object"
    ? (inner as Record<string, unknown>)
    : {};
}

function readingsMap(value: unknown): Record<string, number> | null {
  const model = nested(value, "model");
  const source = nested(model, "readings");
  const entries = Object.entries(source).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function reading(value: unknown): number | null {
  return readingsMap(value)?.authorized ?? null;
}

/**
 * Turn record lines into label templates.
 *
 * A line is rejected rather than partially accepted: a template missing the
 * model's profile identity would let a human approve a reading whose provenance
 * nobody can check later.
 *
 * Both shapes are accepted — a raw gate record (`request.command`) and a
 * previously exported template (flat `command`) — so re-running the export over
 * its own output is idempotent rather than a way to lose work.
 */
export function labelTemplates(lines: string): ParseResult {
  const templates: LabelTemplate[] = [];
  const rejectedRows: { line: number; reason: string }[] = [];
  const seen = new Set<string>();
  let number = 0;
  for (const line of lines.split("\n")) {
    number++;
    if (line.trim() === "") continue;
    let record: RawRecord;
    try {
      record = JSON.parse(line) as RawRecord;
    } catch {
      rejectedRows.push({ line: number, reason: "not JSON" });
      continue;
    }
    const request = nested(record, "request");
    const command = text(request.command, null) ?? text(record.command, null);
    const cwd = text(request.cwd, null) ?? text(record.cwd, null);
    const timestamp = text(record.timestamp, null);
    if (command === null || cwd === null || timestamp === null) {
      rejectedRows.push({
        line: number,
        reason: "missing command, cwd or timestamp",
      });
      continue;
    }
    const id = text(record.id, null) ?? `${timestamp}|${command}|${cwd}`;
    if (seen.has(id)) {
      rejectedRows.push({ line: number, reason: "duplicate id" });
      continue;
    }
    seen.add(id);
    templates.push({
      id,
      timestamp,
      command,
      cwd,
      userIntent: text(request.userIntent, null),
      policy: {
        kind: text(nested(record, "policy").kind, null) ?? "unknown",
        reasonCode:
          text(nested(record, "policy").reasonCode, null) ?? "unknown",
      },
      model: {
        kind: text(nested(record, "model").kind, null),
        reasonCode: text(nested(record, "model").reasonCode, null),
        authority: text(nested(record, "model").authority, null),
        profileId: text(nested(record, "model").profileId, null),
        profileIdentity: text(nested(record, "model").profileIdentity, null),
        authorizedReading: reading(record),
        readings: readingsMap(record),
      },
      effective: {
        kind: text(nested(record, "effective").kind, null) ?? "unknown",
        source: text(nested(record, "effective").source, null) ?? "unknown",
        reasonCode:
          text(nested(record, "effective").reasonCode, null) ?? "unknown",
      },
      execution: "not_observed",
      label: null,
      reviewedBy: null,
      reviewedAt: null,
      note: null,
    });
  }
  return { templates, rejected: rejectedRows };
}

export function renderTemplates(templates: readonly LabelTemplate[]): string {
  return `${templates.map((template) => JSON.stringify(template)).join("\n")}${
    templates.length > 0 ? "\n" : ""
  }`;
}

export function readRecordsFile(path: string): ParseResult {
  return labelTemplates(readFileSync(path, "utf8"));
}

export interface ReviewedExample {
  readonly id: string;
  readonly family: SafetyFamily;
  readonly command: string;
  readonly cwd: string;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly authorizedReading: number | null;
  readonly readings: Record<string, number> | null;
  readonly profileIdentity: string | null;
}

export interface LabelParseResult {
  readonly reviewed: readonly ReviewedExample[];
  readonly rejected: readonly {
    readonly line: number;
    readonly reason: string;
  }[];
}

/**
 * Accept a filled-in template as a reviewed example.
 *
 * `reviewedBy` is required, not courteous: without knowing who adjudicated a
 * label, a held-out false-allow rate is a number with no source, and the
 * measurement module would be quoting it as evidence.
 *
 * Both shapes are read: an exported template (flat `command`/`cwd`) and an
 * annotated raw record (nested `request`). A row is only usable when the
 * adjudication fields are present, so either way an unfilled row is rejected.
 */
export function parseLabelled(lines: string): LabelParseResult {
  const reviewed: ReviewedExample[] = [];
  const rejectedRows: { line: number; reason: string }[] = [];
  let number = 0;
  for (const line of lines.split("\n")) {
    number++;
    if (line.trim() === "") continue;
    let value: RawRecord;
    try {
      value = JSON.parse(line) as RawRecord;
    } catch {
      rejectedRows.push({ line: number, reason: "not JSON" });
      continue;
    }
    const label = value.label;
    if (label !== "safe" && label !== "dangerous" && label !== "unsure") {
      rejectedRows.push({
        line: number,
        reason: `label must be safe|dangerous|unsure, got ${JSON.stringify(label)}`,
      });
      continue;
    }
    const reviewedBy = text(value.reviewedBy, null);
    if (reviewedBy === null) {
      rejectedRows.push({ line: number, reason: "reviewedBy is required" });
      continue;
    }
    const request = nested(value, "request");
    const command = text(value.command, null) ?? text(request.command, null);
    const cwd = text(value.cwd, null) ?? text(request.cwd, null);
    const id =
      text(value.id, null) ??
      (typeof value.timestamp === "string" && command !== null && cwd !== null
        ? `${value.timestamp}|${command}|${cwd}`
        : null);
    if (id === null || command === null || cwd === null) {
      rejectedRows.push({ line: number, reason: "missing id, command or cwd" });
      continue;
    }
    reviewed.push({
      id,
      family: label,
      command,
      cwd,
      reviewedBy,
      reviewedAt: text(value.reviewedAt, "") ?? "",
      authorizedReading: modelReading(value),
      readings: readingsMap(value),
      profileIdentity: modelIdentity(value),
    });
  }
  return { reviewed, rejected: rejectedRows };
}

/**
 * Where a model's reading lives, across both accepted shapes: an exported
 * template flattens it to `model.authorizedReading`, an annotated raw record
 * keeps it under `model.readings.authorized`. Missing is allowed and stays null
 * — a labelled row without a reading still labels the command.
 */
function modelReading(value: RawRecord): number | null {
  const model = nested(value, "model");
  if (typeof model.authorizedReading === "number")
    return model.authorizedReading;
  return reading(value);
}

function modelIdentity(value: RawRecord): string | null {
  return text(nested(value, "model").profileIdentity, null);
}
