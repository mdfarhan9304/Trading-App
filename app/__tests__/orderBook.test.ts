import {
  createBookState,
  midPrice,
  onDelta,
  onSnapshot,
  resetForResync,
  spread,
  topOfBook,
  type BookState,
} from '../src/domain/orderBook';
import type { DepthDelta, DepthSnapshot } from '../src/protocol/types';

/**
 * Order book snapshot/delta synchronisation and recovery.
 *
 * This is one of the two tests the assignment specifically recommends. It covers the race
 * the requirement names - "Handle updates that arrive while the snapshot request is in
 * flight" - plus gap detection and recovery.
 *
 * The reducer is pure, so every scenario is a sequence of function calls. There is no
 * socket, no fetch, no timer, and no React. That is the entire reason it was written as a
 * reducer: this behaviour is almost impossible to test through a live connection, because
 * you cannot reliably provoke a delta arriving mid-request on demand.
 */

/** Build a delta. Quantities are integer lots, prices integer ticks, as on the wire. */
function delta(U: number, u: number, pu: number, bids: [number, number][] = [], asks: [number, number][] = []): DepthDelta {
  return {
    symbol: 'BTC-USDT',
    U,
    u,
    pu,
    bids: bids.map(([price, qty]) => ({ price, qty })),
    asks: asks.map(([price, qty]) => ({ price, qty })),
  };
}

function snapshot(lastUpdateId: number, bids: [number, number][], asks: [number, number][]): DepthSnapshot {
  return {
    symbol: 'BTC-USDT',
    lastUpdateId,
    bids: bids.map(([price, qty]) => ({ price, qty })),
    asks: asks.map(([price, qty]) => ({ price, qty })),
  };
}

/** A plausible starting book: bids below 10000, asks above. */
const BASE_BIDS: [number, number][] = [
  [9_995, 100],
  [9_990, 200],
  [9_985, 300],
];
const BASE_ASKS: [number, number][] = [
  [10_005, 100],
  [10_010, 200],
  [10_015, 300],
];

describe('initial state', () => {
  it('starts awaiting a snapshot with nothing displayable', () => {
    const state = createBookState();
    expect(state.status).toBe('awaiting-snapshot');
    expect(state.bids.size).toBe(0);
    expect(state.asks.size).toBe(0);
    expect(state.lastUpdateId).toBe(0);
  });
});

