import { CONFIG } from '../config';
import type { Candle, Interval, Millis } from '../protocol/types';

/**
 * The local candle window: history fetched over REST, then kept current from the live feed.
 *
 * Pure functions over an immutable array. No React, no fetch, no timers, so every edge case
 * below is exercised by simply calling a function with a candle.
 *
 * WHY UPSERT BY openTime RATHER THAN APPEND
 * -----------------------------------------
 * At `full` tier the server sends up to ten updates per second for the SAME candle, each a
 * complete snapshot of its current state. Appending would produce ten bars per second
 * instead of one. `openTime` is the candle's identity, so a frame either replaces the entry
 * with that openTime or, if it is genuinely new, extends the window.
 *
 * This also makes duplicate frames free: receiving the same candle twice is a no-op, which
 * matters because a resubscribe after reconnect will re-send the active candle.
 */

export interface CandleWindow {
  interval: Interval;
  /** Ascending by openTime. Never contains two entries with the same openTime. */
  candles: Candle[];
  /** When the window last changed, for the stale badge. */
  updatedAt: Millis | null;
  /** Frames rejected for belonging to another interval. Surfaced in the debug panel. */
  rejectedWrongInterval: number;
  /** Frames rejected for falling outside the retained window. */
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

/**
 * Replace the window with freshly fetched history.
 *
 * The `interval` argument is the interval the RESPONSE was for, checked against the window's
 * current interval. This is the late-response guard at the domain level: if the user changed
 * interval while the request was in flight, the response is discarded rather than painting
 * 1m candles onto a 1s chart. The network layer also tags requests, so this is the second of
 * two independent defences.
 */
export function setHistory(
  window: CandleWindow,
  interval: Interval,
  candles: Candle[],
  now: Millis
): CandleWindow {
  if (interval !== window.interval) {
    return { ...window, rejectedWrongInterval: window.rejectedWrongInterval + 1 };
  }

  // Defensive: drop any candle whose interval disagrees with the payload's own label, then
  // sort and de-duplicate. A well-behaved server sends these already ordered and unique;
  // relying on that would make one server bug corrupt the chart silently.
  const clean = dedupeSorted(candles.filter((c) => c.interval === interval));

  return {
    ...window,
    candles: clean.slice(-CONFIG.MAX_CANDLES),
    updatedAt: now,
  };
}

/**
 * Fold one live or final candle frame into the window.
 *
 * Handles, in order: wrong interval, replacing an existing openTime, appending a newer
 * candle, inserting an out-of-order older candle, and rejecting one that predates the window.
 */
export function upsertCandle(window: CandleWindow, candle: Candle, now: Millis): CandleWindow {
  if (candle.interval !== window.interval) {
    return { ...window, rejectedWrongInterval: window.rejectedWrongInterval + 1 };
  }

  const candles = window.candles;

  // Fast path, and by far the most common: this is the candle at the end of the window
  // being updated in place. Checked first so the usual case costs one comparison.
  const last = candles[candles.length - 1];
  if (last && last.openTime === candle.openTime) {
    const next = candles.slice(0, -1);
    next.push(candle);
    return { ...window, candles: next, updatedAt: now };
  }

  // A brand new candle at the leading edge.
  if (!last || candle.openTime > last.openTime) {
    const next = [...candles, candle];
    return {
      ...window,
      candles: next.length > CONFIG.MAX_CANDLES ? next.slice(-CONFIG.MAX_CANDLES) : next,
      updatedAt: now,
    };
  }

  // Older than everything we hold. This happens after an interval switch when a frame for
  // the previous view is still in flight, or if the window has already scrolled past it.
  // Silently inserting it would grow the array leftward without bound.
  const first = candles[0];
  if (first && candle.openTime < first.openTime) {
    return { ...window, rejectedTooOld: window.rejectedTooOld + 1 };
  }

  // Out-of-order but inside the window: replace by openTime if present, else insert in
  // position. A `final: true` frame arriving after the next candle already opened lands
  // here, and must be applied because it is the authoritative version.
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

/** Switch interval, clearing the window so no candle from the old interval can survive. */
export function changeInterval(window: CandleWindow, interval: Interval): CandleWindow {
  if (interval === window.interval) return window;
  return createCandleWindow(interval);
}

/**
 * Index of the candle with this openTime, or `-(insertionPoint) - 1` when absent.
 *
 * The same convention as Java's `Arrays.binarySearch`: a single return value encodes both
 * "found at i" and "not found, insert at j", so the caller needs one lookup rather than two.
 */
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

/**
 * Sort ascending and collapse duplicate openTimes, keeping the LAST occurrence.
 *
 * Last wins because in a stream the later frame is the more current one: history that ends
 * with the active candle, followed by a live update for that same candle, should leave the
 * live version standing.
 */
function dedupeSorted(candles: Candle[]): Candle[] {
  const byOpenTime = new Map<Millis, Candle>();
  for (const candle of candles) byOpenTime.set(candle.openTime, candle);
  return [...byOpenTime.values()].sort((a, b) => a.openTime - b.openTime);
}

/** The candle currently forming, i.e. the newest one. */
export function activeCandle(window: CandleWindow): Candle | undefined {
  return window.candles[window.candles.length - 1];
}

/** Latest traded price in ticks, or null when the window is empty. */
export function lastPrice(window: CandleWindow): number | null {
  const last = activeCandle(window);
  return last ? last.close : null;
}

/**
 * Price change across the whole visible window, for the header's movement indicator.
 *
 * Measured from the first candle's OPEN rather than its close, so the figure describes the
 * move over the period actually on screen.
 */
export function windowChange(window: CandleWindow): { from: number; to: number } | null {
  const first = window.candles[0];
  const last = activeCandle(window);
  if (!first || !last) return null;
  return { from: first.open, to: last.close };
}

/**
 * Price bounds across the window, padded, for the chart's y-axis.
 *
 * Returns null for an empty window so the caller renders an empty state rather than an axis
 * from 0 to 0. The zero-range case (every candle flat at the same price, which our generator
 * produces during a silent interval) is padded to a visible band instead of collapsing to a
 * single line that would divide by zero in the scale.
 */
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
    // A completely flat window. Manufacture a band so the scale stays invertible.
    const pad = Math.max(1, Math.round(Math.abs(max) * 0.0005));
    return { min: min - pad, max: max + pad };
  }

  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}
