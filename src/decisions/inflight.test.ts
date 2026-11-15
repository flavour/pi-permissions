/**
 * Deduplication is a *model-computation* optimisation. The property these tests
 * exist to protect: sharing a reading never shares a decision. Nothing in this
 * module can approve anything, and a sibling that arrives after the first
 * computation settled must start its own.
 */

import { describe, expect, it } from "bun:test";
import { InflightShare } from "./inflight.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("in-flight sharing", () => {
  it("shares one computation between concurrent identical requests", async () => {
    const share = new InflightShare();
    let calls = 0;
    const work = () => {
      calls++;
      return Promise.resolve("reading");
    };
    const a = share.run("k", work);
    const b = share.run("k", work);
    expect(await a.promise).toBe("reading");
    expect(await b.promise).toBe("reading");
    expect(calls).toBe(1);
    expect(a.joined).toBe(false);
    expect(b.joined).toBe(true);
    expect(a.joiners()).toBe(2);
  });

  it("starts fresh work for a request that arrives after the first settled", async () => {
    const share = new InflightShare();
    let calls = 0;
    await share.run("k", () => Promise.resolve(++calls)).promise;
    await share.run("k", () => Promise.resolve(++calls)).promise;
    // Repeated side effects across time are never re-verified from a cache: the
    // entry only lives while the first computation is in flight.
    expect(calls).toBe(2);
    expect(share.size).toBe(0);
  });

  it("keeps different snapshots on separate computations", async () => {
    const share = new InflightShare();
    let calls = 0;
    const work = () => Promise.resolve(++calls);
    await Promise.all([
      share.run("pwd", work).promise,
      share.run("ls", work).promise,
      share.run("pwd", work).promise,
    ]);
    expect(calls).toBe(2);
  });

  it("abandons the shared work only once every caller has aborted", async () => {
    const share = new InflightShare();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    let sawAbort = false;
    let secondCreatorRan = 0;
    // The computation belongs to the first caller; a joiner never starts its own.
    const first = share.run(
      "k",
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              resolve("abandoned");
            },
            { once: true },
          );
        }),
      controllerA.signal,
    );
    await tick();
    const second = share.run(
      "k",
      () => {
        secondCreatorRan++;
        return Promise.resolve("never used");
      },
      controllerB.signal,
    );
    expect(second.joined).toBe(true);
    expect(secondCreatorRan).toBe(0);

    controllerA.abort();
    await tick();
    // One caller leaving must not deprive an identical sibling of its reading,
    // so the shared work stays alive and unsettled.
    expect(sawAbort).toBe(false);
    let settled = false;
    void first.promise.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);

    controllerB.abort();
    expect(await first.promise).toBe("abandoned");
    expect(await second.promise).toBe("abandoned");
    expect(sawAbort).toBe(true);
  });

  it("aborts a lone caller's own computation", async () => {
    const share = new InflightShare();
    const controller = new AbortController();
    const result = share.run(
      "k",
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("abandoned"), {
            once: true,
          });
        }),
      controller.signal,
    );
    controller.abort();
    expect(await result.promise).toBe("abandoned");
  });

  it("does not hand a fresh caller work an abandoned entry left behind", async () => {
    const share = new InflightShare();
    const controller = new AbortController();
    let calls = 0;
    const abandoned = share.run(
      "k",
      () => new Promise<string>(() => {}),
      controller.signal,
    );
    await tick();
    controller.abort();
    // The abandoned promise never settles, so the entry must not be reused by a
    // live caller that would otherwise wait forever on dead work.
    const fresh = share.run("k", () => Promise.resolve(++calls));
    expect(fresh.joined).toBe(false);
    expect(await fresh.promise).toBe(1);
    expect(abandoned.joiners()).toBe(1);
  });

  it("drops everything on shutdown so no stale verdict is delivered", async () => {
    const share = new InflightShare();
    const running = share.run(
      "k",
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("abandoned"), {
            once: true,
          });
        }),
    );
    await tick();
    share.clear();
    expect(await running.promise).toBe("abandoned");
    expect(share.size).toBe(0);
  });

  it("does not resurrect a settled key after a late joiner", async () => {
    const share = new InflightShare();
    const gate = deferred<string>();
    const first = share.run("k", () => gate.promise);
    await tick();
    gate.resolve("value");
    expect(await first.promise).toBe("value");
    expect(share.size).toBe(0);
    const second = share.run("k", () => Promise.resolve("fresh"));
    expect(second.joined).toBe(false);
    expect(await second.promise).toBe("fresh");
  });
});
