import type { PriceTicks, QtyLots, SymbolInfo } from '../protocol/types';

/**
 * Formatting for display only.
 *
 * This is the ONLY place integer ticks and lots become decimal strings. Everywhere else in
 * the app they stay integers, so no comparison, sum, or candle value is ever computed on a
 * float. Converting early is how precision bugs get in: once a price has been through
 * `parseFloat`, it can no longer be compared for exact equality.
 *
 * The scale factors come from the server's hello frame, so the app never hard-codes how
 * many decimal places a symbol has.
 */

/** Fallback used before the hello frame arrives. Matches the server's BTC-USDT config. */
export const DEFAULT_SYMBOL_INFO: SymbolInfo = {
  symbol: 'BTC-USDT',
  priceScale: 100,
  qtyScale: 10_000,
  priceDecimals: 2,
  qtyDecimals: 4,
};

export function formatPrice(ticks: PriceTicks, info: SymbolInfo): string {
  return (ticks / info.priceScale).toFixed(info.priceDecimals);
}

export function formatQty(lots: QtyLots, info: SymbolInfo): string {
  return (lots / info.qtyScale).toFixed(info.qtyDecimals);
}

/**
 * Price with thousands separators, for the large headline figure.
 *
 * Built by hand rather than with `Intl.NumberFormat` because Hermes ships a reduced ICU by
 * default, so locale-aware formatting is both heavier and less predictable across devices
 * than a five-line implementation for a value whose shape we already know.
 */
export function formatPriceGrouped(ticks: PriceTicks, info: SymbolInfo): string {
  const fixed = formatPrice(ticks, info);
  const [whole = '0', fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/** Compact quantity for dense order book rows, e.g. 1.2345 -> "1.234", 0.0421 -> "0.042". */
export function formatQtyCompact(lots: QtyLots, info: SymbolInfo): string {
  const value = lots / info.qtyScale;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(3);
}

/** Signed percentage change between two tick prices. Returns null if `from` is zero. */
export function percentChange(from: PriceTicks, to: PriceTicks): number | null {
  if (from === 0) return null;
  return ((to - from) / from) * 100;
}

export function formatPercent(value: number | null): string {
  if (value === null) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

/** Signed absolute price change, in display units. */
export function formatPriceDelta(deltaTicks: number, info: SymbolInfo): string {
  const sign = deltaTicks > 0 ? '+' : deltaTicks < 0 ? '-' : '';
  return `${sign}${formatPrice(Math.abs(deltaTicks), info)}`;
}

/** Wall clock as HH:MM:SS, used for trade rows and the crosshair readout. */
export function formatTime(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** HH:MM:SS.mmm, for the crosshair where sub-second intervals need distinguishing. */
export function formatTimeMs(ts: number): string {
  const date = new Date(ts);
  return `${formatTime(ts)}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

/** Short axis label: omits seconds for 1m candles where they are always zero. */
export function formatAxisTime(ts: number, showSeconds: boolean): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return showSeconds
    ? `${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "3.4s ago" style age, for the stale badge. */
export function formatAge(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
}
