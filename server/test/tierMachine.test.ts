import { TIER_CONFIG, TIER_INTERVAL_MS, TierMachine, type Tier } from '../src/tier/tierMachine';

/**
 * Tests for the adaptive delivery state machine.
 *
 * The machine takes `now` as an argument rather than reading the clock, so all of this
 * runs instantly with no fake timers and no sleeping. Every timestamp below is explicit,
 * which also makes the intent of each test readable.
 */

/** Report cadence the app uses, mirrored here so the timing maths matches production. */
const REPORT_EVERY = 2_000;

/** Build a report with a given score, expressed entirely as latency for clarity. */
function reportWithScore(score: number) {
  return { latencyMs: score, jitterMs: 0, samples: 10 };
}

/**
 * Feed `count` reports of the same score at the production cadence, starting at
 * `startAt`. Returns the timestamp of the last report.
 */
function feed(machine: TierMachine, score: number, count: number, startAt: number): number {
  let t = startAt;
  for (let i = 0; i < count; i++) {
    t += REPORT_EVERY;
    machine.report(reportWithScore(score), t);
  }
  return t;
}

describe('TierMachine: scoring', () => {
  it('weights jitter twice as heavily as latency', () => {
    expect(TierMachine.score(100, 0)).toBe(100);
    expect(TierMachine.score(100, 25)).toBe(150);
    expect(TierMachine.score(0, 50)).toBe(100);
  });

  it('treats a jittery link as worse than a uniformly slow one with equal mean', () => {
    const slowButStable = TierMachine.score(140, 5);
    const fasterButJittery = TierMachine.score(100, 40);
    expect(fasterButJittery).toBeGreaterThan(slowButStable);
  });
});

describe('TierMachine: band logic', () => {
  it('demotes out of full once the score reaches the degraded boundary', () => {
    expect(TierMachine.desiredTier(TIER_CONFIG.DEGRADED_AT - 1, 'full')).toBe('full');
    expect(TierMachine.desiredTier(TIER_CONFIG.DEGRADED_AT, 'full')).toBe('degraded');
  });

  it('allows demotion to skip a step when the score is very bad', () => {
    expect(TierMachine.desiredTier(TIER_CONFIG.MINIMAL_AT, 'full')).toBe('minimal');
  });

  it('requires the score to clear the asymmetric promote band before upgrading', () => {
    const boundary = TIER_CONFIG.DEGRADED_AT; // 150
    const promoteAt = boundary * TIER_CONFIG.PROMOTE_FACTOR; // 105

    // Below the demote boundary but still inside the dead zone: stay put.
    expect(TierMachine.desiredTier(boundary - 10, 'degraded')).toBe('degraded');
    expect(TierMachine.desiredTier(promoteAt, 'degraded')).toBe('degraded');
    // Clear of the dead zone: promote.
    expect(TierMachine.desiredTier(promoteAt - 1, 'degraded')).toBe('full');
  });

  it('promotes only one step at a time, even when conditions are excellent', () => {
    // A score of 1ms is as good as it gets, yet minimal must go via degraded.
    expect(TierMachine.desiredTier(1, 'minimal')).toBe('degraded');
    expect(TierMachine.desiredTier(1, 'degraded')).toBe('full');
  });
});

describe('TierMachine: initial state', () => {
  it('starts at the conservative default rather than assuming a good link', () => {
    const machine = new TierMachine(0);
    expect(machine.tier).toBe('degraded');
    expect(TIER_CONFIG.INITIAL).toBe('degraded');
    expect(machine.snapshot().reason).toBe('initial');
    expect(machine.snapshot().latencyMs).toBeNull();
  });

  it('reports the delivery interval implied by its tier', () => {
    const machine = new TierMachine(0, 'full');
    expect(machine.intervalMs).toBe(TIER_INTERVAL_MS.full);
    expect(machine.snapshot().hz).toBe(10);
  });
});

describe('TierMachine: confirmation count', () => {
  it('does not change tier before the confirmation threshold is met', () => {
    const machine = new TierMachine(0, 'degraded');

    // Two good reports are not enough, even though dwell has expired.
    feed(machine, 50, TIER_CONFIG.CONFIRM_REPORTS - 1, 10_000);
    expect(machine.tier).toBe('degraded');
  });

  it('changes tier once enough consecutive reports agree', () => {
    const machine = new TierMachine(0, 'degraded');
    feed(machine, 50, TIER_CONFIG.CONFIRM_REPORTS, 10_000);
    expect(machine.tier).toBe('full');
    expect(machine.snapshot().reason).toBe('measurement');
  });

  it('restarts the count when a report disagrees with the pending target', () => {
    const machine = new TierMachine(0, 'degraded');

    // Two good reports build toward `full`...
    let t = feed(machine, 50, 2, 10_000);
    // ...then one report that agrees with the current tier wipes the progress.
    t = feed(machine, 200, 1, t);
    expect(machine.tier).toBe('degraded');

    // One more good report is now only the first confirmation, not the third.
    t = feed(machine, 50, 1, t);
    expect(machine.tier).toBe('degraded');

    // Two further good reports complete a fresh run of three.
    feed(machine, 50, 2, t);
    expect(machine.tier).toBe('full');
  });
});

