import { SYMBOL_INFO, TRADE_HISTORY } from '../config';
import type { MarketEngine } from '../engine/marketEngine';
import { INTERVALS, type Candle, type DepthDelta, type Interval, type Millis, type Trade } from '../engine/types';
import { TIER_CONFIG, TierMachine, type Tier } from '../tier/tierMachine';
import { parseClientMessage, type ServerMessage } from './protocol';

/**
 * The minimum surface a session needs from a socket. Defining it as an interface rather
 * than importing ws.WebSocket lets the tests drive a session with a fake socket that
 * records frames, with no server, no ports, and no async.
 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  /** Bytes queued but not yet written to the OS. Our backpressure signal. */
  readonly bufferedAmount: number;
}

export interface SessionOptions {
  connId: string;
  engine: MarketEngine;
  socket: SocketLike;
  /** Injectable for tests. Defaults to Date.now. */
  clock?: () => Millis;
  /** Starting interval subscription. */
  interval?: Interval;
}

/**
 * Everything that is per-connection: the delivery tier, the coalescing buffers, the
 * interval subscription, and the timers.
 *
 * THE CENTRAL INVARIANT
 * ---------------------
 * This class may only READ from the engine. It has no method that mutates market data,
 * and the engine hands out copies rather than internal objects. So the worst a slow or
 * hostile client can do is receive fewer frames. It cannot alter a candle, and it cannot
 * affect any other connection, because every connection owns its own instance of this
 * class and its own TierMachine.
 *
 * WHAT THE TIER THROTTLES, AND WHAT IT DOES NOT
 * ---------------------------------------------
 * Throttled (coalesced):
 *   - Active-candle updates. Several trades collapse into one frame carrying the
 *     candle's current state. Because the frame is a full snapshot rather than a delta,
 *     collapsing is lossless: OHLCV is identical to what an unthrottled client sees.
 *   - Trade batches, for the recent-trades list.
 *   - Depth deltas, but MERGED rather than dropped (see flushDepth).
 *
 * Never throttled:
 *   - Candle CLOSE frames. A closed candle is the final, immutable record of an
 *     interval. Delaying it past the next candle's open would let the client's history
 *     disagree with the server's, and dropping it would corrupt the chart permanently.
 *     This bypass is the single most important line in the tier system.
 *   - Pongs, so latency measurement stays accurate at every tier.
 */
export class ClientSession {
  readonly connId: string;
  readonly tierMachine: TierMachine;

  private readonly engine: MarketEngine;
  private readonly socket: SocketLike;
  private readonly now: () => Millis;

  private interval: Interval;
  private closed = false;
  private paused = false;

  /** Latest state of the active candle, waiting to be delivered. */
  private pendingCandle: Candle | null = null;
  /** Trades accumulated since the last flush. */
  private pendingTrades: Trade[] = [];
  /** Depth deltas accumulated since the last flush, in arrival order. */
  private pendingDepth: DepthDelta[] = [];

  private flushTimer: NodeJS.Timeout | undefined;
  private silenceTimer: NodeJS.Timeout | undefined;
  private pongTimers = new Set<NodeJS.Timeout>();

  /** Artificial pong delay in ms, for demonstrating automatic tier transitions. */
  private injectedDelayMs = 0;

  private unsubscribes: Array<() => void> = [];

  // Diagnostics, surfaced in the tier frame so the app can cross-check the rate it is
  // actually receiving against the rate the server intends.
  private chartUpdatesSent = 0;
  private framesDropped = 0;

  /**
   * Bytes allowed to sit unwritten before we start dropping frames.
   *
   * 256KB is roughly a second of the fastest tier's output. Beyond that the client is
   * not draining, and queueing more would grow memory without ever catching up, so it is
   * strictly better to drop.
   */
  private static readonly BACKPRESSURE_BYTES = 256 * 1_024;

  /** How often to check for missing reports. */
  private static readonly SILENCE_CHECK_MS = 1_000;

  constructor(options: SessionOptions) {
    this.connId = options.connId;
    this.engine = options.engine;
    this.socket = options.socket;
    this.now = options.clock ?? (() => Date.now());
    this.interval = options.interval ?? '1s';
    this.tierMachine = new TierMachine(this.now(), TIER_CONFIG.INITIAL);
  }

