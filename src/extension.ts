import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  isToolCallEventType,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { visible } from "./ask.js";
import { loadConfig } from "./config.js";
import { Handler } from "./handler.js";
import { IntentTracker } from "./provenance.js";
import { writeRecord } from "./records.js";
import { snapshot } from "./request.js";

/** Pi owns the final execution path. Later mutating extensions are outside this boundary. */
export default function install(pi: ExtensionAPI): void {
  const handler = new Handler();
  const intent = new IntentTracker();
  let lifetime = new AbortController();
  let turnId = randomUUID();
  let expectedInitialUserMessage = false;
  const invalidate = () => {
    lifetime.abort();
    lifetime = new AbortController();
    intent.reset();
    expectedInitialUserMessage = false;
    turnId = randomUUID();
  };
  pi.on("session_start", (_event, ctx) => {
    invalidate();
    const config = loadConfig(getAgentDir());
    const message = `pi-permissions: ACTIVE built-in bash gate; Pi ${VERSION}; mode ${ctx.mode}; config ${config.status}. Models OFF. ${VERSION === "1.5.2" ? "" : "UNSUPPORTED runtime: bash blocked."}`;
    ctx.ui.setStatus("pi-permissions", message);
    if (ctx.hasUI)
      ctx.ui.notify(message, config.status === "invalid" ? "warning" : "info");
    else console.error(message);
  });
  pi.on("input", (event) => {
    lifetime.abort();
    lifetime = new AbortController();
    intent.input(
      event.text,
      event.source,
      event.streamingBehavior !== undefined,
    );
  });
  pi.on("before_agent_start", (event) => {
    intent.start(
      event.messageType === "user" ? event.prompt : undefined,
      event.messageType,
    );
    expectedInitialUserMessage = event.messageType === "user";
  });
  pi.on("message_start", (event) => {
    if (event.message.role !== "user") return;
    if (expectedInitialUserMessage) expectedInitialUserMessage = false;
    else invalidate(); // A delivered queued/extension message has no durable input provenance.
  });
  pi.on("agent_start", () => {
    turnId = randomUUID();
  });
  pi.on("agent_end", () => {
    lifetime.abort();
    lifetime = new AbortController();
    intent.end();
  });
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_before_compact", invalidate);
  pi.on("session_shutdown", invalidate);

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const block = (reason: string) => ({
      block: true,
      reason: `pi-permissions: ${reason} Do not evade this decision by rewording or wrapping the command. Explain the need to the user or request an explicit policy change.`,
    });
    try {
      const tool = pi.getAllTools().find((entry) => entry.name === "bash");
      if (VERSION !== "1.5.2")
        return block("Unsupported Pi runtime; use verified Pi 1.5.2.");
      if (
        tool?.sourceInfo.source !== "builtin" ||
        tool.sourceInfo.path !== "builtin:bash"
      )
        return block(
          "Bash is not the supported built-in tool; remove the override.",
        );
      if (
        typeof event.input.command !== "string" ||
        typeof ctx.cwd !== "string"
      )
        return block("Invalid bash request snapshot.");
      const settings = pi.getSettings();
      const prefix = settings.shellCommandPrefix ?? "";
      const shellPath = settings.shellPath;
      const request = snapshot({
        requestId: randomUUID(),
        sessionId: ctx.sessionManager.getSessionId(),
        turnId,
        toolCallId: event.toolCallId,
        command: event.input.command,
        ...(event.input.timeout === undefined
          ? {}
          : { timeout: event.input.timeout }),
        cwd: ctx.cwd,
        ...(intent.intent === undefined ? {} : { userIntent: intent.intent }),
        executionContext: {
          prefix,
          verified: prefix === "" && !shellPath,
          ...(shellPath ? { shellPath } : {}),
        },
      });
      const config = loadConfig(getAgentDir());
      if (config.status === "invalid") {
        const message =
          "pi-permissions: invalid global config; automatic rules disabled. Fix <agentDir>/extensions/pi-permissions/config.json.";
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.error(message);
      }
      const signals = [lifetime.signal, ...(ctx.signal ? [ctx.signal] : [])];
      const signal = AbortSignal.any(signals);
      const valid = () => {
        const current = pi.getSettings();
        const currentTool = pi
          .getAllTools()
          .find((entry) => entry.name === "bash");
        return (
          !signal.aborted &&
          event.input.command === request.command &&
          event.input.timeout === request.timeout &&
          ctx.cwd === request.cwd &&
          event.toolCallId === request.toolCallId &&
          ctx.sessionManager.getSessionId() === request.sessionId &&
          (current.shellCommandPrefix ?? "") ===
            request.executionContext.prefix &&
          current.shellPath === request.executionContext.shellPath &&
          currentTool?.sourceInfo.source === "builtin" &&
          currentTool.sourceInfo.path === "builtin:bash"
        );
      };
      const decision = await handler.decide(request, config, {
        valid,
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        signal,
        confirm: (title, message, options) =>
          ctx.ui.confirm(title, message, options),
        record: (record) => {
          if (config.config.records !== false)
            writeRecord(getAgentDir(), record);
        },
      });
      // Re-check the live object: this cannot protect against a later handler's mutations.
      if (!valid())
        return block(
          "Request changed or was cancelled during review; approval is invalid.",
        );
      if (decision.kind !== "allow")
        return block(
          visible(
            `${decision.reasonCode}${decision.ruleId ? ` (rule ${decision.ruleId})` : ""}: ${decision.explanation}`,
          ),
        );
      return;
    } catch {
      // No exception body: it can contain user command/config/transport secrets.
      return block(
        "Gate failure; no approval was granted. Inspect activation and private config/record directory permissions.",
      );
    }
  });
}
