/**
 * Wire types, mirroring the server's `server/src/ws/protocol.ts` and
 * `server/src/engine/types.ts`.
 *
 * These are duplicated rather than imported from a shared package on purpose. A shared
 * workspace package would need npm workspaces, and workspace hoisting is a well known
 * cause of React Native native-module resolution breaking. The wire format is small and
 * documented in docs/PROTOCOL.md, so the cost of duplication is low and the cost of a
 * broken Metro build is high.
 *
 * PRECISION
 * ---------
 * Prices are integer TICKS and quantities integer LOTS, exactly as the server sends them.
 * We never convert to a float. `priceScale` and `qtyScale` arrive in the hello frame and
 * are used only for formatting at the render edge (see src/util/format.ts).
 */

export type PriceTicks = number;
export type QtyLots = number;
export type Millis = number;
export type Side = 'buy' | 'sell';

export type Interval = '1s' | '5s' | '1m';

export const INTERVAL_MS: Record<Interval, number> = {
  '1s': 1_000,
  '5s': 5_000,
  '1m': 60_000,
};

export const INTERVALS: readonly Interval[] = ['1s', '5s', '1m'];

export function isInterval(value: unknown): value is Interval {
  return value === '1s' || value === '5s' || value === '1m';
}

export type Tier = 'full' | 'degraded' | 'minimal';

export function isTier(value: unknown): value is Tier {
  return value === 'full' || value === 'degraded' || value === 'minimal';
}

export interface SymbolInfo {
  symbol: string;
  priceScale: number;
  qtyScale: number;
  priceDecimals: number;
  qtyDecimals: number;
}

export interface Trade {
  id: number;
  ts: Millis;
  price: PriceTicks;
  qty: QtyLots;
  side: Side;
}

export interface BookLevel {
  price: PriceTicks;
  qty: QtyLots;
}

