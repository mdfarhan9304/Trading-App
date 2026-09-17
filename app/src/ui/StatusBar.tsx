import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ConnectionStatus } from '../net/WsClient';
import type { Interval, Tier, TierState } from '../protocol/types';
import { formatAge } from '../util/format';
import { theme } from './theme';

/**
 * Connection status, delivery tier, and interval selection.
 *
 * This row is where the assignment's "expose the active tier and effective update rate" and
 * "show cached values as stale while disconnected" requirements are actually satisfied.
 */

interface StatusProps {
  status: ConnectionStatus;
  detail: string | null;
  lastFrameAt: number | null;
  reconnectAttempts: number;
}

/**
 * Live/stale indicator.
 *
 * Two separate facts are shown deliberately: the socket's state, and how long since data last
 * arrived. They can disagree - a socket can report itself open while nothing flows - and the
 * age is the one that tells you whether what is on screen means anything.
 */
export const ConnectionBadge: React.FC<StatusProps> = ({
  status,
  detail,
  lastFrameAt,
  reconnectAttempts,
}) => {
  // A ticking clock so the age keeps counting up while disconnected. Only runs when NOT live,
  // so it costs nothing during normal operation - the point at which we least want spare work.
  const [, setTick] = useState(0);
  const isLive = status === 'live';

  useEffect(() => {
    if (isLive) return;
    const timer = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [isLive]);

  const { label, color } = describe(status, reconnectAttempts);
  const age = lastFrameAt === null ? null : Date.now() - lastFrameAt;

  return (
    <View style={styles.badgeRow}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.badgeLabel, { color }]}>{label}</Text>
      {!isLive && age !== null ? (
        <Text style={styles.stale}>STALE {formatAge(age)}</Text>
      ) : null}
      {!isLive && detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  );
};

function describe(status: ConnectionStatus, attempts: number): { label: string; color: string } {
  switch (status) {
    case 'live':
      return { label: 'LIVE', color: theme.color.live };
    case 'connecting':
      return { label: 'CONNECTING', color: theme.color.warn };
    case 'reconnecting':
      return { label: attempts > 1 ? `RECONNECTING (${attempts})` : 'RECONNECTING', color: theme.color.bad };
    case 'suspended':
      return { label: 'PAUSED', color: theme.color.neutral };
    case 'idle':
      return { label: 'OFFLINE', color: theme.color.neutral };
  }
}

/**
 * Delivery tier and rate.
 *
 * Shows the server's target rate next to the rate the app actually measured. Displaying both is
 * what makes the tier system verifiable instead of merely asserted: if they disagree, that is
 * visible on screen rather than hidden in a log.
 */
export const TierBadge: React.FC<{
  tier: TierState | null;
  measuredHz: number;
  onPress(): void;
}> = ({ tier, measuredHz, onPress }) => {
  const color = tier ? tierColor(tier.tier) : theme.color.neutral;

  return (
    <Pressable onPress={onPress} style={styles.tierBadge} hitSlop={8}>
      <Text style={[styles.tierName, { color }]}>{tier ? tier.tier.toUpperCase() : 'TIER --'}</Text>
      {/*
        Target next to measured. `measuredHz` is a 2-second rolling average, so immediately
        after a tier change it can briefly read above or below the new target while the window
        still holds frames delivered at the old rate. Labelling it as an average avoids that
        looking like a discrepancy.
      */}
      <Text style={styles.tierRate}>
        {tier ? `${tier.hz}/s target` : '--'}
        {'  '}
        <Text style={styles.tierMeasured}>{measuredHz.toFixed(1)}/s avg</Text>
      </Text>
      {tier?.override ? <Text style={styles.forced}>FORCED</Text> : null}
    </Pressable>
  );
};

export function tierColor(tier: Tier): string {
  switch (tier) {
    case 'full':
      return theme.color.up;
    case 'degraded':
      return theme.color.warn;
    case 'minimal':
      return theme.color.bad;
  }
}

/** Interval selector. The available set comes from the server's hello frame. */
export const IntervalSelector: React.FC<{
  intervals: readonly Interval[];
  active: Interval;
  onSelect(interval: Interval): void;
}> = ({ intervals, active, onSelect }) => (
  <View style={styles.intervals}>
    {intervals.map((interval) => {
      const selected = interval === active;
      return (
        <Pressable
          key={interval}
          onPress={() => onSelect(interval)}
          style={[styles.intervalChip, selected && styles.intervalChipActive]}
          hitSlop={4}
        >
          <Text style={[styles.intervalText, selected && styles.intervalTextActive]}>{interval}</Text>
        </Pressable>
      );
    })}
  </View>
);

/** Latency and jitter, the figures we report to the backend. */
export const LatencyBadge: React.FC<{
  latencyMs: number | null;
  jitterMs: number | null;
  score: number | null;
}> = ({ latencyMs, jitterMs, score }) => (
  <View style={styles.latency}>
    <Text style={styles.latencyText}>
      rtt <Text style={styles.latencyValue}>{latencyMs === null ? '--' : `${latencyMs}ms`}</Text>
    </Text>
    <Text style={styles.latencyText}>
      jit <Text style={styles.latencyValue}>{jitterMs === null ? '--' : `${jitterMs}ms`}</Text>
    </Text>
    <Text style={styles.latencyText}>
      score <Text style={styles.latencyValue}>{score === null ? '--' : Math.round(score)}</Text>
    </Text>
  </View>
);

const styles = StyleSheet.create({
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: theme.space(1.5),
  },
  badgeLabel: {
    fontSize: theme.font.size.xs,
    fontWeight: '700',
    letterSpacing: 1,
  },
  stale: {
    color: theme.color.warn,
    fontSize: theme.font.size.xs,
    fontWeight: '700',
    marginLeft: theme.space(2),
  },
  detail: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
    marginLeft: theme.space(2),
  },
  tierBadge: {
    alignItems: 'flex-end',
  },
  tierName: {
    fontSize: theme.font.size.xs,
    fontWeight: '700',
    letterSpacing: 1,
  },
  tierRate: {
    color: theme.color.textFaint,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
  },
  tierMeasured: {
    color: theme.color.textDim,
  },
  forced: {
    color: theme.color.accent,
    fontSize: theme.font.size.xs,
    fontWeight: '700',
  },
  intervals: {
    flexDirection: 'row',
  },
  intervalChip: {
    paddingHorizontal: theme.space(2.5),
    paddingVertical: theme.space(1),
    borderRadius: theme.radius.sm,
    marginRight: theme.space(1.5),
    backgroundColor: theme.color.surfaceAlt,
  },
  intervalChipActive: {
    backgroundColor: theme.color.accent,
  },
  intervalText: {
    color: theme.color.textDim,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm,
  },
  intervalTextActive: {
    color: '#0B0E11',
    fontWeight: '700',
  },
  latency: {
    flexDirection: 'row',
    gap: theme.space(3),
  },
  latencyText: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
  },
  latencyValue: {
    color: theme.color.textDim,
    fontFamily: theme.font.mono,
  },
});
