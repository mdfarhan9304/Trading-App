import React, { useCallback, useState } from 'react';
import { Pressable, StatusBar as RNStatusBar, StyleSheet, Text, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CONFIG } from '../../config';
import { activeCandle, lastPrice } from '../../domain/candles';
import { spread } from '../../domain/orderBook';
import { INTERVALS, type Interval, type Tier } from '../../protocol/types';
import { marketController } from '../../state/MarketController';
import { selectIsLive, useConnectionStore, useMarketStore, useTierStore } from '../../state/stores';
import { BackButton } from '../components/BackButton';
import { CandleChart } from '../components/CandleChart';
import { DebugSheet } from '../components/DebugSheet';
import { OrderBookPanel } from '../components/OrderBookPanel';
import { PriceHeader } from '../components/PriceHeader';
import { ConnectionBadge, IntervalSelector, LatencyBadge, TierBadge } from '../components/StatusBar';
import { theme } from '../theme';
import { TradesList } from '../components/TradesList';

interface Props {
  onBack(): void;
}

export const TradingScreen: React.FC<Props> = ({ onBack }) => {
  const [debugVisible, setDebugVisible] = useState(false);
  const [chartGesturing, setChartGesturing] = useState(false);

  // pick fields, not whole stores — otherwise every tick redraws the screen
  const symbol = useMarketStore((s) => s.symbol);
  const symbolInfo = useMarketStore((s) => s.symbolInfo);
  const interval = useMarketStore((s) => s.interval);
  const candles = useMarketStore((s) => s.candles);
  const book = useMarketStore((s) => s.book);
  const trades = useMarketStore((s) => s.trades);
  const sessionOpen = useMarketStore((s) => s.sessionOpen);

  const status = useConnectionStore((s) => s.status);
  const detail = useConnectionStore((s) => s.detail);
  const lastFrameAt = useConnectionStore((s) => s.lastFrameAt);
  const reconnectAttempts = useConnectionStore((s) => s.reconnectAttempts);
  const malformedFrames = useConnectionStore((s) => s.malformedFrames);
  const serverErrors = useConnectionStore((s) => s.serverErrors);
  const connId = useConnectionStore((s) => s.connId);
  const isLive = useConnectionStore(selectIsLive);

  const serverTier = useTierStore((s) => s.server);
  const measuredHz = useTierStore((s) => s.measuredHz);
  const chartUpdatesSent = useTierStore((s) => s.chartUpdatesSent);
  const latency = useTierStore((s) => s.latency);
  const injectedDelayMs = useTierStore((s) => s.injectedDelayMs);

  const price = lastPrice(candles);
  const current = activeCandle(candles);
  const spreadTicks = spread(book);

  const stale = !isLive;

  const handleInterval = useCallback((next: Interval) => {
    marketController.setInterval(next);
  }, []);

  const handleSetTier = useCallback((tier: Tier | 'auto') => {
    marketController.setTier(tier);
  }, []);

  const handleInjectDelay = useCallback((ms: number) => {
    marketController.injectDelay(ms);
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <RNStatusBar barStyle="light-content" />

      <View style={styles.topBar}>
        <View>
          <BackButton onPress={onBack} />
          <ConnectionBadge
            status={status}
            detail={detail}
            lastFrameAt={lastFrameAt}
            reconnectAttempts={reconnectAttempts}
          />
        </View>
        <TierBadge tier={serverTier} measuredHz={measuredHz} onPress={() => setDebugVisible(true)} />
      </View>

      <PriceHeader
        symbol={symbol}
        lastPrice={price}
        referencePrice={sessionOpen}
        symbolInfo={symbolInfo}
        spreadTicks={spreadTicks}
        stale={stale}
      />

      <View style={styles.controlRow}>
        <IntervalSelector intervals={INTERVALS} active={interval} onSelect={handleInterval} />
        <Pressable onPress={() => setDebugVisible(true)} hitSlop={8} style={styles.debugButton}>
          <Text style={styles.debugButtonText}>DEBUG</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
        scrollEnabled={!chartGesturing}
      >
        <View style={styles.chartCard}>
          <CandleChart
            window={candles}
            interval={interval}
            symbolInfo={symbolInfo}
            stale={stale}
            onViewportGesture={setChartGesturing}
          />
        </View>

        <View style={styles.metaRow}>
          <LatencyBadge
            latencyMs={latency?.latencyMs ?? null}
            jitterMs={latency?.jitterMs ?? null}
            score={serverTier?.score ?? null}
          />
          <Text style={styles.candleMeta}>
            {current ? `${candles.candles.length} candles` : 'no candles'}
          </Text>
        </View>

        <View style={styles.card}>
          <OrderBookPanel
            book={book}
            symbolInfo={symbolInfo}
            rows={CONFIG.BOOK_ROWS}
            stale={stale}
          />
        </View>

        <View style={styles.card}>
          <TradesList trades={trades} symbolInfo={symbolInfo} stale={stale} />
        </View>
      </ScrollView>

      <DebugSheet
        visible={debugVisible}
        onClose={() => setDebugVisible(false)}
        tier={serverTier}
        chartUpdatesSent={chartUpdatesSent}
        measuredHz={measuredHz}
        latency={latency}
        injectedDelayMs={injectedDelayMs}
        book={book}
        candles={candles}
        connId={connId}
        malformedFrames={malformedFrames}
        serverErrors={serverErrors}
        onSetTier={handleSetTier}
        onInjectDelay={handleInjectDelay}
        onForceResync={() => marketController.forceResync()}
        onForceDisconnect={() => marketController.forceDisconnect()}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.color.bg,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(2),
  },
  controlRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: theme.space(4),
    paddingBottom: theme.space(2),
  },
  debugButton: {
    paddingHorizontal: theme.space(2.5),
    paddingVertical: theme.space(1),
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
  },
  debugButtonText: {
    color: theme.color.textDim,
    fontSize: theme.font.size.xs,
    letterSpacing: 1,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingBottom: theme.space(6),
  },
  chartCard: {
    height: 280,
    marginHorizontal: theme.space(2),
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(2),
  },
  candleMeta: {
    color: theme.color.textFaint,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
  },
  card: {
    marginHorizontal: theme.space(2),
    marginBottom: theme.space(2),
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
  },
});
