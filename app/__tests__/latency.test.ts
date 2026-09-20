import { CONFIG } from '../src/config';
import {
  LatencySampler,
  meanAbsoluteSuccessiveDifference,
  median,
} from '../src/net/latency';

describe('median', () => {
  it('returns the middle value for an odd-length window', () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it('averages the two middle values for an even-length window', () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('does not mutate the input array', () => {
    const input = [30, 10, 20];
    median(input);
    expect(input).toEqual([30, 10, 20]);
  });

  it('ignores a single extreme outlier, which is the entire reason it is used', () => {
    // Nine samples around 20ms plus one 2-second stall, the shape produced by a radio wake-up
    // or a garbage collection pause.
    const samples = [20, 21, 19, 22, 20, 18, 21, 20, 19, 2_000];

    // A mean would report ~218ms and, at a 400ms threshold, push this healthy connection most
    // of the way to the `minimal` tier off one bad sample.
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(200);

    // The median is unmoved.
    expect(median(samples)).toBeLessThan(25);
  });

  it('returns 0 for an empty window rather than NaN', () => {
    // NaN would propagate into the reported score and poison the tier decision permanently.
    expect(median([])).toBe(0);
  });
});

describe('jitter as mean absolute successive difference', () => {
  it('matches a hand-computed example', () => {
    // Differences: 10, 10, 10, 10 -> mean 10
    expect(meanAbsoluteSuccessiveDifference([10, 20, 30, 40, 50])).toBe(10);
  });

  it('is zero for a perfectly steady connection', () => {
    expect(meanAbsoluteSuccessiveDifference([25, 25, 25, 25])).toBe(0);
  });

  it('is symmetric: direction of change does not matter', () => {
    expect(meanAbsoluteSuccessiveDifference([10, 50, 10, 50])).toBe(40);
    expect(meanAbsoluteSuccessiveDifference([50, 10, 50, 10])).toBe(40);
  });

  it('is undefined-safe for windows too small to have a difference', () => {
    expect(meanAbsoluteSuccessiveDifference([])).toBe(0);
    expect(meanAbsoluteSuccessiveDifference([42])).toBe(0);
  });

  it('scores a smooth drift as stable, which standard deviation would not', () => {
    // This is the reason successive differences were chosen over standard deviation. A
    // connection drifting steadily from 20ms to 200ms is perfectly consistent frame to frame,
    // which is what a live chart cares about.
    const drifting = [20, 40, 60, 80, 100, 120, 140, 160, 180, 200];
    const alternating = [20, 200, 20, 200, 20, 200, 20, 200, 20, 200];

    // Both have a large spread, so a standard deviation would rate them similarly...
    expect(stdDev(drifting)).toBeGreaterThan(50);
    expect(stdDev(alternating)).toBeGreaterThan(50);

    // ...but only one of them actually stutters, and jitter distinguishes them sharply.
    expect(meanAbsoluteSuccessiveDifference(drifting)).toBe(20);
    expect(meanAbsoluteSuccessiveDifference(alternating)).toBe(180);
  });
});

function stdDev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

describe('LatencySampler', () => {
  it('measures RTT from the device clock only', () => {
    const sampler = new LatencySampler();
    const ping = sampler.createPing(1_000);
    // The server echoes `t` back; RTT is computed against our own record of when we sent it, so
    // a server clock that is wildly wrong cannot affect the measurement.
    const rtt = sampler.onPong(ping.seq, ping.t, 1_042);
    expect(rtt).toBe(42);
  });

  it('ignores a pong whose sequence number was never sent', () => {
    const sampler = new LatencySampler();
    sampler.createPing(1_000);
    expect(sampler.onPong(999, 1_000, 1_050)).toBeNull();
  });

  it('ignores a duplicated pong', () => {
    const sampler = new LatencySampler();
    const ping = sampler.createPing(1_000);
    expect(sampler.onPong(ping.seq, ping.t, 1_020)).toBe(20);
    // The second one has no outstanding ping to match, so it cannot inflate the window.
    expect(sampler.onPong(ping.seq, ping.t, 1_500)).toBeNull();
    expect(sampler.sampleCount).toBe(1);
  });

  it('matches pongs by sequence rather than assuming arrival order', () => {
    // The server delays pongs when injectDelay is active, and changing that delay mid-flight can
    // reorder them. Matching by seq makes that harmless.
    const sampler = new LatencySampler();
    const first = sampler.createPing(1_000);
    const second = sampler.createPing(1_100);

    expect(sampler.onPong(second.seq, second.t, 1_150)).toBe(50);
    expect(sampler.onPong(first.seq, first.t, 1_400)).toBe(400);
  });

  it('discards an implausibly large sample', () => {
    const sampler = new LatencySampler();
    const ping = sampler.createPing(0);
    expect(sampler.onPong(ping.seq, ping.t, CONFIG.RTT_OUTLIER_MS + 1)).toBeNull();
    expect(sampler.stats().outliers).toBe(1);
    expect(sampler.sampleCount).toBe(0);
  });

  it('discards a negative sample caused by the clock moving backwards', () => {
    const sampler = new LatencySampler();
    const ping = sampler.createPing(5_000);
    // An NTP correction mid-flight. Clamping to zero would look like a perfect connection.
    expect(sampler.onPong(ping.seq, ping.t, 4_000)).toBeNull();
    expect(sampler.stats().outliers).toBe(1);
  });

  it('withholds a report until jitter is defined', () => {
    const sampler = new LatencySampler();
    expect(sampler.report()).toBeNull();

    const first = sampler.createPing(0);
    sampler.onPong(first.seq, first.t, 20);
    // One sample has no successive difference, so reporting jitter 0 would claim a stability we
    // have not observed and could earn a promotion the link has not demonstrated.
    expect(sampler.report()).toBeNull();

    const second = sampler.createPing(2_000);
    sampler.onPong(second.seq, second.t, 2_030);
    expect(sampler.report()).toEqual({ latencyMs: 25, jitterMs: 10, samples: 2 });
  });

  it('bounds the window to the configured size', () => {
    const sampler = new LatencySampler();
    for (let i = 0; i < CONFIG.RTT_WINDOW + 20; i++) {
      const ping = sampler.createPing(i * 2_000);
      sampler.onPong(ping.seq, ping.t, i * 2_000 + 30);
    }
    expect(sampler.sampleCount).toBe(CONFIG.RTT_WINDOW);
  });

  it('rounds reported values to whole milliseconds', () => {
    const sampler = new LatencySampler();
    const samples = [10, 11, 13];
    samples.forEach((rtt, i) => {
      const ping = sampler.createPing(i * 2_000);
      sampler.onPong(ping.seq, ping.t, i * 2_000 + rtt);
    });
    const report = sampler.report();
    expect(report).not.toBeNull();
    expect(Number.isInteger(report?.latencyMs)).toBe(true);
    expect(Number.isInteger(report?.jitterMs)).toBe(true);
  });

  it('counts a ping that never gets answered as lost', () => {
    const sampler = new LatencySampler();
    sampler.createPing(0);
    // Issuing a much later ping sweeps the abandoned one.
    sampler.createPing(CONFIG.RTT_OUTLIER_MS + 1_000);
    expect(sampler.stats().lost).toBe(1);
  });

  it('clears the window on reset but keeps cumulative diagnostics', () => {
    const sampler = new LatencySampler();
    const ping = sampler.createPing(0);
    sampler.onPong(ping.seq, ping.t, CONFIG.RTT_OUTLIER_MS + 1); // an outlier
    const second = sampler.createPing(2_000);
    sampler.onPong(second.seq, second.t, 2_020);

    sampler.reset();

    // Samples from a dead socket say nothing about a new one, so the window goes...
    expect(sampler.sampleCount).toBe(0);
    expect(sampler.report()).toBeNull();
    // ...but the counters are diagnostics, not inputs, so they survive.
    expect(sampler.stats().outliers).toBe(1);
  });
});
