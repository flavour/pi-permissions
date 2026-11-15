// Runs in normal Node, not Bun. All UI decisions below are AUTOMATED adapters.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [host, cwd, agentDir] = process.argv.slice(2);
const pi = await import(pathToFileURL(join(host, "dist/index.js")).href);
assert.equal(pi.VERSION, "1.5.2", "smoke is pinned to Pi 1.5.2");
// No prompt/model invocation is made. Nested executeTool uses AgentSession's real pipeline.
// The only permitted socket is the loopback decision fixture below, and only for
// the shadow-model scenarios that explicitly ask for it.
const blockedFetch = () => {
  throw new Error("network forbidden by smoke fixture");
};
// Captured before the block is installed: the loopback fixture needs a real fetch.
const nativeFetch = globalThis.fetch.bind(globalThis);
// Every fixture registers its origin here. A per-fixture override would let a
// later fixture reject an earlier fixture's own loopback calls.
const permittedOrigins = new Set();
function permitLoopback(origin) {
  permittedOrigins.add(origin);
  globalThis.fetch = async (url, init) => {
    // A URL object has `href`, not `url`; resolving it wrongly would block the
    // fixture's own loopback call.
    const text = typeof url === "string" ? url : String(url?.href ?? url ?? "");
    if ([...permittedOrigins].some((origin) => text.startsWith(origin)))
      return nativeFetch(url, init);
    throw new Error("network forbidden by smoke fixture");
  };
}
function revokeLoopback(origin) {
  permittedOrigins.delete(origin);
  if (permittedOrigins.size === 0) globalThis.fetch = blockedFetch;
}
globalThis.fetch = blockedFetch;
/**
 * Loopback decision endpoint for the shadow-model scenarios only.
 *
 * It answers the profile's whole question set with readings the judge aggregates
 * to an approval, so the scenario tests the dangerous direction: a model that
 * wants to allow must still not run anything when the human rejects.
 */
