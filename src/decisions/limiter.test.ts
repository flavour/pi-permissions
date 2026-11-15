import { describe, expect, it } from "bun:test";
import { EndpointLimiter, QueueError } from "./limiter.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("endpoint concurrency", () => {
  it("runs one task at a time by default", async () => {
    const limiter = new EndpointLimiter({
      concurrency: 1,
      maxQueue: 4,
      maxWaitMs: 1_000,
    });
    let inFlight = 0;
    let peak = 0;
    const run = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    };
    await Promise.all([limiter.run(run), limiter.run(run), limiter.run(run)]);
    expect(peak).toBe(1);
    expect(limiter.snapshot().active).toBe(0);
  });

  it("honours a configured concurrency above one", async () => {
    const limiter = new EndpointLimiter({
      concurrency: 3,
      maxQueue: 0,
      maxWaitMs: 1_000,
    });
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const running = gates.map((gate, index) =>
      limiter.run(async () => {
        await gate.promise;
        return index;
      }),
    );
    await tick();
    expect(limiter.snapshot().active).toBe(3);
    gates.forEach((gate) => {
      gate.resolve();
    });
    expect(await Promise.all(running)).toEqual([0, 1, 2]);
  });

  it("refuses an eighth caller instead of queueing without bound", async () => {
    const limiter = new EndpointLimiter({
      concurrency: 1,
      maxQueue: 2,
      maxWaitMs: 1_000,
    });
    const block = deferred<void>();
    const started = Array.from({ length: 3 }, () =>
      limiter.run(() => block.promise),
    );
    await tick();
    const overflow = limiter
      .run(() => block.promise)
      .catch((cause: unknown) => cause);
    const error = (await overflow) as QueueError;
    expect(error).toBeInstanceOf(QueueError);
    expect(error.kind).toBe("queue_full");
    block.resolve();
    await Promise.all(started);
  });

  it("refuses immediately when queueing is disabled", async () => {
    const limiter = new EndpointLimiter({
      concurrency: 1,
      maxQueue: 0,
      maxWaitMs: 1_000,
    });
    const block = deferred<void>();
    const running = limiter.run(() => block.promise);
    await tick();
    const error = (await limiter
      .run(() => block.promise)
      .catch((cause: unknown) => cause)) as QueueError;
    expect(error.kind).toBe("queue_full");
    block.resolve();
    await running;
  });

  it("gives up waiting callers on a deadline rather than hanging the hook", async () => {
    const limiter = new EndpointLimiter({
      concurrency: 1,
      maxQueue: 1,
      maxWaitMs: 20,
    });
    const block = deferred<void>();
    const running = limiter.run(() => block.promise);
    await tick();
    const started = Date.now();
    const error = (await limiter
      .run(() => block.promise)
      .catch((cause: unknown) => cause)) as QueueError;
    expect(error.kind).toBe("queue_wait");
    expect(Date.now() - started).toBeLessThan(500);
    block.resolve();
    await running;
  });

  it("never grants a slot to a caller that is already gone", async () => {
    const limiter = new EndpointLimiter({
      concurrency: 1,
      maxQueue: 1,
      maxWaitMs: 1_000,
    });
    const block = deferred<void>();
    const running = limiter.run(() => block.promise);
    await tick();
    const cancelled = new AbortController();
    const queued = limiter
      .run(() => block.promise, cancelled.signal)
      .catch((cause: unknown) => cause);
    await tick();
    expect(limiter.snapshot().queued).toBe(1);
    cancelled.abort();
    expect(((await queued) as QueueError).kind).toBe("cancelled");
    // The queue drained: a cancelled waiter cannot later wake up and send.
    expect(limiter.snapshot().queued).toBe(0);
    block.resolve();
    await running;
  });

  it("cancels a running request by propagating its signal to the task", async () => {
    const limiter = new EndpointLimiter({
      concurrency: 1,
      maxQueue: 1,
      maxWaitMs: 1_000,
    });
    const controller = new AbortController();
    let sawSignal = false;
    const running = limiter.run(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          sawSignal = signal?.aborted === false;
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          );
        }),
      controller.signal,
    );
    await tick();
    controller.abort();
    expect(sawSignal).toBe(true);
    await expect(running).rejects.toThrow("aborted");
    // The slot is back, so the next request is not locked out by a dead caller.
    expect(limiter.snapshot().active).toBe(0);
  });

  it("refuses a caller that was cancelled before it asked", async () => {
    const limiter = new EndpointLimiter({
      concurrency: 1,
      maxQueue: 1,
      maxWaitMs: 1_000,
    });
    const controller = new AbortController();
    controller.abort();
    const error = (await limiter
      .run(async () => "never", controller.signal)
      .catch((cause: unknown) => cause)) as QueueError;
    expect(error.kind).toBe("cancelled");
    expect(limiter.snapshot().active).toBe(0);
  });

  it("serves waiters in arrival order, so one slow call cannot starve the rest", async () => {
    const limiter = new EndpointLimiter({
      concurrency: 1,
      maxQueue: 4,
      maxWaitMs: 5_000,
    });
    const order: string[] = [];
    const block = deferred<void>();
    const first = limiter.run(async () => {
      await block.promise;
      order.push("first");
    });
    await tick();
    const rest = ["a", "b", "c"].map((name) =>
      limiter.run(async () => {
        order.push(name);
      }),
    );
    await tick();
    block.resolve();
    await Promise.all([first, ...rest]);
    expect(order).toEqual(["first", "a", "b", "c"]);
  });

  it("releases a slot even when the task throws", async () => {
    const limiter = new EndpointLimiter({
      concurrency: 1,
      maxQueue: 1,
      maxWaitMs: 1_000,
    });
    await expect(
      limiter.run(async () => {
        throw new Error("endpoint exploded");
      }),
    ).rejects.toThrow("endpoint exploded");
    expect(limiter.snapshot().active).toBe(0);
    expect(await limiter.run(async () => "next")).toBe("next");
  });
});