describe('the in-flight race: deltas arriving while the snapshot request is open', () => {
  it('buffers deltas instead of applying or discarding them', () => {
    let state = createBookState();
    state = onDelta(state, delta(100, 102, 99, [[9_995, 150]]));
    state = onDelta(state, delta(103, 105, 102, [[9_990, 250]]));

    expect(state.buffer).toHaveLength(2);
    // Crucially, nothing was applied: without a snapshot there is no base to apply onto.
    expect(state.bids.size).toBe(0);
    expect(state.status).toBe('awaiting-snapshot');
  });

  it('replays buffered deltas that postdate the snapshot', () => {
    let state = createBookState();

    // These arrived while the HTTP request was in flight.
    state = onDelta(state, delta(106, 108, 105, [[9_995, 500]]));
    state = onDelta(state, delta(109, 111, 108, [[9_990, 600]]));

    state = onSnapshot(state, snapshot(105, BASE_BIDS, BASE_ASKS));

    expect(state.status).toBe('synced');
    // Snapshot value 100 was superseded by the buffered delta's 500.
    expect(state.bids.get(9_995)).toBe(500);
    expect(state.bids.get(9_990)).toBe(600);
    // Untouched level retains its snapshot value.
    expect(state.bids.get(9_985)).toBe(300);
    // The chain now continues from the last replayed delta, not from the snapshot.
    expect(state.lastUpdateId).toBe(111);
    expect(state.buffer).toHaveLength(0);
  });

  it('discards buffered deltas already contained in the snapshot', () => {
    let state = createBookState();

    // Both of these predate the snapshot: their changes are already baked in.
    state = onDelta(state, delta(90, 95, 89, [[9_995, 999]]));
    state = onDelta(state, delta(96, 100, 95, [[9_990, 888]]));

    state = onSnapshot(state, snapshot(105, BASE_BIDS, BASE_ASKS));

    expect(state.status).toBe('synced');
    // Snapshot values stand; the stale deltas did not overwrite them with older data.
    expect(state.bids.get(9_995)).toBe(100);
    expect(state.bids.get(9_990)).toBe(200);
    expect(state.lastUpdateId).toBe(105);
  });

  it('handles a mix of stale and fresh buffered deltas', () => {
    let state = createBookState();
    state = onDelta(state, delta(90, 100, 89, [[9_995, 111]])); // stale, u <= 105
    state = onDelta(state, delta(101, 105, 100, [[9_990, 222]])); // stale, u == 105
    state = onDelta(state, delta(106, 110, 105, [[9_985, 333]])); // fresh
    state = onSnapshot(state, snapshot(105, BASE_BIDS, BASE_ASKS));

    expect(state.status).toBe('synced');
    expect(state.bids.get(9_995)).toBe(100); // from snapshot
    expect(state.bids.get(9_990)).toBe(200); // from snapshot
    expect(state.bids.get(9_985)).toBe(333); // from the fresh delta
    expect(state.lastUpdateId).toBe(110);
  });

  it('syncs cleanly when nothing was buffered at all', () => {
    let state = createBookState();
    state = onSnapshot(state, snapshot(105, BASE_BIDS, BASE_ASKS));

    expect(state.status).toBe('synced');
    expect(state.lastUpdateId).toBe(105);
    expect(state.bids.size).toBe(3);
  });
});

describe('the first-delta bracket check', () => {
  /**
   * The subtle case, and the reason the first delta is validated by RANGE rather than by
   * chain. Our server's snapshot `lastUpdateId` includes mutations it has not published yet,
   * so the next delta can legitimately carry a `pu` LOWER than the snapshot id.
   */
  it('accepts a first delta whose pu is below the snapshot id', () => {
    let state = createBookState();
    // Snapshot at 105, but this delta covers 100..110 with pu=99.
    state = onDelta(state, delta(100, 110, 99, [[9_995, 777]]));
    state = onSnapshot(state, snapshot(105, BASE_BIDS, BASE_ASKS));

    // A naive `pu === 105` check would have rejected this and resynced for no reason.
    expect(state.status).toBe('synced');
    expect(state.bids.get(9_995)).toBe(777);
    expect(state.lastUpdateId).toBe(110);
  });

  it('accepts a delta that starts exactly at the next id', () => {
    let state = createBookState();
    state = onDelta(state, delta(106, 108, 105));
    state = onSnapshot(state, snapshot(105, BASE_BIDS, BASE_ASKS));
    expect(state.status).toBe('synced');
  });

  it('rejects a delta that starts beyond the next id, proving a gap', () => {
    let state = createBookState();
    // 106 and 107 were never received: this delta begins at 108.
    state = onDelta(state, delta(108, 110, 107));
    state = onSnapshot(state, snapshot(105, BASE_BIDS, BASE_ASKS));

    expect(state.status).toBe('resync-required');
    expect(state.resyncReason).toContain('snapshot gap');
    expect(state.stats.resyncCount).toBe(1);
  });

  it('detects a gap in the middle of the replayed buffer', () => {
    let state = createBookState();
    state = onDelta(state, delta(106, 108, 105));
    // 109 is missing: this one claims to follow 109, not 108.
    state = onDelta(state, delta(110, 112, 109));
    state = onSnapshot(state, snapshot(105, BASE_BIDS, BASE_ASKS));

    expect(state.status).toBe('resync-required');
    expect(state.resyncReason).toContain('gap while replaying buffer');
  });
});

