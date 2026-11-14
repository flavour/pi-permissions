import {
  type Assessment,
  type BashRequest,
  denied,
  type ModelAssessment,
} from "./request.js";

/** Escape controls/bidi characters visibly, without altering the decision snapshot. */
export function visible(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) =>
    c === "\n" ? "\n" : `\\u{${c.codePointAt(0)?.toString(16)}}`,
  );
}

/**
 * A shadow proposal line for the reviewer. The model's wording is operator- or
 * profile-derived text, so it is escaped exactly like the command: a proposal
 * can inform the human, never instruct the terminal.
 */
export function modelProposalLines(model: ModelAssessment): string[] {
  const profile = model.profileId ? ` [profile ${model.profileId}]` : "";
  return [
    `Decisions model proposal (${model.mode}, no authority): ${model.kind}${profile} — ${visible(
      model.explanation,
    )}`,
    "The model cannot approve or block this call. Your decision is the decision.",
  ];
}

export function buildHumanPrompt(
  request: BashRequest,
  why: Assessment,
  model?: ModelAssessment,
): string {
  const modelLines = model ? modelProposalLines(model) : [];
  return [
    "Approve once or reject this entire invocation. Controls are visually escaped.",
    `Request: ${visible(request.requestId)}`,
    `Why review: ${visible(why.explanation)}`,
    "Command (complete):",
    visible(request.command),
    `Working directory: ${visible(request.cwd)}`,
    `Tool timeout: ${request.timeout === undefined ? "host default" : `${request.timeout} seconds`}`,
    `Raw interactive intent (context, not authority): ${visible(request.userIntent ?? "UNKNOWN — no associated raw interactive input")}`,
    `Shell prefix: ${visible(request.executionContext.prefix || "(none)")}`,
    `Configured shell: ${visible(request.executionContext.shellPath ?? "host default (not attested)")}`,
    ...modelLines,
    "Execution unknowns: shell startup files, functions, executable resolution, backend/spawn hooks, mutable files and later extensions are not attested.",
    "Approve only if this exact invocation is intended. Reject if unsure.",
  ].join("\n\n");
}

export type Confirm = (
  title: string,
  message: string,
  options: { signal: AbortSignal; timeout: number },
) => Promise<boolean>;

/** Serialized one-shot dialogs, with a total queue+dialog deadline and bounded queue. */
export class HumanReviewer {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(
    private readonly timeout = 60_000,
    private readonly now = () => performance.now(),
  ) {}

  async review(
    request: BashRequest,
    why: Assessment,
    confirm: Confirm,
    signal?: AbortSignal,
    model?: ModelAssessment,
  ): Promise<Assessment> {
    if (this.pending >= 16)
      return denied(
        "review_queue_full",
        "Human review queue is full; retry only after consulting the user.",
      );
    this.pending++;
    const deadline = this.now() + this.timeout;
    const previous = this.tail;
    let release = () => {};
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => slot);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      abort();
    }, this.timeout);
    let removeAbort = () => {};
    const cancelled = new Promise<false>((resolve) => {
      const done = () => resolve(false);
      controller.signal.addEventListener("abort", done, { once: true });
      removeAbort = () => controller.signal.removeEventListener("abort", done);
      if (controller.signal.aborted) done();
    });
    try {
      const ready = await Promise.race([previous.then(() => true), cancelled]);
      if (this.now() >= deadline) {
        expired = true;
        abort();
      }
      if (!ready || controller.signal.aborted)
        return denied(
          expired ? "review_timeout" : "review_cancelled",
          "Review expired or was cancelled; no approval was granted.",
        );
      const approved = await Promise.race([
        confirm(
          "pi-permissions: approve once?",
          buildHumanPrompt(request, why, model),
          { signal: controller.signal, timeout: this.timeout },
        ),
        cancelled,
      ]);
      if (this.now() >= deadline) {
        expired = true;
        abort();
      }
      if (controller.signal.aborted)
        return denied(
          expired ? "review_timeout" : "review_cancelled",
          "Review expired or was cancelled; a late answer cannot approve it.",
        );
      return {
        kind: approved === true ? "allow" : "deny",
        source: "human",
        reasonCode: approved === true ? "human_approved" : "human_rejected",
        explanation:
          approved === true
            ? "Human approved this request once."
            : "Human rejected or dismissed this request.",
      };
    } catch {
      return denied(
        "review_failed",
        "Human review failed; no approval was granted.",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      removeAbort();
      this.pending--;
      release();
    }
  }
}
