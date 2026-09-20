import { CANDLE_HISTORY } from '../config';
import {
  candleOpenTime,
  INTERVAL_MS,
  type Candle,
  type Interval,
  type Millis,
  type PriceTicks,
  type Trade,
} from './types';

// open = previous close, so quiet intervals still have a valid candle
export class CandleSeries {
  readonly interval: Interval;

  private readonly intervalMs: number;
  private readonly historyLimit: number;

  /** Closed candles, oldest first. */
  private closed: Candle[] = [];

  /** The candle currently accepting trades. Always present after construction. */
  private active: Candle;

  /**
   * Guard against a pathological time jump (a laptop waking from sleep, a debugger
   * pause) generating millions of empty candles and freezing the process. If the gap
   * exceeds this many intervals we stop backfilling and jump straight to the present.
   */
  private static readonly MAX_BACKFILL = 5_000;

  /** Number of trades rejected for arriving out of order. Surfaced for diagnostics. */
  outOfOrderTrades = 0;

  constructor(interval: Interval, startTime: Millis, startPrice: PriceTicks, historyLimit = CANDLE_HISTORY) {
    this.interval = interval;
    this.intervalMs = INTERVAL_MS[interval];
    this.historyLimit = historyLimit;
    this.active = this.newCandle(candleOpenTime(startTime, interval), startPrice);
  }

  /**
   * The first instant that no longer belongs to the active candle.
   *
   * This is deliberately NOT `closeTime`. `closeTime` is `openTime + intervalMs - 1`, an
   * inclusive end used for display and for the wire format. Using it as the comparison
   * boundary is only correct if timestamps are whole milliseconds; a timestamp of
   * 1999.7 satisfies `> 1999` and would close the candle early, after which the trade
   * that produced it would be rejected as out-of-order against the next candle's
   * openTime of 2000. Comparing against an exclusive end has no such crack.
   */
  private get activeEndExclusive(): Millis {
    return this.active.openTime + this.intervalMs;
  }

  private newCandle(openTime: Millis, price: PriceTicks): Candle {
    return {
      interval: this.interval,
      openTime,
      closeTime: openTime + this.intervalMs - 1,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      trades: 0,
      lastTradeId: 0,
      closed: false,
    };
  }

  /**
   * Roll the series forward to `now`, closing any candle whose interval has elapsed.
   *
   * Returns the candles that closed during this call, oldest first, so the caller can
   * publish them. A closed candle must be delivered to every client regardless of
   * tier: it is the final, immutable record of that interval.
   *
   * This runs on the engine clock, not on trade arrival, so a candle closes on time
   * even during a completely silent interval.
   */
  advanceTo(now: Millis): Candle[] {
    const justClosed: Candle[] = [];
    let guard = 0;

    while (now >= this.activeEndExclusive) {
      if (guard++ >= CandleSeries.MAX_BACKFILL) {
        // The gap is absurd. Abandon backfilling and resynchronise to the present so
        // the process stays responsive.
        const lastPrice = this.active.close;
        this.active = this.newCandle(candleOpenTime(now, this.interval), lastPrice);
        break;
      }

      this.active.closed = true;
      const finished = this.active;
      this.pushClosed(finished);
      justClosed.push({ ...finished });

      this.active = this.newCandle(finished.openTime + this.intervalMs, finished.close);
    }

    return justClosed;
  }

  /**
   * Fold a trade into the series.
   *
   * Advances the clock first, so the trade is guaranteed to land in the bucket its
   * own timestamp belongs to rather than in whichever candle happened to be open.
   * Returns any candles that closed as a side effect.
   */
  applyTrade(trade: Trade): Candle[] {
    const justClosed = this.advanceTo(trade.ts);

    if (trade.ts < this.active.openTime) {
      // A trade older than the active candle. The generator produces trades in
      // strictly increasing timestamp order, so this indicates a bug rather than a
      // real market condition. We count it instead of silently corrupting a candle
      // that has already been published as final.
      this.outOfOrderTrades++;
      return justClosed;
    }

    const c = this.active;
    if (trade.price > c.high) c.high = trade.price;
    if (trade.price < c.low) c.low = trade.price;
    c.close = trade.price;
    c.volume += trade.qty;
    c.trades += 1;
    c.lastTradeId = trade.id;

    return justClosed;
  }

  private pushClosed(candle: Candle): void {
    this.closed.push(candle);
    if (this.closed.length > this.historyLimit) {
      // Trim in one splice rather than shifting per insert. At one close per second
      // this runs rarely, so an O(n) copy is cheaper than the complexity of a real
      // ring buffer with wrap-around indices.
      this.closed.splice(0, this.closed.length - this.historyLimit);
    }
  }

  /**
   * History for the REST endpoint: the most recent `limit` candles, oldest first,
   * with the still-open active candle as the final element.
   *
   * Including the active candle matters for the client: it can render immediately and
   * then keep updating that same candle from the WebSocket feed, instead of waiting up
   * to a full interval for the first live message to give it something to draw.
   *
   * Every candle is a copy. Handing out internal objects would let a caller mutate
   * engine state, and would also mean a client's serialised payload could change
   * underneath it between JSON.stringify calls.
   */
  getHistory(limit: number): Candle[] {
    const closedWanted = Math.max(0, limit - 1);
    const slice = closedWanted === 0 ? [] : this.closed.slice(-closedWanted);
    return [...slice.map((c) => ({ ...c })), { ...this.active }];
  }

  /** A copy of the candle currently accepting trades. */
  getActive(): Candle {
    return { ...this.active };
  }

  /** Count of closed candles retained. Used by tests. */
  get closedCount(): number {
    return this.closed.length;
  }

  /** A copy of the most recently closed candle, if any. Used by tests. */
  getLastClosed(): Candle | undefined {
    const last = this.closed[this.closed.length - 1];
    return last ? { ...last } : undefined;
  }

  /** Copies of all closed candles. Used by the cross-tier equality test. */
  getAllClosed(): Candle[] {
    return this.closed.map((c) => ({ ...c }));
  }
}