describe('the steady-state chain check', () => {
  function synced(): BookState {
    return onSnapshot(createBookState(), snapshot(105, BASE_BIDS, BASE_ASKS));
  }

  it('applies a delta that chains correctly', () => {
    let state = synced();
    state = onDelta(state, delta(106, 108, 105, [[9_995, 400]]));

    expect(state.status).toBe('synced');
    expect(state.bids.get(9_995)).toBe(400);
    expect(state.lastUpdateId).toBe(108);
    expect(state.stats.deltasApplied).toBe(1);
  });

  it('applies a long run of chained deltas', () => {
    let state = synced();
    let pu = 105;
    for (let i = 0; i < 50; i++) {
      const U = pu + 1;
      const u = pu + 3;
      state = onDelta(state, delta(U, u, pu, [[9_995, 100 + i]]));
      pu = u;
    }
    expect(state.status).toBe('synced');
    expect(state.lastUpdateId).toBe(pu);
    expect(state.bids.get(9_995)).toBe(149);
    expect(state.stats.deltasApplied).toBe(50);
  });

  it('requests a resync when pu does not chain', () => {
    let state = synced();
    state = onDelta(state, delta(106, 108, 105));
    // Next event should have pu=108 but claims 200: at least one event was lost.
    state = onDelta(state, delta(201, 203, 200));

    expect(state.status).toBe('resync-required');
    expect(state.resyncReason).toContain('gap: expected pu=108');
    expect(state.stats.gapCount).toBe(1);
  });

  it('ignores a duplicate delta idempotently', () => {
    let state = synced();
    const event = delta(106, 108, 105, [[9_995, 400]]);
    state = onDelta(state, event);
    state = onDelta(state, event);

    // Still synced, not resynced: a replay is harmless because quantities are absolute.
    expect(state.status).toBe('synced');
    expect(state.bids.get(9_995)).toBe(400);
    expect(state.lastUpdateId).toBe(108);
    expect(state.stats.deltasApplied).toBe(1);
    expect(state.stats.deltasIgnored).toBe(1);
  });

  it('ignores an out-of-order older delta', () => {
    let state = synced();
    state = onDelta(state, delta(106, 120, 105, [[9_995, 400]]));
    // An older event arriving late. Applying it would revert a newer value.
    state = onDelta(state, delta(107, 110, 106, [[9_995, 1]]));

    expect(state.status).toBe('synced');
    expect(state.bids.get(9_995)).toBe(400);
    expect(state.lastUpdateId).toBe(120);
    expect(state.stats.deltasIgnored).toBe(1);
  });

  it('does not keep resyncing once a resync is already pending', () => {
    let state = synced();
    state = onDelta(state, delta(500, 502, 499)); // gap -> resync
    expect(state.status).toBe('resync-required');
    const afterFirst = state.stats.resyncCount;

    // Further deltas while waiting must not inflate the resync count.
    state = onDelta(state, delta(503, 505, 502));
    state = onDelta(state, delta(506, 508, 505));
    expect(state.stats.resyncCount).toBe(afterFirst);
  });
});

describe('level semantics', () => {
  function synced(): BookState {
    return onSnapshot(createBookState(), snapshot(105, BASE_BIDS, BASE_ASKS));
  }

  it('treats zero quantity as a deletion, not a level worth zero', () => {
    let state = synced();
    expect(state.bids.has(9_990)).toBe(true);

    state = onDelta(state, delta(106, 106, 105, [[9_990, 0]]));

    expect(state.bids.has(9_990)).toBe(false);
    expect(state.bids.size).toBe(2);
    // And it must not appear as a zero row in the display.
    expect(topOfBook(state).bids.some((l) => l.price === 9_990)).toBe(false);
  });

  it('ignores deletion of a level that was never present', () => {
    let state = synced();
    const before = state.bids.size;
    state = onDelta(state, delta(106, 106, 105, [[1_234, 0]]));
    expect(state.bids.size).toBe(before);
    expect(state.status).toBe('synced');
  });

  it('drops zero-quantity levels present in a snapshot', () => {
    const state = onSnapshot(
      createBookState(),
      snapshot(105, [...BASE_BIDS, [9_980, 0]], BASE_ASKS)
    );
    expect(state.bids.has(9_980)).toBe(false);
    expect(state.bids.size).toBe(3);
  });

  it('adds a brand new price level', () => {
    let state = synced();
    state = onDelta(state, delta(106, 106, 105, [[9_980, 450]]));
    expect(state.bids.get(9_980)).toBe(450);
  });
});

