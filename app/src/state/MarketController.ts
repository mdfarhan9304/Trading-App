import { AppState, type AppStateStatus } from 'react-native';
import { CONFIG } from '../config';
import { LatestRequest, fetchDepth, fetchKlines } from '../net/rest';
import { WsClient, type ConnectionStatus } from '../net/WsClient';
import type { Interval, Tier } from '../protocol/types';
import { useConnectionStore, useMarketStore, useTierStore } from './stores';

class MarketController {
  private ws: WsClient | null = null;

  private klinesRequest = new LatestRequest<{ interval: Interval; candles: Awaited<ReturnType<typeof fetchKlines>>['candles'] }>();
  private depthRequest = new LatestRequest<Awaited<ReturnType<typeof fetchDepth>>>();

  private appStateSub: { remove(): void } | null = null;
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncWatchTimer: ReturnType<typeof setInterval> | null = null;

  private lastSnapshotAt = 0;
  private snapshotInFlight = false;

  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    const interval = useMarketStore.getState().interval;

    this.ws = new WsClient(interval, {
      onStatus: (status, detail) => this.onStatus(status, detail),
      onConnected: (hello) => {
        useConnectionStore.getState().setConnId(hello.connId);
        useMarketStore.getState().setSymbolInfo(hello.symbol, hello.symbolInfo);
        useTierStore.getState().setServerTier(hello.tier, 0);
        this.resyncAll();
      },
      onTrades: (trades) => {
        useMarketStore.getState().addTrades(trades);
        useConnectionStore.getState().markFrame();
      },
      onDepth: (delta) => {
        useMarketStore.getState().applyDelta(delta);
        useConnectionStore.getState().markFrame();
      },
      onCandle: (candle) => {
        useMarketStore.getState().upsertCandle(candle);
        useTierStore.getState().recordChartFrame();
        useConnectionStore.getState().markFrame();
      },
      onTier: (frame) => {
        const { type, chartUpdatesSent, ...state } = frame;
        void type;
        useTierStore.getState().setServerTier(state, chartUpdatesSent);
      },
      onLatency: (stats) => useTierStore.getState().setLatency(stats),
      onServerError: (code, message) => useConnectionStore.getState().addServerError(code, message),
      onMalformed: () => useConnectionStore.getState().countMalformed(),
    });

    this.ws.connect();

    this.appStateSub = AppState.addEventListener('change', (next) => this.onAppStateChange(next));

    this.resyncWatchTimer = setInterval(() => this.checkBookHealth(), 250);
  }

  stop(): void {
    this.started = false;

    this.ws?.dispose();
    this.ws = null;

    this.klinesRequest.cancel();
    this.depthRequest.cancel();

    this.appStateSub?.remove();
    this.appStateSub = null;

    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = null;

    if (this.resyncWatchTimer) clearInterval(this.resyncWatchTimer);
    this.resyncWatchTimer = null;
  }

  private onStatus(status: ConnectionStatus, detail?: string): void {
    useConnectionStore.getState().setStatus(status, detail);
    useConnectionStore.getState().setReconnectAttempts(this.ws?.reconnectAttempts ?? 0);

    if (status === 'reconnecting' || status === 'suspended') {
      this.klinesRequest.cancel();
      this.depthRequest.cancel();
      this.snapshotInFlight = false;
      useMarketStore.getState().requestResync(`connection ${status}`);
    }
  }

  private resyncAll(): void {
    void this.loadHistory(useMarketStore.getState().interval);
    void this.loadSnapshot('connected');
  }

  private async loadHistory(interval: Interval): Promise<void> {
    const result = await this.klinesRequest.run((signal) =>
      fetchKlines(interval, CONFIG.HISTORY_LIMIT, signal)
    );

    if (!result.ok) {
      if (result.reason === 'failed') {
        useConnectionStore.getState().addServerError('klines', describeError(result.error));
      }
      return;
    }

    useMarketStore.getState().setHistory(result.value.interval, result.value.candles);
  }

  private async loadSnapshot(reason: string): Promise<void> {
    const now = Date.now();

    if (now - this.lastSnapshotAt < CONFIG.RESNAPSHOT_MIN_INTERVAL_MS) return;
    if (this.snapshotInFlight) return;

    this.lastSnapshotAt = now;
    this.snapshotInFlight = true;

    try {
      const result = await this.depthRequest.run((signal) => fetchDepth(CONFIG.BOOK_ROWS * 2, signal));
      if (!result.ok) {
        if (result.reason === 'failed') {
          useConnectionStore.getState().addServerError('depth', describeError(result.error));
        }
        return;
      }
      useMarketStore.getState().applySnapshot(result.value);
      void reason;
    } finally {
      this.snapshotInFlight = false;
    }
  }

  private checkBookHealth(): void {
    const { book } = useMarketStore.getState();
    if (book.status === 'synced') return;
    if (useConnectionStore.getState().status !== 'live') return;
    void this.loadSnapshot(book.resyncReason ?? 'book not synced');
  }

  setInterval(interval: Interval): void {
    const market = useMarketStore.getState();
    if (market.interval === interval) return;

    market.setInterval(interval);
    this.ws?.setInterval(interval);
    void this.loadHistory(interval);
  }

  setTier(tier: Tier | 'auto'): void {
    useTierStore.getState().setPendingOverride(tier);
    this.ws?.setTier(tier);
  }

  injectDelay(ms: number): void {
    useTierStore.getState().setInjectedDelay(ms);
    this.ws?.injectDelay(ms);
  }

  forceResync(): void {
    useMarketStore.getState().requestResync('manual (debug)');
    this.lastSnapshotAt = 0;
  }

  forceDisconnect(): void {
    this.ws?.suspend();
    setTimeout(() => this.ws?.resume(), 3_000);
  }

  private onAppStateChange(next: AppStateStatus): void {
    if (next === 'active') {
      if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;

      if (this.ws?.currentStatus === 'suspended' || this.ws?.currentStatus === 'idle') {
        this.ws?.resume();
      } else {
        this.ws?.resumeStream();
        this.resyncAll();
      }
      return;
    }

    this.ws?.pauseStream();
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;
      this.ws?.suspend();
    }, CONFIG.BACKGROUND_GRACE_MS);
  }

  get connectionId(): string | null {
    return this.ws?.currentConnId ?? null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

export const marketController = new MarketController();