describe('TierMachine: hysteresis under flapping', () => {
  it('holds its tier when the score oscillates across a boundary', () => {
    const machine = new TierMachine(0, 'full');
    const boundary = TIER_CONFIG.DEGRADED_AT;

    // Alternate either side of the demote boundary for a full minute.
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += REPORT_EVERY;
      machine.report(reportWithScore(i % 2 === 0 ? boundary + 1 : boundary - 1), t);
    }

    // Every "bad" report is immediately contradicted, so the confirmation counter never
    // reaches three and the tier never moves.
    expect(machine.tier).toBe('full');
  });

  it('holds its tier when the score sits exactly in the dead zone', () => {
    const machine = new TierMachine(0, 'degraded');

    // 120 is below the 150 demote boundary but above the 105 promote line: a score that
    // a naive single-threshold implementation would flip on every report.
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += REPORT_EVERY;
      machine.report(reportWithScore(120), t);
    }

    expect(machine.tier).toBe('degraded');
  });

  it('still reacts to a sustained change rather than being permanently frozen', () => {
    const machine = new TierMachine(0, 'full');

    // Flap first, proving no change...
    let t = 0;
    for (let i = 0; i < 10; i++) {
      t += REPORT_EVERY;
      machine.report(reportWithScore(i % 2 === 0 ? 151 : 149), t);
    }
    expect(machine.tier).toBe('full');

    // ...then a genuine, sustained degradation does move it.
    feed(machine, 200, TIER_CONFIG.CONFIRM_REPORTS, t);
    expect(machine.tier).toBe('degraded');
  });
});

describe('TierMachine: dwell time', () => {
  it('withholds a confirmed change until the dwell window has passed', () => {
    // Created at t=100_000, so dwell runs until t=105_000.
    const created = 100_000;
    const machine = new TierMachine(created, 'degraded');

    // Three agreeing reports, all inside the dwell window.
    machine.report(reportWithScore(50), created + 500);
    machine.report(reportWithScore(50), created + 1_000);
    machine.report(reportWithScore(50), created + 1_500);

    expect(machine.tier).toBe('degraded');
    expect(created + 1_500 - created).toBeLessThan(TIER_CONFIG.DWELL_MS);
  });

  it('applies the change on the next report once dwell expires, without restarting', () => {
    const created = 100_000;
    const machine = new TierMachine(created, 'degraded');

    machine.report(reportWithScore(50), created + 500);
    machine.report(reportWithScore(50), created + 1_000);
    machine.report(reportWithScore(50), created + 1_500);
    expect(machine.tier).toBe('degraded');

    // A single further report after dwell is enough, because the confirmation was
    // retained rather than discarded.
    machine.report(reportWithScore(50), created + TIER_CONFIG.DWELL_MS + 1);
    expect(machine.tier).toBe('full');
  });

  it('enforces dwell between two successive changes', () => {
    const machine = new TierMachine(0, 'degraded');

    const promotedAt = feed(machine, 50, TIER_CONFIG.CONFIRM_REPORTS, 10_000);
    expect(machine.tier).toBe('full');

    // Immediately hammer it with bad reports, but keep every one inside the new dwell.
    let t = promotedAt;
    for (let i = 0; i < TIER_CONFIG.CONFIRM_REPORTS; i++) {
      t += 100;
      machine.report(reportWithScore(500), t);
    }
    expect(machine.tier).toBe('full');

    // Past dwell, the pending demotion lands.
    machine.report(reportWithScore(500), promotedAt + TIER_CONFIG.DWELL_MS + 1);
    expect(machine.tier).toBe('minimal');
  });
});