describe('corruption detection', () => {
  it('resyncs when a delta crosses the book', () => {
    let state = onSnapshot(createBookState(), snapshot(105, BASE_BIDS, BASE_ASKS));
    // A bid at 10_020 sits above the best ask of 10_005, which cannot happen in a
    // correctly synchronised feed.
    state = onDelta(state, delta(106, 106, 105, [[10_020, 100]]));

    expect(state.status).toBe('resync-required');
    expect(state.resyncReason).toContain('crossed');
  });

  it('resyncs when a snapshot itself is crossed', () => {
    const state = onSnapshot(
      createBookState(),
      snapshot(105, [[10_020, 100]], [[10_005, 100]])
    );
    expect(state.status).toBe('resync-required');
  });

  it('does not flag a one-sided book as crossed', () => {
    // A book with only bids has no ask to cross against and must remain usable.
    const state = onSnapshot(createBookState(), snapshot(105, BASE_BIDS, []));
    expect(state.status).toBe('synced');
    expect(topOfBook(state).asks).toHaveLength(0);
  });

  it('resyncs when the delta buffer overflowed while awaiting a snapshot', () => {
    let state = createBookState();
    // Far more than MAX_BUFFER, so the oldest were discarded and the buffer has a hole.
    let pu = 1_000;
    for (let i = 0; i < 600; i++) {
      state = onDelta(state, delta(pu + 1, pu + 2, pu));
      pu += 2;
    }
    expect(state.bufferOverflowed).toBe(true);

    state = onSnapshot(state, snapshot(900, BASE_BIDS, BASE_ASKS));
    expect(state.status).toBe('resync-required');
    expect(state.resyncReason).toContain('overflow');
  });
});

describe('recovery', () => {
  it('returns to synced after a gap and a fresh snapshot', () => {
    let state = onSnapshot(createBookState(), snapshot(105, BASE_BIDS, BASE_ASKS));

    // A gap knocks it out of sync.
    state = onDelta(state, delta(500, 502, 499));
    expect(state.status).toBe('resync-required');
    expect(state.bids.size).toBe(0); // the stale book was discarded

    // The delta that revealed the gap is retained rather than thrown away, so the buffer
    // already holds one entry before any new delta arrives.
    expect(state.buffer).toHaveLength(1);

    // While the new snapshot is in flight, deltas keep buffering.
    state = onDelta(state, delta(600, 602, 599, [[9_995, 42]]));
    expect(state.buffer).toHaveLength(2);

    // The fresh snapshot lands and the buffered delta replays on top.
    state = onSnapshot(state, snapshot(599, BASE_BIDS, BASE_ASKS));
    expect(state.status).toBe('synced');
    expect(state.bids.get(9_995)).toBe(42);
    expect(state.lastUpdateId).toBe(602);
  });

  it('carries resync statistics across a reset so they are not lost', () => {
    let state = onSnapshot(createBookState(), snapshot(105, BASE_BIDS, BASE_ASKS));
    state = onDelta(state, delta(106, 108, 105));
    expect(state.stats.deltasApplied).toBe(1);

    state = resetForResync(state, 'manual');
    // A reset reports `resync-required` so the UI can distinguish "recovering from a gap"
    // from a normal cold start, even though delta handling is identical in both.
    expect(state.status).toBe('resync-required');
    expect(state.stats.deltasApplied).toBe(1); // preserved
    expect(state.stats.resyncCount).toBe(1);
  });

  it('survives repeated gap-and-recover cycles', () => {
    let state = onSnapshot(createBookState(), snapshot(100, BASE_BIDS, BASE_ASKS));

    for (let cycle = 0; cycle < 5; cycle++) {
      const base = 1_000 * (cycle + 1);
      state = onDelta(state, delta(base, base + 2, base - 1)); // gap
      expect(state.status).toBe('resync-required');
      state = onSnapshot(state, snapshot(base + 100, BASE_BIDS, BASE_ASKS));
      expect(state.status).toBe('synced');
    }

    expect(state.stats.resyncCount).toBe(5);
    expect(state.stats.gapCount).toBe(5);
  });
});

