import type { BookLevel, DepthDelta, DepthSnapshot, PriceTicks, QtyLots } from '../protocol/types';

/**
 * Local order book, assembled from a REST snapshot plus ordered WebSocket deltas.
 *
 * THE RACE THIS SOLVES
 * --------------------
 * The book comes from two channels with independent latency: a REST snapshot (a photograph
 * of one instant) and a delta stream (a continuous film). The book is only correct if the
 * film starts on exactly the frame after the photograph.
 *
 * By the time a snapshot arrives, the server's book has already moved on. Some deltas we
 * received are already baked into the snapshot; some happened after it and must be applied;
 * and if any in between were never received, the book is silently wrong forever.
 *
 * Three obvious approaches all fail:
 *   - Discard deltas until the snapshot lands  -> permanently lose the ones in flight.
 *   - Apply deltas, then apply the snapshot     -> stale data overwrites newer data.
 *   - Fetch the snapshot first, then subscribe  -> an undetectable hole between them.
 *
 * So the order is forced: subscribe and BUFFER first, then request the snapshot. You must
 * already be recording before you take the photograph.
 *
 * TWO DIFFERENT RULES
 * -------------------
 * The first applied delta and every later delta are validated differently, and this is the
 * part that is easy to get wrong:
 *
 *   First delta:  U <= lastUpdateId + 1 <= u    (a RANGE BRACKET check)
 *   Later deltas: pu === lastUpdateId           (a CHAIN check)
 *
 * The bracket check is required because our server's snapshot `lastUpdateId` includes
 * mutations it has not published yet. The next delta can therefore legitimately arrive with
 * a `pu` LOWER than the snapshot id. A `pu === lastUpdateId` check on the first delta would
 * reject a perfectly valid event and resync for no reason.
 *
 * Re-applying levels the snapshot already contained is harmless because deltas carry
 * ABSOLUTE quantities, not increments. That one protocol decision is what makes this whole
 * recovery path possible.
 *
 * This module is deliberately pure: no React, no fetch, no timers. It is a reducer over
 * events, which is what makes every edge case below testable by simply calling functions.
 */

export type BookStatus =
  /** No snapshot yet. Deltas are being buffered, nothing is displayable. */
  | 'awaiting-snapshot'
  /** Snapshot applied and the delta chain is intact. The book is live. */
  | 'synced'
  /** A gap or corruption was detected. A fresh snapshot is needed. */
  | 'resync-required';

export interface BookState {
  status: BookStatus;
  /** Final update id of the last applied delta, or the snapshot id before any delta. */
  lastUpdateId: number;
  bids: Map<PriceTicks, QtyLots>;
  asks: Map<PriceTicks, QtyLots>;
  /** Deltas held while awaiting a snapshot, in arrival order. */
  buffer: DepthDelta[];
  /**
   * True when the buffer overflowed and old deltas were discarded.
   *
   * Tracked explicitly rather than relying on the bracket check, because a hole in the
   * middle of the buffer could coincidentally still satisfy the bracket and leave us
   * "synced" over missing data.
   */
  bufferOverflowed: boolean;
  /** Why a resync was requested. Surfaced in the UI and useful in tests. */
  resyncReason: string | null;
  /** Diagnostics for the debug panel. */
  stats: {
    deltasApplied: number;
    deltasIgnored: number;
    resyncCount: number;
    gapCount: number;
  };
}

/**
 * Cap on buffered deltas while a snapshot is in flight.
 *
 * At 5 depth events per second this is well over a minute of buffering, far longer than any
 * plausible snapshot request. If it is ever hit, something is badly wrong and a resync is
 * the right answer.
 */
const MAX_BUFFER = 500;

export function createBookState(): BookState {
  return {
    status: 'awaiting-snapshot',
    lastUpdateId: 0,
    bids: new Map(),
    asks: new Map(),
    buffer: [],
    bufferOverflowed: false,
    resyncReason: null,
    stats: { deltasApplied: 0, deltasIgnored: 0, resyncCount: 0, gapCount: 0 },
  };
}

