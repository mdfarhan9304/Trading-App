import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { DashPathEffect, Line, matchFont, vec } from '@shopify/react-native-skia';
import { useDerivedValue } from 'react-native-reanimated';
import {
  CartesianChart,
  Candlestick,
  useChartPressState,
  useChartTransformState,
} from 'victory-native';
import { priceBounds, type CandleWindow } from '../domain/candles';
import type { Interval, SymbolInfo } from '../protocol/types';
import { formatAxisTime, formatPrice, formatTimeMs } from '../util/format';
import { skiaFontFamily, theme } from './theme';

// ticks stay ints; labels convert at the edge
interface ChartPoint {
  x: number;
  open: number;
  high: number;
  low: number;
  close: number;
  [key: string]: number;
}

interface Props {
  window: CandleWindow;
  interval: Interval;
  symbolInfo: SymbolInfo;
  stale: boolean;
}

export const CandleChart: React.FC<Props> = ({ window, interval, symbolInfo, stale }) => {
  const { state: press, isActive } = useChartPressState({
    x: 0,
    y: { open: 0, high: 0, low: 0, close: 0 },
  });

  const { state: transform } = useChartTransformState({ scaleX: 1, scaleY: 1 });

  const font = useMemo(() => matchFont({ fontFamily: skiaFontFamily, fontSize: 9 }), []);

  const data = useMemo<ChartPoint[]>(
    () =>
      window.candles.map((candle) => ({
        x: candle.openTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    [window.candles]
  );

  const bounds = useMemo(() => priceBounds(window), [window]);

  const showSeconds = interval !== '1m';

  if (data.length === 0 || !bounds) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          {stale ? 'No cached candles' : 'Waiting for candle history\u2026'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CartesianChart
        data={data}
        xKey="x"
        yKeys={['open', 'high', 'low', 'close']}
        domain={{ y: [bounds.min, bounds.max] }}
        domainPadding={{ left: 12, right: 12, top: 8, bottom: 8 }}
        padding={{ left: 4, right: 4, top: 8, bottom: 4 }}
        chartPressState={press}
        transformState={transform}
        transformConfig={{
          // x only — vertical pinch on a price chart is just confusing
          pan: { dimensions: 'x' },
          pinch: { dimensions: 'x' },
        }}
        xAxis={{
          font,
          lineColor: theme.color.border,
          labelColor: theme.color.textFaint,
          tickCount: 4,
          formatXLabel: (value) => (value ? formatAxisTime(value, showSeconds) : ''),
        }}
        yAxis={[
          {
            font,
            lineColor: theme.color.border,
            labelColor: theme.color.textFaint,
            tickCount: 5,
            formatYLabel: (value) => formatPrice(value, symbolInfo),
          },
        ]}
      >
        {({ points, chartBounds }) => (
          <>
            <Candlestick
              openPoints={points.open}
              highPoints={points.high}
              lowPoints={points.low}
              closePoints={points.close}
              chartBounds={chartBounds}
              candleRatio={0.65}
              minBodyHeight={1} // keep dojis visible
              candleColors={{ positive: theme.color.up, negative: theme.color.down }}
              wickStrokeWidth={1}
              opacity={stale ? 0.35 : 1}
            />
            {isActive ? (
              <Crosshair press={press} chartBounds={chartBounds} />
            ) : null}
          </>
        )}
      </CartesianChart>

      {isActive ? <CrosshairReadout press={press} symbolInfo={symbolInfo} /> : null}
    </View>
  );
};

const Crosshair: React.FC<{
  press: ReturnType<typeof useChartPressState<{ x: number; y: { open: number; high: number; low: number; close: number } }>>['state'];
  chartBounds: { left: number; right: number; top: number; bottom: number };
}> = ({ press, chartBounds }) => {
  const from = useDerivedValue(() => vec(press.x.position.value, chartBounds.top));
  const to = useDerivedValue(() => vec(press.x.position.value, chartBounds.bottom));

  return (
    <Line p1={from} p2={to} color={theme.color.textDim} strokeWidth={1}>
      <DashPathEffect intervals={[4, 4]} />
    </Line>
  );
};

const CrosshairReadout: React.FC<{
  press: ReturnType<typeof useChartPressState<{ x: number; y: { open: number; high: number; low: number; close: number } }>>['state'];
  symbolInfo: SymbolInfo;
}> = ({ press, symbolInfo }) => {
  const x = press.x.value.value;
  const open = press.y.open.value.value;
  const high = press.y.high.value.value;
  const low = press.y.low.value.value;
  const close = press.y.close.value.value;

  const bullish = close >= open;

  return (
    <View style={styles.readout} pointerEvents="none">
      <Text style={styles.readoutTime}>{formatTimeMs(x)}</Text>
      <View style={styles.readoutRow}>
        <Field label="O" value={formatPrice(open, symbolInfo)} />
        <Field label="H" value={formatPrice(high, symbolInfo)} tone={theme.color.up} />
        <Field label="L" value={formatPrice(low, symbolInfo)} tone={theme.color.down} />
        <Field
          label="C"
          value={formatPrice(close, symbolInfo)}
          tone={bullish ? theme.color.up : theme.color.down}
        />
      </View>
    </View>
  );
};

const Field: React.FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone }) => (
  <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <Text style={[styles.fieldValue, tone ? { color: tone } : null]}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 220,
  },
  empty: {
    flex: 1,
    minHeight: 220,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.sm,
  },
  readout: {
    position: 'absolute',
    top: theme.space(1),
    left: theme.space(2),
    right: theme.space(2),
    backgroundColor: 'rgba(20,26,32,0.94)',
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    paddingVertical: theme.space(1.5),
    paddingHorizontal: theme.space(2),
  },
  readoutTime: {
    color: theme.color.textDim,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
    marginBottom: theme.space(1),
  },
  readoutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  field: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  fieldLabel: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
    marginRight: theme.space(1),
  },
  fieldValue: {
    color: theme.color.text,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm,
  },
});
