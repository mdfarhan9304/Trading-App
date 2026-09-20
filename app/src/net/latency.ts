import { CONFIG } from '../config';

/**
 * Round-trip time measurement, and the latency/jitter figures reported to the backend.
 *
 * HOW A SAMPLE IS TAKEN
 * ---------------------
 * The app sends `{type:'ping', seq, t}` where `t` is a reading of ITS OWN clock. The server
 * echoes `t` back untouched in the pong. RTT is then `now - t`, computed entirely against
 * the device's clock.
 *
 * That is the whole reason `t` is opaque to the server: no clock synchronisation is needed
 * and device/server clock skew cannot corrupt the measurement. If instead we compared a
 * device timestamp against a server timestamp, a phone whose clock is two minutes fast
 * would report a latency of minus two minutes.
 *
 * LATENCY = MEDIAN of the window
 * ------------------------------
 * Not the mean. One stalled sample (a radio wake-up, a garbage collection pause, a single
 * TCP retransmit) can be ten times the typical RTT, and a mean would let that single value
 * dominate the window for the next twenty seconds. The median ignores it. This matters
 * because the median feeds a tier decision, and we do not want one hiccup to demote a
 * healthy connection.
 *
 * JITTER = MEAN ABSOLUTE SUCCESSIVE DIFFERENCE
 * --------------------------------------------
 *     jitter = mean( |rtt[i] - rtt[i-1]| )   over the window
 *
 * This is packet delay variation: how much consecutive round trips differ from each other.
 * It is the same idea as RFC 3550's smoothed interarrival jitter, but computed over a plain
 * window instead of an exponential filter, which makes it trivial to explain and to test
 * against a known array of numbers.
 *
 * Standard deviation was the alternative and is worse here: it measures spread around the
 * mean, so a connection that drifts smoothly from 20ms to 200ms across the window scores a
 * high standard deviation while actually being perfectly stable from frame to frame. What a
 * live chart cares about is frame-to-frame consistency, which is exactly what successive
 * differences capture.
 *
 * The backend combines them as `score = latency + 2 x jitter`, weighting instability more
 * heavily than uniform slowness.
 */

export interface LatencyReport {
  latencyMs: number;
  jitterMs: number;
  samples: number;
}

export interface LatencyStats extends LatencyReport {
  /** Most recent raw sample, shown live in the debug panel. */
  lastRttMs: number | null;
  /** Samples discarded as implausible. */
  outliers: number;
  /** Pings sent for which no pong ever arrived. */
  lost: number;
}

export class LatencySampler {
  /** Ring of recent RTTs, oldest first. */
  private samples: number[] = [];

  /** Outstanding pings: seq -> the `t` we sent, so a late pong can still be matched. */
  private inflight = new Map<number, number>();

  private nextSeq = 1;
  private lastRtt: number | null = null;
  private outlierCount = 0;
  private lostCount = 0;

  /** Allocate the next ping. The caller sends it and hands the pong back to `onPong`. */
  createPing(now: number): { seq: number; t: number } {
    const seq = this.nextSeq++;
    this.inflight.set(seq, now);

    // Any ping still outstanding after several intervals is lost, not slow. Counting and
    // forgetting them keeps `inflight` bounded and stops a very late pong from being
    // recorded as an enormous RTT.
    for (const [oldSeq, sentAt] of this.inflight) {
      if (now - sentAt > CONFIG.RTT_OUTLIER_MS) {
        this.inflight.delete(oldSeq);
        this.lostCount++;
      }
    }

    return { seq, t: now };
  }

  /**
   * Record a pong. Returns the RTT, or null if the frame was unmatched or implausible.
   *
   * `seq` is matched rather than assuming pongs arrive in order. They normally do over a
   * single TCP connection, but the server delays pongs when `injectDelay` is active, and
   * changing that delay mid-flight can reorder them. Matching by seq makes that harmless.
   */
  onPong(seq: number, t: number, now: number): number | null {
    const sentAt = this.inflight.get(seq);
    if (sentAt === undefined) {
      // A pong for a ping we already gave up on, or a duplicate. Ignore it rather than
      // trusting the echoed `t`, which a broken server could have altered.
      return null;
    }
    this.inflight.delete(seq);

    // Prefer our own record over the echoed value. They should agree; if they do not, ours
    // is the one we can trust.
    const rtt = now - sentAt;

    // A negative RTT is only possible if the device clock moved backwards mid-flight, e.g.
    // an NTP correction. Discard rather than clamping to zero, which would look like a
    // perfect connection.
    if (rtt < 0) {
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

    // `t` is accepted but unused; kept in the signature because a future protocol version
    // may need it, and ignoring it explicitly is clearer than not receiving it.
    void t;
    return rtt;
  }

  /**
   * The report to send, or null when there is not enough data yet.
   *
   * Two samples are required because jitter is undefined with fewer: a single RTT has no
   * successive difference. Sending a jitter of 0 off one sample would tell the backend the
   * connection is perfectly stable when we simply do not know yet, and could earn a
   * promotion the link has not demonstrated.
   */
  report(): LatencyReport | null {
    if (this.samples.length < 2) return null;
    return {
      latencyMs: Math.round(median(this.samples)),
      jitterMs: Math.round(meanAbsoluteSuccessiveDifference(this.samples)),
      samples: this.samples.length,
    };
  }

  /** Everything the debug panel shows, valid even before a report can be produced. */
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

  /**
   * Discard the window.
   *
   * Called on reconnect: RTTs measured over a socket that has since died say nothing about
   * the new one, and carrying them over would let a stale good measurement mask a newly bad
   * connection. Cumulative counters are kept because they are diagnostics, not inputs.
   */
  reset(): void {
    this.samples = [];
    this.inflight.clear();
    this.lastRtt = null;
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}

/** Median of a numeric array. Does not mutate the input. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const lower = sorted[mid - 1] ?? 0;
  const upper = sorted[mid] ?? 0;
  return (lower + upper) / 2;
}

/**
 * Mean of |x[i] - x[i-1]| across the array. Zero for fewer than two values.
 *
 * Exported so the test can check it against a hand-computed example.
 */
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
