import {
  DEFAULT_WATCHLIST,
  LIVE_SYMBOL,
  WATCHLIST_ROW_GAP,
  WATCHLIST_ROW_HEIGHT,
  WATCHLIST_ROW_STRIDE,
  clampIndex,
  coinFromSymbol,
  isLiveSymbol,
  reorderWatchlist,
  rowShiftSlots,
  targetIndexFromDrag,
  upsertWatchlistCoin,
} from '../src/domain/watchlist';
import { routeFromDeepLink } from '../src/util/deeplink';

describe('watchlist reorder', () => {
  const letters = ['A', 'B', 'C', 'D', 'E'];

  it('moves an item down the list', () => {
    expect(reorderWatchlist(letters, 0, 3)).toEqual(['B', 'C', 'D', 'A', 'E']);
  });

  it('moves an item up the list', () => {
    expect(reorderWatchlist(letters, 4, 1)).toEqual(['A', 'E', 'B', 'C', 'D']);
  });

  it('returns the same reference when the index does not change', () => {
    expect(reorderWatchlist(letters, 2, 2)).toBe(letters);
  });

  it('returns the same reference for an out-of-range index', () => {
    expect(reorderWatchlist(letters, -1, 2)).toBe(letters);
    expect(reorderWatchlist(letters, 2, 9)).toBe(letters);
    expect(reorderWatchlist(letters, 1.5, 2)).toBe(letters);
  });

  it('does not mutate the input', () => {
    const input = ['A', 'B', 'C'];
    reorderWatchlist(input, 0, 2);
    expect(input).toEqual(['A', 'B', 'C']);
  });
});

describe('watchlist catalog', () => {
  it('treats only BTC-USDT as the live market', () => {
    expect(isLiveSymbol(LIVE_SYMBOL)).toBe(true);
    expect(isLiveSymbol('ETH-USDT')).toBe(false);
  });

  it('resolves a catalog pair by symbol', () => {
    expect(coinFromSymbol('ETH-USDT')).toEqual({
      symbol: 'ETH-USDT',
      name: 'Ethereum',
      base: 'ETH',
    });
  });

  it('builds a placeholder coin for an unknown valid pair', () => {
    expect(coinFromSymbol('DOGE-USDT')).toEqual({
      symbol: 'DOGE-USDT',
      name: 'DOGE',
      base: 'DOGE',
    });
  });

  it('appends a missing coin and leaves an existing one untouched', () => {
    const same = upsertWatchlistCoin(DEFAULT_WATCHLIST, 'BTC-USDT');
    expect(same).toBe(DEFAULT_WATCHLIST);

    const next = upsertWatchlistCoin(DEFAULT_WATCHLIST, 'DOGE-USDT');
    expect(next).not.toBe(DEFAULT_WATCHLIST);
    expect(next[next.length - 1]).toEqual({
      symbol: 'DOGE-USDT',
      name: 'DOGE',
      base: 'DOGE',
    });
  });
});

describe('drag target', () => {
  it('counts the gap between rows in the drag stride', () => {
    expect(WATCHLIST_ROW_STRIDE).toBe(WATCHLIST_ROW_HEIGHT + WATCHLIST_ROW_GAP);
  });

  it('rounds a downward drag to the nearest row', () => {
    expect(targetIndexFromDrag(1, WATCHLIST_ROW_STRIDE * 2.4, 5, WATCHLIST_ROW_STRIDE)).toBe(3);
  });

  it('clamps a drag that would leave the list', () => {
    expect(targetIndexFromDrag(0, -400, 5, WATCHLIST_ROW_HEIGHT)).toBe(0);
    expect(targetIndexFromDrag(4, 400, 5, WATCHLIST_ROW_HEIGHT)).toBe(4);
  });

  it('clamps an empty list to zero', () => {
    expect(clampIndex(3, 0)).toBe(0);
  });
});

describe('row shift while dragging', () => {
  it('opens a gap below a downward drag', () => {
    expect(rowShiftSlots(2, 0, 3)).toBe(-1);
    expect(rowShiftSlots(0, 0, 3)).toBe(0);
    expect(rowShiftSlots(4, 0, 3)).toBe(0);
  });

  it('opens a gap above an upward drag', () => {
    expect(rowShiftSlots(1, 4, 1)).toBe(1);
    expect(rowShiftSlots(4, 4, 1)).toBe(0);
    expect(rowShiftSlots(0, 4, 1)).toBe(0);
  });
});

describe('deep link to the detail screen', () => {
  it('turns a valid link into a detail route', () => {
    expect(routeFromDeepLink('twospoon://symbol/BTC-USDT')).toEqual({
      name: 'detail',
      symbol: 'BTC-USDT',
    });
  });

  it('returns null instead of a route for a bad link', () => {
    expect(routeFromDeepLink('twospoon://symbol/NOPAIR')).toBeNull();
    expect(routeFromDeepLink(null)).toBeNull();
  });
});
