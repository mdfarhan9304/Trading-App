import type { SymbolInfo } from './engine/types';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const PORT = envInt('PORT', 8080);

export const SEED = envInt('SEED', 42);

export const SYMBOL = process.env.SYMBOL ?? 'BTC-USDT';

export const SYMBOL_INFO: SymbolInfo = {
  symbol: SYMBOL,
  priceScale: 100,
  qtyScale: 10_000,
  priceDecimals: 2,
  qtyDecimals: 4,
};

export const INITIAL_PRICE_TICKS = envInt('INITIAL_PRICE_TICKS', 10_452_345);
export const STEP_MS = envInt('STEP_MS', 50);
export const TRADES_PER_SEC = envInt('TRADES_PER_SEC', 25);
export const BOOK_LEVELS = envInt('BOOK_LEVELS', 20);
export const DEPTH_INTERVAL_MS = envInt('DEPTH_INTERVAL_MS', 200);
export const CANDLE_HISTORY = envInt('CANDLE_HISTORY', 1_000);
export const KLINES_DEFAULT_LIMIT = envInt('KLINES_DEFAULT_LIMIT', 300);
export const KLINES_MAX_LIMIT = envInt('KLINES_MAX_LIMIT', 1_000);
export const TRADE_HISTORY = envInt('TRADE_HISTORY', 200);
