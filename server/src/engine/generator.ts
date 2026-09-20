import { TRADES_PER_SEC } from '../config';
import type { OrderBook } from './orderBook';
import type { Rng } from './rng';
import type { Millis, PriceTicks, QtyLots, Side, Trade } from './types';

/**
 * The mid-price process.
 *
 * A geometric random walk with mild mean reversion and occasional jumps. Geometric
 * (multiplicative) rather than arithmetic (additive) because price moves should scale
 * with the price level: a $50 move means something very different at $100 than at
 * $100,000. It also guarantees the price can never go negative.
 *
 * The internal state is a float, and it is quantized to integer ticks only when read.
 * Rounding on every step instead would accumulate a small bias over tens of thousands
 * of steps and could pin the price if step sizes fell below half a tick. So: the
 * underlying process is continuous, the observable price is discrete.
 */
export class PriceProcess {
  private mid: number;
  private readonly anchor: number;
  private lastTs: Millis;
  private readonly rng: Rng;

  /** Standard deviation of return per second. 0.0004 is 4 basis points. */
  private static readonly VOL_PER_SEC = 0.0004;

  /**
   * Pull toward the starting price, per second. Very weak: it exists only so that a
   * backend left running overnight does not wander to an absurd price and make the
   * chart's axis meaningless. Over minutes it is imperceptible.
   */
  private static readonly REVERSION_PER_SEC = 0.02;

  /** Probability per second of a jump, and its size range in basis points. */
  private static readonly JUMP_PER_SEC = 0.08;
  private static readonly JUMP_MIN_BPS = 5;
  private static readonly JUMP_MAX_BPS = 25;

  constructor(rng: Rng, startPrice: PriceTicks, startTs: Millis) {
    this.rng = rng;
    this.mid = startPrice;
    this.anchor = startPrice;
    this.lastTs = startTs;
  }

  /**
   * Advance the process to `ts`. Safe to call with a timestamp equal to or before the
   * current one, in which case it does nothing: the engine calls this once per trade
   * and once per step, and those can coincide.
   */
  advanceTo(ts: Millis): void {
    const dtMs = ts - this.lastTs;
    if (dtMs <= 0) return;
    this.lastTs = ts;

    const dtSec = dtMs / 1_000;

    // Diffusion: sigma scales with the square root of time, which is what makes this a
    // proper random walk rather than one whose volatility depends on our step size.
    const sigma = PriceProcess.VOL_PER_SEC * Math.sqrt(dtSec);
    let logReturn = sigma * this.rng.normal();

    // Mean reversion, expressed in log space so it composes with the diffusion term.
    logReturn += Math.log(this.anchor / this.mid) * PriceProcess.REVERSION_PER_SEC * dtSec;

    // Jumps: a Poisson-ish arrival scaled by the elapsed time.
    if (this.rng.chance(PriceProcess.JUMP_PER_SEC * dtSec)) {
      const bps =
        PriceProcess.JUMP_MIN_BPS +
        this.rng.next() * (PriceProcess.JUMP_MAX_BPS - PriceProcess.JUMP_MIN_BPS);
      const direction = this.rng.chance(0.5) ? 1 : -1;
      logReturn += (direction * bps) / 10_000;
    }

    this.mid *= Math.exp(logReturn);
  }

  /** The observable mid price, quantized to whole ticks. */
  get ticks(): PriceTicks {
    return Math.round(this.mid);
  }
}

/**
 * Generates the trade stream.
 *
 * WHY POISSON ARRIVALS INSTEAD OF A FIXED TIMER
 * ---------------------------------------------
 * Real trades do not arrive on a metronome, and a fixed cadence would make the
 * coalescing logic look better than it is: with evenly spaced trades, every outgoing
 * chart update would fold in exactly the same number of trades. Poisson arrivals
 * produce clusters and quiet gaps, which is what actually stresses the "several trades
 * collapsed into one update" path.
 *
 * Crucially, each trade's timestamp comes from the arrival process itself, not from
 * whenever the timer happened to fire. So a late or jittery `setInterval` callback
 * changes *when we notice* a trade, never *when the trade occurred*. Candle bucketing
 * therefore stays exact even on a loaded machine, and a replay with the same seed
 * produces byte-identical candles.
 */
