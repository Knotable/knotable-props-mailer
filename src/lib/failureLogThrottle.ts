// Keeps a repeating failure from becoming a database write per occurrence.
//
// The SES webhook rejects a misconfigured topic or a bad signature once per
// notification SNS delivers. During a send that is a write per bounce on the
// instance the send path was rewritten to stop writing to, and the rows are all
// the same row. Log the first of each kind, then count the rest and report the
// tally with the next one that gets through.

export type FailureLogDecision = { log: boolean; suppressed: number };

export class FailureLogThrottle {
  private readonly windowMs: number;
  private readonly seen = new Map<string, { until: number; suppressed: number }>();

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  consider(kind: string, nowMs = Date.now()): FailureLogDecision {
    const entry = this.seen.get(kind);
    if (entry && nowMs < entry.until) {
      entry.suppressed += 1;
      return { log: false, suppressed: entry.suppressed };
    }
    const suppressed = entry?.suppressed ?? 0;
    this.seen.set(kind, { until: nowMs + this.windowMs, suppressed: 0 });
    return { log: true, suppressed };
  }

  reset() {
    this.seen.clear();
  }
}