  /** Send the hello frame, subscribe to the engine, and start the timers. */
  start(): void {
    this.send({
      type: 'hello',
      connId: this.connId,
      symbol: this.engine.symbol,
      symbolInfo: SYMBOL_INFO,
      intervals: INTERVALS,
      serverTime: this.now(),
      tier: this.tierMachine.snapshot(),
    });

    // Retain every unsubscribe function. Forgetting even one would leak this session
    // into the engine's listener set forever after the socket closed, which is the
    // classic long-lived-emitter memory leak.
    this.unsubscribes.push(
      this.engine.events.on('trades', (trades) => this.onTrades(trades)),
      this.engine.events.on('depth', (delta) => this.onDepth(delta)),
      this.engine.events.on('candleUpdate', (candle) => this.onCandleUpdate(candle)),
      this.engine.events.on('candleClose', (candle) => this.onCandleClose(candle))
    );

    // Give the client something to draw immediately rather than waiting for the first
    // flush, which at `minimal` would be a whole second away.
    const active = this.engine.getActiveCandle(this.interval);
    if (active) this.sendCandle(active, false);

    this.restartFlushTimer();
    this.silenceTimer = setInterval(() => this.onSilenceCheck(), ClientSession.SILENCE_CHECK_MS);
  }

  /** Tear down every timer and listener. Idempotent. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;

    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];

    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    for (const timer of this.pongTimers) clearTimeout(timer);
    this.pongTimers.clear();

    this.flushTimer = undefined;
    this.silenceTimer = undefined;
    this.pendingCandle = null;
    this.pendingTrades = [];
    this.pendingDepth = [];
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  /**
   * Handle one raw frame from the client.
   *
   * A malformed frame produces an `error` reply and nothing else. We deliberately do not
   * close the connection: a client bug that sent one bad frame would otherwise turn into
   * an endless reconnect loop, which is far worse than ignoring the frame.
   */
  handleRaw(raw: string): void {
    if (this.closed) return;

    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.send(parsed.error);
      return;
    }

    const message = parsed.message;
    const now = this.now();