/**
 * Discard the book and go back to buffering.
 *
 * Called on connect, on reconnect, and whenever a gap is detected. Statistics are carried
 * across so the debug panel can show how often recovery has been needed.
 */
export function resetForResync(state: BookState, reason: string): BookState {
  return {
    ...createBookState(),
    // `resync-required` rather than `awaiting-snapshot` so the caller can tell the two apart:
    // one is a normal cold start, the other means a gap was detected and the UI should show a
    // resyncing indicator. Delta handling is identical in both - see onDelta.
    status: 'resync-required',
    resyncReason: reason,
    stats: { ...state.stats, resyncCount: state.stats.resyncCount + 1 },
  };
}

/** Apply one side of a delta. A quantity of zero DELETES the level. */
function applyLevels(target: Map<PriceTicks, QtyLots>, levels: BookLevel[]): void {
  for (const level of levels) {
    if (level.qty <= 0) {
      // Zero means "this price no longer has resting interest", not "a level worth zero".
      // Keeping it would render an empty row and distort the depth totals.
      target.delete(level.price);
    } else {
      target.set(level.price, level.qty);
    }
  }
}

/**
 * Sanity check: the best bid must be strictly below the best ask.
 *
 * A crossed book cannot occur in a correctly synchronised feed, so if we see one we have
 * silently applied something wrong. Cheap to check and it catches classes of bug that the
 * update-id checks cannot.
 */
function isCrossed(bids: Map<PriceTicks, QtyLots>, asks: Map<PriceTicks, QtyLots>): boolean {
  let bestBid = -Infinity;
  for (const price of bids.keys()) if (price > bestBid) bestBid = price;
  let bestAsk = Infinity;
  for (const price of asks.keys()) if (price < bestAsk) bestAsk = price;
  if (bestBid === -Infinity || bestAsk === Infinity) return false;
  return bestBid >= bestAsk;
}

/**
 * A delta arrived.
 *
 * While awaiting a snapshot it is buffered. Once synced it is validated against the chain
 * and applied, or it triggers a resync.
 */
export function onDelta(state: BookState, delta: DepthDelta): BookState {
  // Any non-synced state buffers. This includes `resync-required`: while we wait for a
  // replacement snapshot the stream keeps flowing, and discarding those deltas would
  // guarantee a second gap the moment the new snapshot landed.
  if (state.status !== 'synced') {
    const buffer = [...state.buffer, delta];
    if (buffer.length > MAX_BUFFER) {
      return { ...state, buffer: buffer.slice(-MAX_BUFFER), bufferOverflowed: true };
    }
    return { ...state, buffer };
  }

  // A duplicate or replayed event. Harmless because quantities are absolute, so we ignore
  // it idempotently rather than treating it as corruption.
  if (delta.u <= state.lastUpdateId) {
    return { ...state, stats: { ...state.stats, deltasIgnored: state.stats.deltasIgnored + 1 } };
  }

  // The chain check. Any mismatch proves at least one event was lost or reordered.
  if (delta.pu !== state.lastUpdateId) {
    const reset = resetForResync(state, `gap: expected pu=${state.lastUpdateId}, got pu=${delta.pu}`);
    return {
      ...reset,
      // Keep the delta that revealed the gap. It is a valid future event, and the incoming
      // snapshot will either supersede it or chain from it via the bracket check.
      buffer: [delta],
      stats: { ...reset.stats, gapCount: reset.stats.gapCount + 1 },
    };
  }

  const bids = new Map(state.bids);
  const asks = new Map(state.asks);
  applyLevels(bids, delta.bids);
  applyLevels(asks, delta.asks);

  if (isCrossed(bids, asks)) {
    return resetForResync(state, 'crossed book after applying delta');
  }

  return {
    ...state,
    bids,
    asks,
    lastUpdateId: delta.u,
    stats: { ...state.stats, deltasApplied: state.stats.deltasApplied + 1 },
  };
}

/**
 * A snapshot arrived. Reconcile it against whatever was buffered.
 *
 * Returns a synced state, or a state requesting another snapshot if a gap is proven.
 */
