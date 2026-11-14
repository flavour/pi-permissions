// Runs in normal Node, not Bun. All UI decisions below are AUTOMATED adapters.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [host, cwd, agentDir] = process.argv.slice(2);
const pi = await import(pathToFileURL(join(host, "dist/index.js")).href);
assert.equal(pi.VERSION, "1.5.2", "smoke is pinned to Pi 1.5.2");
// No prompt/model invocation is made. Nested executeTool uses AgentSession's real pipeline.
globalThis.fetch = () => {
  throw new Error("network forbidden by smoke fixture");
};
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
  } = {},
) {
  let confirms = 0;
  let customExecuted = false;
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
              notify: () => {},
              confirm: async (title, message, options) => {
                confirms++;
                assert.equal(options?.timeout, 60000);
                assert.equal(typeof title, "string");
                assert.equal(typeof message, "string");
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
    const result = await ctx.executeTool("bash", {
      command: `printf smoke > '${sentinel}'`,
      timeout: 2,
    });
    assert.equal(customExecuted, false, "custom bash must not reach execution");
    const approved = name === "approved";
    assert.equal(
      existsSync(sentinel),
      approved,
      `${name}: sentinel execution mismatch: ${JSON.stringify(result)}`,
    );
    if (approved) {
      assert.equal(readFileSync(sentinel, "utf8"), "smoke");
      assert.equal(result.isError ?? false, false);
      assert.equal(confirms, 1);
      assert.deepEqual(events, [
        "tool_execution_start",
        "tool_call",
        "tool_result",
        "tool_execution_end",
      ]);
    } else {
      assert.equal(result.isError, true, `${name} must be blocked`);
      assert(!events.includes("tool_result"), "blocked calls skip tool_result");
      if (mode !== "tui" || custom) assert.equal(confirms, 0);
      if (name === "rejected" || name === "ui-error" || cancel || hookError)
        assert.equal(confirms, 1);
      if (hookError)
        assert(
          JSON.stringify(result).includes("automated hook failure"),
          "throwing hook must be reported in the tool error",
        );
    }
    assert.equal(errors.length, 0, "no unexpected extension lifecycle errors");
    console.log(
      JSON.stringify({
        name,
        automatedUI: !!uiContext,
        mode,
        confirms,
        events,
        hookErrors: errors.length,
        hookErrorMessages: errors.map((error) => error.error ?? error.message),
        loadErrors: loaded.errors.length,
        isError: result.isError ?? false,
      }),
    );
  } finally {
    session.dispose();
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
console.log(
  "PASS: real Node Pi AgentSession smoke (automated UI; no model requests)",
);
