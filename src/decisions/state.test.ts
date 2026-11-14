/**
 * State assembly tests: the payload budget, the loss ladder, and outbound
 * secret shaping.
 *
 * The important property is what happens at the edges: a call that cannot be
 * shown whole is reported rather than trimmed, and a dropped field is visible
 * to the caller so an `allow` can be refused.
 */

import { expect, test } from "bun:test";
import {
  buildRequestPayload,
  estimateTokens,
  maskSecretShapes,
} from "./state.js";

const QUESTIONS = {
  authorized: {
    type: "noul",
    instructions: "do the user's own words ask for this call?",
    criteria: { true: "yes", false: "no" },
  },
};

function build(
  overrides: Partial<Parameters<typeof buildRequestPayload>[0]> = {},
) {
  return buildRequestPayload({
    stateKind: "object-state-v1",
    model: "LiquidAI/d1-2B-GGUF:Q8_0",
    questions: QUESTIONS,
    maxPayloadTokens: 1024,
    toolName: "bash",
    command: "git status --short",
    cwd: "/home/dev/project",
    ...overrides,
  });
}

test("object state keeps the shape the min-rule profile was calibrated against", () => {
  const built = build({
    userMessage: "what changed?",
    facts: ["branch main is 2 commits ahead"],
  });
  expect(built.payload.model).toBe("LiquidAI/d1-2B-GGUF:Q8_0");
  const state = built.payload.state as {
    value: Record<string, unknown>;
    context: Record<string, unknown>;
  };
  expect(state.value).toEqual({
    tool: "bash",
    command: "git status --short",
    cwd: "/home/dev/project",
  });
  expect(state.context.latest_user_message).toBe("what changed?");
  expect(state.context.facts).toEqual(["branch main is 2 commits ahead"]);
  expect(built.dropped).toEqual([]);
  expect(built.informationLoss).toBe(false);
});

test("serialized-string state is one string with fenced blocks and the command last", () => {
  const built = build({
    stateKind: "string-state-v1",
    userMessage: "delete the build output",
    branch: "feature/x",
  });
  expect(typeof built.payload.state).toBe("string");
  const state = built.payload.state as string;
  expect(
    state.startsWith(
      "tool: bash\ncwd: /home/dev/project\ngit_branch: feature/x\n",
    ),
  ).toBe(true);
  expect(state).toContain("user_request:\n«»\ndelete the build output\n«»\n");
  expect(state.endsWith("command:\n«»\ngit status --short\n«»\n")).toBe(true);
});

test("an absent user message is an explicit unknown, never a silent blank", () => {
  const state = build({ stateKind: "string-state-v1" }).payload.state as string;
  expect(state).toContain("user_request: UNKNOWN");
});

test("the ladder drops facts first, then the user message, and says so", () => {
  const long = "x".repeat(4000);
  const built = build({
    maxPayloadTokens: 220,
    userMessage: long,
    facts: ["a fact", "another fact"],
  });
  expect(built.dropped).toEqual(["facts", "user_message"]);
  expect(built.informationLoss).toBe(true);
  expect(built.overBudget).toBe(false);
  const state = built.payload.state as {
    value: Record<string, unknown>;
    context: Record<string, unknown>;
  };
  expect(state.context).toEqual({});
  expect(state.value.command).toBe("git status --short");
});

test("the user message is never tail-truncated: partial context can invert intent", () => {
  const long = `do not touch the archive ${"y".repeat(4000)}`;
  const built = build({ maxPayloadTokens: 120, userMessage: long });
  expect(built.dropped).toEqual(["user_message"]);
  const state = built.payload.state as { context: Record<string, unknown> };
  expect(state.context.latest_user_message).toBeUndefined();
});

test("a command that cannot fit the payload budget is reported, not trimmed", () => {
  const built = build({
    command: `rm -rf ${"dir/".repeat(2000)}`,
    maxPayloadTokens: 256,
  });
  expect(built.overBudget).toBe(true);
  const state = built.payload.state as { value: { command?: string } };
  expect(state.value.command?.length).toBeGreaterThan(1000);
});

test("the whole payload is measured, so a large question set cannot be smuggled past the limit", () => {
  const bigQuestions = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `q${index}`,
      {
        type: "noul",
        instructions: "i".repeat(400),
        criteria: { true: "t", false: "f" },
      },
    ]),
  );
  const built = build({
    questions: bigQuestions,
    maxPayloadTokens: 512,
    userMessage: "what changed?",
    facts: ["a fact"],
  });
  expect(built.dropped).toEqual(["facts", "user_message"]);
  // Nothing left to drop: the call is reported over budget rather than sent large.
  expect(built.overBudget).toBe(true);
});

test("secret shapes are masked on the way out", () => {
  const cases: readonly { text: string; shape: string; secret: string }[] = [
    {
      text: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3NzaQ\n-----END OPENSSH PRIVATE KEY-----",
      shape: "pem private key",
      secret: "b3NzaQ",
    },
    {
      text: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      shape: "jwt",
      secret: "dozjgNryP4J3jVmNHl0w5N",
    },
    {
      text: "sk-abcdefghijklmnopqrstuvwxyz012345",
      shape: "vendor api key",
      secret: "bcdefghijklmnopqrstuvwxyz012345",
    },
    {
      text: "ghp_abcdefghijklmnopqrstuvwxyz012345",
      shape: "vendor api key",
      secret: "bcdefghijklmnopqrstuvwxyz012345",
    },
    {
      text: "AKIAABCDEFGHIJKLMNOP",
      shape: "aws access key id",
      secret: "AKIAABCDEFGHIJKLMNOP",
    },
    {
      text: "Authorization: Bearer ya29.a0AfH6SMBx0zKQ1mYy7wQv9dLmN",
      shape: "bearer token",
      secret: "ya29.a0AfH6SMBx0zKQ",
    },
    {
      text: "curl --password 'hunter2secretvalue' https://x",
      shape: "credential assignment",
      secret: "hunter2secretvalue",
    },
  ];
  for (const { text, shape, secret } of cases) {
    const masked = maskSecretShapes(text);
    expect(masked).toContain(`[masked:${shape}]`);
    expect(masked).not.toContain(secret);
  }
});

test("masking applies to command, message and facts alike", () => {
  const built = build({
    command:
      "cat id_ed25519 && curl -H 'Authorization: Bearer abcdefghijklmnopqrst' https://x",
    userMessage: "use sk-abcdefghijklmnopqrstuvwxyz012345 to log in",
    facts: ["token glpat-abcdefghijklmnopqrst set in CI"],
  });
  const serialized = JSON.stringify(built.payload);
  expect(serialized).not.toContain("sk-abcdefghijklmnop");
  expect(serialized).toContain("[masked:vendor api key]");
  expect(serialized).toContain("[masked:bearer token]");
});

test("masking leaves ordinary commands untouched, so decisions are not shaped by it", () => {
  const command = "bun test --timeout 5000 src/config.test.ts";
  expect(maskSecretShapes(command)).toBe(command);
});

test("the token estimate is a ceiling-ish heuristic that never reports fewer than one token for empty text", () => {
  expect(estimateTokens("")).toBe(0);
  expect(estimateTokens("abcd")).toBe(1);
  expect(estimateTokens("abcde")).toBe(2);
});