describe('TierMachine: missing reports', () => {
  it('demotes one step after the silence threshold', () => {
    const machine = new TierMachine(0, 'full');
    machine.report(reportWithScore(50), 1_000);

    // Just before the threshold: nothing happens.
    expect(machine.checkSilence(1_000 + TIER_CONFIG.SILENCE_DEMOTE_MS - 1)).toBe(false);
    expect(machine.tier).toBe('full');

    // At the threshold: one step down.
    expect(machine.checkSilence(1_000 + TIER_CONFIG.SILENCE_DEMOTE_MS)).toBe(true);
    expect(machine.tier).toBe('degraded');
    expect(machine.snapshot().reason).toBe('silence-demote');
  });

  it('demotes only once per silent episode rather than on every check', () => {
    const machine = new TierMachine(0, 'full');
    machine.report(reportWithScore(50), 1_000);

    machine.checkSilence(1_000 + TIER_CONFIG.SILENCE_DEMOTE_MS);
    expect(machine.tier).toBe('degraded');

    // Repeated checks in the same episode must not walk it further down.
    for (let t = TIER_CONFIG.SILENCE_DEMOTE_MS + 100; t < TIER_CONFIG.SILENCE_MINIMAL_MS; t += 100) {
      machine.checkSilence(1_000 + t);
    }
    expect(machine.tier).toBe('degraded');
  });

  it('forces the floor after prolonged silence', () => {
    const machine = new TierMachine(0, 'full');
    machine.report(reportWithScore(50), 1_000);

    machine.checkSilence(1_000 + TIER_CONFIG.SILENCE_DEMOTE_MS);
    expect(machine.tier).toBe('degraded');

    expect(machine.checkSilence(1_000 + TIER_CONFIG.SILENCE_MINIMAL_MS)).toBe(true);
    expect(machine.tier).toBe('minimal');
    expect(machine.snapshot().reason).toBe('silence-minimal');
  });

  it('stops reporting a change once already at the floor', () => {
    const machine = new TierMachine(0, 'full');
    machine.report(reportWithScore(50), 1_000);
    machine.checkSilence(1_000 + TIER_CONFIG.SILENCE_MINIMAL_MS);
    expect(machine.tier).toBe('minimal');

    // Idempotent from here on.
    expect(machine.checkSilence(1_000 + TIER_CONFIG.SILENCE_MINIMAL_MS + 5_000)).toBe(false);
    expect(machine.tier).toBe('minimal');
  });

  it('degrades a client that connects and never reports at all', () => {
    const machine = new TierMachine(0, 'full');
    expect(machine.checkSilence(TIER_CONFIG.SILENCE_MINIMAL_MS)).toBe(true);
    expect(machine.tier).toBe('minimal');
  });

  it('recovers when reports resume after a silent episode', () => {
    const machine = new TierMachine(0, 'full');
    machine.report(reportWithScore(50), 1_000);
    machine.checkSilence(1_000 + TIER_CONFIG.SILENCE_MINIMAL_MS);
    expect(machine.tier).toBe('minimal');

    // Reports come back and the link is genuinely good again. Promotion is one step at
    // a time, so this takes two confirmed runs.
    const resumeAt = 1_000 + TIER_CONFIG.SILENCE_MINIMAL_MS;
    let t = feed(machine, 30, TIER_CONFIG.CONFIRM_REPORTS, resumeAt);
    expect(machine.tier).toBe('degraded');

    t = feed(machine, 30, TIER_CONFIG.CONFIRM_REPORTS, t);
    expect(machine.tier).toBe('full');
  });

  it('re-arms the silence demotion after reports resume and stop again', () => {
    const machine = new TierMachine(0, 'full');
    machine.report(reportWithScore(50), 1_000);

    machine.checkSilence(1_000 + TIER_CONFIG.SILENCE_DEMOTE_MS);
    expect(machine.tier).toBe('degraded');

    // A report arrives, clearing the episode.
    machine.report(reportWithScore(50), 20_000);
    // Silence again: the one-shot demotion must be available once more.
    expect(machine.checkSilence(20_000 + TIER_CONFIG.SILENCE_DEMOTE_MS)).toBe(true);
    expect(machine.tier).toBe('minimal');
  });
});

