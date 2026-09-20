import type { SymbolInfo } from './engine/types';

/**
 * Every tunable in one place, so the README can point here instead of describing
 * numbers that then drift out of date.
 *
 * Anything a demo might want to change is overridable by environment variable.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const PORT = envInt('PORT', 8080);

/**
 * Seeding the generator makes a run reproducible. Change it to get a different but
 * equally deterministic market. Documented in the README so a reviewer can replay
 * the exact market from the screen recording.
 */
export const SEED = envInt('SEED', 42);

export const SYMBOL = process.env.SYMBOL ?? 'BTC-USDT';

/**
 * tickSize 0.01 and lotSize 0.0001, expressed as the integer scale factors used
 * everywhere in the code. See the precision note in engine/types.ts.
 */
export const SYMBOL_INFO: SymbolInfo = {
  symbol: SYMBOL,
  priceScale: 100,
  qtyScale: 10_000,
  priceDecimals: 2,
  qtyDecimals: 4,
};

/** Starting mid price: 104523.45, in ticks. */
export const INITIAL_PRICE_TICKS = envInt('INITIAL_PRICE_TICKS', 10_452_345);

/**
 * Simulation step. The engine wakes on this cadence and generates whatever trades
 * should have occurred in the elapsed window.
 *
 * 50ms is a deliberate compromise: small enough that the live candle feels
 * continuous even at the fastest tier (which delivers every 100ms), large enough
 * that we are not burning CPU on an idle laptop.
 */
export const STEP_MS = envInt('STEP_MS', 50);

/**
 * Target trade arrival rate. Trades are generated as a Poisson process, so this is
 * a mean, not a fixed cadence.
 *
 * 25/s is chosen so that the tiers are visibly different: at 10 updates/sec (full)
 * roughly 2-3 trades are folded into each outgoing chart update, while at 1/s
 * (minimal) roughly 25 are. That makes "multiple trades coalesced into one update,
 * with candle values still correct" a real code path rather than a theoretical one.
 */
export const TRADES_PER_SEC = envInt('TRADES_PER_SEC', 25);

/** Number of price levels maintained per side. The app displays the top 10. */
export const BOOK_LEVELS = envInt('BOOK_LEVELS', 20);

/**
 * How often the book publishes a delta. Real exchanges push depth far faster than
 * this, but 5/s keeps the delta stream readable while still exercising the
 * snapshot/delta synchronization logic.
 */
export const DEPTH_INTERVAL_MS = envInt('DEPTH_INTERVAL_MS', 200);

/** How many closed candles to retain per interval for the REST history endpoint. */
export const CANDLE_HISTORY = envInt('CANDLE_HISTORY', 1_000);

/** Default and maximum number of candles returned by GET /api/v1/klines. */
export const KLINES_DEFAULT_LIMIT = envInt('KLINES_DEFAULT_LIMIT', 300);
export const KLINES_MAX_LIMIT = envInt('KLINES_MAX_LIMIT', 1_000);

/** How many recent trades to retain for the REST endpoint and initial WS payload. */
export const TRADE_HISTORY = envInt('TRADE_HISTORY', 200);
