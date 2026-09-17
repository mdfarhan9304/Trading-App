import { CONFIG, getWsUrl } from '../config';
import { LatencySampler, type LatencyStats } from './latency';
import {
  parseServerFrame,
  type Candle,
  type DepthDelta,
  type HelloFrame,
  type Interval,
  type Tier,
  type TierFrame,
  type Trade,
} from '../protocol/types';

/**
 * WebSocket transport: connection lifecycle, latency probing, and frame dispatch.
 *
 * Deliberately contains no application state - no book, no candles, no React. It turns a
 * socket into typed callbacks and owns exactly three concerns: staying connected, measuring
 * the connection, and validating what arrives.
 */

export type ConnectionStatus =
  /** Never connected, or explicitly disposed. */
  | 'idle'
  /** A socket is opening. */
  | 'connecting'
  /** Connected and receiving. Data is live. */
  | 'live'
  /** Disconnected and waiting to retry. Cached data must be shown as stale. */
  | 'reconnecting'
  /** Backgrounded: socket closed on purpose, will reconnect on foreground. */
  | 'suspended';

export interface WsClientHandlers {
  onStatus(status: ConnectionStatus, detail?: string): void;
  /**
   * Fired on every successful (re)connection.
   *
   * This is the signal to re-fetch REST history and a fresh depth snapshot. It is separate
   * from `onStatus('live')` because it carries the meaning "your cached state is now
   * untrustworthy, resynchronise", which is a different thing from "the socket is up".
   */
  onConnected(hello: HelloFrame): void;
  onTrades(trades: Trade[]): void;
  onDepth(delta: DepthDelta): void;
  onCandle(candle: Candle, final: boolean): void;
  onTier(frame: TierFrame): void;
  onLatency(stats: LatencyStats): void;
  onServerError(code: string, message: string): void;
  /** A frame that failed validation. Counted for the debug panel, never fatal. */
  onMalformed(raw: string): void;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = 'idle';
  private handlers: WsClientHandlers;

  private interval: Interval;
  private readonly sampler = new LatencySampler();

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Consecutive failed attempts, driving exponential backoff. */
  private attempt = 0;

  /** When the last pong arrived, for the half-open socket guard. */
  private lastPongAt = 0;

  /** True once dispose() has run; blocks any further reconnect. */
  private disposed = false;

  /** Set while backgrounded so an incidental close does not trigger a reconnect. */
  private suspended = false;

  private connId: string | null = null;
  private malformedCount = 0;

