import { CONFIG } from '../config';

// rtt = now - t we sent. latency = median. jitter = mean |rtt[i]-rtt[i-1]|
export interface LatencyReport {
  latencyMs: number;
  jitterMs: number;
  samples: number;
}

export interface LatencyStats extends LatencyReport {
  lastRttMs: number | null;
  outliers: number;
  lost: number;
}

export class LatencySampler {
  private samples: number[] = [];
  private inflight = new Map<number, number>();

  private nextSeq = 1;
  private lastRtt: number | null = null;
  private outlierCount = 0;
  private lostCount = 0;

  createPing(now: number): { seq: number; t: number } {
    const seq = this.nextSeq++;
    this.inflight.set(seq, now);

    for (const [oldSeq, sentAt] of this.inflight) {
      if (now - sentAt > CONFIG.RTT_OUTLIER_MS) {
        this.inflight.delete(oldSeq);
        this.lostCount++;
      }
    }

    return { seq, t: now };
  }

  onPong(seq: number, t: number, now: number): number | null {
    const sentAt = this.inflight.get(seq);
    if (sentAt === undefined) return null;
    this.inflight.delete(seq);

    const rtt = now - sentAt; // our sent time, not the echoed t

    if (rtt < 0) { // clock jumped backwards — don't treat as 0ms
      this.outlierCount++;
      return null;
    }

    if (rtt > CONFIG.RTT_OUTLIER_MS) {
      this.outlierCount++;
      return null;
    }

    this.lastRtt = rtt;
    this.samples.push(rtt);
    if (this.samples.length > CONFIG.RTT_WINDOW) {
      this.samples.splice(0, this.samples.length - CONFIG.RTT_WINDOW);
    }

    void t;
    return rtt;
  }

  report(): LatencyReport | null {
    if (this.samples.length < 2) return null;
    return {
      latencyMs: Math.round(median(this.samples)),
      jitterMs: Math.round(meanAbsoluteSuccessiveDifference(this.samples)),
      samples: this.samples.length,
    };
  }

  stats(): LatencyStats {
    const report = this.report();
    return {
      latencyMs: report?.latencyMs ?? 0,
      jitterMs: report?.jitterMs ?? 0,
      samples: this.samples.length,
      lastRttMs: this.lastRtt,
      outliers: this.outlierCount,
      lost: this.lostCount,
    };
  }

  reset(): void {
    this.samples = [];
    this.inflight.clear();
    this.lastRtt = null;
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const lower = sorted[mid - 1] ?? 0;
  const upper = sorted[mid] ?? 0;
  return (lower + upper) / 2;
}

export function meanAbsoluteSuccessiveDifference(values: number[]): number {
  if (values.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < values.length; i++) {
    const current = values[i];
    const previous = values[i - 1];
    if (current === undefined || previous === undefined) continue;
    total += Math.abs(current - previous);
  }
  return total / (values.length - 1);
}
