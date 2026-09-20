import { isInterval, type Candle, type DepthDelta, type Interval, type SymbolInfo, type Trade } from '../engine/types';
import { isTier, type Tier, type TierState } from '../tier/tierMachine';

/**
 * The WebSocket wire protocol. Also see docs/PROTOCOL.md.
 *
 * WHY HAND-WRITTEN VALIDATORS
 * ---------------------------
 * A schema library (zod, valibot) would be less code here, but every inbound message
 * arrives from a network peer we do not control, and the assignment explicitly requires
 * handling malformed messages. Hand-written guards make the exact accepted shape
 * readable in one place, add no dependency to the server, and — because they are plain
 * predicates — cost nothing on the hot path.
 *
 * Every guard is total: it takes `unknown` and never throws, so a hostile or buggy
 * client cannot crash the server with an unexpected type. The caller replies with an
 * `error` frame and keeps the connection open, because dropping a connection over one
 * bad frame would turn a client-side bug into a reconnect storm.
 */

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** Select which interval's active candle this connection wants streamed. */
export interface SubscribeMessage {
  type: 'subscribe';
  interval: Interval;
}

/**
 * Latency probe. `t` is the client's own clock reading and is opaque to us: we echo it
 * back untouched so the client can compute RTT entirely against its own clock. This is
 * why server/device clock skew cannot corrupt the measurement.
 */
export interface PingMessage {
  type: 'ping';
  seq: number;
  t: number;
}

/** The client's computed latency and jitter. The server owns the tier decision. */
export interface NetReportMessage {
  type: 'netreport';
  latencyMs: number;
  jitterMs: number;
  samples?: number;
}

/** Debug control: force a tier, or 'auto' to hand control back to the machine. */
export interface SetTierMessage {
  type: 'setTier';
  tier: Tier | 'auto';
}

/**
 * Debug control: delay every pong reply by `ms`.
 *
 * This is the more interesting of the two debug controls. Forcing a tier proves the
 * three delivery states exist; injecting delay raises the client's genuinely measured
 * RTT, which drives the automatic state machine through a real transition. That lets
 * the automatic behaviour be demonstrated on a good office network, which is otherwise
 * very hard to film.
 */
export interface InjectDelayMessage {
  type: 'injectDelay';
  ms: number;
}

/** App lifecycle: stop or resume chart and trade delivery without dropping the socket. */
export interface PauseMessage {
  type: 'pause';
}
export interface ResumeMessage {
  type: 'resume';
}

export type ClientMessage =
  | SubscribeMessage
  | PingMessage
  | NetReportMessage
  | SetTierMessage
  | InjectDelayMessage
  | PauseMessage
  | ResumeMessage;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

/**
 * First frame on every connection. Carries the precision scales so the client never has
 * to hard-code them, and the server time so the client can display a clock offset.
 */
export interface HelloMessage {
  type: 'hello';
  connId: string;
  symbol: string;
  symbolInfo: SymbolInfo;
  intervals: readonly Interval[];
  serverTime: number;
  tier: TierState;
}

export interface PongMessage {
  type: 'pong';
  seq: number;
  /** The client's `t`, echoed verbatim. */
  t: number;
  serverTime: number;
}

export interface TradesMessage {
  type: 'trades';
  trades: Trade[];
}

export interface DepthMessage extends DepthDelta {
  type: 'depth';
}

export interface CandleMessage {
  type: 'candle';
  candle: Candle;
  /**
   * True when this frame carries a candle that has closed and is now final. Close
   * frames bypass tier throttling entirely.
   */
  final: boolean;
}

export interface TierMessage extends TierState {
  type: 'tier';
  /** Chart frames this connection has actually been sent, for cross-checking the rate. */
  chartUpdatesSent: number;
}

export interface ErrorMessage {
  type: 'error';
  code: 'bad-message' | 'bad-interval' | 'bad-tier' | 'bad-json';
  message: string;
}

export type ServerMessage =
  | HelloMessage
  | PongMessage
  | TradesMessage
  | DepthMessage
  | CandleMessage
  | TierMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** True for a plain object. Excludes null and arrays, both of which are `typeof 'object'`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A number we are willing to act on.
 *
 * `Number.isFinite` rejects NaN and both infinities. This matters because `NaN` fails
 * every comparison silently: a NaN latency would slip past a naive `x > 0` check and
 * then poison the tier score into permanent NaN.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Parse a raw frame into a validated ClientMessage, or return an error describing why
 * it was rejected. Never throws.
 */
export function parseClientMessage(raw: string): { ok: true; message: ClientMessage } | { ok: false; error: ErrorMessage } {
  const badJson = (message: string) => ({ ok: false as const, error: { type: 'error' as const, code: 'bad-json' as const, message } });
  const bad = (message: string) => ({ ok: false as const, error: { type: 'error' as const, code: 'bad-message' as const, message } });

  // Cheap guard against a client streaming an enormous string at us. Our largest
  // legitimate inbound frame is a few hundred bytes.
  if (raw.length > 4_096) return bad('frame too large');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return badJson('not valid JSON');
  }

  if (!isRecord(parsed)) return bad('frame must be a JSON object');
  const type = parsed['type'];
  if (typeof type !== 'string') return bad('missing string "type"');

  switch (type) {
    case 'subscribe': {
      const interval = parsed['interval'];
      if (!isInterval(interval)) {
        return { ok: false, error: { type: 'error', code: 'bad-interval', message: `unknown interval: ${String(interval)}` } };
      }
      return { ok: true, message: { type: 'subscribe', interval } };
    }

    case 'ping': {
      const seq = parsed['seq'];
      const t = parsed['t'];
      if (!isFiniteNumber(seq) || !isFiniteNumber(t)) return bad('ping requires numeric "seq" and "t"');
      return { ok: true, message: { type: 'ping', seq, t } };
    }

    case 'netreport': {
      const latencyMs = parsed['latencyMs'];
      const jitterMs = parsed['jitterMs'];
      if (!isFiniteNumber(latencyMs) || !isFiniteNumber(jitterMs)) {
        return bad('netreport requires numeric "latencyMs" and "jitterMs"');
      }
      if (latencyMs < 0 || jitterMs < 0) return bad('netreport values must be non-negative');
      const samples = parsed['samples'];
      return {
        ok: true,
        message: isFiniteNumber(samples)
          ? { type: 'netreport', latencyMs, jitterMs, samples }
          : { type: 'netreport', latencyMs, jitterMs },
      };
    }

    case 'setTier': {
      const tier = parsed['tier'];
      if (tier !== 'auto' && !isTier(tier)) {
        return { ok: false, error: { type: 'error', code: 'bad-tier', message: `expected full|degraded|minimal|auto, got ${String(tier)}` } };
      }
      return { ok: true, message: { type: 'setTier', tier } };
    }

    case 'injectDelay': {
      const ms = parsed['ms'];
      if (!isFiniteNumber(ms) || ms < 0) return bad('injectDelay requires a non-negative numeric "ms"');
      // Cap it. An unbounded value would let a client pin a timer far into the future
      // and keep the session's teardown list growing.
      return { ok: true, message: { type: 'injectDelay', ms: Math.min(ms, 5_000) } };
    }

    case 'pause':
      return { ok: true, message: { type: 'pause' } };

    case 'resume':
      return { ok: true, message: { type: 'resume' } };

    default:
      return bad(`unknown message type: ${type}`);
  }
}
