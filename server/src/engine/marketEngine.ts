import {
  DEPTH_INTERVAL_MS,
  INITIAL_PRICE_TICKS,
  SEED,
  STEP_MS,
  SYMBOL,
  TRADE_HISTORY,
} from '../config';
import { Emitter } from '../util/emitter';
import { CandleSeries } from './candles';
import { PriceProcess, TradeGenerator } from './generator';
import { OrderBook } from './orderBook';
import { createRng } from './rng';
import {
  INTERVALS,
  type Candle,
  type DepthDelta,
  type DepthSnapshot,
  type Interval,
  type Millis,
  type PriceTicks,
  type Trade,
} from './types';

/**
 * Declared as a type alias rather than an interface on purpose: TypeScript gives
 * object type aliases an implicit index signature, which is what lets them satisfy the
 * `Record<string, unknown>` constraint on Emitter. An interface would not.
 */
export type EngineEvents = {
  /** A batch of trades, in ascending id order. Never empty. */
  trades: Trade[];
  /** An incremental depth update. */
  depth: DepthDelta;
  /** The active candle for one interval was modified. */
  candleUpdate: Candle;
  /** A candle closed and is now final. Must reach every client regardless of tier. */
  candleClose: Candle;
};

/**
 * The authoritative market simulation.
 *
 * ARCHITECTURAL ROLE
 * ------------------
 * This class is the *only* source of truth. It processes every generated trade and
 * maintains correct OHLCV for every interval, and it does so at exactly one rate: as
 * fast as trades occur. It knows nothing whatsoever about delivery tiers, WebSocket
 * connections, or how often anyone is listening.
 *
 * That ignorance is the design. The assignment requires that "the backend must continue
 * processing the complete generated trade stream and computing correct OHLCV candles at
 * every tier". Rather than trying to remember to honour that rule in the delivery code,
 * we make it structurally impossible to break: tier logic lives in ClientSession, which
 * only ever *reads* from this engine. There is no code path by which a slow client can
 * influence a candle, because no such path exists to write.
 *
 * A single engine instance also means N connected clients cost one simulation, not N.
 */
export class MarketEngine {
  readonly events = new Emitter<EngineEvents>();
  readonly symbol = SYMBOL;

  private readonly price: PriceProcess;
  private readonly generator: TradeGenerator;
  private readonly book: OrderBook;
  private readonly series = new Map<Interval, CandleSeries>();

  /** Recent trades, oldest first, for REST and for a new client's initial payload. */
  private recentTrades: Trade[] = [];

  private timer: NodeJS.Timeout | undefined;
  private lastDepthPublish: Millis;
  private running = false;

  /**
   * Injected by tests so they can drive the simulation with a synthetic clock. In
   * production this is just Date.now.
   *
   * Passing the clock in rather than calling Date.now() directly is what makes the
   * cross-tier candle test possible: it can replay ten minutes of market in
   * milliseconds and get bit-identical results.
   */
  private readonly now: () => Millis;

  constructor(options: { seed?: number; startTime?: Millis; clock?: () => Millis } = {}) {
    const seed = options.seed ?? SEED;
    this.now = options.clock ?? (() => Date.now());
    const startTime = options.startTime ?? this.now();

    // One RNG shared by every component. This is deliberate: it means the whole
    // simulation is a single deterministic stream driven by one seed. Separate RNGs per
    // component would also be deterministic, but then adding a component that consumes
    // randomness would silently change every other component's output, making a
    // recorded demo impossible to reproduce after a refactor.
    const rng = createRng(seed);

    this.price = new PriceProcess(rng, INITIAL_PRICE_TICKS, startTime);
    this.book = new OrderBook(rng, INITIAL_PRICE_TICKS);
    this.generator = new TradeGenerator(rng, startTime);
    this.lastDepthPublish = startTime;

    for (const interval of INTERVALS) {
      this.series.set(interval, new CandleSeries(interval, startTime, INITIAL_PRICE_TICKS));
    }
  }

