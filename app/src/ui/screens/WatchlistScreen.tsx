import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StatusBar as RNStatusBar, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { SafeAreaView } from 'react-native-safe-area-context';
import { lastPrice } from '../../domain/candles';
import {
  LIVE_SYMBOL,
  WATCHLIST_ROW_GAP,
  WATCHLIST_ROW_HEIGHT,
  WATCHLIST_ROW_STRIDE,
  isLiveSymbol,
  rowShiftSlots,
  targetIndexFromDrag,
  type WatchlistCoin,
} from '../../domain/watchlist';
import { selectIsLive, useConnectionStore, useMarketStore, useSessionStore } from '../../state/stores';
import { formatPercent, formatPriceGrouped, percentChange } from '../../util/format';
import { ConnectionBadge } from '../components/StatusBar';
import { theme } from '../theme';

const SLOT_TIMING = { duration: 140 } as const;

export const WatchlistScreen: React.FC = () => {
  const coins = useSessionStore((s) => s.coins);
  const openDetail = useSessionStore((s) => s.openDetail);
  const reorder = useSessionStore((s) => s.reorder);

  const [dragging, setDragging] = useState(false);
  const dragFrom = useSharedValue(-1);
  const dragY = useSharedValue(0);

  const lockScroll = useCallback(() => {
    setDragging(true);
  }, []);

  const commitDrag = useCallback(
    (from: number, translationY: number) => {
      const to = targetIndexFromDrag(from, translationY, coins.length, WATCHLIST_ROW_STRIDE);
      if (to !== from) reorder(from, to);
      dragFrom.value = -1;
      dragY.value = 0;
      setDragging(false);
    },
    [coins.length, dragFrom, dragY, reorder]
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <RNStatusBar barStyle="light-content" />

      <WatchlistHeader />

      <Text style={styles.hint}>Drag the handle to reorder. Tap a row for the market.</Text>

      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        scrollEnabled={!dragging}
        showsVerticalScrollIndicator={false}
      >
        {coins.map((coin, index) => (
          <WatchlistRow
            key={coin.symbol}
            coin={coin}
            index={index}
            count={coins.length}
            dragFrom={dragFrom}
            dragY={dragY}
            onOpen={() => openDetail(coin.symbol)}
            onDragStart={lockScroll}
            onDragEnd={commitDrag}
          />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
};

interface RowProps {
  coin: WatchlistCoin;
  index: number;
  count: number;
  dragFrom: SharedValue<number>;
  dragY: SharedValue<number>;
  onOpen(): void;
  onDragStart(): void;
  onDragEnd(from: number, translationY: number): void;
}

const WatchlistRow: React.FC<RowProps> = ({
  coin,
  index,
  count,
  dragFrom,
  dragY,
  onOpen,
  onDragStart,
  onDragEnd,
}) => {
  const live = isLiveSymbol(coin.symbol);
  const offset = useSharedValue(0);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .activeOffsetY([-8, 8])
        .onStart(() => {
          dragFrom.value = index;
          dragY.value = 0;
          scheduleOnRN(onDragStart);
        })
        .onUpdate((event) => {
          dragY.value = event.translationY;
        })
        .onEnd((event) => {
          scheduleOnRN(onDragEnd, index, event.translationY);
        }),
    [dragFrom, dragY, index, onDragEnd, onDragStart]
  );

  useAnimatedReaction(
    () => {
      const from = dragFrom.value;
      if (from < 0 || from === index) return 0;
      const to = targetIndexFromDrag(from, dragY.value, count, WATCHLIST_ROW_STRIDE);
      return rowShiftSlots(index, from, to) * WATCHLIST_ROW_STRIDE;
    },
    (next, prev) => {
      if (next === prev) return;
      if (dragFrom.value < 0) {
        offset.value = next;
        return;
      }
      offset.value = withTiming(next, SLOT_TIMING);
    }
  );

  const animatedStyle = useAnimatedStyle(() => {
    const lifting = dragFrom.value === index;
    return {
      zIndex: lifting ? 10 : 0,
      elevation: lifting ? 10 : 0,
      transform: [{ translateY: lifting ? dragY.value : offset.value }],
    };
  });

  return (
    <Animated.View style={[styles.rowWrap, animatedStyle]}>
      <Pressable onPress={onOpen} style={styles.row} android_ripple={{ color: theme.color.surfaceAlt }}>
        <View style={styles.identity}>
          <Text style={styles.base}>{coin.base}</Text>
          <Text style={styles.name}>{coin.name}</Text>
        </View>

        {live ? <LiveQuote /> : <CatalogQuote />}

        <View style={[styles.pill, live ? styles.pillLive : styles.pillList]}>
          <Text style={[styles.pillText, live ? styles.pillTextLive : styles.pillTextList]}>
            {live ? 'LIVE' : 'LIST'}
          </Text>
        </View>

        <GestureDetector gesture={gesture}>
          <View style={styles.handle} hitSlop={8}>
            <Text style={styles.handleBars}>≡</Text>
          </View>
        </GestureDetector>
      </Pressable>
    </Animated.View>
  );
};

const WatchlistHeader: React.FC = () => {
  const status = useConnectionStore((s) => s.status);
  const detail = useConnectionStore((s) => s.detail);
  const lastFrameAt = useConnectionStore((s) => s.lastFrameAt);
  const reconnectAttempts = useConnectionStore((s) => s.reconnectAttempts);

  return (
    <View style={styles.topBar}>
      <Text style={styles.title}>WATCHLIST</Text>
      <ConnectionBadge
        status={status}
        detail={detail}
        lastFrameAt={lastFrameAt}
        reconnectAttempts={reconnectAttempts}
      />
    </View>
  );
};

const LiveQuote: React.FC = () => {
  const candles = useMarketStore((s) => s.candles);
  const sessionOpen = useMarketStore((s) => s.sessionOpen);
  const symbolInfo = useMarketStore((s) => s.symbolInfo);
  const marketSymbol = useMarketStore((s) => s.symbol);
  const isFeedLive = useConnectionStore(selectIsLive);

  const show = marketSymbol === LIVE_SYMBOL;
  const price = show ? lastPrice(candles) : null;
  const pct = show && price !== null && sessionOpen !== null ? percentChange(sessionOpen, price) : null;
  const tone = pct === null || pct === 0 ? theme.color.textDim : pct > 0 ? theme.color.up : theme.color.down;

  return (
    <View style={styles.quote}>
      <Text style={[styles.price, { color: isFeedLive ? theme.color.text : theme.color.textDim }]}>
        {price === null ? '—' : formatPriceGrouped(price, symbolInfo)}
      </Text>
      <Text style={[styles.change, { color: isFeedLive ? tone : theme.color.textFaint }]}>
        {formatPercent(pct)}
      </Text>
    </View>
  );
};

const CatalogQuote: React.FC = () => (
  <View style={styles.quote}>
    <Text style={[styles.price, { color: theme.color.textFaint }]}>—</Text>
    <Text style={[styles.change, { color: theme.color.textFaint }]}>no feed</Text>
  </View>
);

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.color.bg,
  },
  topBar: {
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(3),
    paddingBottom: theme.space(1),
  },
  title: {
    color: theme.color.text,
    fontSize: theme.font.size.lg,
    fontWeight: '700',
    letterSpacing: 1.4,
    marginBottom: theme.space(1),
  },
  hint: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
    paddingHorizontal: theme.space(4),
    paddingBottom: theme.space(2),
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.space(2),
    paddingBottom: theme.space(6),
    gap: WATCHLIST_ROW_GAP,
  },
  rowWrap: {
    height: WATCHLIST_ROW_HEIGHT,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: theme.space(3),
    paddingRight: theme.space(1),
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
  },
  identity: {
    flex: 1,
  },
  base: {
    color: theme.color.text,
    fontSize: theme.font.size.md,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  name: {
    color: theme.color.textDim,
    fontSize: theme.font.size.xs,
    marginTop: 2,
  },
  quote: {
    alignItems: 'flex-end',
    marginRight: theme.space(2),
    minWidth: 96,
  },
  price: {
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.md,
    fontWeight: '600',
  },
  change: {
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
    marginTop: 2,
  },
  pill: {
    paddingHorizontal: theme.space(1.5),
    paddingVertical: 3,
    borderRadius: theme.radius.sm,
    marginRight: theme.space(1),
  },
  pillLive: {
    backgroundColor: '#0b7a4e',
  },
  pillList: {
    backgroundColor: theme.color.surfaceAlt,
  },
  pillText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  pillTextLive: {
    color: theme.color.up,
  },
  pillTextList: {
    color: theme.color.textFaint,
  },
  handle: {
    width: 36,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleBars: {
    color: theme.color.textDim,
    fontSize: 22,
    lineHeight: 24,
  },
});