async function startDecisionFixture(readings, delayMs = 0) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      // A held response lets concurrent gated calls overlap in flight, so a
      // deduplication scenario tests sharing rather than two fast sequential calls.
      const body = JSON.stringify({
        model: "LiquidAI/d1-2B-GGUF:Q8_0",
        answers: Object.fromEntries(
          Object.entries(readings).map(([key, noul]) => [
            key,
            { type: "noul", noul },
          ]),
        ),
        usage: { input_tokens: 140, output_tokens: 0 },
      });
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  permitLoopback(origin);
  return {
    origin,
    requests,
    async close() {
      revokeLoopback(origin);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A fixture that always fails, so the human path must be reached anyway. */
async function startFailingFixture() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("fixture unavailable");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  permitLoopback(origin);
  return {
    origin,
    requests,
    async close() {
      revokeLoopback(origin);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Host events for `calls` allowed calls, checked as counts rather than a fixed
 * sequence: concurrent calls legitimately interleave, and interleaving is what
 * a deduplicated pair looks like. What must hold is one start, one call, one
 * result and one end per executed call — no phantom execution, no silent skip.
 */
function assertEventCounts(events, calls, label) {
  for (const kind of [
    "tool_execution_start",
    "tool_call",
    "tool_result",
    "tool_execution_end",
  ])
    assert.equal(
      events.filter((event) => event === kind).length,
      calls,
      `${label}: ${kind} count`,
    );
}

/** The operator's global policy file, written only for scenarios that need it. */
function writePolicy(value) {
  const target = join(agentDir, "extensions/pi-permissions");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "config.json"), JSON.stringify(value));
}

function removePolicy() {
  try {
    rmSync(join(agentDir, "extensions/pi-permissions/config.json"), {
      force: true,
    });
  } catch {
    /* nothing written for this scenario */
  }
}

function readRecords() {
  const path = join(agentDir, "pi-permissions-records", "decisions.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function run(
  name,
  {
    mode = "tui",
    answer = false,
    prefix,
    custom = false,
    hookError = false,
    loadFailure = false,
    cancel = false,
    model = null,
    calls = 1,
    parallel = false,
    policy = {},
  } = {},
) {
  let confirms = 0;
  let customExecuted = false;
  const prompts = [];
  const events = [];
  const errors = [];
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);
  if (prefix) settingsManager.applyOverrides({ shellCommandPrefix: prefix });
  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: loadFailure
      ? [fileURLToPath(new URL("./pi-load-failure.ts", import.meta.url))]
      : [],
    extensionFactories: [
      (api) => {
        for (const event of [
          "tool_execution_start",
          "tool_call",
          "tool_result",
          "tool_execution_end",
        ]) {
          api.on(event, (e) => {
            if (e.toolName === "bash") events.push(event);
            if (event === "tool_call" && hookError)
              throw new Error("automated hook failure");
          });
        }
        if (custom)
          api.registerTool({
            name: "bash",
            label: "Automated custom bash fixture",
            description: "Must never execute",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
            execute: async () => {
              customExecuted = true;
              throw new Error("custom bash reached execution");
            },
          });
      },
    ],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loadFailure)
    assert(loaded.errors.length > 0, "load failure must be observable");
  else
    assert.deepEqual(
      loaded.errors,
      [],
      "installed extension must load without local dependencies",
    );
  assert(
    loaded.extensions.some((e) => e.path.includes("src/extension.ts")),
    "Git-installed gate must be discovered",
  );
  if (model) {
    // The operator's real global policy path, inside the isolated agent dir only.
    writePolicy({
      version: 1,
      whitelist: [],
      blacklist: [],
      records: true,
      ...policy,
      model: {
        mode: model.mode,
        profile: "minrule-4q-conservative",
        maxPayloadTokens: 1024,
        endpoint: {
          baseUrl: model.origin,
          model: "LiquidAI/d1-2B-GGUF:Q8_0",
          timeoutMs: 2000,
        },
        // M3: `enforce` grants authority only against this exact sentence.
        ...(model.mode === "enforce"
          ? {
              enforceAcknowledgement:
                "I understand this profile is provisional and its allows may be wrong",
            }
          : {}),
        ...(policy.model ?? {}),
      },
    });
  }
  // Seed an explicitly synthetic assistant turn via the supported history boundary.
  // Pi requires an issuing assistant message even for a nested tool call.
  const sessionManager = pi.SessionManager.inMemory(cwd);
  sessionManager.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Automated smoke fixture, not model output" },
    ],
    api: "smoke",
    provider: "smoke",
    model: "offline",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    sessionManager,
    tools: ["bash"],
  });
  try {
    const controller = new AbortController();
    const uiContext =
      mode === "tui" || mode === "rpc"
        ? new Proxy(
            {
              // SDK copies enumerable UI members; a Proxy fallback alone is insufficient.
              setStatus: () => {},
              notify: (message) => {
                console.log(`NOTIFY ${name}: ${String(message).slice(0, 200)}`);
              },
              confirm: async (title, message, options) => {
                confirms++;
                assert.equal(options?.timeout, 60000);
                assert.equal(typeof title, "string");
                assert.equal(typeof message, "string");
                prompts.push(message);
                if (cancel) {
                  assert(options.signal instanceof AbortSignal);
                  controller.abort();
                  return true; // A late automated approval must not beat cancellation.
                }
                if (answer === "throw") throw new Error("automated UI failure");
                return answer;
              },
            },
            {
              get: (target, key) =>
                key in target ? target[key] : () => undefined,
            },
          )
        : undefined;
    await session.bindExtensions({
      mode,
      uiContext,
      hasUI: !!uiContext,
      onError: (e) => errors.push(e),
    });
    const sentinel = join(cwd, `${name}.sentinel`);
    assert(!existsSync(sentinel));
    const ctx = session.extensionRunner.createToolContext(
      `automated-${name}`,
      controller.signal,
    );
    // A reused fixture accumulates requests across scenarios, so each scenario
    // asserts its own delta and the totals are asserted at the end.
    const requestsAtStart = model ? model.requests.length : 0;
    const invoke = () =>
      ctx.executeTool("bash", {
        command: `printf smoke > '${sentinel}'`,
        timeout: 2,
      });
    // Sequential by default. `parallel` fires the calls together, which is the
    // only way two requests can be in flight at once — what model-only
    // deduplication requires, and what must still not share an approval.
    const executions = parallel
      ? await Promise.all(Array.from({ length: calls }, invoke))
      : [];
    for (let index = 0; index < calls && !parallel; index++)
      executions.push(await invoke());
    const result = executions[executions.length - 1];
    assert.equal(customExecuted, false, "custom bash must not reach execution");
    // Shadow scenarios decide execution only by the human's answer, so the
    // sentinel expectation is stated per scenario rather than by name.
    const approved = model ? model.approved : name === "approved";
    assert.equal(
      existsSync(sentinel),
      approved,
      `${name}: sentinel execution mismatch: ${JSON.stringify(result)}`,
    );
    if (approved) {
      assert.equal(readFileSync(sentinel, "utf8"), "smoke");
      assert.equal(result.isError ?? false, false);
      // One review per gated call: sharing model computation never shares a
      // review, so N approved calls mean N confirmations even when deduped.
      assert.equal(confirms, calls, `${name}: one review per gated call`);
      assertEventCounts(events, calls, name);
    } else {
      assert.equal(result.isError, true, `${name} must be blocked`);
      assert(!events.includes("tool_result"), "blocked calls skip tool_result");
      if (mode !== "tui" || custom) assert.equal(confirms, 0);
      if (
        name === "rejected" ||
        name === "ui-error" ||
        cancel ||
        hookError ||
        (model && !model.terminalDeny)
      )
        assert.equal(confirms, 1);
      if (hookError)
        assert(
          JSON.stringify(result).includes("automated hook failure"),
          "throwing hook must be reported in the tool error",
        );
    }
    assert.equal(errors.length, 0, "no unexpected extension lifecycle errors");
    if (prefix)
      assert(
        JSON.stringify(result).includes("prefix"),
        "prefixed bash requires review and the prefix must be displayed",
      );
    const record = readRecords().at(-1);
    if (model) {
      const enforce = model.mode === "enforce";
      // The exact number of endpoint calls is asserted per scenario: a defer asks
      // once, `off` asks never, and dedupe asks once for two identical calls.
      assert.equal(
        model.requests.length - requestsAtStart,
        model.expectRequests,
        `${name}: endpoint calls for this scenario`,
      );
      const record = readRecords().at(-1);
      assert.ok(record, `${name}: the turn is recorded`);
      assert.equal(record.policy.kind, "defer");
      assert.equal(record.execution, "not_observed");
      if (enforce) {
        if (model.terminalDeny) {
          // A provisional deny is terminal: no review opened, and the record
          // names the profile and the only ways forward.
          assert.equal(
            confirms,
            0,
            `${name}: a model deny must not ask a human`,
          );
          assert.equal(record.model?.authority, "selected_profile");
          assert.equal(record.model?.kind, "deny");
          assert.equal(record.effective.kind, "deny");
          assert.equal(record.effective.source, "decisions-model");
          assert(
            record.effective.explanation.includes("whitelist"),
            `${name}: a model denial must name the way forward`,
          );
        } else if (model.breakerOpens) {
          // The circuit opened inside the live gate: the last call never reached
          // the endpoint and still went to a human with authority `none`.
          assert.equal(confirms, calls);
          assert.equal(record.model?.reasonCode, "breaker_open");
          assert.equal(record.model?.authority, "none");
          assert.equal(record.effective.source, "human");
        } else if (model.grantsNothing) {
          // Endpoint failure or an operational bound grants nothing: a human
          // decides exactly as in shadow mode.
          assert.equal(confirms, 1);
          assert.equal(record.model?.authority, "none");
          assert.equal(record.effective.source, "human");
        } else {
          // A provisional allow still needed review; nothing ran without it. One
          // review per call: sharing a model reading never shares an approval.
          assert.equal(
            confirms,
            calls,
            `${name}: enforce allows stay provisional, one review per call`,
          );
          assert.equal(record.model?.authority, "selected_profile");
          assert.equal(record.model?.kind, model.proposal);
          assert.equal(record.effective.source, "human");
          assert(
            prompts.some((prompt) => prompt.includes("provisional")),
            `${name}: the reviewer must see that the approval is what authorises`,
          );
        }
        if (model.dedupe)
          assert.equal(
            readRecords().filter((entry) =>
              entry.request.command.includes(name),
            ).length,
            calls,
            `${name}: dedupe shares computation only: each call keeps its own record`,
          );
      } else if (model.mode === "shadow") {
        // Shadow: a proposal changes what the reviewer sees, never whether a
        // command runs. A rejection leaves no sentinel even when the model said
        // yes, and no record may claim execution.
        assert.ok(
          prompts.some((prompt) =>
            prompt.includes("Decisions model proposal (shadow, no authority):"),
          ),
          `${name}: the reviewer must see the proposal beside the deterministic reason`,
        );
        assert.ok(
          prompts.some((prompt) => prompt.includes("Why review")),
          `${name}: the deterministic reason must still be shown`,
        );
        assert.equal(record.effective.kind, approved ? "allow" : "deny");
        assert.equal(record.model?.authority, "none");
        assert.equal(record.model?.mode, "shadow");
        assert.equal(record.model?.kind, model.proposal);
        if (model.fails)
          assert.equal(
            record.model?.reasonCode,
            "endpoint_http",
            "an unavailable endpoint is named in the record, not hidden",
          );
      } else {
        // Posture `off`: nothing was asked, and nothing may claim a model view.
        assert.equal(record.model, undefined);
        assert.equal(confirms, 1);
      }
      assert.equal(
        existsSync(sentinel),
        approved,
        `${name}: a model outcome must not run or block a command on its own`,
      );
    }

    const summary = {
      name,
      automatedUI: !!uiContext,
      mode,
      confirms,
      events,
      hookErrors: errors.length,
      hookErrorMessages: errors.map((error) => error.error ?? error.message),
      loadErrors: loaded.errors.length,
      isError: result.isError ?? false,
      ...(model
        ? {
            modelMode: model.mode,
            modelProposed: model.requests.length - requestsAtStart,
            calls,
            breakerTrips: record?.model?.breaker?.trips ?? null,
            modelShared: record?.model?.shared === true,
            reviewPromptHasProposal: prompts.some((prompt) =>
              prompt.includes("Decisions model proposal"),
            ),
          }
        : {}),
    };
    console.log(JSON.stringify(summary));
    return summary;
  } finally {
    session.dispose();
    removePolicy();
    rmSync(join(cwd, `${name}.sentinel`), { force: true });
  }
}

