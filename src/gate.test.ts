import { describe, expect, it } from "bun:test";

import { HumanGate, type Runtime } from "./gate.js";

/**
 * Offline, deterministic tests for the gate's core `review` policy. These never touch a shell,
 * the network, or Pi's runtime — they feed structured inputs into the same decision function the
 * extension calls, and assert the block/allow outcome.
 *
 * `review` is a private method, so we reach it through a typed cast. The cast only widens the
 * visibility of the method for the test; the logic under test is untouched.
 */
function review(
  this: Runtime,
  input: { command: string },
  ctx: unknown,
  gate: unknown,
) {
  return (
    HumanGate.prototype as unknown as {
      review: (
        this: Runtime,
        input: { command: string },
        ctx: unknown,
        gate: unknown,
      ) => Promise<{ block?: boolean } | undefined>;
    }
  ).review.call(this, input, ctx, gate);
}

describe("HumanGate.review", () => {
  const input = { command: "echo hello" };
  const runtime: Runtime = { version: "0.0.0", builtinBash: true };

  it("blocks when there is no interactive shell (non-TUI context)", async () => {
    const result = await review.call(
      runtime,
      input,
      { mode: "tui", hasUI: false, cwd: "/tmp" },
      {},
    );
    expect(result?.block).toBe(true);
  });

  it("blocks when the call is not in the interactive chat UI", async () => {
    const result = await review.call(
      runtime,
      input,
      { mode: "rpc", hasUI: true, cwd: "/tmp" },
      {},
    );
    expect(result?.block).toBe(true);
  });

  it("blocks when the human denies the command", async () => {
    let notified = "";
    const result = await review.call(
      runtime,
      input,
      {
        mode: "tui",
        hasUI: true,
        cwd: "/tmp",
        confirm: async () => false,
        notify: (message: string) => {
          notified = message;
        },
      },
      {},
    );
    expect(result?.block).toBe(true);
    expect(notified).toContain("denied by human");
  });

  it("allows the command (returns undefined) when the human approves", async () => {
    const result = await review.call(
      runtime,
      input,
      {
        mode: "tui",
        hasUI: true,
        cwd: "/tmp",
        confirm: async () => true,
        notify: () => {},
      },
      {},
    );
    expect(result).toBeUndefined();
  });
});
