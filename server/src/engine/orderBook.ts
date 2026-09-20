import { BOOK_LEVELS, SYMBOL } from '../config';
import type { Rng } from './rng';
import type { BookLevel, DepthDelta, DepthSnapshot, PriceTicks, QtyLots, Side } from './types';

/**
 * The authoritative order book for the simulated symbol.
 *
 * WHY AN ABSOLUTE PRICE GRID
 * --------------------------
 * The obvious way to model a book is relative to mid: bid[i] = mid - spread - i*gap.
 * That is wrong for our purposes, because when mid moves a single tick, *every* level
 * moves with it, so every depth delta rewrites all 40 levels. The client's
 * synchronization logic would then never be meaningfully exercised, and the stream
 * would be needlessly fat.
 *
 * Real books do not work that way: resting orders sit at absolute prices and stay
 * there while mid moves through them. So we do the same. Levels live on a fixed price
 * grid (every `GRID_TICKS` ticks). Bids are the grid prices below mid, asks the grid
 * prices above it. When mid rises past a grid price, that price stops being an ask and
 * becomes a bid, and one new ask appears at the far end of the book. A one-tick mid
 * move therefore produces a delta of a couple of levels, not forty.
 *
 * UPDATE IDS
 * ----------
 * Every individual level mutation consumes one id. A published delta covers a *range*
 * of those ids (`U` through `u`) plus the previous delta's final id (`pu`). See the
 * DepthDelta docs in types.ts for why `pu` is what makes gap detection possible.
 *
 * Deltas carry ABSOLUTE quantities, never increments. This makes applying the same
 * delta twice harmless, which is what lets a client safely replay events it buffered
 * while its snapshot request was in flight.
 */
export class OrderBook {
  /** Spacing of the price grid, in ticks. 5 ticks = 0.05 at a tickSize of 0.01. */
  private static readonly GRID_TICKS = 5;

  private readonly levels = BOOK_LEVELS;
  private readonly rng: Rng;

  /** Absolute price -> resting quantity, for each side. */
  private bids = new Map<PriceTicks, QtyLots>();
  private asks = new Map<PriceTicks, QtyLots>();

  /** Id of the most recent level mutation. */
  private updateId = 0;

  /** First mutation id in the batch not yet published, or 0 if the batch is empty. */
  private batchFirstId = 0;

  /** Final mutation id of the last published delta, i.e. the next delta's `pu`. */
  private lastPublishedId = 0;

  /** Levels changed since the last publish. Value is the new absolute quantity. */
  private pendingBids = new Map<PriceTicks, QtyLots>();
  private pendingAsks = new Map<PriceTicks, QtyLots>();

  constructor(rng: Rng, mid: PriceTicks) {
    this.rng = rng;
    this.alignTo(mid);
    // The initial shaping is the book's starting state, not an update clients need to
    // reconcile, so discard the pending set and let the first real delta start clean.
    this.pendingBids.clear();
    this.pendingAsks.clear();
    this.batchFirstId = 0;
    this.lastPublishedId = this.updateId;
  }

  /** A plausible resting size: mostly small, occasionally chunky. */
  private randomQty(): QtyLots {
    // Lognormal-ish shape via an exponential draw, floored so a level is never
    // pointlessly tiny. Units are lots (1e-4), so this spans roughly 0.01 to 3 BTC.
    const lots = Math.round(this.rng.exponential(4_000) + 100);
    return Math.max(100, lots);
  }

  private setLevel(side: Side, price: PriceTicks, qty: QtyLots): void {
    const book = side === 'buy' ? this.bids : this.asks;
    const pending = side === 'buy' ? this.pendingBids : this.pendingAsks;

    const existing = book.get(price);
    if (existing === qty) return; // No change, so do not burn an update id.

    if (qty <= 0) {
      if (existing === undefined) return; // Deleting a level that was never there.
      book.delete(price);
    } else {
      book.set(price, qty);
    }

    this.updateId++;
    if (this.batchFirstId === 0) this.batchFirstId = this.updateId;
    // A qty of 0 is the delete instruction the client will act on.
    pending.set(price, qty <= 0 ? 0 : qty);
  }

  /** Highest grid price strictly below mid. */
  private bestBidPrice(mid: PriceTicks): PriceTicks {
    const g = OrderBook.GRID_TICKS;
    return Math.floor((mid - 1) / g) * g;
  }

  /** Lowest grid price strictly above mid. */
  private bestAskPrice(mid: PriceTicks): PriceTicks {
    const g = OrderBook.GRID_TICKS;
    return Math.ceil((mid + 1) / g) * g;
  }

