import { CONFIG } from '../config';
import type { Candle, Interval, Millis } from '../protocol/types';

// upsert by openTime — same candle can land many times a second
export interface CandleWindow {
  interval: Interval;
  candles: Candle[];
  updatedAt: Millis | null;
  rejectedWrongInterval: number;
  rejectedTooOld: number;
}

export function createCandleWindow(interval: Interval): CandleWindow {
  return {
    interval,
    candles: [],
    updatedAt: null,
    rejectedWrongInterval: 0,
    rejectedTooOld: 0,
  };
}

export function setHistory(
  window: CandleWindow,
  interval: Interval,
  candles: Candle[],
  now: Millis
): CandleWindow {
  if (interval !== window.interval) {
    return { ...window, rejectedWrongInterval: window.rejectedWrongInterval + 1 };
  }

  const clean = dedupeSorted(candles.filter((c) => c.interval === interval));

  return {
    ...window,
    candles: clean.slice(-CONFIG.MAX_CANDLES),
    updatedAt: now,
  };
}

export function upsertCandle(window: CandleWindow, candle: Candle, now: Millis): CandleWindow {
  if (candle.interval !== window.interval) {
    return { ...window, rejectedWrongInterval: window.rejectedWrongInterval + 1 };
  }

  const candles = window.candles;

  const last = candles[candles.length - 1];
  if (last && last.openTime === candle.openTime) {
    const next = candles.slice(0, -1);
    next.push(candle);
    return { ...window, candles: next, updatedAt: now };
  }

  if (!last || candle.openTime > last.openTime) {
    const next = [...candles, candle];
    return {
      ...window,
      candles: next.length > CONFIG.MAX_CANDLES ? next.slice(-CONFIG.MAX_CANDLES) : next,
      updatedAt: now,
    };
  }

  // too old to keep — don't grow the window backwards
  const first = candles[0];
  if (first && candle.openTime < first.openTime) {
    return { ...window, rejectedTooOld: window.rejectedTooOld + 1 };
  }

  const index = binarySearchByOpenTime(candles, candle.openTime);
  if (index >= 0) {
    const next = [...candles];
    next[index] = candle;
    return { ...window, candles: next, updatedAt: now };
  }

  const insertAt = -index - 1;
  const next = [...candles.slice(0, insertAt), candle, ...candles.slice(insertAt)];
  return { ...window, candles: next, updatedAt: now };
}

export function changeInterval(window: CandleWindow, interval: Interval): CandleWindow {
  if (interval === window.interval) return window;
  return createCandleWindow(interval);
}

function binarySearchByOpenTime(candles: Candle[], openTime: Millis): number {
  let low = 0;
  let high = candles.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const candidate = candles[mid];
    if (!candidate) break;
    if (candidate.openTime === openTime) return mid;
    if (candidate.openTime < openTime) low = mid + 1;
    else high = mid - 1;
  }

  return -low - 1;
}

function dedupeSorted(candles: Candle[]): Candle[] {
  const byOpenTime = new Map<Millis, Candle>();
  for (const candle of candles) byOpenTime.set(candle.openTime, candle);
  return [...byOpenTime.values()].sort((a, b) => a.openTime - b.openTime);
}

export function activeCandle(window: CandleWindow): Candle | undefined {
  return window.candles[window.candles.length - 1];
}

export function lastPrice(window: CandleWindow): number | null {
  const last = activeCandle(window);
  return last ? last.close : null;
}

export function windowChange(window: CandleWindow): { from: number; to: number } | null {
  const first = window.candles[0];
  const last = activeCandle(window);
  if (!first || !last) return null;
  return { from: first.open, to: last.close };
}

export function priceBounds(window: CandleWindow): { min: number; max: number } | null {
  if (window.candles.length === 0) return null;

  let min = Infinity;
  let max = -Infinity;
  for (const candle of window.candles) {
    if (candle.low < min) min = candle.low;
    if (candle.high > max) max = candle.high;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

  if (max === min) {
    // flat window — pad so the scale isn't 0
    const pad = Math.max(1, Math.round(Math.abs(max) * 0.0005));
    return { min: min - pad, max: max + pad };
  }

  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}
