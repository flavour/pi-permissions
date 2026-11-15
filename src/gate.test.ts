import { describe, expect, it } from "bun:test";
import { buildHumanPrompt, HumanReviewer, visible } from "./ask.js";
import { IntentTracker } from "./provenance.js";
import { type Assessment, snapshot } from "./request.js";

const request = (id = "one") =>
  snapshot({
    requestId: id,
    sessionId: "s",
    turnId: "t",
    toolCallId: id,
    command: "echo hello\nsecond line",
    cwd: "/tmp",
    executionContext: { prefix: "", verified: true },
  });
const why: Assessment = {
  kind: "defer",
  source: "policy",
  reasonCode: "unsupported_syntax",
  explanation: "The complete shell syntax is not supported.",
};

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("human review", () => {
  it("displays the whole snapshot, reason, intent unknown and hidden context", () => {
    const prompt = buildHumanPrompt(request(), why);
    for (const part of [
      request().command,
      "/tmp",
      why.explanation,
      "UNKNOWN",
      "Shell prefix",
      "startup files",
    ])
      expect(prompt).toContain(part);
    expect(visible("a\u001b[31m\u0007\u202eb\t")).toBe(
      "a\\u{1b}[31m\\u{7}\\u{202e}b\\u{9}",
    );
  });
  it("freezes request and execution facts", () => {
    expect(Object.isFrozen(request())).toBe(true);
    expect(Object.isFrozen(request().executionContext)).toBe(true);
  });
  it("approves once, rejects dismissal, and blocks UI failure", async () => {
    const reviewer = new HumanReviewer();
    expect((await reviewer.review(request(), why, async () => true)).kind).toBe(
      "allow",
    );
    expect(
      (await reviewer.review(request(), why, async () => false)).reasonCode,
    ).toBe("human_rejected");
    expect(
      (
        await reviewer.review(request(), why, async () => {
          throw new Error("secret");
        })
      ).reasonCode,
    ).toBe("review_failed");
  });
  it("serializes reentrant calls without sharing approval", async () => {
    const reviewer = new HumanReviewer();
    const first = deferred<boolean>();
    const shown: string[] = [];
    const a = reviewer.review(request("a"), why, async (_t, message) => {
      shown.push(message);
      return first.promise;
    });
    const b = reviewer.review(request("b"), why, async (_t, message) => {
      shown.push(message);
      return false;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(shown.length).toBe(1);
    expect(shown[0]).toContain("Request: a");
    first.resolve(true);
    expect((await a).kind).toBe("allow");
    expect((await b).kind).toBe("deny");
    expect(shown[1]).toContain("Request: b");
  });
  it("cancels queued requests without opening another dialog", async () => {
    const reviewer = new HumanReviewer();
    const first = deferred<boolean>();
    const a = reviewer.review(request(), why, () => first.promise);
    const controller = new AbortController();
    let called = false;
    const b = reviewer.review(
      request("b"),
      why,
      async () => {
        called = true;
        return true;
      },
      controller.signal,
    );
    controller.abort();
    expect((await b).kind).toBe("deny");
    expect(called).toBe(false);
    first.resolve(false);
    await a;
  });
  it("rejects late approval after abort, including already aborted signals", async () => {
    const reviewer = new HumanReviewer();
    const controller = new AbortController();
    const result = await reviewer.review(
      request(),
      why,
      async () => {
        controller.abort();
        return true;
      },
      controller.signal,
    );
    expect(result.kind).toBe("deny");
    expect(
      (
        await reviewer.review(
          request(),
          why,
          async () => true,
          controller.signal,
        )
      ).kind,
    ).toBe("deny");
  });
  it("bounds the review queue and expires queued work without showing it", async () => {
    let now = 0;
    const reviewer = new HumanReviewer(5, () => now, 16, 5);
    let shown = 0;
    const confirm = () => {
      shown++;
      now = 5;
      return new Promise<boolean>(() => {});
    };
    const pending = Array.from({ length: 16 }, (_, index) =>
      reviewer.review(request(String(index)), why, confirm),
    );
    expect(
      (await reviewer.review(request("overflow"), why, confirm)).reasonCode,
    ).toBe("review_queue_full");
    const results = await Promise.all(pending);
    expect(results.every((result) => result.kind === "deny")).toBe(true);
    expect(shown).toBe(1);
  });
  it("times out dialogs that ignore the signal", async () => {
    const reviewer = new HumanReviewer(5);
    const result = await reviewer.review(
      request(),
      why,
      () => new Promise(() => {}),
    );
    expect(result.reasonCode).toBe("review_timeout");
  });
});

describe("raw input provenance", () => {
  it("associates only fresh idle interactive input with the run", () => {
    const tracker = new IntentTracker();
    tracker.input("original /template", "interactive");
    expect(tracker.intent).toBeUndefined();
    tracker.start("original /template");
    expect(tracker.intent).toBe("original /template");
    tracker.end();
    tracker.start();
    expect(tracker.intent).toBeUndefined();
  });
  it("does not promote processed template expansion or custom prompts", () => {
    const tracker = new IntentTracker();
    tracker.input("/template", "interactive");
    tracker.start("expanded prompt");
    expect(tracker.intent).toBeUndefined();
    tracker.end();
    tracker.input("same", "interactive");
    tracker.start("same", "custom");
    expect(tracker.intent).toBeUndefined();
  });
  it("never promotes extension/RPC text or streaming steering/queued text", () => {
    for (const source of ["extension", "rpc", "interactive"]) {
      const tracker = new IntentTracker();
      tracker.input("old", "interactive");
      tracker.start("old");
      tracker.input("new", source, true);
      expect(tracker.intent).toBeUndefined();
      tracker.end();
      tracker.start();
      expect(tracker.intent).toBeUndefined();
    }
  });
  it("clears pending and active intent on session switch, fork, compaction and shutdown", () => {
    const tracker = new IntentTracker();
    tracker.input("old", "interactive");
    tracker.reset();
    tracker.start();
    expect(tracker.intent).toBeUndefined();
    tracker.end();
    tracker.input("new", "interactive");
    tracker.start("new");
    tracker.reset();
    expect(tracker.intent).toBeUndefined();
  });
});
