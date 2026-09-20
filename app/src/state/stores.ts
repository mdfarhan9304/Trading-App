import { create } from 'zustand';
import { CONFIG } from '../config';
import {
  DEFAULT_WATCHLIST,
  reorderWatchlist,
  upsertWatchlistCoin,
  type WatchlistCoin,
} from '../domain/watchlist';
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

interface MarketState {
  symbolInfo: SymbolInfo;
  symbol: string;
  interval: Interval;

  candles: CandleWindow;
  book: BookState;
  trades: Trade[];

  sessionOpen: number | null;

  setSymbolInfo(symbol: string, info: SymbolInfo): void;
  setInterval(interval: Interval): void;
  setHistory(interval: Interval, candles: Candle[]): void;
  upsertCandle(candle: Candle): void;
  applyDelta(delta: DepthDelta): void;
  applySnapshot(snapshot: DepthSnapshot): void;
  requestResync(reason: string): void;
  addTrades(trades: Trade[]): void;
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
    set({ interval, candles: changeIntervalPure(get().candles, interval), sessionOpen: null });
  },

  setHistory: (interval, candles) => {
    const next = setHistoryPure(get().candles, interval, candles, Date.now());
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

interface ConnectionState {
  status: ConnectionStatus;
  detail: string | null;
  connId: string | null;

  lastFrameAt: number | null;

  malformedFrames: number;
  reconnectAttempts: number;
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
    // ~4/s is enough for the stale badge
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

export function selectIsLive(state: ConnectionState): boolean {
  return state.status === 'live';
}

interface TierStoreState {
  server: TierState | null;
  chartUpdatesSent: number;
  latency: LatencyStats | null;
  measuredHz: number;
  pendingOverride: Tier | 'auto' | null;
  injectedDelayMs: number;

  setServerTier(state: TierState, chartUpdatesSent: number): void;
  setLatency(stats: LatencyStats): void;
  recordChartFrame(): void;
  setPendingOverride(tier: Tier | 'auto' | null): void;
  setInjectedDelay(ms: number): void;
  reset(): void;
}

let chartFrameTimes: number[] = []; // keep this off the store so it doesn't rerender

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
      pendingOverride: null,
    }),

  setLatency: (stats) => set({ latency: stats }),

  recordChartFrame: () => {
    const now = Date.now();
    chartFrameTimes.push(now);
    const cutoff = now - 2_000;
    while (chartFrameTimes.length > 0 && (chartFrameTimes[0] ?? 0) < cutoff) {
      chartFrameTimes.shift();
    }
    const hz = chartFrameTimes.length / 2;
    if (Math.abs(hz - get().measuredHz) >= 0.05) set({ measuredHz: hz });
  },

  setPendingOverride: (tier) => set({ pendingOverride: tier }),
  setInjectedDelay: (ms) => set({ injectedDelayMs: ms }),

  reset: () => {
    chartFrameTimes = [];
    set({ server: null, chartUpdatesSent: 0, latency: null, measuredHz: 0, pendingOverride: null });
  },
}));

export type AppRoute = { name: 'watchlist' } | { name: 'detail'; symbol: string };

interface SessionState {
  route: AppRoute;
  coins: WatchlistCoin[];

  openDetail(symbol: string): void;
  goWatchlist(): void;
  reorder(from: number, to: number): void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  route: { name: 'watchlist' },
  coins: DEFAULT_WATCHLIST,

  openDetail: (symbol) => {
    const coins = upsertWatchlistCoin(get().coins, symbol);
    const route = get().route;
    if (route.name === 'detail' && route.symbol === symbol && coins === get().coins) return;
    set({ coins, route: { name: 'detail', symbol } });
  },

  goWatchlist: () => {
    if (get().route.name === 'watchlist') return;
    set({ route: { name: 'watchlist' } });
  },

  reorder: (from, to) => {
    const coins = reorderWatchlist(get().coins, from, to);
    if (coins === get().coins) return;
    set({ coins });
  },
}));
