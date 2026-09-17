import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SymbolInfo } from '../protocol/types';
import { formatPercent, formatPriceDelta, formatPriceGrouped, percentChange } from '../util/format';
import { theme } from './theme';

/**
 * Latest price and its movement.
 *
 * Movement is measured from the first candle in the visible window, so the figure always
 * describes the period actually on screen rather than an arbitrary 24h reference the simulated
 * market does not have.
 */

interface Props {
  symbol: string;
  lastPrice: number | null;
  referencePrice: number | null;
  symbolInfo: SymbolInfo;
  spreadTicks: number | null;
  stale: boolean;
}

export const PriceHeader: React.FC<Props> = ({
  symbol,
  lastPrice,
  referencePrice,
  symbolInfo,
  spreadTicks,
  stale,
}) => {
  const delta = lastPrice !== null && referencePrice !== null ? lastPrice - referencePrice : null;
  const pct = lastPrice !== null && referencePrice !== null ? percentChange(referencePrice, lastPrice) : null;

  const tone = delta === null || delta === 0 ? theme.color.textDim : delta > 0 ? theme.color.up : theme.color.down;

  return (
    <View style={styles.container}>
      <View style={styles.left}>
        <Text style={styles.symbol}>{symbol}</Text>
        <Text
          style={[
            styles.price,
            // While stale we dim the number rather than hiding it. Hiding would lose useful
            // context; showing it at full strength would imply it is current.
            { color: stale ? theme.color.textDim : theme.color.text },
          ]}
          // Prevent the headline from reflowing if a digit is added.
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {lastPrice === null ? '--' : formatPriceGrouped(lastPrice, symbolInfo)}
        </Text>
      </View>

      <View style={styles.right}>
        <Text style={[styles.delta, { color: stale ? theme.color.textFaint : tone }]}>
          {delta === null ? '--' : formatPriceDelta(delta, symbolInfo)}
        </Text>
        <Text style={[styles.percent, { color: stale ? theme.color.textFaint : tone }]}>
          {formatPercent(pct)}
        </Text>
        <Text style={styles.spread}>
          spread {spreadTicks === null ? '--' : (spreadTicks / symbolInfo.priceScale).toFixed(symbolInfo.priceDecimals)}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(2),
    paddingBottom: theme.space(2),
  },
  left: {
    flex: 1,
  },
  symbol: {
    color: theme.color.textDim,
    fontSize: theme.font.size.sm,
    letterSpacing: 1,
    marginBottom: theme.space(0.5),
  },
  price: {
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xl,
    fontWeight: '600',
  },
  right: {
    alignItems: 'flex-end',
  },
  delta: {
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.md,
  },
  percent: {
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.md,
    fontWeight: '600',
  },
  spread: {
    color: theme.color.textFaint,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
    marginTop: theme.space(0.5),
  },
});
