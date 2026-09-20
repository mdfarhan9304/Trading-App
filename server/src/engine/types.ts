// prices = ticks, qty = lots. stay ints so candles don't drift
export type PriceTicks = number;
export type QtyLots = number;

export type Millis = number;
export type Side = 'buy' | 'sell';
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

export interface SymbolInfo {
  symbol: string;
  priceScale: number;
  qtyScale: number;
  priceDecimals: number;
  qtyDecimals: number;
}

export interface Trade {
  id: number;
  ts: Millis;
  price: PriceTicks;
  qty: QtyLots;
  side: Side;
}

export interface BookLevel {
  price: PriceTicks;
  qty: QtyLots;
}

export interface DepthSnapshot {
  symbol: string;
  lastUpdateId: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

// U..u = ids in this event, pu = previous event's u
export interface DepthDelta {
  symbol: string;
  U: number;
  u: number;
  pu: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface Candle {
  interval: Interval;
  openTime: Millis;
  closeTime: Millis;
  open: PriceTicks;
  high: PriceTicks;
  low: PriceTicks;
  close: PriceTicks;
  volume: QtyLots;
  trades: number;
  lastTradeId: number;
  closed: boolean;
}

export function candleOpenTime(ts: Millis, interval: Interval): Millis {
  const size = INTERVAL_MS[interval];
  return Math.floor(ts / size) * size;
}
