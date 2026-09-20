import type { BookLevel, DepthDelta, DepthSnapshot, PriceTicks, QtyLots } from '../protocol/types';

// Local book from a REST snapshot + WS deltas.
// Buffer first, then snapshot. First delta is a range check (U..u covers last+1);
// after that it's pu === lastUpdateId. Qty is absolute so replays are fine.

export type BookStatus = 'awaiting-snapshot' | 'synced' | 'resync-required';

export interface BookState {
  status: BookStatus;
  lastUpdateId: number;
  bids: Map<PriceTicks, QtyLots>;
  asks: Map<PriceTicks, QtyLots>;
  buffer: DepthDelta[];
  bufferOverflowed: boolean;
  resyncReason: string | null;
  stats: {
    deltasApplied: number;
    deltasIgnored: number;
    resyncCount: number;
    gapCount: number;
  };
}

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

export function resetForResync(state: BookState, reason: string): BookState {
  return {
    ...createBookState(),
    status: 'resync-required', // not awaiting-snapshot — UI shows RESYNCING
    resyncReason: reason,
    stats: { ...state.stats, resyncCount: state.stats.resyncCount + 1 },
  };
}

function applyLevels(target: Map<PriceTicks, QtyLots>, levels: BookLevel[]): void {
  for (const level of levels) {
    if (level.qty <= 0) {
      target.delete(level.price); // 0 = gone, not a zero-size row
    } else {
      target.set(level.price, level.qty);
    }
  }
}

function isCrossed(bids: Map<PriceTicks, QtyLots>, asks: Map<PriceTicks, QtyLots>): boolean {
  let bestBid = -Infinity;
  for (const price of bids.keys()) if (price > bestBid) bestBid = price;
  let bestAsk = Infinity;
  for (const price of asks.keys()) if (price < bestAsk) bestAsk = price;
  if (bestBid === -Infinity || bestAsk === Infinity) return false;
  return bestBid >= bestAsk;
}

export function onDelta(state: BookState, delta: DepthDelta): BookState {
  // keep buffering while we wait for a snapshot, including after a gap
  if (state.status !== 'synced') {
    const buffer = [...state.buffer, delta];
    if (buffer.length > MAX_BUFFER) {
      return { ...state, buffer: buffer.slice(-MAX_BUFFER), bufferOverflowed: true };
    }
    return { ...state, buffer };
  }

  if (delta.u <= state.lastUpdateId) {
    return { ...state, stats: { ...state.stats, deltasIgnored: state.stats.deltasIgnored + 1 } };
  }

  if (delta.pu !== state.lastUpdateId) {
    const reset = resetForResync(state, `gap: expected pu=${state.lastUpdateId}, got pu=${delta.pu}`);
    return {
      ...reset,
      buffer: [delta], // keep the one that showed the hole
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

export function onSnapshot(state: BookState, snapshot: DepthSnapshot): BookState {
  const S = snapshot.lastUpdateId;

  const bids = new Map<PriceTicks, QtyLots>();
  const asks = new Map<PriceTicks, QtyLots>();
  for (const level of snapshot.bids) if (level.qty > 0) bids.set(level.price, level.qty);
  for (const level of snapshot.asks) if (level.qty > 0) asks.set(level.price, level.qty);

  const pending = state.buffer.filter((delta) => delta.u > S);

  if (state.bufferOverflowed && pending.length > 0) {
    return resetForResync(state, 'delta buffer overflowed while awaiting snapshot');
  }

  let lastUpdateId = S;
  let applied = 0;

  if (pending.length > 0) {
    const first = pending[0];
    if (!first) return resetForResync(state, 'internal: empty pending head');

    // first delta after snapshot: range check, not pu === S
    if (!(first.U <= S + 1 && S + 1 <= first.u)) {
      return resetForResync(
        state,
        `snapshot gap: snapshot=${S}, first buffered delta covers ${first.U}..${first.u}`
      );
    }

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

export function midPrice(state: BookState): number | null {
  let bestBid = -Infinity;
  for (const price of state.bids.keys()) if (price > bestBid) bestBid = price;
  let bestAsk = Infinity;
  for (const price of state.asks.keys()) if (price < bestAsk) bestAsk = price;
  if (bestBid === -Infinity || bestAsk === Infinity) return null;
  return (bestBid + bestAsk) / 2;
}

export function spread(state: BookState): number | null {
  let bestBid = -Infinity;
  for (const price of state.bids.keys()) if (price > bestBid) bestBid = price;
  let bestAsk = Infinity;
  for (const price of state.asks.keys()) if (price < bestAsk) bestAsk = price;
  if (bestBid === -Infinity || bestAsk === Infinity) return null;
  return bestAsk - bestBid;
}
