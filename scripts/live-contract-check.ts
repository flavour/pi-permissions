#!/usr/bin/env bun
/**
 * Opt-in live contract check. Offline `bun run verify` never calls this.
 *
 * It runs the *shipped* judge — state builder, payload budget, request, response
 * validation, aggregation — against synthetic benign command text and reports what
 * the endpoint actually served. Nothing here is executed.
 *
 * The served identity is reported, not asserted as a constant. The endpoint has
 * changed model and build during planning, so a hardcoded expectation would either
 * rot or hide a swap. The profile pins the identity it was written for, and the
 * judge fails closed when the endpoint answers as something else: measuring a
 * different model under this profile's thresholds is how a profile ends up
 * credited with numbers that are not its own.
 *
 *   MODEL_BASE_URL=http://host:port bun run test:live
 *   MODEL_BASE_URL=... MODEL_API_KEY=... bun run test:live   # header, never a URL
 */

import { DEFAULT_MODEL_TIMEOUT_MS } from "../src/config.js";
import {
  getProfile,
  PROFILES,
  profileIdentity,
} from "../src/decisions/profile.js";
import { createModelJudge } from "../src/decisions/propose.js";

const baseUrl = process.env.MODEL_BASE_URL;
if (!baseUrl) {
  console.error(
    "MODEL_BASE_URL is required. This check is opt-in: it contacts a real endpoint.",
  );
  console.error(
    "Example: MODEL_BASE_URL=http://jetson.lan:9931 bun run test:live",
  );
  process.exit(2);
}
if (/\/\/[^/@]*@/.test(baseUrl)) {
  console.error(
    "Put the credential in MODEL_API_KEY; basic-auth URLs are rejected.",
  );
  process.exit(2);
}

const profileId = process.env.MODEL_PROFILE ?? "minrule-4q-conservative";
const profile = getProfile(profileId);
if (!profile) {
  console.error(
    `unknown profile ${JSON.stringify(profileId)}; known: ${PROFILES.map((entry) => entry.id).join(", ")}`,
  );
  process.exit(2);
}

const apiKey = process.env.MODEL_API_KEY;
const timeoutMs = Number(
  process.env.MODEL_TIMEOUT_MS ?? DEFAULT_MODEL_TIMEOUT_MS,
);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("MODEL_TIMEOUT_MS must be a positive number of milliseconds.");
  process.exit(2);
}

/** Synthetic benign text. No case here is executed, anywhere. */
const PROBES: readonly { readonly label: string; readonly command: string }[] =
  [
    { label: "short read-only command", command: "git status --short" },
    {
      label: "long command that still fits the budget",
      command: `ls ${"/some/deep/path ".repeat(30)}`,
    },
    {
      label: "command with no user context",
      command: "ls",
    },
    {
      label: "state over the payload budget (must be refused, not truncated)",
      command: `echo ${"x".repeat(40_000)}`,
    },
  ];

console.log(
  `profile: ${profile.id} · kind ${profile.kind} · state ${profile.stateKind}`,
);
console.log(`profile identity: ${profileIdentity(profile)}`);
console.log(
  `timeout: ${timeoutMs}ms · credential: ${apiKey ? "MODEL_API_KEY header" : "none"}`,
);

const judge = createModelJudge({
  settings: () => ({
    profile,
    baseUrl,
    timeoutMs,
    maxPayloadTokens: Number(process.env.MODEL_MAX_PAYLOAD_TOKENS ?? 1024),
  }),
  ...(apiKey
    ? {
        transport: async (url: string, payload: unknown) => {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok)
            throw new Error(`endpoint returned HTTP ${response.status}`);
          return (await response.json()) as unknown;
        },
      }
    : {}),
});

let failures = 0;
for (const probe of PROBES) {
  const proposal = await judge.propose({
    toolName: "bash",
    command: probe.command,
    cwd: "/tmp",
    userMessage: "synthetic contract probe, not a real request",
  });
  const identity = proposal.servedModel ?? proposal.model;
  const mismatch =
    proposal.servedModel && proposal.servedModel !== profile.model;
  if (mismatch || proposal.reasonCode === "endpoint_identity") failures += 1;
  console.log(
    `${probe.label}:\n  proposal ${proposal.kind} (${proposal.reasonCode}) · served ${JSON.stringify(identity)} · ${proposal.latencyMs}ms` +
      (proposal.readings
        ? `\n  readings ${JSON.stringify(proposal.readings)}`
        : proposal.choices
          ? `\n  choices ${JSON.stringify(proposal.choices)}`
          : "") +
      (proposal.dropped.length > 0
        ? `\n  state omissions: ${proposal.dropped.join(", ")}`
        : ""),
  );
}

if (failures > 0) {
  console.error(
    "\nThe endpoint did not answer as the identity this profile was written for. Fix the endpoint or the profile; do not relax this check.",
  );
  process.exit(1);
}
console.log(
  "\nThe shipped client's contract holds. This says nothing about decision quality: that needs the labelled comparison (`bun run evaluate`).",
);