export function onSnapshot(state: BookState, snapshot: DepthSnapshot): BookState {
  const S = snapshot.lastUpdateId;

  const bids = new Map<PriceTicks, QtyLots>();
  const asks = new Map<PriceTicks, QtyLots>();
  for (const level of snapshot.bids) if (level.qty > 0) bids.set(level.price, level.qty);
  for (const level of snapshot.asks) if (level.qty > 0) asks.set(level.price, level.qty);

  // Step 1: drop buffered deltas already contained in the snapshot.
  const pending = state.buffer.filter((delta) => delta.u > S);

  // If the buffer lost events, we cannot trust that `pending` is contiguous with the
  // snapshot even if the bracket check happens to pass.
  if (state.bufferOverflowed && pending.length > 0) {
    return resetForResync(state, 'delta buffer overflowed while awaiting snapshot');
  }

  let lastUpdateId = S;
  let applied = 0;

  if (pending.length > 0) {
    const first = pending[0];
    if (!first) return resetForResync(state, 'internal: empty pending head');

    // Step 2: the first surviving delta must CONTAIN the id immediately after the snapshot.
    // Note this is a range check, not a `pu` check - see the header comment for why.
    if (!(first.U <= S + 1 && S + 1 <= first.u)) {
      return resetForResync(
        state,
        `snapshot gap: snapshot=${S}, first buffered delta covers ${first.U}..${first.u}`
      );
    }

    // Step 3: replay the buffer, enforcing the chain from the second delta onward.
    for (let i = 0; i < pending.length; i++) {
      const delta = pending[i];
      if (!delta) continue;

      if (i > 0 && delta.pu !== lastUpdateId) {
        return resetForResync(
          state,
          `gap while replaying buffer: expected pu=${lastUpdateId}, got pu=${delta.pu}`
        );
      }

      applyLevels(bids, delta.bids);
      applyLevels(asks, delta.asks);
      lastUpdateId = delta.u;
      applied++;
    }
  }

  if (isCrossed(bids, asks)) {
    return resetForResync(state, 'crossed book after applying snapshot');
  }

  return {
    status: 'synced',
    lastUpdateId,
    bids,
    asks,
    buffer: [],
    bufferOverflowed: false,
    resyncReason: null,
    stats: { ...state.stats, deltasApplied: state.stats.deltasApplied + applied },
  };
}

/**
 * Top `limit` levels per side, sorted for display: bids highest first, asks lowest first.
 *
 * Returns fewer than `limit` rows when the book holds fewer levels rather than padding, so
 * the UI decides how to present a thin book. Never indexes blindly into the arrays.
 */
export function topOfBook(
  state: BookState,
  limit = 10
): { bids: BookLevel[]; asks: BookLevel[] } {
  const bids: BookLevel[] = [];
  for (const [price, qty] of state.bids) bids.push({ price, qty });
  bids.sort((a, b) => b.price - a.price);

  const asks: BookLevel[] = [];
  for (const [price, qty] of state.asks) asks.push({ price, qty });
  asks.sort((a, b) => a.price - b.price);

  return { bids: bids.slice(0, limit), asks: asks.slice(0, limit) };
}

/** Mid price in ticks, or null when either side is empty. */
export function midPrice(state: BookState): number | null {
  let bestBid = -Infinity;
  for (const price of state.bids.keys()) if (price > bestBid) bestBid = price;
  let bestAsk = Infinity;
  for (const price of state.asks.keys()) if (price < bestAsk) bestAsk = price;
  if (bestBid === -Infinity || bestAsk === Infinity) return null;
  return (bestBid + bestAsk) / 2;
}

/** Spread in ticks, or null when either side is empty. */
export function spread(state: BookState): number | null {
  let bestBid = -Infinity;
  for (const price of state.bids.keys()) if (price > bestBid) bestBid = price;
  let bestAsk = Infinity;
  for (const price of state.asks.keys()) if (price < bestAsk) bestAsk = price;
  if (bestBid === -Infinity || bestAsk === Infinity) return null;
  return bestAsk - bestBid;
}
