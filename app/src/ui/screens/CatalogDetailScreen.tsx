import React, { useMemo } from 'react';
import { Pressable, ScrollView, StatusBar as RNStatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CONFIG } from '../../config';
import { createCandleWindow } from '../../domain/candles';
import { createBookState } from '../../domain/orderBook';
import { LIVE_SYMBOL, coinFromSymbol } from '../../domain/watchlist';
import { INTERVALS } from '../../protocol/types';
import { useConnectionStore, useSessionStore } from '../../state/stores';
import { DEFAULT_SYMBOL_INFO } from '../../util/format';
import { BackButton } from '../components/BackButton';
import { CandleChart } from '../components/CandleChart';
import { OrderBookPanel } from '../components/OrderBookPanel';
import { PriceHeader } from '../components/PriceHeader';
import { ConnectionBadge, IntervalSelector, LatencyBadge } from '../components/StatusBar';
import { TradesList } from '../components/TradesList';
import { theme } from '../theme';

const EMPTY_WINDOW = createCandleWindow('1s');
const EMPTY_BOOK = { ...createBookState(), status: 'synced' as const };

interface Props {
  symbol: string;
}

export const CatalogDetailScreen: React.FC<Props> = ({ symbol }) => {
  const coin = coinFromSymbol(symbol);
  const goWatchlist = useSessionStore((s) => s.goWatchlist);
  const openDetail = useSessionStore((s) => s.openDetail);

  const status = useConnectionStore((s) => s.status);
  const detail = useConnectionStore((s) => s.detail);
  const lastFrameAt = useConnectionStore((s) => s.lastFrameAt);
  const reconnectAttempts = useConnectionStore((s) => s.reconnectAttempts);

  const symbolInfo = useMemo(
    () => ({ ...DEFAULT_SYMBOL_INFO, symbol: coin.symbol }),
    [coin.symbol]
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <RNStatusBar barStyle="light-content" />

      <View style={styles.topBar}>
        <View>
          <BackButton onPress={goWatchlist} />
          <ConnectionBadge
            status={status}
            detail={detail}
            lastFrameAt={lastFrameAt}
            reconnectAttempts={reconnectAttempts}
          />
        </View>
        <View style={styles.pill}>
          <Text style={styles.pillText}>LIST</Text>
        </View>
      </View>

      <PriceHeader
        symbol={coin.symbol}
        lastPrice={null}
        referencePrice={null}
        symbolInfo={symbolInfo}
        spreadTicks={null}
        stale
      />

      <View style={styles.controlRow}>
        <View pointerEvents="none">
          <IntervalSelector intervals={INTERVALS} active="1s" onSelect={() => undefined} />
        </View>
        <Pressable onPress={() => openDetail(LIVE_SYMBOL)} hitSlop={8} style={styles.debugButton}>
          <Text style={styles.debugButtonText}>OPEN {LIVE_SYMBOL}</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.chartCard}>
          <CandleChart window={EMPTY_WINDOW} interval="1s" symbolInfo={symbolInfo} stale />
        </View>

        <View style={styles.metaRow}>
          <LatencyBadge latencyMs={null} jitterMs={null} score={null} />
          <Text style={styles.candleMeta}>no candles</Text>
        </View>

        <View style={styles.card}>
          <OrderBookPanel book={EMPTY_BOOK} symbolInfo={symbolInfo} rows={CONFIG.BOOK_ROWS} stale />
        </View>

        <View style={styles.card}>
          <TradesList trades={[]} symbolInfo={symbolInfo} stale />
        </View>
      </ScrollView>
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
  pill: {
    paddingHorizontal: theme.space(1.5),
    paddingVertical: 3,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.color.surfaceAlt,
  },
  pillText: {
    color: theme.color.textFaint,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
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