export class TradeGenerator {
  private readonly rng: Rng;
  private readonly meanIntervalMs: number;

  /** Timestamp of the next trade to be emitted. */
  private nextTradeAt: Millis;

  /** Strictly increasing trade id. Starts at 1 so that 0 can mean "no trade yet". */
  private nextId = 1;

  /**
   * Short-term order flow imbalance in [-1, 1], as an AR(1) process. Without it, buys
   * and sells would be an independent coin flip and the tape would look unnaturally
   * balanced; real flow arrives in bursts of one-sided pressure.
   */
  private momentum = 0;

  constructor(rng: Rng, startTs: Millis, tradesPerSec = TRADES_PER_SEC) {
    this.rng = rng;
    this.meanIntervalMs = 1_000 / tradesPerSec;
    this.nextTradeAt = this.scheduleFrom(startTs);
  }

  /**
   * Pick the next arrival time, as a whole number of milliseconds.
   *
   * Rounding matters. An exponential draw is a float, so unrounded arrivals land on
   * fractional milliseconds like 1999.7. Real exchanges timestamp in whole units, such
   * values serialise awkwardly, and — as this project found the hard way — they invite
   * off-by-one bugs at candle boundaries.
   *
   * Rounding can produce two trades sharing a millisecond, and that is left in
   * deliberately: it is precisely why a trade needs a separate monotonic `id` to be
   * orderable. It cannot produce a timestamp that moves backwards, because the
   * exponential draw is always non-negative.
   */
  private scheduleFrom(ts: Millis): Millis {
    return ts + Math.round(this.rng.exponential(this.meanIntervalMs));
  }

  /** Timestamp of the next pending trade, so the engine knows whether one is due. */
  get dueAt(): Millis {
    return this.nextTradeAt;
  }

  /** A plausible trade size: many small, a few large. */
  private randomQty(): QtyLots {
    const lots = Math.round(this.rng.exponential(1_200) + 20);
    return Math.max(20, lots);
  }

  /**
   * Emit the trade due at `dueAt`, priced against the current state of `book`, and
   * schedule the next arrival.
   *
   * Trades execute against the book's touch, which is why the trade feed and the depth
   * feed stay consistent with each other. Occasionally a trade sweeps a level deeper,
   * which is how a real aggressive order behaves and gives the book something to
   * refill.
   */
  emit(book: OrderBook): Trade {
    const ts = this.nextTradeAt;

    // AR(1) update: 0.92 retention gives a burst a half-life of roughly 8 trades.
    this.momentum = this.momentum * 0.92 + this.rng.normal() * 0.12;
    this.momentum = Math.max(-1, Math.min(1, this.momentum));

    // Momentum tilts the buy/sell split by at most 15 percentage points.
    const buyProbability = 0.5 + this.momentum * 0.15;
    const side: Side = this.rng.chance(buyProbability) ? 'buy' : 'sell';

    const touch = side === 'buy' ? book.bestAsk() : book.bestBid();
    // Fall back to the far side if one side is momentarily empty, and to a
    // last-resort price if the book is entirely empty. Neither should happen, but a
    // crash in the generator would take down the whole feed.
    const fallback = side === 'buy' ? book.bestBid() : book.bestAsk();
    const level = touch ?? fallback;
    let price: PriceTicks = level?.price ?? 0;

    // 12% of trades are aggressive enough to reach the next level out.
    if (level && this.rng.chance(0.12)) {
      const step = 5; // One grid step, matching OrderBook.GRID_TICKS.
      price = side === 'buy' ? price + step : price - step;
    }

    const qty = this.randomQty();
    const trade: Trade = { id: this.nextId++, ts, price, qty, side };

    // Schedule the next arrival from this one, so the process is exactly Poisson and
    // never drifts relative to wall clock.
    this.nextTradeAt = this.scheduleFrom(ts);

    return trade;
  }
}
