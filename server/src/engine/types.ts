/**
 * Core domain types for the synthetic market.
 *
 * PRECISION MODEL
 * ---------------
 * Every price and quantity in this codebase is an INTEGER, never a float.
 *
 *   - A price is a count of ticks.  tickSize 0.01 => price 104523.45 is 10452345 ticks.
 *   - A quantity is a count of lots. lotSize 0.0001 => qty 1.2345 is 12345 lots.
 *
 * This is done because floats cannot represent decimal money exactly: in IEEE-754,
 * `0.1 + 0.2 !== 0.3`. If candle highs/lows/volumes accumulated in floats, the
 * "candles must be identical across tiers" guarantee could fail purely from
 * summation-order drift. Integers make that class of bug impossible.
 *
 * Integers are also what travels over the wire (see docs/PROTOCOL.md). The client
 * receives ticks and lots plus the scale factors, and converts to a display string
 * only at the render edge. We deliberately do NOT send decimal strings like
 * "104523.45", because that invites `parseFloat` on the client and reintroduces
 * exactly the float drift we just eliminated.
 *
 * JS numbers are safe for this: they hold integers exactly up to 2^53 - 1
 * (~9.0e15). Our largest realistic value is a candle volume, and even a million
 * trades of 10 BTC each is only 1e11 lots.
 */

/** An integer count of ticks. Multiply by tickSize to get a human price. */
export type PriceTicks = number;

/** An integer count of lots. Multiply by lotSize to get a human quantity. */
export type QtyLots = number;

/** Epoch milliseconds. */
export type Millis = number;

export type Side = 'buy' | 'sell';

/**
 * Supported candle intervals.
 *
 * 1s and 5s are not realistic exchange intervals, but they make live candle
 * formation and the difference between delivery tiers visible in a short screen
 * recording. 1m is the realistic case. Choosing all three lets us demonstrate
 * both the mechanics and the real-world shape.
 */
export type Interval = '1s' | '5s' | '1m';

export const INTERVAL_MS: Record<Interval, number> = {
  '1s': 1_000,
  '5s': 5_000,
  '1m': 60_000,
};

export const INTERVALS: readonly Interval[] = ['1s', '5s', '1m'];

export function isInterval(value: unknown): value is Interval {
  return typeof value === 'string' && value in INTERVAL_MS;
}

/** Static description of the traded instrument, sent to clients so they can format. */
export interface SymbolInfo {
  symbol: string;
  /** Human price = priceTicks / priceScale. 100 => 2 decimal places. */
  priceScale: number;
  /** Human qty = qtyLots / qtyScale. 10000 => 4 decimal places. */
  qtyScale: number;
  /** Decimal places implied by priceScale, for convenient client formatting. */
  priceDecimals: number;
  qtyDecimals: number;
}

/**
 * A single executed trade.
 *
 * `id` is the unambiguous ordering identifier the assignment asks for: a strictly
 * increasing integer assigned by the engine. It is independent of `ts`, because
 * two trades can share a millisecond timestamp and would then be unorderable by
 * time alone.
 */
export interface Trade {
  id: number;
  ts: Millis;
  price: PriceTicks;
  qty: QtyLots;
  side: Side;
}

/** One side of one order book level. */
export interface BookLevel {
  price: PriceTicks;
  qty: QtyLots;
}

/**
 * A depth snapshot, as returned by the REST endpoint.
 *
 * `lastUpdateId` is the book revision this snapshot reflects. The client uses it
 * to decide which buffered deltas to discard.
 */
export interface DepthSnapshot {
  symbol: string;
  lastUpdateId: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

/**
 * An incremental depth update.
 *
 * The three ids follow the scheme used by Binance's futures depth stream, because
 * it is the only common design that lets a client detect a *gap* rather than merely
 * detecting that it fell behind:
 *
 *   U  - first update id contained in this event
 *   u  - final update id contained in this event
 *   pu - final update id of the immediately preceding event
 *
 * A client that has applied an event with final id `u` must see `pu === u` on the
 * next event. Any mismatch proves at least one event was lost or reordered, which
 * triggers a resync. Without `pu`, a client can only guess.
 */
export interface DepthDelta {
  symbol: string;
  U: number;
  u: number;
  pu: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

/**
 * An OHLCV candle.
 *
 * `volume` is a sum of integer lots, so it is exact regardless of how many trades
 * were folded into it or in what order.
 *
 * `lastTradeId` is what makes cross-tier verification possible: two clients on
 * different tiers receive a different NUMBER of updates for the same candle, but
 * once the candle closes, every field including `lastTradeId` must match.
 */
export interface Candle {
  interval: Interval;
  openTime: Millis;
  closeTime: Millis;
  open: PriceTicks;
  high: PriceTicks;
  low: PriceTicks;
  close: PriceTicks;
  volume: QtyLots;
  /** Number of trades folded into this candle. */
  trades: number;
  /** Id of the most recent trade applied to this candle, or 0 if none. */
  lastTradeId: number;
  /** True once the interval has elapsed and no further trades can land here. */
  closed: boolean;
}

/** Bucket a timestamp into the opening time of its interval. */
export function candleOpenTime(ts: Millis, interval: Interval): Millis {
  const size = INTERVAL_MS[interval];
  return Math.floor(ts / size) * size;
}
