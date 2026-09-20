export const LIVE_SYMBOL = 'BTC-USDT';
export const WATCHLIST_ROW_HEIGHT = 72;
export const WATCHLIST_ROW_GAP = 6;
export const WATCHLIST_ROW_STRIDE = WATCHLIST_ROW_HEIGHT + WATCHLIST_ROW_GAP;

export interface WatchlistCoin {
  symbol: string;
  name: string;
  base: string;
}

export const CATALOG: readonly WatchlistCoin[] = [
  { symbol: 'BTC-USDT', name: 'Bitcoin', base: 'BTC' },
  { symbol: 'ETH-USDT', name: 'Ethereum', base: 'ETH' },
  { symbol: 'SOL-USDT', name: 'Solana', base: 'SOL' },
  { symbol: 'BNB-USDT', name: 'BNB', base: 'BNB' },
  { symbol: 'XRP-USDT', name: 'XRP', base: 'XRP' },
];

export const DEFAULT_WATCHLIST: WatchlistCoin[] = CATALOG.map((coin) => ({ ...coin }));

export function isLiveSymbol(symbol: string): boolean {
  return symbol === LIVE_SYMBOL;
}

export function coinFromSymbol(symbol: string): WatchlistCoin {
  const known = CATALOG.find((coin) => coin.symbol === symbol);
  if (known) return { ...known };
  const base = symbol.split('-')[0] ?? symbol;
  return { symbol, name: base, base };
}

export function upsertWatchlistCoin(coins: WatchlistCoin[], symbol: string): WatchlistCoin[] {
  if (coins.some((coin) => coin.symbol === symbol)) return coins;
  return [...coins, coinFromSymbol(symbol)];
}

export function reorderWatchlist<T>(items: T[], from: number, to: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return items;
  if (from === to) return items;
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) return items;

  const next = items.slice();
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return items;
  next.splice(to, 0, moved);
  return next;
}

export function clampIndex(index: number, length: number): number {
  'worklet';
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

export function targetIndexFromDrag(
  from: number,
  translationY: number,
  length: number,
  rowHeight: number
): number {
  'worklet';
  if (rowHeight <= 0) return clampIndex(from, length);
  return clampIndex(from + Math.round(translationY / rowHeight), length);
}

/** How many row-heights a resting row should shift while another is mid-drag. */
export function rowShiftSlots(index: number, dragFrom: number, dragTo: number): number {
  'worklet';
  if (index === dragFrom) return 0;
  if (dragFrom < dragTo && index > dragFrom && index <= dragTo) return -1;
  if (dragFrom > dragTo && index < dragFrom && index >= dragTo) return 1;
  return 0;
}
