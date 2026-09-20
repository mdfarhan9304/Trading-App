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

export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'suspended';

export interface WsClientHandlers {
  onStatus(status: ConnectionStatus, detail?: string): void;
  onConnected(hello: HelloFrame): void;
  onTrades(trades: Trade[]): void;
  onDepth(delta: DepthDelta): void;
  onCandle(candle: Candle, final: boolean): void;
  onTier(frame: TierFrame): void;
  onLatency(stats: LatencyStats): void;
  onServerError(code: string, message: string): void;
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

  private attempt = 0;
  private lastPongAt = 0;
  private disposed = false;
  private suspended = false;

  private connId: string | null = null;
  private malformedCount = 0;

  constructor(interval: Interval, handlers: WsClientHandlers) {
    this.interval = interval;
    this.handlers = handlers;
  }

  connect(): void {
    if (this.disposed) return;
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;

    this.suspended = false;
    this.setStatus('connecting');
    this.clearReconnectTimer();

    let socket: WebSocket;
    try {
      socket = new WebSocket(getWsUrl(this.interval));
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : 'bad websocket url');
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.lastPongAt = Date.now();
      this.sampler.reset();
      this.startProbing();
    };

    socket.onmessage = (event: WebSocketMessageEvent) => {
      if (this.socket !== socket) return;
      this.handleRaw(typeof event.data === 'string' ? event.data : '');
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
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

  suspend(): void {
    this.suspended = true;
    this.clearReconnectTimer();
    this.stopProbing();
    this.closeSocket();
    this.setStatus('suspended');
  }

  resume(): void {
    if (this.disposed) return;
    this.suspended = false;
    this.attempt = 0;
    this.connect();
  }

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
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
    }
  }

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

  private startProbing(): void {
    this.stopProbing();
    this.pingTimer = setInterval(() => this.probe(), CONFIG.PING_INTERVAL_MS);
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

    if (now - this.lastPongAt > CONFIG.PONG_TIMEOUT_MS) {
      this.setStatus('reconnecting', 'no pong within timeout');
      this.closeSocket();
      this.scheduleReconnect('heartbeat timeout');
      return;
    }

    const ping = this.sampler.createPing(now);
    this.send({ type: 'ping', seq: ping.seq, t: ping.t });

    const report = this.sampler.report();
    if (report) {
      this.send({ type: 'netreport', ...report });
    }
    this.handlers.onLatency(this.sampler.stats());
  }

  private handleRaw(raw: string): void {
    const frame = parseServerFrame(raw);
    if (!frame) {
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

  private send(frame: object): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
    }
  }

  setInterval(interval: Interval): void {
    this.interval = interval;
    this.send({ type: 'subscribe', interval });
  }

  setTier(tier: Tier | 'auto'): void {
    this.send({ type: 'setTier', tier });
  }

  injectDelay(ms: number): void {
    this.send({ type: 'injectDelay', ms });
  }

  pauseStream(): void {
    this.send({ type: 'pause' });
  }

  resumeStream(): void {
    this.send({ type: 'resume' });
  }

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
