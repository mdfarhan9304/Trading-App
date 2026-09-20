import type { Millis } from '../engine/types';

export type Tier = 'full' | 'degraded' | 'minimal';

export const TIERS: readonly Tier[] = ['full', 'degraded', 'minimal'];

export function isTier(value: unknown): value is Tier {
  return value === 'full' || value === 'degraded' || value === 'minimal';
}

export const TIER_INTERVAL_MS: Record<Tier, number> = {
  full: 100,
  degraded: 250,
  minimal: 1_000,
};

/** Human-facing update rate in hertz, derived so the two can never disagree. */
export const TIER_HZ: Record<Tier, number> = {
  full: 1_000 / TIER_INTERVAL_MS.full,
  degraded: 1_000 / TIER_INTERVAL_MS.degraded,
  minimal: 1_000 / TIER_INTERVAL_MS.minimal,
};

export const TIER_CONFIG = {
  /**
   * Score boundaries in milliseconds, applied when conditions are WORSENING.
   * score >= DEGRADED_AT leaves `full`; score >= MINIMAL_AT drops to `minimal`.
   */
  DEGRADED_AT: 150,
  MINIMAL_AT: 400,

  /**
   * Asymmetric band for IMPROVING conditions. A tier is only left upward once the
   * score falls to this fraction of the boundary that caused the demotion.
   *
   * 0.7 gives a 30% dead zone: having dropped to `degraded` at 150ms, a client must
   * reach 105ms to earn `full` back. Without it, a client sitting at 149-151ms would
   * satisfy the promote and demote conditions on alternating reports.
   */
  PROMOTE_FACTOR: 0.7,

  /**
   * Jitter weight in the score. Jitter is penalised twice as heavily as latency
   * because a link with unstable delivery times is worse for a live chart than one
   * that is uniformly slow: consistent 200ms delay looks like a smooth chart shifted
   * slightly in time, whereas 100ms +/- 100ms looks like stuttering.
   */
  JITTER_WEIGHT: 2,

  /**
   * Minimum time in a tier before any measurement-driven change is applied. Prevents
   * a change from being followed immediately by its own reversal.
   */
  DWELL_MS: 5_000,

  /**
   * Consecutive reports that must agree before a change is applied. With a 2s report
   * cadence this means a condition must persist about 6 seconds to move the tier, so a
   * single dropped packet or a one-off GC pause cannot cause a switch.
   */
  CONFIRM_REPORTS: 3,

  /** No report for this long: demote one step. */
  SILENCE_DEMOTE_MS: 6_000,

  /** No report for this long: force the floor. */
  SILENCE_MINIMAL_MS: 12_000,

  /**
   * Tier assigned to a brand-new or freshly reconnected connection.
   *
   * `degraded` rather than `full` on purpose. We know nothing about a new client's link
   * yet, and the failure modes are asymmetric: starting optimistically and being wrong
   * means flooding a link that cannot cope, right at the moment the client is also
   * fetching REST snapshots. Starting conservatively and being wrong costs one
   * promotion cycle of slightly-less-smooth chart.
   */
  INITIAL: 'degraded' as Tier,
} as const;

/** One latency/jitter measurement reported by a client. */
export interface NetReport {
  latencyMs: number;
  jitterMs: number;
  /** How many RTT samples the client's window held. Used only for diagnostics. */
  samples?: number;
}

/** Why the tier last changed. Surfaced to the client and used in tests. */
export type TierReason =
  | 'initial'
  | 'measurement'
  | 'silence-demote'
  | 'silence-minimal'
  | 'override-set'
  | 'override-cleared';

export interface TierState {
  /** The tier actually in force, i.e. the override if one is set. */
  tier: Tier;
  /** The tier the automatic machine has decided on, regardless of any override. */
  autoTier: Tier;
  /** The forced tier, or null when running automatically. */
  override: Tier | null;
  /** Delivery interval implied by `tier`. */
  intervalMs: number;
  /** Delivery rate implied by `tier`, in hertz. */
  hz: number;
  reason: TierReason;
  latencyMs: number | null;
  jitterMs: number | null;
  score: number | null;
  /** Timestamp of the last accepted report, or null if none yet. */
  lastReportAt: Millis | null;
}

// clock is passed in so tests don't need fake timers
export class TierMachine {
  private auto: Tier;
  private forced: Tier | null = null;
  private reasonValue: TierReason = 'initial';

  private latency: number | null = null;
  private jitter: number | null = null;
  private scoreValue: number | null = null;

  private lastReport: Millis | null = null;
  private lastChangeAt: Millis;

  /** Tier the confirmation counter is currently accumulating toward, if any. */
  private pendingTier: Tier | null = null;
  private pendingCount = 0;

  /** True once a silence demotion has been applied, so it happens only once. */
  private silenceDemoted = false;

  constructor(createdAt: Millis, initial: Tier = TIER_CONFIG.INITIAL) {
    this.auto = initial;
    this.lastChangeAt = createdAt;
  }

  /** The tier in force: the override when set, otherwise the automatic decision. */
  get tier(): Tier {
    return this.forced ?? this.auto;
  }

  get intervalMs(): number {
    return TIER_INTERVAL_MS[this.tier];
  }

  get override(): Tier | null {
    return this.forced;
  }

  /** Combine latency and jitter into the single number the bands are applied to. */
  static score(latencyMs: number, jitterMs: number): number {
    return latencyMs + TIER_CONFIG.JITTER_WEIGHT * jitterMs;
  }