  /**
   * Bring the set of live price levels in line with the current mid, adding levels
   * that have come into range and deleting those that have fallen out.
   *
   * The engine calls this immediately before pricing each trade, so that the touch a
   * trade executes against always brackets the current mid. Mutations accumulate into
   * the pending set and are published together on the depth cadence, which is how real
   * exchanges batch depth updates.
   */
  alignTo(mid: PriceTicks): void {
    const g = OrderBook.GRID_TICKS;

    const wantedBids = new Set<PriceTicks>();
    const bestBid = this.bestBidPrice(mid);
    for (let i = 0; i < this.levels; i++) wantedBids.add(bestBid - i * g);

    const wantedAsks = new Set<PriceTicks>();
    const bestAsk = this.bestAskPrice(mid);
    for (let i = 0; i < this.levels; i++) wantedAsks.add(bestAsk + i * g);

    // Remove levels that have crossed to the other side or fallen off the far end.
    for (const price of [...this.bids.keys()]) {
      if (!wantedBids.has(price)) this.setLevel('buy', price, 0);
    }
    for (const price of [...this.asks.keys()]) {
      if (!wantedAsks.has(price)) this.setLevel('sell', price, 0);
    }

    // Add levels that have come into range.
    for (const price of wantedBids) {
      if (!this.bids.has(price)) this.setLevel('buy', price, this.randomQty());
    }
    for (const price of wantedAsks) {
      if (!this.asks.has(price)) this.setLevel('sell', price, this.randomQty());
    }
  }

  /**
   * Advance the book for a new mid price: reshape the level set, then jiggle a few
   * resting sizes to simulate ordinary order flow.
   */
  update(mid: PriceTicks): void {
    this.alignTo(mid);

    // Perturb a handful of levels rather than all of them. Real books see continuous
    // small changes at a few prices, and it keeps deltas small.
    const churn = 3;
    for (let i = 0; i < churn; i++) {
      const side: Side = this.rng.chance(0.5) ? 'buy' : 'sell';
      const book = side === 'buy' ? this.bids : this.asks;
      const prices = [...book.keys()];
      if (prices.length === 0) continue;
      const price = prices[this.rng.int(0, prices.length - 1)];
      if (price === undefined) continue;
      this.setLevel(side, price, this.randomQty());
    }
  }

  /**
   * Apply the liquidity impact of a trade: the resting size at the traded price is
   * reduced, and if it is fully consumed the level is refilled by a new resting order.
   *
   * This is what ties the trade stream to the book, so the two feeds tell a consistent
   * story rather than being two independent random processes.
   */
  consume(side: Side, price: PriceTicks, qty: QtyLots): void {
    // A buy trade lifts the ask side; a sell trade hits the bid side.
    const bookSide: Side = side === 'buy' ? 'sell' : 'buy';
    const book = bookSide === 'buy' ? this.bids : this.asks;

    const resting = book.get(price);
    if (resting === undefined) return;

    const remaining = resting - qty;
    if (remaining <= 0) {
      // Fully consumed, then replenished by fresh interest at the same price.
      this.setLevel(bookSide, price, this.randomQty());
    } else {
      this.setLevel(bookSide, price, remaining);
    }
  }

  /**
   * Publish the accumulated changes as one delta, or null if nothing changed.
   *
   * Returning null rather than an empty event matters: an empty delta would still
   * advance `pu` on the client and burn bandwidth to say "nothing happened".
   */
  flush(): DepthDelta | null {
    if (this.pendingBids.size === 0 && this.pendingAsks.size === 0) return null;

    const delta: DepthDelta = {
      symbol: SYMBOL,
      U: this.batchFirstId,
      u: this.updateId,
      pu: this.lastPublishedId,
      bids: [...this.pendingBids].map(([price, qty]) => ({ price, qty })),
      asks: [...this.pendingAsks].map(([price, qty]) => ({ price, qty })),
    };

    this.pendingBids.clear();
    this.pendingAsks.clear();
    this.batchFirstId = 0;
    this.lastPublishedId = this.updateId;

    return delta;
  }

  /**
   * A REST-style snapshot of the top `limit` levels per side.
   *
   * `lastUpdateId` is the current mutation id, which includes changes that have not yet
   * been published as a delta. That is intentional and safe: because deltas carry
   * absolute quantities, a client that receives an overlapping delta simply reapplies
   * values it already has.
   */
  snapshot(limit = this.levels): DepthSnapshot {
    const bids = [...this.bids]
      .map(([price, qty]) => ({ price, qty }))
      .sort((a, b) => b.price - a.price) // Best (highest) bid first.
      .slice(0, limit);

    const asks = [...this.asks]
      .map(([price, qty]) => ({ price, qty }))
      .sort((a, b) => a.price - b.price) // Best (lowest) ask first.
      .slice(0, limit);

    return { symbol: SYMBOL, lastUpdateId: this.updateId, bids, asks };
  }

  /** Best bid, or undefined if the book is somehow empty. */
  bestBid(): BookLevel | undefined {
    let best: BookLevel | undefined;
    for (const [price, qty] of this.bids) {
      if (!best || price > best.price) best = { price, qty };
    }
    return best;
  }

  /** Best ask, or undefined if the book is somehow empty. */
  bestAsk(): BookLevel | undefined {
    let best: BookLevel | undefined;
    for (const [price, qty] of this.asks) {
      if (!best || price < best.price) best = { price, qty };
    }
    return best;
  }

  /** Current mutation id. Used by tests and diagnostics. */
  get currentUpdateId(): number {
    return this.updateId;
  }
}
