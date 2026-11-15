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

/** A proposal line for the reviewer. */
export function modelProposalLines(model: ModelAssessment): string[] {
  const profile = model.profileId ? ` [profile ${model.profileId}]` : "";
  const shadow = model.authority === "none";
  return [
    `Decisions model proposal (${model.mode}, ${
      shadow
        ? "no authority"
        : "provisional enforce authority: an allow is provisional, a deny is terminal"
    }): ${model.kind}${profile} — ${visible(model.explanation)}`,
    shadow
      ? "The model cannot approve or block this call. Your decision is the decision."
      : "Your approval is still required before this call can run; the model cannot approve it alone.",
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

/**
 * One-shot review with no shared state: each call owns its queue slot, its own
 * deadline, and its own approval.
 *
 * `deadlineMs` is a *total* bound measured from the moment the request arrived,
 * covering queue wait plus dialog, so a caller cannot be held behind an
 * abandoned predecessor indefinitely. `maxPending` bounds how many reviews may
 * wait at all; beyond it a caller is refused immediately rather than queued.
 * The bound is optional: a single-caller host that wants a plain fixed dialog
 * window omits it, and nothing is measured from a shared start time.
 */
export class HumanReviewer {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(
    private readonly timeout = 60_000,
    private readonly now = () => performance.now(),
    private readonly maxPending = 16,
    private readonly deadlineMs: number | undefined = undefined,
  ) {}

  /** How many reviews are waiting or in front of the dialog right now. */
  get pendingCount(): number {
    return this.pending;
  }

  async review(
    request: BashRequest,
    why: Assessment,
    confirm: Confirm,
    signal?: AbortSignal,
    model?: ModelAssessment,
  ): Promise<Assessment> {
    if (this.pending >= this.maxPending)
      return denied(
        "review_queue_full",
        "Human review queue is full; retry only after consulting the user.",
      );
    this.pending++;
    const deadline =
      this.deadlineMs === undefined
        ? Number.POSITIVE_INFINITY
        : this.now() + this.deadlineMs;
    const remaining = () =>
      this.deadlineMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, deadline - this.now());
    /**
     * The caller's whole life is bounded: queue wait plus dialog cannot exceed
     * one dialog window, nor the total bound measured from arrival, whichever is
     * shorter. The timer is armed at arrival so waiting behind an abandoned
     * review is bounded too, and the dialog shows the remainder as its countdown.
     */
    const budget = () => Math.min(this.timeout, remaining());
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
    }, budget());
    let removeAbort = () => {};
    const cancelled = new Promise<false>((resolve) => {
      const done = () => resolve(false);
      controller.signal.addEventListener("abort", done, { once: true });
      removeAbort = () => controller.signal.removeEventListener("abort", done);
      if (controller.signal.aborted) done();
    });
    try {
      const ready = await Promise.race([previous.then(() => true), cancelled]);
      if (!ready || controller.signal.aborted)
        return denied(
          expired ? "review_timeout" : "review_cancelled",
          "Review expired or was cancelled; no approval was granted.",
        );
      // Never open a dialog with no time in it: a caller whose total bound has
      // already been spent waiting for an earlier review is refused, not flashed.
      const dialogMs = budget();
      if (dialogMs <= 0)
        return denied(
          "review_timeout",
          "Review expired while waiting for an earlier review; no approval was granted.",
        );
      const approved = await Promise.race([
        confirm(
          "pi-permissions: approve once?",
          buildHumanPrompt(request, why, model),
          { signal: controller.signal, timeout: dialogMs },
        ),
        cancelled,
      ]);
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