  constructor(interval: Interval, handlers: WsClientHandlers) {
    this.interval = interval;
    this.handlers = handlers;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  connect(): void {
    if (this.disposed) return;
    // Guard against overlapping sockets. Two live sockets would double every frame and each
    // get its own tier on the server, which is confusing rather than harmful - but it also
    // leaks the first one.
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;

    this.suspended = false;
    this.setStatus('connecting');
    this.clearReconnectTimer();

    let socket: WebSocket;
    try {
      socket = new WebSocket(getWsUrl(this.interval));
    } catch (error) {
      // A malformed URL (e.g. a typo typed into the debug panel) throws synchronously.
      this.scheduleReconnect(error instanceof Error ? error.message : 'bad websocket url');
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      // Ignore events from a socket we have already replaced or abandoned.
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.lastPongAt = Date.now();
      this.sampler.reset();
      this.startProbing();
      // Status becomes 'live' only after the hello frame, so the UI never claims to be live
      // while still missing the symbol scales it needs to render anything.
    };

    socket.onmessage = (event: WebSocketMessageEvent) => {
      if (this.socket !== socket) return;
      this.handleRaw(typeof event.data === 'string' ? event.data : '');
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      // RN's WebSocket error event carries no useful detail; the close event follows and is
      // where reconnection is handled. Recording nothing here avoids a misleading message.
    };

    socket.onclose = (event: WebSocketCloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopProbing();

      if (this.disposed) return;
      if (this.suspended) {
        this.setStatus('suspended');
        return;
      }
      this.scheduleReconnect(`socket closed (${event?.code ?? 'no code'})`);
    };
  }

  /**
   * Close the socket and stop reconnecting, for backgrounding.
   *
   * `suspended` is set before closing so the close handler knows this was intentional and
   * does not schedule a reconnect - the classic bug where backgrounding an app starts a
   * reconnect loop that drains the battery it was meant to save.
   */
  suspend(): void {
    this.suspended = true;
    this.clearReconnectTimer();
    this.stopProbing();
    this.closeSocket();
    this.setStatus('suspended');
  }

  /** Reconnect after backgrounding. Safe to call when already connected. */
  resume(): void {
    if (this.disposed) return;
    this.suspended = false;
    this.attempt = 0;
    this.connect();
  }

  /** Permanent teardown. Idempotent, and blocks any queued reconnect. */
  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    this.stopProbing();
    this.closeSocket();
    this.setStatus('idle');
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    // Detach handlers before closing: otherwise the close event fires against a client that
    // may already have started a new socket, and the guards above would have to sort it out.
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Already closing or dead. Nothing to do.
    }
  }

  /**
   * Exponential backoff with jitter.
   *
   * Jitter matters even for a single client: without it, an app that loses Wi-Fi retries on
   * an exactly predictable schedule, and every client that dropped at the same moment (a
   * server restart) returns in a synchronised wave. Randomising spreads that out.
   */
  private scheduleReconnect(reason: string): void {
    if (this.disposed || this.suspended) return;

    this.setStatus('reconnecting', reason);
    this.attempt++;

    const base = Math.min(CONFIG.RECONNECT_MAX_MS, CONFIG.RECONNECT_MIN_MS * 2 ** (this.attempt - 1));
    const jitter = base * CONFIG.RECONNECT_JITTER * (Math.random() * 2 - 1);
    const delay = Math.max(CONFIG.RECONNECT_MIN_MS, Math.round(base + jitter));

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // -------------------------------------------------------------------------
  // Latency probing
  // -------------------------------------------------------------------------

  /**
   * Start the ping loop.
   *
   * This loop serves two purposes at once, which is worth being explicit about:
   *   1. It measures RTT and jitter, which the backend turns into a delivery tier.
   *   2. It is the app's only liveness check. React Native's WebSocket API does not expose
   *      protocol-level ping/pong, so a dead-but-unclosed socket is undetectable without an
   *      application-level heartbeat. Missing three pongs forces a close and reconnect.
   */
  private startProbing(): void {
    this.stopProbing();
    this.pingTimer = setInterval(() => this.probe(), CONFIG.PING_INTERVAL_MS);
    // Probe immediately so the first measurement is not one interval away.
    this.probe();
  }

  private stopProbing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private probe(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;

    const now = Date.now();

    // Half-open guard. The socket claims to be open but nothing is coming back.
    if (now - this.lastPongAt > CONFIG.PONG_TIMEOUT_MS) {
      // Force the close path, which schedules a reconnect. Without this the app would sit
      // showing "live" against a socket that will never deliver another frame.
      this.setStatus('reconnecting', 'no pong within timeout');
      this.closeSocket();
      this.scheduleReconnect('heartbeat timeout');
      return;
    }

    const ping = this.sampler.createPing(now);
    this.send({ type: 'ping', seq: ping.seq, t: ping.t });

    // Report measurements to the backend, which owns the tier decision. Null while fewer
    // than two samples exist, because jitter is undefined with one.
    const report = this.sampler.report();
    if (report) {
      this.send({ type: 'netreport', ...report });
    }
    this.handlers.onLatency(this.sampler.stats());
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private handleRaw(raw: string): void {
    const frame = parseServerFrame(raw);
    if (!frame) {
      // A malformed or unknown frame must never throw here. An uncaught error inside a
      // socket handler would tear down the connection over one bad message.
      this.malformedCount++;
      this.handlers.onMalformed(raw);
      return;
    }

    switch (frame.type) {
      case 'hello':
        this.connId = frame.connId;
        this.setStatus('live');
        this.handlers.onConnected(frame);
        return;

      case 'pong': {
        this.lastPongAt = Date.now();
        this.sampler.onPong(frame.seq, frame.t, this.lastPongAt);
        return;
      }

      case 'trades':
        if (frame.trades.length > 0) this.handlers.onTrades(frame.trades);
        return;

      case 'depth':
        this.handlers.onDepth(frame);
        return;

      case 'candle':
        this.handlers.onCandle(frame.candle, frame.final);
        return;

      case 'tier':
        this.handlers.onTier(frame);
        return;

      case 'error':
        this.handlers.onServerError(frame.code, frame.message);
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  private send(frame: object): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // The socket died between the readyState check and the write. The close handler will
      // deal with it; swallowing here keeps a send failure from propagating into a timer.
    }
  }

  /** Change the streamed interval. Server-side this also flushes any pending candle. */
  setInterval(interval: Interval): void {
    this.interval = interval;
    this.send({ type: 'subscribe', interval });
  }

  /** Debug control: force a tier, or 'auto' to return to automatic control. */
  setTier(tier: Tier | 'auto'): void {
    this.send({ type: 'setTier', tier });
  }

  /**
   * Debug control: ask the server to delay its pong replies.
   *
   * This raises genuinely measured RTT, so the automatic tier machine transitions through
   * its real measurement path rather than being overridden. It is how automatic behaviour
   * gets demonstrated without a bad network.
   */
  injectDelay(ms: number): void {
    this.send({ type: 'injectDelay', ms });
  }

  /** Tell the server to stop chart/trade delivery without dropping the socket. */
  pauseStream(): void {
    this.send({ type: 'pause' });
  }

  resumeStream(): void {
    this.send({ type: 'resume' });
  }

  // -------------------------------------------------------------------------

  private setStatus(status: ConnectionStatus, detail?: string): void {
    if (this.status === status && detail === undefined) return;
    this.status = status;
    this.handlers.onStatus(status, detail);
  }

  get currentStatus(): ConnectionStatus {
    return this.status;
  }

  get currentConnId(): string | null {
    return this.connId;
  }

  get malformedFrames(): number {
    return this.malformedCount;
  }

  get reconnectAttempts(): number {
    return this.attempt;
  }
}