describe('display projection', () => {
  it('sorts bids descending and asks ascending', () => {
    const state = onSnapshot(
      createBookState(),
      snapshot(
        1,
        [
          [9_985, 300],
          [9_995, 100],
          [9_990, 200],
        ],
        [
          [10_015, 300],
          [10_005, 100],
          [10_010, 200],
        ]
      )
    );

    const { bids, asks } = topOfBook(state);
    expect(bids.map((l) => l.price)).toEqual([9_995, 9_990, 9_985]);
    expect(asks.map((l) => l.price)).toEqual([10_005, 10_010, 10_015]);
  });

  it('limits to the requested number of rows', () => {
    const manyBids: [number, number][] = [];
    const manyAsks: [number, number][] = [];
    for (let i = 0; i < 20; i++) {
      manyBids.push([9_995 - i * 5, 100 + i]);
      manyAsks.push([10_005 + i * 5, 100 + i]);
    }
    const state = onSnapshot(createBookState(), snapshot(1, manyBids, manyAsks));

    const { bids, asks } = topOfBook(state, 10);
    expect(bids).toHaveLength(10);
    expect(asks).toHaveLength(10);
    expect(bids[0]?.price).toBe(9_995); // best bid first
    expect(asks[0]?.price).toBe(10_005); // best ask first
  });

  it('returns fewer rows than requested for a thin book rather than padding', () => {
    const state = onSnapshot(createBookState(), snapshot(1, [[9_995, 100]], [[10_005, 100]]));
    const { bids, asks } = topOfBook(state, 10);
    expect(bids).toHaveLength(1);
    expect(asks).toHaveLength(1);
  });

  it('reports mid and spread, and null when a side is empty', () => {
    const state = onSnapshot(createBookState(), snapshot(1, BASE_BIDS, BASE_ASKS));
    expect(midPrice(state)).toBe(10_000);
    expect(spread(state)).toBe(10);

    const oneSided = onSnapshot(createBookState(), snapshot(1, BASE_BIDS, []));
    expect(midPrice(oneSided)).toBeNull();
    expect(spread(oneSided)).toBeNull();
  });

  it('returns empty rows for an empty book without throwing', () => {
    const state = createBookState();
    const { bids, asks } = topOfBook(state);
    expect(bids).toEqual([]);
    expect(asks).toEqual([]);
    expect(midPrice(state)).toBeNull();
  });
});

describe('immutability', () => {
  it('does not mutate the state passed in', () => {
    const state = onSnapshot(createBookState(), snapshot(105, BASE_BIDS, BASE_ASKS));
    const bidsBefore = new Map(state.bids);

    const next = onDelta(state, delta(106, 108, 105, [[9_995, 999]]));

    // The original is untouched, which is what lets Zustand subscribers compare by
    // reference and skip re-rendering when nothing they care about changed.
    expect(state.bids).toEqual(bidsBefore);
    expect(state.lastUpdateId).toBe(105);
    expect(next.lastUpdateId).toBe(108);
    expect(next.bids).not.toBe(state.bids);
  });
});