  /** Begin generating market data on a wall-clock timer. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.step(this.now()), STEP_MS);
  }

  /** Stop the timer. Safe to call when not running. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Advance the simulation to `now`.
   *
   * Public so tests can drive it directly with a synthetic clock instead of waiting on
   * real timers.
   *
   * The loop interleaves price movement with trade generation: for each due trade we
   * first advance the price process to that trade's exact timestamp, then align the
   * book, then execute. This is why the price a trade prints at is consistent with the
   * book at that instant, rather than being priced against a book from up to one step
   * in the past.
   */
  step(now: Millis): void {
    const trades: Trade[] = [];

    // Bound the work one step can do. Without this, a long process pause would produce
    // an unbounded burst of trades on resume and could block the event loop for
    // seconds. We would rather lose simulated trades than stall the server.
    const maxTradesPerStep = 5_000;

    while (this.generator.dueAt <= now && trades.length < maxTradesPerStep) {
      const ts = this.generator.dueAt;

      this.price.advanceTo(ts);
      this.book.alignTo(this.price.ticks);

      const trade = this.generator.emit(this.book);
      this.book.consume(trade.side, trade.price, trade.qty);

      this.applyTradeToCandles(trade);
      trades.push(trade);
    }

    // Bring the price and the clock to the present even if no trade was due, so that
    // candles still close on schedule during a silent interval.
    this.price.advanceTo(now);
    this.advanceCandles(now);

    if (trades.length > 0) {
      this.pushRecentTrades(trades);
      this.events.emit('trades', trades);
    }

    this.maybePublishDepth(now);
  }

  /**
   * Fold a trade into every interval's series, emitting a close event for any candle
   * that finished as a result.
   */
  private applyTradeToCandles(trade: Trade): void {
    for (const series of this.series.values()) {
      const closed = series.applyTrade(trade);
      for (const candle of closed) this.events.emit('candleClose', candle);
      this.events.emit('candleUpdate', series.getActive());
    }
  }

  /** Close candles whose interval has elapsed, independent of trade arrival. */
  private advanceCandles(now: Millis): void {
    for (const series of this.series.values()) {
      const closed = series.advanceTo(now);
      for (const candle of closed) this.events.emit('candleClose', candle);
      if (closed.length > 0) {
        // A new candle just opened. Tell clients about it so the chart grows a fresh
        // (flat) candle immediately rather than appearing to stall until the next trade.
        this.events.emit('candleUpdate', series.getActive());
      }
    }
  }

  private maybePublishDepth(now: Millis): void {
    if (now - this.lastDepthPublish < DEPTH_INTERVAL_MS) return;
    this.lastDepthPublish = now;

    this.book.update(this.price.ticks);
    const delta = this.book.flush();
    if (delta) this.events.emit('depth', delta);
  }

  private pushRecentTrades(trades: Trade[]): void {
    this.recentTrades.push(...trades);
    if (this.recentTrades.length > TRADE_HISTORY) {
      this.recentTrades.splice(0, this.recentTrades.length - TRADE_HISTORY);
    }
  }

  // ---------------------------------------------------------------------------
  // Read-only accessors. Everything returns copies, so no consumer can mutate
  // engine state, and a serialised payload cannot change underneath a client.
  // ---------------------------------------------------------------------------

  getDepthSnapshot(limit?: number): DepthSnapshot {
    return this.book.snapshot(limit);
  }

  getCandleHistory(interval: Interval, limit: number): Candle[] {
    return this.series.get(interval)?.getHistory(limit) ?? [];
  }

  getActiveCandle(interval: Interval): Candle | undefined {
    return this.series.get(interval)?.getActive();
  }

  getRecentTrades(limit: number): Trade[] {
    return this.recentTrades.slice(-limit).map((t) => ({ ...t }));
  }

  getLastPrice(): PriceTicks {
    const last = this.recentTrades[this.recentTrades.length - 1];
    return last?.price ?? this.price.ticks;
  }

  /** Exposed for the cross-tier equality test. */
  getAllClosedCandles(interval: Interval): Candle[] {
    return this.series.get(interval)?.getAllClosed() ?? [];
  }
}
