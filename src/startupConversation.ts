import type { ManagerSnapshot, SessionRecord } from "./types";

// A startup route must never become a periodic refresh action or override a user action.
export class StartupConversation {
  private finished = false;

  constructor(
    private readonly enabled: boolean,
    private readonly prepare: () => Promise<void>,
    private readonly open: (record: SessionRecord) => Promise<void>
  ) {}

  cancel(): void { this.finished = true; }

  async restore(snapshot: () => ManagerSnapshot): Promise<void> {
    if (!this.enabled || this.finished) return;
    const initial = snapshot();
    if (initial.loading) return;
    const first = initial.records[0];
    if (!first || first.source !== "local" || initial.errors.local) {
      this.finished = true;
      return;
    }
    await this.prepare();
    if (this.finished) return;
    const current = snapshot();
    this.finished = true;
    if (current.loading || current.errors.local || current.records[0]?.key !== first.key) return;
    await this.open(current.records[0]);
  }
}
