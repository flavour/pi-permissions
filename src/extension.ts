import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, VERSION } from "@earendil-works/pi-coding-agent";

import { HumanGate, type Runtime } from "./gate.js";

/**
 * pi-permissions (M0).
 *
 * A human-only bash gate for Pi. See PLAN.md for the milestone breakdown and SPEC.md for the full
 * contract. This file implements only milestone 0: a standalone package and a verified, bash-only
 * human approval gate. Later milestones add other tools, policies, and model integration.
 *
 * The gate is intentionally a thin plugin: it registers nothing persistent, reads no secrets, and
 * performs no network I/O. It only inspects incoming `tool_call` events and, when the context looks
 * like a human at the terminal, asks them to approve the command before it runs.
 */
const gate = new HumanGate();

/**
 * Minimal view of the runtime the gate needs. Kept small so the gate keeps working even if Pi adds
 * fields the gate does not care about.
 */
function runtime(pi: ExtensionAPI): Runtime {
  const tools = pi.getActiveTools?.() ?? [];
  const declared = new Set(tools);
  return {
    version: VERSION,
    builtinBash: declared.has("bash"),
  };
}

/**
 * Gate the built-in `bash` tool.
 *
 * Two-phase by design:
 *  1. Refuse anything that is not a human at the terminal (no TUI, or not a chat session). Blocking
 *     up front keeps the decision visible and avoids waking the model for a call that will be denied.
 *  2. Otherwise ask the human, in real time, to approve the command.
 *
 * Nested calls (`parentToolCallId` set) are always model-driven (for example a codemode script
 * running inside the agent) and are refused without prompting: they can never be a human.
 */
export function gateBashTool(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    console.error(
      "[gate-debug] tool_call fired; toolName=",
      event.toolName,
      "parent=",
      event.parentToolCallId,
    );
    // Only the built-in bash tool matters. Ignore every other tool and non-tool events.
    if (!isToolCallEventType("bash", event)) return;

    // Nested calls are always model-driven (issued by another tool such as a codemode script),
    // and must be blocked: no policy shortcuts, no model input.
    if (event.parentToolCallId) {
      ctx.ui.notify(
        `pi-permissions: blocking model-driven command: ${JSON.stringify(event.input.command)}`,
        "warning",
      );
      return {
        block: true,
        reason: "pi-permissions: BLOCKED by policy (model-driven).",
      };
    }

    // Everything below is a top-level, non-nested call. Delegate the policy to the gate. The gate
    // refuses non-interactive and non-chat contexts, then asks the human to approve.
    return gate.review(
      event.input,
      {
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        cwd: ctx.cwd,
        signal: ctx.signal,
        confirm: ctx.ui.confirm,
        notify: ctx.ui.notify,
      },
      runtime(pi),
    ) as ToolCallEventResult | undefined;
  });
}

export default gateBashTool;
