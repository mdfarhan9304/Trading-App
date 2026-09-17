import { create } from 'zustand';
import { CONFIG } from '../config';
import {
  createCandleWindow,
  setHistory as setHistoryPure,
  upsertCandle as upsertCandlePure,
  changeInterval as changeIntervalPure,
  type CandleWindow,
} from '../domain/candles';
import {
  createBookState,
  onDelta as onDeltaPure,
  onSnapshot as onSnapshotPure,
  resetForResync as resetForResyncPure,
  type BookState,
} from '../domain/orderBook';
import type { ConnectionStatus } from '../net/WsClient';
import type { LatencyStats } from '../net/latency';
import { DEFAULT_SYMBOL_INFO } from '../util/format';
import type {
  Candle,
  DepthDelta,
  DepthSnapshot,
  Interval,
  SymbolInfo,
  Tier,
  TierState,
  Trade,
} from '../protocol/types';

/**
 * Application state, as three Zustand stores.
 *
 * WHY ZUSTAND
 * -----------
 * At `full` tier this screen receives up to 10 chart frames, 5 depth frames and ~25 trades
 * every second. The state library's job here is to stop those updates from re-rendering
 * components that do not care about them.
 *
 * React Context would fail at exactly that: a single provider value means every consumer
 * becomes eligible to re-render whenever the value identity changes, so a trade arriving
 * would re-render the chart. Redux would work but its boilerplate and immutable-update
 * ceremony buy nothing here, since the reducers already live in `domain/` as pure functions.
 *
 * Zustand gives per-selector subscriptions: `useMarketStore(s => s.book)` re-renders only
 * when the book reference changes. That is why every store method returns NEW objects for
 * the slice it touched and leaves the others untouched by reference.
 *
 * WHY THREE STORES AND NOT TEN
 * ----------------------------
 * Grouped by update frequency and by who reads them. Splitting further would add ceremony
 * without reducing renders, since narrow selectors already do that job.
 */

// ---------------------------------------------------------------------------
// Market data: the hot path
// ---------------------------------------------------------------------------

interface MarketState {
  symbolInfo: SymbolInfo;
  symbol: string;
  interval: Interval;

  candles: CandleWindow;
  book: BookState;
  trades: Trade[];

  /**
   * Close of the last candle at the moment history loaded, used as the reference for the
   * header's movement figure. Held separately so it does not shift as the window scrolls.
   */
  sessionOpen: number | null;

  setSymbolInfo(symbol: string, info: SymbolInfo): void;
  setInterval(interval: Interval): void;
  setHistory(interval: Interval, candles: Candle[]): void;
  upsertCandle(candle: Candle): void;
  applyDelta(delta: DepthDelta): void;
  applySnapshot(snapshot: DepthSnapshot): void;
  requestResync(reason: string): void;
  addTrades(trades: Trade[]): void;
  /** Wipe market data but keep configuration. Used on reconnect before resyncing. */
  clearForResync(): void;
}

export const useMarketStore = create<MarketState>((set, get) => ({
  symbolInfo: DEFAULT_SYMBOL_INFO,
  symbol: DEFAULT_SYMBOL_INFO.symbol,
  interval: '1s',
  candles: createCandleWindow('1s'),
  book: createBookState(),
  trades: [],
  sessionOpen: null,

  setSymbolInfo: (symbol, info) => set({ symbol, symbolInfo: info }),

  setInterval: (interval) => {
    if (get().interval === interval) return;
    // Clear the window rather than keeping it: a 1s candle has no meaning on a 1m chart, and
    // leaving them would briefly render the wrong bars before history arrives.
    set({ interval, candles: changeIntervalPure(get().candles, interval), sessionOpen: null });
  },

  setHistory: (interval, candles) => {
    const next = setHistoryPure(get().candles, interval, candles, Date.now());
    // A mismatched interval is rejected inside the pure function, which leaves the window
    // reference unchanged - so bail out and avoid a pointless re-render.
    if (next === get().candles) return;
    const first = next.candles[0];
    set({ candles: next, sessionOpen: first ? first.open : null });
  },

  upsertCandle: (candle) => {
    const next = upsertCandlePure(get().candles, candle, Date.now());
    if (next === get().candles) return;
    set({ candles: next });
  },

  applyDelta: (delta) => {
    const next = onDeltaPure(get().book, delta);
    if (next === get().book) return;
    set({ book: next });
  },

  applySnapshot: (snapshot) => set({ book: onSnapshotPure(get().book, snapshot) }),

  requestResync: (reason) => set({ book: resetForResyncPure(get().book, reason) }),

  addTrades: (incoming) => {
    if (incoming.length === 0) return;
    const merged = [...get().trades, ...incoming];
    // Newest last, bounded. Trades arrive in id order, so no sort is needed; the bound is
    // what keeps this array from growing all session.
    set({
      trades: merged.length > CONFIG.TRADE_ROWS ? merged.slice(-CONFIG.TRADE_ROWS) : merged,
    });
  },

  clearForResync: () =>
    set({
      candles: createCandleWindow(get().interval),
      book: createBookState(),
      trades: [],
      sessionOpen: null,
    }),
}));

