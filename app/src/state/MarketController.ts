import { AppState, type AppStateStatus } from 'react-native';
import { CONFIG } from '../config';
import { LatestRequest, fetchDepth, fetchKlines } from '../net/rest';
import { WsClient, type ConnectionStatus } from '../net/WsClient';
import type { Interval, Tier } from '../protocol/types';
import { useConnectionStore, useMarketStore, useTierStore } from './stores';

/**
 * Orchestration: owns the socket and the REST requests, and drives the stores.
 *
 * This is the only place that knows about BOTH networking and application state. Keeping it
 * separate means `net/` stays free of app concerns, `domain/` stays pure, `state/` stays a
 * dumb container, and the UI never touches a socket. That is the separation the assignment
 * asks for ("Keep UI, application state, networking, and backend feed logic distinct").
 *
 * A single instance, created once per app run. It is not a hook because its lifetime is the
 * app's, not a component's - a socket that reconnects whenever a component remounts would be
 * a bug, not a feature.
 */
class MarketController {
  private ws: WsClient | null = null;

  /** Only the newest klines and depth requests can produce a usable result. */
  private klinesRequest = new LatestRequest<{ interval: Interval; candles: Awaited<ReturnType<typeof fetchKlines>>['candles'] }>();
  private depthRequest = new LatestRequest<Awaited<ReturnType<typeof fetchDepth>>>();

  private appStateSub: { remove(): void } | null = null;
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncWatchTimer: ReturnType<typeof setInterval> | null = null;

  /** Last time a depth snapshot was requested, for rate limiting. */
  private lastSnapshotAt = 0;
  private snapshotInFlight = false;

  private started = false;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

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
        // A new socket means our cached book and candles may be arbitrarily stale, so
        // resynchronise from scratch rather than trying to patch them up.
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

    /**
     * Watch for the book asking to be resynchronised.
     *
     * Polling a store rather than reacting inside `applyDelta` is deliberate: the gap is
     * detected inside a pure reducer, and having that reducer trigger a network request would
     * make it impure and untestable. A 250ms check is far faster than a human notices and
     * keeps the reducer honest.
     */
    this.resyncWatchTimer = setInterval(() => this.checkBookHealth(), 250);
  }

  /** Full teardown: socket, timers, subscriptions, in-flight requests. */
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
      // Abandon in-flight requests: their results would apply to a session that has ended.
      // The book is marked as needing resync so the UI shows it as stale rather than live.
      this.klinesRequest.cancel();
      this.depthRequest.cancel();
      this.snapshotInFlight = false;
      useMarketStore.getState().requestResync(`connection ${status}`);
    }
  }

  // -------------------------------------------------------------------------
  // Resynchronisation
  // -------------------------------------------------------------------------

  /** Fetch history and a fresh depth snapshot. Called on every (re)connection. */
  private resyncAll(): void {
    void this.loadHistory(useMarketStore.getState().interval);
    void this.loadSnapshot('connected');
  }

  /**
   * Fetch candle history for `interval`.
   *
   * Guarded twice against the late-response race: `LatestRequest` discards a superseded
   * result, and the store's `setHistory` rejects a payload whose interval no longer matches
   * what is displayed. Either alone would be sufficient in most cases; together they make the
   * race impossible rather than unlikely.
   */
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

    // Empty history is valid, not an error: a backend that just started has no closed
    // candles yet. The store accepts it and the chart renders an empty state.
    useMarketStore.getState().setHistory(result.value.interval, result.value.candles);
  }

  /**
   * Fetch a depth snapshot, rate limited.
   *
   * The socket is already open and buffering deltas by the time this runs, which is the
   * ordering the whole synchronisation scheme depends on - see domain/orderBook.ts.
   */
  private async loadSnapshot(reason: string): Promise<void> {
    const now = Date.now();

    // Rate limit. Without this, a persistently broken feed produces gap -> snapshot -> gap
    // in a tight loop, hammering the server while never recovering.
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
      // Deltas that arrived while this request was in flight are sitting in the reducer's
      // buffer, and onSnapshot reconciles them against this snapshot's lastUpdateId.
      useMarketStore.getState().applySnapshot(result.value);
      void reason;
    } finally {
      this.snapshotInFlight = false;
    }
  }

  /** If the reducer has asked for a resync, satisfy it. */
  private checkBookHealth(): void {
    const { book } = useMarketStore.getState();
    if (book.status === 'synced') return;
    if (useConnectionStore.getState().status !== 'live') return;
    void this.loadSnapshot(book.resyncReason ?? 'book not synced');
  }

  // -------------------------------------------------------------------------
  // User actions
  // -------------------------------------------------------------------------

  /**
   * Change the chart interval.
   *
   * Order matters: clear local state first so the old interval's candles cannot be shown
   * under the new label even for one frame, then tell the server, then fetch history.
   */
  setInterval(interval: Interval): void {
    const market = useMarketStore.getState();
    if (market.interval === interval) return;

    market.setInterval(interval);
    this.ws?.setInterval(interval);
    void this.loadHistory(interval);
  }

  /** Debug control: force a tier, or hand control back to the automatic machine. */
  setTier(tier: Tier | 'auto'): void {
    useTierStore.getState().setPendingOverride(tier);
    this.ws?.setTier(tier);
  }

  /**
   * Debug control: make the server delay its pong replies.
   *
   * Unlike a forced tier, this drives the AUTOMATIC state machine: measured RTT genuinely
   * rises, so the tier changes through the real hysteresis path. It is the only practical way
   * to demonstrate automatic behaviour on a good network.
   */
  injectDelay(ms: number): void {
    useTierStore.getState().setInjectedDelay(ms);
    this.ws?.injectDelay(ms);
  }

  /** Manual resync button, for demonstrating book recovery on camera. */
  forceResync(): void {
    useMarketStore.getState().requestResync('manual (debug)');
    // Bypass the rate limit so the demo responds immediately to a button press.
    this.lastSnapshotAt = 0;
  }

  /** Drop the socket, to demonstrate reconnection and the stale state. */
  forceDisconnect(): void {
    this.ws?.suspend();
    // Come back shortly so the demo shows the full stale-then-recover cycle.
    setTimeout(() => this.ws?.resume(), 3_000);
  }

  // -------------------------------------------------------------------------
  // App lifecycle
  // -------------------------------------------------------------------------

  /**
   * Foreground/background handling.
   *
   * Backgrounding does not close the socket immediately. A brief switch away - checking a
   * notification, answering a call - should not cost a full resync when the user returns.
   * Instead we tell the server to stop chart delivery (saving its work and our battery) and
   * only close the socket if the app stays backgrounded past the grace period.
   *
   * Coming back always triggers a full resync, because we cannot know how much we missed.
   */
  private onAppStateChange(next: AppStateStatus): void {
    if (next === 'active') {
      if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;

      if (this.ws?.currentStatus === 'suspended' || this.ws?.currentStatus === 'idle') {
        this.ws?.resume();
        // resyncAll runs from onConnected once the new socket says hello.
      } else {
        this.ws?.resumeStream();
        // The socket survived, but we were not receiving while backgrounded, so the book and
        // history are both suspect.
        this.resyncAll();
      }
      return;
    }

    // 'background' or 'inactive'
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

/** The single instance for the app's lifetime. */
export const marketController = new MarketController();
