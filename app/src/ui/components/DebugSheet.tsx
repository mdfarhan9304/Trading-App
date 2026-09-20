import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BookState } from '../../domain/orderBook';
import type { CandleWindow } from '../../domain/candles';
import type { LatencyStats } from '../../net/latency';
import type { Tier, TierState } from '../../protocol/types';
import { theme } from '../theme';
import { tierColor } from './StatusBar';

interface Props {
  visible: boolean;
  onClose(): void;

  tier: TierState | null;
  chartUpdatesSent: number;
  measuredHz: number;
  latency: LatencyStats | null;
  injectedDelayMs: number;

  book: BookState;
  candles: CandleWindow;
  connId: string | null;
  malformedFrames: number;
  serverErrors: { code: string; message: string; at: number }[];

  onSetTier(tier: Tier | 'auto'): void;
  onInjectDelay(ms: number): void;
  onForceResync(): void;
  onForceDisconnect(): void;
}

const TIER_OPTIONS: (Tier | 'auto')[] = ['auto', 'full', 'degraded', 'minimal'];
const DELAY_OPTIONS = [0, 120, 300, 600];

export const DebugSheet: React.FC<Props> = ({
  visible,
  onClose,
  tier,
  chartUpdatesSent,
  measuredHz,
  latency,
  injectedDelayMs,
  book,
  candles,
  connId,
  malformedFrames,
  serverErrors,
  onSetTier,
  onInjectDelay,
  onForceResync,
  onForceDisconnect,
}) => (
  <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <View style={styles.sheet}>
        <View style={styles.handleRow}>
          <Text style={styles.sheetTitle}>DEBUG</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>Close</Text>
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          <Section title="Delivery tier (override)">
            <Text style={styles.help}>
              Forces the tier immediately. AUTO returns control to the server&apos;s state machine,
              which has been tracking your connection the whole time.
            </Text>
            <View style={styles.chipRow}>
              {TIER_OPTIONS.map((option) => {
                const active =
                  option === 'auto' ? tier?.override === null : tier?.override === option;
                return (
                  <Pressable
                    key={option}
                    onPress={() => onSetTier(option)}
                    style={[
                      styles.chip,
                      active && { backgroundColor: option === 'auto' ? theme.color.accent : tierColor(option) },
                    ]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {option.toUpperCase()}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Section>

          <Section title="Inject pong delay (drives AUTOMATIC tiering)">
            <Text style={styles.help}>
              Delays the server&apos;s pong replies, so measured RTT actually rises and the
              automatic machine transitions through hysteresis. Expect ~6s to demote and ~12s to
              climb back, because promotion moves one tier at a time.
            </Text>
            <View style={styles.chipRow}>
              {DELAY_OPTIONS.map((ms) => (
                <Pressable
                  key={ms}
                  onPress={() => onInjectDelay(ms)}
                  style={[styles.chip, injectedDelayMs === ms && styles.chipActive]}
                >
                  <Text style={[styles.chipText, injectedDelayMs === ms && styles.chipTextActive]}>
                    {ms === 0 ? 'OFF' : `+${ms}ms`}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Section>

          <Section title="Recovery">
            <View style={styles.chipRow}>
              <Pressable onPress={onForceResync} style={[styles.chip, styles.actionChip]}>
                <Text style={styles.chipText}>Force book resync</Text>
              </Pressable>
              <Pressable onPress={onForceDisconnect} style={[styles.chip, styles.actionChip]}>
                <Text style={styles.chipText}>Drop connection (3s)</Text>
              </Pressable>
            </View>
          </Section>

          <Section title="Tier state (server-owned)">
            <Row label="Active tier" value={tier?.tier ?? '--'} />
            <Row label="Automatic decision" value={tier?.autoTier ?? '--'} />
            <Row label="Override" value={tier?.override ?? 'none'} />
            <Row label="Last change reason" value={tier?.reason ?? '--'} />
            <Row label="Target rate" value={tier ? `${tier.hz}/s (${tier.intervalMs}ms)` : '--'} />
            <Row label="Measured rate" value={`${measuredHz.toFixed(1)}/s`} />
            <Row label="Chart frames sent" value={String(chartUpdatesSent)} />
            <Row label="Score (lat + 2xjit)" value={tier?.score === null || tier === null ? '--' : String(Math.round(tier.score))} />
          </Section>

          <Section title="Latency measurement (app-owned)">
            <Row label="Median RTT" value={latency ? `${latency.latencyMs}ms` : '--'} />
            <Row label="Jitter (mean |diff|)" value={latency ? `${latency.jitterMs}ms` : '--'} />
            <Row label="Last raw RTT" value={latency?.lastRttMs === null || !latency ? '--' : `${latency.lastRttMs}ms`} />
            <Row label="Samples in window" value={latency ? String(latency.samples) : '0'} />
            <Row label="Outliers discarded" value={latency ? String(latency.outliers) : '0'} />
            <Row label="Pings lost" value={latency ? String(latency.lost) : '0'} />
          </Section>

          <Section title="Order book sync">
            <Row label="Status" value={book.status} />
            <Row label="Last update id" value={String(book.lastUpdateId)} />
            <Row label="Buffered deltas" value={String(book.buffer.length)} />
            <Row label="Deltas applied" value={String(book.stats.deltasApplied)} />
            <Row label="Deltas ignored" value={String(book.stats.deltasIgnored)} />
            <Row label="Gaps detected" value={String(book.stats.gapCount)} />
            <Row label="Resyncs" value={String(book.stats.resyncCount)} />
            <Row label="Last resync reason" value={book.resyncReason ?? 'none'} />
          </Section>

          <Section title="Candles">
            <Row label="Interval" value={candles.interval} />
            <Row label="In window" value={String(candles.candles.length)} />
            <Row label="Rejected (wrong interval)" value={String(candles.rejectedWrongInterval)} />
            <Row label="Rejected (too old)" value={String(candles.rejectedTooOld)} />
          </Section>

          <Section title="Connection">
            <Row label="Connection id" value={connId ?? '--'} />
            <Row label="Malformed frames" value={String(malformedFrames)} />
            {serverErrors.length === 0 ? (
              <Row label="Server errors" value="none" />
            ) : (
              serverErrors.slice(0, 4).map((error, index) => (
                <Row key={index} label={error.code} value={error.message} />
              ))
            )}
          </Section>

          <View style={{ height: theme.space(8) }} />
        </ScrollView>
      </View>
    </View>
  </Modal>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    {children}
  </View>
);

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={styles.row}>
    <Text style={styles.rowLabel}>{label}</Text>
    <Text style={styles.rowValue} numberOfLines={1}>
      {value}
    </Text>
  </View>
);

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '88%',
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(3),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
  },
  handleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.space(2),
  },
  sheetTitle: {
    color: theme.color.text,
    fontSize: theme.font.size.md,
    fontWeight: '700',
    letterSpacing: 2,
  },
  close: {
    color: theme.color.accent,
    fontSize: theme.font.size.md,
  },
  section: {
    marginBottom: theme.space(4),
  },
  sectionTitle: {
    color: theme.color.textDim,
    fontSize: theme.font.size.xs,
    letterSpacing: 1,
    marginBottom: theme.space(1.5),
    textTransform: 'uppercase',
  },
  help: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
    lineHeight: 15,
    marginBottom: theme.space(2),
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space(2),
  },
  chip: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(1.5),
    borderRadius: theme.radius.sm,
    backgroundColor: theme.color.surfaceAlt,
  },
  chipActive: {
    backgroundColor: theme.color.accent,
  },
  actionChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
  },
  chipText: {
    color: theme.color.textDim,
    fontSize: theme.font.size.sm,
    fontWeight: '600',
  },
  chipTextActive: {
    color: '#0B0E11',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: theme.space(0.75),
  },
  rowLabel: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
    flex: 1,
  },
  rowValue: {
    color: theme.color.text,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
    flex: 1,
    textAlign: 'right',
  },
});