// ---------------------------------------------------------------------------
// Connection: status and diagnostics
// ---------------------------------------------------------------------------

interface ConnectionState {
  status: ConnectionStatus;
  detail: string | null;
  connId: string | null;

  /**
   * When a data frame last arrived. This is what "stale" is computed from: the socket can
   * report itself open while nothing is actually flowing.
   */
  lastFrameAt: number | null;

  malformedFrames: number;
  reconnectAttempts: number;
  /** Most recent server error frames, newest first, bounded. */
  serverErrors: { code: string; message: string; at: number }[];

  setStatus(status: ConnectionStatus, detail?: string): void;
  setConnId(connId: string | null): void;
  markFrame(): void;
  countMalformed(): void;
  addServerError(code: string, message: string): void;
  setReconnectAttempts(n: number): void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: 'idle',
  detail: null,
  connId: null,
  lastFrameAt: null,
  malformedFrames: 0,
  reconnectAttempts: 0,
  serverErrors: [],

  setStatus: (status, detail) => set({ status, detail: detail ?? null }),
  setConnId: (connId) => set({ connId }),

  markFrame: () => {
    // Throttled to ~4/s. Writing this on every frame would re-render the staleness badge ten
    // times a second to show a number that only needs to change a few times a second.
    const now = Date.now();
    const last = get().lastFrameAt;
    if (last !== null && now - last < 250) return;
    set({ lastFrameAt: now });
  },

  countMalformed: () => set({ malformedFrames: get().malformedFrames + 1 }),

  addServerError: (code, message) =>
    set({ serverErrors: [{ code, message, at: Date.now() }, ...get().serverErrors].slice(0, 10) }),

  setReconnectAttempts: (n) => set({ reconnectAttempts: n }),
}));

/**
 * Whether displayed values represent live data.
 *
 * A selector rather than stored state, so it can never disagree with `status`. The assignment
 * requires cached values be shown as stale rather than presented as live, and everything in
 * the UI keys off this one predicate.
 */
export function selectIsLive(state: ConnectionState): boolean {
  return state.status === 'live';
}

// ---------------------------------------------------------------------------
// Tier: what the server decided, and what we actually measured
// ---------------------------------------------------------------------------

interface TierStoreState {
  /** The server's view. It owns the decision; we only display it. */
  server: TierState | null;
  chartUpdatesSent: number;

  /** Our own RTT/jitter measurements, which we report to the server. */
  latency: LatencyStats | null;

  /**
   * Chart frames per second as MEASURED BY THE APP over a rolling window.
   *
   * Deliberately independent of the server's declared target. Showing both side by side is
   * what makes the tier system verifiable rather than merely claimed: if the badge says
   * "10/s target" and we are receiving 4/s, something is wrong and it is visible.
   */
  measuredHz: number;

  /** Local override request, echoed until the server confirms. */
  pendingOverride: Tier | 'auto' | null;
  injectedDelayMs: number;

  setServerTier(state: TierState, chartUpdatesSent: number): void;
  setLatency(stats: LatencyStats): void;
  recordChartFrame(): void;
  setPendingOverride(tier: Tier | 'auto' | null): void;
  setInjectedDelay(ms: number): void;
  reset(): void;
}

/** Timestamps of recent chart frames, for the rolling rate. Outside the store: mutating an */
/** array here must not trigger a re-render, only the derived number should.               */
let chartFrameTimes: number[] = [];

export const useTierStore = create<TierStoreState>((set, get) => ({
  server: null,
  chartUpdatesSent: 0,
  latency: null,
  measuredHz: 0,
  pendingOverride: null,
  injectedDelayMs: 0,

  setServerTier: (state, chartUpdatesSent) =>
    set({
      server: state,
      chartUpdatesSent,
      // The server has spoken, so any locally pending override request is resolved.
      pendingOverride: null,
    }),

  setLatency: (stats) => set({ latency: stats }),

  recordChartFrame: () => {
    const now = Date.now();
    chartFrameTimes.push(now);
    // Keep a 2-second window: long enough that 1/s at minimal tier is measurable at all,
    // short enough to react promptly to a tier change.
    const cutoff = now - 2_000;
    while (chartFrameTimes.length > 0 && (chartFrameTimes[0] ?? 0) < cutoff) {
      chartFrameTimes.shift();
    }
    const hz = chartFrameTimes.length / 2;
    // Only write when the displayed value would actually change, to one decimal place.
    if (Math.abs(hz - get().measuredHz) >= 0.05) set({ measuredHz: hz });
  },

  setPendingOverride: (tier) => set({ pendingOverride: tier }),
  setInjectedDelay: (ms) => set({ injectedDelayMs: ms }),

  reset: () => {
    chartFrameTimes = [];
    set({ server: null, chartUpdatesSent: 0, latency: null, measuredHz: 0, pendingOverride: null });
  },
}));
