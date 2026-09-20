import React, { useCallback } from 'react';
import { FlatList, StyleSheet, Text, View, type ListRenderItemInfo } from 'react-native';
import type { SymbolInfo, Trade } from '../../protocol/types';
import { formatPrice, formatQtyCompact, formatTime } from '../../util/format';
import { theme } from '../theme';

const ROW_HEIGHT = 18;

interface Props {
  trades: Trade[];
  symbolInfo: SymbolInfo;
  stale: boolean;
}

export const TradesList: React.FC<Props> = ({ trades, symbolInfo, stale }) => {
  // store is oldest-first; flip for the list
  const data = React.useMemo(() => [...trades].reverse(), [trades]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Trade>) => (
      <TradeRow
        price={item.price}
        qty={item.qty}
        ts={item.ts}
        side={item.side}
        symbolInfo={symbolInfo}
      />
    ),
    [symbolInfo]
  );

  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index }),
    []
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>RECENT TRADES</Text>
        <Text style={styles.count}>{trades.length}</Text>
      </View>

      <View style={styles.columns}>
        <Text style={[styles.columnLabel, styles.colPrice]}>Price</Text>
        <Text style={[styles.columnLabel, styles.colQty]}>Size</Text>
        <Text style={[styles.columnLabel, styles.colTime]}>Time</Text>
      </View>

      {data.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{stale ? 'No cached trades' : 'Waiting for trades\u2026'}</Text>
        </View>
      ) : (
        <FlatList
          style={{ opacity: stale ? 0.45 : 1 }}
          data={data}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemLayout={getItemLayout}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={3}
          removeClippedSubviews
          scrollEnabled={false} // parent ScrollView owns the gesture
        />
      )}
    </View>
  );
};

const keyExtractor = (trade: Trade): string => String(trade.id);

const TradeRow = React.memo<{
  price: number;
  qty: number;
  ts: number;
  side: 'buy' | 'sell';
  symbolInfo: SymbolInfo;
}>(({ price, qty, ts, side, symbolInfo }) => {
  const tone = side === 'buy' ? theme.color.up : theme.color.down;
  return (
    <View style={styles.row}>
      <Text style={[styles.price, styles.colPrice, { color: tone }]}>
        {formatPrice(price, symbolInfo)}
      </Text>
      <Text style={[styles.qty, styles.colQty]}>{formatQtyCompact(qty, symbolInfo)}</Text>
      <Text style={[styles.time, styles.colTime]}>{formatTime(ts)}</Text>
    </View>
  );
});
TradeRow.displayName = 'TradeRow';

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.space(1),
  },
  title: {
    color: theme.color.textDim,
    fontSize: theme.font.size.xs,
    letterSpacing: 1,
  },
  count: {
    color: theme.color.textFaint,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
  },
  columns: {
    flexDirection: 'row',
    marginBottom: theme.space(1),
  },
  columnLabel: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
  },
  row: {
    flexDirection: 'row',
    height: ROW_HEIGHT,
    alignItems: 'center',
  },
  colPrice: {
    flex: 1.4,
  },
  colQty: {
    flex: 1,
  },
  colTime: {
    flex: 1,
    textAlign: 'right',
  },
  price: {
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm,
  },
  qty: {
    color: theme.color.textDim,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
  },
  time: {
    color: theme.color.textFaint,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
  },
  empty: {
    flex: 1,
    minHeight: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
  },
});