describe('TierMachine: debug override', () => {
  it('forces the tier in force regardless of measurements', () => {
    const machine = new TierMachine(0, 'full');
    expect(machine.setOverride('minimal', 1_000)).toBe(true);
    expect(machine.tier).toBe('minimal');
    expect(machine.override).toBe('minimal');
    expect(machine.snapshot().reason).toBe('override-set');

    // Excellent reports cannot lift it while forced.
    feed(machine, 10, 10, 2_000);
    expect(machine.tier).toBe('minimal');
  });

  it('keeps the automatic decision tracking reality underneath the override', () => {
    const machine = new TierMachine(0, 'full');
    machine.setOverride('minimal', 1_000);

    // A sustained bad link while the override is pinning us to `minimal`.
    feed(machine, 500, TIER_CONFIG.CONFIRM_REPORTS + 2, 10_000);

    const snapshot = machine.snapshot();
    expect(snapshot.tier).toBe('minimal'); // forced
    expect(snapshot.autoTier).toBe('minimal'); // and genuinely earned
    expect(snapshot.override).toBe('minimal');
  });

  it('resumes automatic control from current conditions when cleared', () => {
    const machine = new TierMachine(0, 'full');

    // Force minimal, but the link is actually excellent throughout.
    machine.setOverride('minimal', 1_000);
    const lastReport = feed(machine, 20, TIER_CONFIG.CONFIRM_REPORTS, 2_000);

    // Underneath, the machine has been promoting itself normally.
    expect(machine.snapshot().autoTier).toBe('full');
    expect(machine.tier).toBe('minimal');

    // Clearing the override immediately exposes that automatic decision.
    expect(machine.setOverride(null, lastReport)).toBe(true);
    expect(machine.tier).toBe('full');
    expect(machine.override).toBeNull();
    expect(machine.snapshot().reason).toBe('override-cleared');
  });

  it('is not stuck after the override is cleared', () => {
    const machine = new TierMachine(0, 'full');
    machine.setOverride('full', 1_000);
    machine.setOverride(null, 2_000);

    // The automatic machine must still respond to a sustained degradation. Reports start
    // after the fresh dwell window that clearing the override established.
    feed(machine, 500, TIER_CONFIG.CONFIRM_REPORTS, 2_000 + TIER_CONFIG.DWELL_MS);
    expect(machine.tier).toBe('minimal');
  });

  it('reports no change when the override matches the tier already in force', () => {
    const machine = new TierMachine(0, 'full');
    expect(machine.setOverride('full', 1_000)).toBe(false);
    expect(machine.tier).toBe('full');
  });
});

describe('TierMachine: malformed reports', () => {
  const invalid = [
    { name: 'NaN latency', report: { latencyMs: Number.NaN, jitterMs: 0 } },
    { name: 'NaN jitter', report: { latencyMs: 50, jitterMs: Number.NaN } },
    { name: 'infinite latency', report: { latencyMs: Number.POSITIVE_INFINITY, jitterMs: 0 } },
    { name: 'negative latency', report: { latencyMs: -10, jitterMs: 0 } },
    { name: 'negative jitter', report: { latencyMs: 50, jitterMs: -1 } },
  ];

  it.each(invalid)('rejects $name without disturbing state', ({ report }) => {
    const machine = new TierMachine(0, 'full');
    machine.report(reportWithScore(50), 1_000);
    const before = machine.snapshot();

    expect(machine.report(report, 2_000)).toBe(false);

    const after = machine.snapshot();
    expect(after.tier).toBe(before.tier);
    expect(after.score).toBe(before.score);
    // A rejected report must not count as a sign of life, or a client sending garbage
    // would keep a dead connection pinned at a fast tier forever.
    expect(after.lastReportAt).toBe(before.lastReportAt);
  });

  it('does not let rejected reports prevent silence demotion', () => {
    const machine = new TierMachine(0, 'full');
    machine.report(reportWithScore(50), 1_000);

    // A client spamming invalid reports is indistinguishable from a silent one.
    for (let t = 1_500; t < 1_000 + TIER_CONFIG.SILENCE_DEMOTE_MS; t += 500) {
      machine.report({ latencyMs: Number.NaN, jitterMs: 0 }, t);
    }

    expect(machine.checkSilence(1_000 + TIER_CONFIG.SILENCE_DEMOTE_MS)).toBe(true);
    expect(machine.tier).toBe('degraded');
  });
});

describe('TierMachine: per-connection independence', () => {
  it('keeps two connections on entirely separate tiers', () => {
    const good = new TierMachine(0, 'degraded');
    const bad = new TierMachine(0, 'degraded');

    let t = 10_000;
    for (let i = 0; i < TIER_CONFIG.CONFIRM_REPORTS; i++) {
      t += REPORT_EVERY;
      good.report(reportWithScore(20), t);
      bad.report(reportWithScore(600), t);
    }

    expect(good.tier).toBe('full');
    expect(bad.tier).toBe('minimal');

    // And an override on one must not leak to the other.
    good.setOverride('minimal', t);
    expect(good.tier).toBe('minimal');
    expect(bad.tier).toBe('minimal');
    bad.setOverride('full', t);
    expect(bad.tier).toBe('full');
    expect(good.tier).toBe('minimal');
  });

  it('gives every tier a distinct delivery interval', () => {
    const seen = new Set<number>();
    for (const tier of ['full', 'degraded', 'minimal'] as Tier[]) {
      seen.add(TIER_INTERVAL_MS[tier]);
    }
    expect(seen.size).toBe(3);
    expect(TIER_INTERVAL_MS.full).toBeLessThan(TIER_INTERVAL_MS.degraded);
    expect(TIER_INTERVAL_MS.degraded).toBeLessThan(TIER_INTERVAL_MS.minimal);
  });
});