  /**
   * The tier the given score implies, starting from `current`.
   *
   * Exported as a static so tests can probe the band logic in isolation from the
   * confirmation and dwell machinery.
   */
  static desiredTier(score: number, current: Tier): Tier {
    const { DEGRADED_AT, MINIMAL_AT, PROMOTE_FACTOR } = TIER_CONFIG;

    // Worsening conditions apply immediately and may skip a step.
    if (score >= MINIMAL_AT) return 'minimal';

    switch (current) {
      case 'full':
        return score >= DEGRADED_AT ? 'degraded' : 'full';

      case 'degraded':
        // Promote only once well clear of the boundary we fell through.
        return score < DEGRADED_AT * PROMOTE_FACTOR ? 'full' : 'degraded';

      case 'minimal':
        // One step at a time, so a brief good patch cannot jump straight to `full`.
        return score < MINIMAL_AT * PROMOTE_FACTOR ? 'degraded' : 'minimal';
    }
  }

  /**
   * Feed in a client measurement. Returns true if the tier in force changed.
   *
   * Note that reports are always processed even while an override is active: the
   * automatic decision keeps tracking reality underneath, so clearing the override
   * resumes from current conditions instead of from a stale decision made minutes ago.
   */
  report(report: NetReport, now: Millis): boolean {
    // Reject nonsense rather than letting it poison the score. A negative latency or a
    // NaN can only come from a client bug or a tampered message.
    if (!Number.isFinite(report.latencyMs) || !Number.isFinite(report.jitterMs)) return false;
    if (report.latencyMs < 0 || report.jitterMs < 0) return false;

    this.lastReport = now;
    this.silenceDemoted = false;
    this.latency = report.latencyMs;
    this.jitter = report.jitterMs;
    this.scoreValue = TierMachine.score(report.latencyMs, report.jitterMs);

    const desired = TierMachine.desiredTier(this.scoreValue, this.auto);

    if (desired === this.auto) {
      // Conditions agree with where we are, so abandon any accumulating change.
      this.pendingTier = null;
      this.pendingCount = 0;
      return false;
    }

    // Accumulate confirmations toward this specific target. A report pointing at a
    // different target restarts the count rather than adding to it.
    if (this.pendingTier === desired) {
      this.pendingCount += 1;
    } else {
      this.pendingTier = desired;
      this.pendingCount = 1;
    }

    if (this.pendingCount < TIER_CONFIG.CONFIRM_REPORTS) return false;

    // Confirmed. Dwell may still hold it back; if so we keep the confirmation so the
    // change applies on the next report after dwell expires, rather than restarting.
    if (now - this.lastChangeAt < TIER_CONFIG.DWELL_MS) return false;

    return this.applyAuto(desired, 'measurement', now);
  }

  /**
   * Handle the absence of reports. The session calls this on a timer.
   *
   * A client that stops reporting has either lost its connection, been backgrounded, or
   * is too overloaded to run its own measurement loop. All three mean we should stop
   * assuming its link is healthy. Dwell is deliberately NOT honoured here: safety
   * outranks stability when we have no information at all.
   */
  checkSilence(now: Millis): boolean {
    if (this.lastReport === null) {
      // No report has ever arrived. Measure silence from construction so a client that
      // connects and never reports still degrades.
      const silence = now - this.lastChangeAt;
      if (silence >= TIER_CONFIG.SILENCE_MINIMAL_MS && this.auto !== 'minimal') {
        return this.applyAuto('minimal', 'silence-minimal', now);
      }
      return false;
    }

    const silence = now - this.lastReport;

    if (silence >= TIER_CONFIG.SILENCE_MINIMAL_MS) {
      // Already at the floor: return early rather than re-applying, which would keep
      // pushing `lastChangeAt` forward on every check and delay the eventual recovery.
      if (this.auto === 'minimal') return false;
      return this.applyAuto('minimal', 'silence-minimal', now);
    }

    if (silence >= TIER_CONFIG.SILENCE_DEMOTE_MS && !this.silenceDemoted) {
      this.silenceDemoted = true;
      return this.applyAuto(TierMachine.oneStepDown(this.auto), 'silence-demote', now);
    }

    return false;
  }

  /** Force a tier, or pass null to resume automatic control. */
  setOverride(tier: Tier | null, now: Millis): boolean {
    const before = this.tier;
    this.forced = tier;
    this.reasonValue = tier === null ? 'override-cleared' : 'override-set';

    if (tier === null) {
      // Give the automatic machine a clean dwell window so it does not immediately act
      // on confirmations accumulated while the override was masking its output.
      this.lastChangeAt = now;
      this.pendingTier = null;
      this.pendingCount = 0;
    }

    return this.tier !== before;
  }

  private applyAuto(tier: Tier, reason: TierReason, now: Millis): boolean {
    const before = this.tier;
    this.auto = tier;
    this.reasonValue = reason;
    this.lastChangeAt = now;
    this.pendingTier = null;
    this.pendingCount = 0;
    // The tier in force only changed if no override is masking the automatic value.
    return this.tier !== before;
  }

  private static oneStepDown(tier: Tier): Tier {
    if (tier === 'full') return 'degraded';
    return 'minimal';
  }

  /** A serialisable view for the client's tier panel and for tests. */
  snapshot(): TierState {
    const tier = this.tier;
    return {
      tier,
      autoTier: this.auto,
      override: this.forced,
      intervalMs: TIER_INTERVAL_MS[tier],
      hz: TIER_HZ[tier],
      reason: this.reasonValue,
      latencyMs: this.latency,
      jitterMs: this.jitter,
      score: this.scoreValue,
      lastReportAt: this.lastReport,
    };
  }
}