    switch (message.type) {
      case 'subscribe': {
        if (message.interval === this.interval) return;
        this.interval = message.interval;
        // Drop any candle pending for the previous interval. Delivering it now would
        // hand the client a candle for an interval it is no longer displaying, which is
        // exactly the sort of stale frame that makes a chart flicker on interval change.
        this.pendingCandle = null;
        const active = this.engine.getActiveCandle(message.interval);
        if (active) this.sendCandle(active, false);
        return;
      }

      case 'ping': {
        // Echo `t` untouched; the client owns the RTT arithmetic.
        const reply: ServerMessage = { type: 'pong', seq: message.seq, t: message.t, serverTime: now };
        if (this.injectedDelayMs > 0) {
          const timer = setTimeout(() => {
            this.pongTimers.delete(timer);
            this.send(reply);
          }, this.injectedDelayMs);
          this.pongTimers.add(timer);
        } else {
          this.send(reply);
        }
        return;
      }

      case 'netreport': {
        const changed = this.tierMachine.report(
          message.samples === undefined
            ? { latencyMs: message.latencyMs, jitterMs: message.jitterMs }
            : { latencyMs: message.latencyMs, jitterMs: message.jitterMs, samples: message.samples },
          now
        );
        if (changed) this.onTierChanged();
        return;
      }

      case 'setTier': {
        const changed = this.tierMachine.setOverride(message.tier === 'auto' ? null : message.tier, now);
        // Always echo the tier frame, even when the effective tier did not change, so the
        // app's debug panel can confirm the override was registered.
        if (changed) this.restartFlushTimer();
        this.sendTier();
        return;
      }

      case 'injectDelay': {
        this.injectedDelayMs = message.ms;
        this.sendTier();
        return;
      }

      case 'pause': {
        this.paused = true;
        // Discard rather than hold: on resume the client refetches history and a fresh
        // depth snapshot anyway, so replaying a backlog would be wasted bandwidth.
        this.pendingCandle = null;
        this.pendingTrades = [];
        this.pendingDepth = [];
        return;
      }

      case 'resume': {
        this.paused = false;
        const active = this.engine.getActiveCandle(this.interval);
        if (active) this.sendCandle(active, false);
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Engine events: accumulate, do not send
  // -------------------------------------------------------------------------

  private onTrades(trades: Trade[]): void {
    if (this.paused) return;
    this.pendingTrades.push(...trades);
    // Bound the buffer. A client paused at a breakpoint for a minute would otherwise
    // accumulate thousands of trades it has no use for; only the most recent are
    // displayable anyway.
    if (this.pendingTrades.length > TRADE_HISTORY) {
      this.pendingTrades.splice(0, this.pendingTrades.length - TRADE_HISTORY);
    }
  }

  private onDepth(delta: DepthDelta): void {
    if (this.paused) return;
    this.pendingDepth.push(delta);
  }

  private onCandleUpdate(candle: Candle): void {
    if (this.paused) return;
    if (candle.interval !== this.interval) return;
    // Overwrite rather than queue. The frame is a full snapshot, so only the newest
    // matters, and this is what makes coalescing lossless.
    this.pendingCandle = candle;
  }

  private onCandleClose(candle: Candle): void {
    if (candle.interval !== this.interval) return;

    // THE BYPASS. A closed candle is final and must reach every client at every tier,
    // so it is sent immediately rather than waiting for the next flush. Note this
    // deliberately ignores `paused` too: a backgrounded app that stays connected must
    // not end up with a hole in its history.
    if (this.pendingCandle && this.pendingCandle.openTime === candle.openTime) {
      // The pending update is superseded by the final version of the same candle.
      this.pendingCandle = null;
    }
    this.sendCandle(candle, true);
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  private restartFlushTimer(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.closed) return;
    this.flushTimer = setInterval(() => this.flush(), this.tierMachine.intervalMs);
  }

  /**
   * Deliver everything accumulated since the last flush. Called on the tier's interval.
   *
   * Public so tests can step delivery deterministically instead of waiting on timers.
   */
  flush(): void {
    if (this.closed || this.paused) return;

    // Backpressure: if the socket has not drained, adding frames only grows memory. We
    // drop this cycle entirely, including depth. Dropping depth is safe precisely
    // because the client detects the resulting gap via `pu` and requests a fresh
    // snapshot; that recovery path is designed for exactly this.
    if (this.socket.bufferedAmount > ClientSession.BACKPRESSURE_BYTES) {
      this.framesDropped++;
      return;
    }

    this.flushDepth();

    if (this.pendingTrades.length > 0) {
      this.send({ type: 'trades', trades: this.pendingTrades });
      this.pendingTrades = [];
    }

    if (this.pendingCandle) {
      this.sendCandle(this.pendingCandle, false);
      this.pendingCandle = null;
    }
  }

  /**
   * Publish accumulated depth deltas as a single merged delta.
   *
   * MERGING RATHER THAN DROPPING
   * ----------------------------
   * The client's book synchronisation requires an unbroken chain: each event's `pu` must
   * equal the previous event's `u`. Dropping a depth event therefore forces a full REST
   * resnapshot, which at `minimal` tier would happen continuously.
   *
   * Merging avoids that entirely, and is sound because deltas carry ABSOLUTE quantities:
   * applying delta A then delta B is equivalent to applying a single delta whose level
   * map is B layered over A. We keep the first event's `pu` and the last event's `u`, so
   * the chain the client validates remains exactly correct across the merge. A slower
   * tier thus gets fewer, larger depth frames — never a broken book.
   */
  private flushDepth(): void {
    if (this.pendingDepth.length === 0) return;

    const first = this.pendingDepth[0];
    const last = this.pendingDepth[this.pendingDepth.length - 1];
    if (!first || !last) {
      this.pendingDepth = [];
      return;
    }

    if (this.pendingDepth.length === 1) {
      this.send({ type: 'depth', ...first });
      this.pendingDepth = [];
      return;
    }

    // Later values win, which is what makes this a correct merge for absolute quantities.
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    for (const delta of this.pendingDepth) {
      for (const level of delta.bids) bids.set(level.price, level.qty);
      for (const level of delta.asks) asks.set(level.price, level.qty);
    }

    this.send({
      type: 'depth',
      symbol: first.symbol,
      U: first.U,
      u: last.u,
      pu: first.pu,
      bids: [...bids].map(([price, qty]) => ({ price, qty })),
      asks: [...asks].map(([price, qty]) => ({ price, qty })),
    });

    this.pendingDepth = [];
  }

  private sendCandle(candle: Candle, final: boolean): void {
    this.chartUpdatesSent++;
    this.send({ type: 'candle', candle, final });
  }

  private onTierChanged(): void {
    this.restartFlushTimer();
    this.sendTier();
  }

  private sendTier(): void {
    this.send({ type: 'tier', ...this.tierMachine.snapshot(), chartUpdatesSent: this.chartUpdatesSent });
  }

  private onSilenceCheck(): void {
    if (this.closed) return;
    if (this.tierMachine.checkSilence(this.now())) this.onTierChanged();
  }

  private send(message: ServerMessage): void {
    if (this.closed) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // A send can throw if the socket died between our check and the write. There is
      // nothing useful to do but stop using it; the close handler will dispose us.
      this.framesDropped++;
    }
  }

  /** Diagnostics for tests and the debug endpoint. */
  stats(): { connId: string; tier: Tier; interval: Interval; chartUpdatesSent: number; framesDropped: number; paused: boolean; injectedDelayMs: number } {
    return {
      connId: this.connId,
      tier: this.tierMachine.tier,
      interval: this.interval,
      chartUpdatesSent: this.chartUpdatesSent,
      framesDropped: this.framesDropped,
      paused: this.paused,
      injectedDelayMs: this.injectedDelayMs,
    };
  }
}