export interface DepthSnapshot {
  symbol: string;
  lastUpdateId: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

/**
 * Incremental depth update.
 *
 *   U  - first update id in this event
 *   u  - final update id in this event
 *   pu - final update id of the previous event
 *
 * `pu` is what lets us detect a genuine GAP rather than merely noticing we fell behind.
 * See src/domain/orderBook.ts for the synchronisation rules built on these.
 */
export interface DepthDelta {
  symbol: string;
  U: number;
  u: number;
  pu: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface Candle {
  interval: Interval;
  openTime: Millis;
  closeTime: Millis;
  open: PriceTicks;
  high: PriceTicks;
  low: PriceTicks;
  close: PriceTicks;
  volume: QtyLots;
  trades: number;
  lastTradeId: number;
  closed: boolean;
}

export interface TierState {
  tier: Tier;
  autoTier: Tier;
  override: Tier | null;
  intervalMs: number;
  hz: number;
  reason: string;
  latencyMs: number | null;
  jitterMs: number | null;
  score: number | null;
  lastReportAt: Millis | null;
}

// ---------------------------------------------------------------------------
// Server -> client frames
// ---------------------------------------------------------------------------

export interface HelloFrame {
  type: 'hello';
  connId: string;
  symbol: string;
  symbolInfo: SymbolInfo;
  intervals: Interval[];
  serverTime: number;
  tier: TierState;
}

export interface PongFrame {
  type: 'pong';
  seq: number;
  t: number;
  serverTime: number;
}

export interface TradesFrame {
  type: 'trades';
  trades: Trade[];
}

export interface DepthFrame extends DepthDelta {
  type: 'depth';
}

export interface CandleFrame {
  type: 'candle';
  candle: Candle;
  final: boolean;
}

export interface TierFrame extends TierState {
  type: 'tier';
  chartUpdatesSent: number;
}

export interface ErrorFrame {
  type: 'error';
  code: string;
  message: string;
}

export type ServerFrame =
  | HelloFrame
  | PongFrame
  | TradesFrame
  | DepthFrame
  | CandleFrame
  | TierFrame
  | ErrorFrame;

// ---------------------------------------------------------------------------
// Client -> server frames
// ---------------------------------------------------------------------------

export type ClientFrame =
  | { type: 'subscribe'; interval: Interval }
  | { type: 'ping'; seq: number; t: number }
  | { type: 'netreport'; latencyMs: number; jitterMs: number; samples?: number }
  | { type: 'setTier'; tier: Tier | 'auto' }
  | { type: 'injectDelay'; ms: number }
  | { type: 'pause' }
  | { type: 'resume' };

// ---------------------------------------------------------------------------
// Validation
//
// WHY HAND-WRITTEN GUARDS ON THE HOT PATH
// ---------------------------------------
// `trades`, `depth` and `candle` frames arrive up to 10 times a second. Running a schema
// validator over every one would burn measurable CPU on a mid-range phone for a shape we
// control on both ends. These predicates are total (they take `unknown` and never throw),
// which is what the assignment's "malformed messages" requirement actually needs.
//
// A malformed frame is counted and dropped, never allowed to throw inside a socket
// handler: an uncaught error there would tear down the connection over one bad message.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNum(value: unknown): value is number {
  // Number.isFinite rejects NaN and both infinities. A plain `typeof === 'number'` would
  // let NaN through, and NaN fails every comparison silently rather than loudly.
  return typeof value === 'number' && Number.isFinite(value);
}

function isBookLevel(value: unknown): value is BookLevel {
  return isRecord(value) && isNum(value['price']) && isNum(value['qty']);
}

function isLevelArray(value: unknown): value is BookLevel[] {
  return Array.isArray(value) && value.every(isBookLevel);
}

export function isTrade(value: unknown): value is Trade {
  return (
    isRecord(value) &&
    isNum(value['id']) &&
    isNum(value['ts']) &&
    isNum(value['price']) &&
    isNum(value['qty']) &&
    (value['side'] === 'buy' || value['side'] === 'sell')
  );
}

export function isCandle(value: unknown): value is Candle {
  return (
    isRecord(value) &&
    isInterval(value['interval']) &&
    isNum(value['openTime']) &&
    isNum(value['closeTime']) &&
    isNum(value['open']) &&
    isNum(value['high']) &&
    isNum(value['low']) &&
    isNum(value['close']) &&
    isNum(value['volume']) &&
    isNum(value['trades']) &&
    typeof value['closed'] === 'boolean'
  );
}

export function isDepthDelta(value: unknown): value is DepthDelta {
  return (
    isRecord(value) &&
    isNum(value['U']) &&
    isNum(value['u']) &&
    isNum(value['pu']) &&
    isLevelArray(value['bids']) &&
    isLevelArray(value['asks'])
  );
}

export function isDepthSnapshot(value: unknown): value is DepthSnapshot {
  return (
    isRecord(value) &&
    isNum(value['lastUpdateId']) &&
    isLevelArray(value['bids']) &&
    isLevelArray(value['asks'])
  );
}

/**
 * Parse a raw socket payload into a validated frame, or return null.
 *
 * Returning null rather than throwing keeps the decision at the call site: the socket
 * layer increments a counter and carries on, which is the only sane response to one bad
 * frame in a live feed.
 */
export function parseServerFrame(raw: string): ServerFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const type = parsed['type'];
  if (typeof type !== 'string') return null;

  switch (type) {
    case 'hello': {
      const info = parsed['symbolInfo'];
      if (!isRecord(info) || !isNum(info['priceScale']) || !isNum(info['qtyScale'])) return null;
      if (typeof parsed['symbol'] !== 'string' || typeof parsed['connId'] !== 'string') return null;
      const intervals = parsed['intervals'];
      if (!Array.isArray(intervals) || !intervals.every(isInterval)) return null;
      return parsed as unknown as HelloFrame;
    }

    case 'pong':
      if (!isNum(parsed['seq']) || !isNum(parsed['t'])) return null;
      return parsed as unknown as PongFrame;

    case 'trades': {
      const trades = parsed['trades'];
      if (!Array.isArray(trades)) return null;
      // Filter rather than reject the whole batch: one malformed trade should not cost us
      // the other twenty-four in the same frame.
      return { type: 'trades', trades: trades.filter(isTrade) };
    }

    case 'depth':
      if (!isDepthDelta(parsed)) return null;
      return parsed as unknown as DepthFrame;

    case 'candle': {
      const candle = parsed['candle'];
      if (!isCandle(candle)) return null;
      return { type: 'candle', candle, final: parsed['final'] === true };
    }

    case 'tier':
      if (!isTier(parsed['tier']) || !isNum(parsed['intervalMs'])) return null;
      return parsed as unknown as TierFrame;

    case 'error':
      return {
        type: 'error',
        code: typeof parsed['code'] === 'string' ? parsed['code'] : 'unknown',
        message: typeof parsed['message'] === 'string' ? parsed['message'] : '',
      };

    default:
      // An unknown type is not an error: it may be a frame from a newer server. Ignore it
      // rather than treating it as corruption.
      return null;
  }
}
