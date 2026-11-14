import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";

/**
 * pi-permissions human gate (M0).
 *
 * This is the first milestone of the permission system. It intentionally models only the narrow
 * case that must be safe by construction: a top-level `bash` tool call issued by a human, in the
 * normal chat UI, with no policy shortcuts and no model input. Everything else is blocked.
 *
 * ## What it blocks
 *
 *  - Any `bash` call that is nested inside another tool call. Nested calls are always model-driven
 *    (for example a codemode script running inside the agent), so blocking them removes the entire
 *    model-driven execution path.
 *  - Any `bash` call that is not interactive (no TUI attached). A non-interactive shell cannot be a
 *    human, and cannot confirm.
 *  - Any `bash` call outside a chat session. A background script or codemode run cannot be a human.
 *
 * ## What it allows
 *
 * A `bash` call that is interactive, inside a chat session, and that the human confirms in real time.
 *
 * ## Design rules (hard constraints, do not remove)
 *
 *  - Human-only. No model or policy shortcut exists: the gate never blocks on a model's judgement and
 *    never auto-approves. It only forwards to a human in the TUI and waits for their answer.
 *  - Bash-only. The gate is written against the `bash` tool event; other tools are handled later.
 *  - No configuration. There is no settings field, no allow-list, no deny-list, no risk scoring. The
 *    gate is a single boolean decision: "is this an interactive, chat-mode, human bash call?".
 *  - No model integration. No prompt, no temperature, no reasoning. The gate is pure policy plumbing.
 *  - Shadow mode is a compile-time constant. The gate never silently passes anything in production.
 *
 * ## Failure is loud
 *
 * If the context does not look like a supported human chat session, the gate refuses the call loudly
 * (a warning notification + a clear block reason) instead of silently letting it through. That is the
 * entire safety argument: anything that is not a human in a chat session never runs.
 */

/** How the extension was loaded: standalone, or bundled inside the Pi distribution. */
export type LoadMode = "standalone" | "bundled";

/**
 * Minimal view of the Pi runtime the gate needs. Kept intentionally small so the gate keeps working
 * even if Pi adds fields it does not care about.
 */
export interface Runtime {
  /** This extension's reported version. */
  version: string;
  /** Whether Pi declares a built-in `bash` tool (so the extension is protecting the real shell). */
  builtinBash: boolean;
}

/**
 * Displayed when the gate detects a context it does not support. The gate refuses the call loudly
 * rather than guessing.
 */
export function display(
  message: string,
  type?: "info" | "warning" | "error",
  notify: (
    message: string,
    type?: "info" | "warning" | "error",
  ) => void = () => {},
): void {
  notify(message, type);
}

/**
 * Human approval gate.
 *
 * The gate is deliberately simple: it only ever forwards a call to a human in the TUI and waits for
 * their answer. There is no policy, no scoring, no model input. This is a hard human-in-the-loop
 * check that runs before any shell command executes.
 */
export class HumanGate {
  /**
   * Decide whether to allow a top-level `bash` call.
   *
   * Returns `undefined` to allow the call (only for interactive, chat-mode, human calls). Returns a
   * block result otherwise.
   */
  async review(
    input: { command: string; timeout?: number },
    ctx: {
      mode: string;
      hasUI: boolean;
      cwd: string;
      signal?: AbortSignal | undefined;
      confirm: (title: string, message: string) => Promise<boolean>;
      notify: (message: string, type?: "info" | "warning" | "error") => void;
    },
    _runtime: Runtime,
  ): Promise<ToolCallEventResult | undefined> {
    // Only interactive, chat-mode, human calls are allowed through.
    // - hasUI: a real human is sitting at a TUI.
    // - mode: the call is happening in the interactive chat UI ("tui"), not a background script,
    //   RPC call, or codemode run. Everything else is non-human and is blocked.
    // - command: top-level (parentToolCallId already filtered out in the extension handler).
    console.error(
      "[gate-debug] review: hasUI=",
      ctx.hasUI,
      "mode=",
      ctx.mode,
      "confirm=",
      typeof ctx.confirm,
      "command=",
      input.command,
    );
    if (!ctx.hasUI) {
      display(
        "pi-permissions: BLOCKED - not an interactive shell (non-TUI context). Only human-approved commands run.",
        "warning",
        ctx.notify,
      );
      return {
        block: true,
        reason: "pi-permissions: BLOCKED by policy. Not an interactive shell.",
      };
    }

    if (ctx.mode !== "tui") {
      display(
        `pi-permissions: BLOCKED - not the interactive chat UI (${ctx.mode}). Only human-approved commands run.`,
        "warning",
        ctx.notify,
      );
      return {
        block: true,
        reason: `pi-permissions: BLOCKED by policy. Not the interactive chat UI (${ctx.mode}).`,
      };
    }

    // Reaching this point means: interactive TUI, chat mode, top-level call. Ask the human.
    const approved = await ctx.confirm(
      "Approve running this bash command?",
      `${input.command}`,
    );
    if (!approved) {
      display("pi-permissions: command denied by human.", "info", ctx.notify);
      return {
        block: true,
        reason: "pi-permissions: Command denied by human approval.",
      };
    }
    return undefined;
  }
}