await run("rejected");
await run("approved", { answer: true });
await run("print", { mode: "print", answer: true });
await run("json", { mode: "json", answer: true });
await run("rpc", { mode: "rpc", answer: true });
await run("ui-error", { answer: "throw" });
await run("cancelled", { cancel: true });
await run("hook-error", { hookError: true, answer: true });
await run("custom-bash", { custom: true, answer: true });
await run("prefix", { prefix: "printf prefix", answer: false });
await run("load-failure", { loadFailure: true });

// M2 shadow scenarios: a model approval must never run anything, and a model
// denial must never block in place of a human.
const approvalFixture = await startDecisionFixture({
  authorized: 0.97,
  reversible: 0.96,
  blast_radius: 0.97,
  exfiltration: 0.01,
});
const denialFixture = await startDecisionFixture({
  authorized: 0.97,
  reversible: 0.02,
  blast_radius: 0.97,
  exfiltration: 0.01,
});
const failingFixture = await startFailingFixture();
try {
  const approvedProposal = await run("shadow-model-approval-rejected", {
    answer: false,
    model: {
      ...approvalFixture,
      mode: "shadow",
      proposal: "allow",
      approved: false,
      expectRequests: 1,
    },
  });
  assert.equal(approvedProposal.confirms, 1);

  const againstDenial = await run("shadow-model-denial-not-terminal", {
    answer: true,
    model: {
      ...denialFixture,
      mode: "shadow",
      proposal: "deny",
      approved: true,
      expectRequests: 1,
    },
  });
  assert.equal(againstDenial.confirms, 1);

  const endpointDown = await run("shadow-endpoint-unavailable", {
    answer: false,
    model: {
      ...failingFixture,
      mode: "shadow",
      proposal: "defer",
      fails: true,
      approved: false,
      expectRequests: 1,
    },
  });
  assert.equal(endpointDown.confirms, 1);

  const offPosture = await run("model-off-asks-nothing", {
    answer: false,
    model: {
      ...approvalFixture,
      mode: "off",
      proposal: "allow",
      requests: [],
      approved: false,
      expectRequests: 0,
    },
  });
  assert.equal(offPosture.confirms, 1);

  // M3 enforce scenarios. The model is never the reason a command runs, and a
  // model deny is the one thing it may end on its own.
  const slowApproval = await startDecisionFixture(
    {
      authorized: 0.97,
      reversible: 0.96,
      blast_radius: 0.97,
      exfiltration: 0.01,
    },
    60,
  );
  try {
    const terminal = await run("enforce-model-deny-terminal", {
      answer: true,
      model: {
        ...denialFixture,
        mode: "enforce",
        proposal: "deny",
        terminalDeny: true,
        approved: false,
        expectRequests: 1,
      },
    });
    assert.equal(
      terminal.isError,
      true,
      `${terminal.name}: a terminal model deny blocks the call`,
    );

    const provisional = await run("enforce-model-allow-still-reviewed", {
      answer: true,
      model: {
        ...approvalFixture,
        mode: "enforce",
        proposal: "allow",
        approved: true,
        expectRequests: 1,
      },
    });
    assert.equal(provisional.confirms, 1);

    const withheld = await run("enforce-model-allow-rejected", {
      answer: false,
      model: {
        ...approvalFixture,
        mode: "enforce",
        proposal: "allow",
        approved: false,
        expectRequests: 1,
      },
    });
    assert.equal(withheld.confirms, 1);

    const endpointDown = await run("enforce-endpoint-grants-nothing", {
      answer: false,
      model: {
        ...failingFixture,
        mode: "enforce",
        proposal: "defer",
        grantsNothing: true,
        approved: false,
        expectRequests: 1,
      },
    });
    assert.equal(endpointDown.confirms, 1);

    // Two identical calls with dedupe enabled, fired together and with the
    // fixture holding its response so they overlap. They share one endpoint
    // computation and still each need their own human approval, each keep their
    // own record, and neither may run on the other's decision. Without dedupe the
    // same shape costs two requests (see `enforce-dedup-never-shares-approval`
    // below, where the endpoint is contacted twice).
    const shared = await run("enforce-dedup-shares-computation-only", {
      answer: true,
      calls: 2,
      parallel: true,
      policy: { model: { operational: { dedupe: true } } },
      model: {
        ...slowApproval,
        mode: "enforce",
        proposal: "allow",
        approved: true,
        dedupe: true,
        expectRequests: 1,
      },
    });
    assert.equal(
      shared.confirms,
      2,
      `${shared.name}: reviews are never shared`,
    );
    // Control: identical shape, dedupe left off, so the endpoint is contacted
    // twice. Without this the sharing assertion above could pass vacuously.
    const unshared = await run("dedupe-off-asks-the-endpoint-each-time", {
      answer: true,
      calls: 2,
      parallel: true,
      model: {
        ...slowApproval,
        mode: "enforce",
        proposal: "allow",
        approved: true,
        expectRequests: 2,
      },
    });
    assert.equal(
      unshared.confirms,
      2,
      `${unshared.name}: two calls, two reviews`,
    );

    // The breaker opens inside the real gate: two failing attempts, then the
    // third call is refused without touching the endpoint and still asks a human.
    const breaker = await run("enforce-breaker-opens-in-the-live-gate", {
      answer: true,
      calls: 3,
      policy: { model: { operational: { breakerFailures: 2 } } },
      model: {
        ...failingFixture,
        mode: "enforce",
        proposal: "defer",
        grantsNothing: true,
        approved: true,
        breakerOpens: true,
        expectRequests: 2,
      },
    });
    assert.equal(breaker.confirms, 3);
  } finally {
    await slowApproval.close();
  }

  // Only the scenarios that ask may talk to the loopback fixture. Totals, not
  // just per-scenario deltas: an endpoint used by a scenario that did not
  // account for it would show up here.
  //   approvalFixture: shadow approval, enforce allow, enforce rejection
  //   denialFixture:   shadow denial, enforce terminal denial
  //   failingFixture:  shadow unavailable, enforce endpoint-down, breaker (2 attempts)
  //   slowApproval:    dedupe pair (1 shared) + unshared control (2)
  assert.equal(approvalFixture.requests.length, 3);
  assert.equal(denialFixture.requests.length, 2);
  assert.equal(failingFixture.requests.length, 4);
  assert.equal(slowApproval.requests.length, 3);
} finally {
  await approvalFixture.close();
  await denialFixture.close();
  await failingFixture.close();
}

console.log(
  "PASS: real Node Pi AgentSession smoke (automated UI; decision fixture is loopback-only)",
);
