import type { PriceTicks, QtyLots, SymbolInfo } from '../protocol/types';

// ticks/lots stay ints until here
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

export function formatPriceGrouped(ticks: PriceTicks, info: SymbolInfo): string {
  const fixed = formatPrice(ticks, info);
  const [whole = '0', fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function formatQtyCompact(lots: QtyLots, info: SymbolInfo): string {
  const value = lots / info.qtyScale;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(3);
}

export function percentChange(from: PriceTicks, to: PriceTicks): number | null {
  if (from === 0) return null;
  return ((to - from) / from) * 100;
}

export function formatPercent(value: number | null): string {
  if (value === null) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function formatPriceDelta(deltaTicks: number, info: SymbolInfo): string {
  const sign = deltaTicks > 0 ? '+' : deltaTicks < 0 ? '-' : '';
  return `${sign}${formatPrice(Math.abs(deltaTicks), info)}`;
}

export function formatTime(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatTimeMs(ts: number): string {
  const date = new Date(ts);
  return `${formatTime(ts)}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function formatAxisTime(ts: number, showSeconds: boolean): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return showSeconds
    ? `${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatAge(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
}
