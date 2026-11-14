/** Only unqueued interactive text observed before a run can be associated.
 * Streaming/extension input invalidates rather than borrowing a previous user's authority.
 * Processed before_agent_start prompts are deliberately never captured.
 */
export class IntentTracker {
  private pending: string | undefined;
  private active: string | undefined;
  private running = false;
  private generation = 0;

  input(text: string, source: string, queued = false): void {
    this.generation++;
    this.active = undefined;
    this.pending =
      source === "interactive" && !queued && !this.running ? text : undefined;
  }
  start(prompt?: string, messageType = "user"): void {
    // The public API has no input ID. Exact equality is a conservative filter,
    // only valid under an audited non-transforming input-handler configuration.
    this.active =
      messageType === "user" && prompt === this.pending
        ? this.pending
        : undefined;
    this.pending = undefined;
    this.running = true;
  }
  end(): void {
    this.active = undefined;
    this.running = false;
  }
  reset(): void {
    this.generation++;
    this.pending = undefined;
    this.end();
  }
  get intent(): string | undefined {
    return this.active;
  }
  get revision(): number {
    return this.generation;
  }
}
