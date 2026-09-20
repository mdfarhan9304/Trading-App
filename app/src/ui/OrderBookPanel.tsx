import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { topOfBook, type BookState } from '../domain/orderBook';
import type { SymbolInfo } from '../protocol/types';
import { formatPrice, formatQtyCompact } from '../util/format';
import { theme } from './theme';

interface Props {
  book: BookState;
  symbolInfo: SymbolInfo;
  rows: number;
  stale: boolean;
}

export const OrderBookPanel: React.FC<Props> = ({ book, symbolInfo, rows, stale }) => {
  const { bids, asks } = useMemo(() => topOfBook(book, rows), [book, rows]);

  // same scale for both sides so a thin book doesn't look full
  const { bidCumulative, askCumulative, maxCumulative } = useMemo(() => {
    const bidTotals: number[] = [];
    let runningBid = 0;
    for (const level of bids) {
      runningBid += level.qty;
      bidTotals.push(runningBid);
    }

    const askTotals: number[] = [];
    let runningAsk = 0;
    for (const level of asks) {
      runningAsk += level.qty;
      askTotals.push(runningAsk);
    }

    return {
      bidCumulative: bidTotals,
      askCumulative: askTotals,
      maxCumulative: Math.max(runningBid, runningAsk, 1),
    };
  }, [bids, asks]);

  const resyncing = book.status !== 'synced';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>ORDER BOOK</Text>
        {resyncing ? (
          <Text style={styles.resyncing}>RESYNCING</Text>
        ) : (
          <Text style={styles.updateId}>u{book.lastUpdateId}</Text>
        )}
      </View>

      <View style={styles.columns}>
        <Text style={[styles.columnLabel, styles.colQty]}>Size</Text>
        <Text style={[styles.columnLabel, styles.colPrice]}>Bid</Text>
        <Text style={[styles.columnLabel, styles.colPrice, styles.right]}>Ask</Text>
        <Text style={[styles.columnLabel, styles.colQty, styles.right]}>Size</Text>
      </View>

      {resyncing && bids.length === 0 && asks.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {book.resyncReason ? `Rebuilding: ${book.resyncReason}` : 'Waiting for snapshot\u2026'}
          </Text>
        </View>
      ) : (
        <View style={{ opacity: stale ? 0.45 : 1 }}>
          {/*
            Always render `rows` rows, using a placeholder where the book is thinner. A list
            that changes height as levels come and go would make the whole screen jump.
          */}
          {Array.from({ length: rows }).map((_, index) => {
            const bid = bids[index];
            const ask = asks[index];
            return (
              <View style={styles.row} key={index}>
                <BarRow
                  side="bid"
                  qty={bid?.qty}
                  price={bid?.price}
                  cumulative={bidCumulative[index]}
                  maxCumulative={maxCumulative}
                  symbolInfo={symbolInfo}
                />
                <BarRow
                  side="ask"
                  qty={ask?.qty}
                  price={ask?.price}
                  cumulative={askCumulative[index]}
                  maxCumulative={maxCumulative}
                  symbolInfo={symbolInfo}
                />
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
};

const BarRow: React.FC<{
  side: 'bid' | 'ask';
  qty: number | undefined;
  price: number | undefined;
  cumulative: number | undefined;
  maxCumulative: number;
  symbolInfo: SymbolInfo;
}> = ({ side, qty, price, cumulative, maxCumulative, symbolInfo }) => {
  const isBid = side === 'bid';
  const width = cumulative === undefined ? 0 : Math.min(100, (cumulative / maxCumulative) * 100);

  return (
    <View style={styles.half}>
      <View
        style={[
          styles.bar,
          isBid ? styles.barBid : styles.barAsk,
          { width: `${width}%` },
        ]}
      />
      {isBid ? (
        <>
          <Text style={[styles.qty, styles.colQty]}>
            {qty === undefined ? '' : formatQtyCompact(qty, symbolInfo)}
          </Text>
          <Text style={[styles.price, styles.bidPrice, styles.colPrice]}>
            {price === undefined ? '' : formatPrice(price, symbolInfo)}
          </Text>
        </>
      ) : (
        <>
          <Text style={[styles.price, styles.askPrice, styles.colPrice]}>
            {price === undefined ? '' : formatPrice(price, symbolInfo)}
          </Text>
          <Text style={[styles.qty, styles.colQty, styles.right]}>
            {qty === undefined ? '' : formatQtyCompact(qty, symbolInfo)}
          </Text>
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
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
  updateId: {
    color: theme.color.textFaint,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
  },
  resyncing: {
    color: theme.color.warn,
    fontSize: theme.font.size.xs,
    fontWeight: '700',
    letterSpacing: 1,
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
  },
  half: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 18,
    position: 'relative',
  },
  bar: {
    position: 'absolute',
    top: 1,
    bottom: 1,
    // grow from the outside in so the prices stay readable
  },
  barBid: {
    left: 0,
    backgroundColor: 'rgba(14,203,129,0.14)',
  },
  barAsk: {
    right: 0,
    backgroundColor: 'rgba(246,70,93,0.14)',
  },
  colQty: {
    flex: 1,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
  },
  colPrice: {
    flex: 1.2,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm,
  },
  right: {
    textAlign: 'right',
  },
  qty: {
    color: theme.color.textDim,
  },
  price: {
    fontWeight: '500',
  },
  bidPrice: {
    color: theme.color.up,
    textAlign: 'right',
    paddingRight: theme.space(2), // keep bid/ask prices from running together
  },
  askPrice: {
    color: theme.color.down,
    paddingLeft: theme.space(2),
  },
  empty: {
    height: 18 * 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
    textAlign: 'center',
    paddingHorizontal: theme.space(4),
  },
});
