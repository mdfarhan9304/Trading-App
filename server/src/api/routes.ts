import express, { type Request, type Response, type Router } from 'express';
import {
  KLINES_DEFAULT_LIMIT,
  KLINES_MAX_LIMIT,
  SEED,
  SYMBOL,
  SYMBOL_INFO,
  TRADE_HISTORY,
} from '../config';
import type { MarketEngine } from '../engine/marketEngine';
import { BOOK_LEVELS } from '../config';
import { INTERVALS, isInterval } from '../engine/types';
import { TIER_CONFIG, TIER_INTERVAL_MS, isTier } from '../tier/tierMachine';
import type { WsHub } from '../ws/wsServer';

/**
 * REST surface. See docs/PROTOCOL.md for the full contract.
 *
 * Two design notes that apply throughout:
 *
 * 1. Query parameters are clamped, not rejected. `?limit=999999` returns the maximum
 *    rather than a 400, because a client asking for too much has made a reasonable
 *    request that we can partially satisfy. An unparseable or unknown *interval*, by
 *    contrast, is a 400: there is no sensible interpretation to fall back on, and
 *    silently substituting a default would make the client render the wrong data
 *    believing it was right.
 *
 * 2. Every numeric field is an integer in ticks or lots, matching the WebSocket feed.
 *    See engine/types.ts for why we do not send decimal strings.
 */

/** Parse and clamp a positive integer query parameter. */
function intParam(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Reject a symbol we do not simulate, rather than quietly serving the one we do. */
function checkSymbol(raw: unknown, res: Response): boolean {
  if (raw === undefined || raw === SYMBOL) return true;
  res.status(404).json({ error: 'unknown symbol', requested: raw, supported: [SYMBOL] });
  return false;
}

export function createRouter(engine: MarketEngine, hub: WsHub): Router {
  const router = express.Router();

  /**
   * Static description of the market plus the live tier configuration.
   *
   * Serving the tier thresholds means the app's debug panel can display the exact numbers
   * the server is using, rather than duplicating them in client code where they would
   * drift out of sync.
   */
  router.get('/info', (_req: Request, res: Response) => {
    res.json({
      symbol: SYMBOL,
      symbolInfo: SYMBOL_INFO,
      intervals: INTERVALS,
      bookLevels: BOOK_LEVELS,
      seed: SEED,
      serverTime: Date.now(),
      tiers: {
        intervalMs: TIER_INTERVAL_MS,
        config: TIER_CONFIG,
      },
    });
  });

  /**
   * Order book snapshot. The client pairs this with the WebSocket delta stream; see
   * docs/PROTOCOL.md for the synchronisation algorithm and engine/types.ts for why the
   * update ids are shaped the way they are.
   */
  router.get('/depth', (req: Request, res: Response) => {
    if (!checkSymbol(req.query['symbol'], res)) return;
    const limit = intParam(req.query['limit'], BOOK_LEVELS, 1, BOOK_LEVELS);
    res.json(engine.getDepthSnapshot(limit));
  });

  /**
   * Historical candles, oldest first, with the still-open active candle as the final
   * element so the client has something to draw and update immediately.
   */
  router.get('/klines', (req: Request, res: Response) => {
    if (!checkSymbol(req.query['symbol'], res)) return;

    const interval = req.query['interval'] ?? '1s';
    if (!isInterval(interval)) {
      res.status(400).json({ error: 'unknown interval', requested: interval, supported: INTERVALS });
      return;
    }

    const limit = intParam(req.query['limit'], KLINES_DEFAULT_LIMIT, 1, KLINES_MAX_LIMIT);
    res.json({ symbol: SYMBOL, interval, candles: engine.getCandleHistory(interval, limit) });
  });

  /** Recent trades, oldest first. */
  router.get('/trades', (req: Request, res: Response) => {
    if (!checkSymbol(req.query['symbol'], res)) return;
    const limit = intParam(req.query['limit'], 50, 1, TRADE_HISTORY);
    res.json({ symbol: SYMBOL, trades: engine.getRecentTrades(limit) });
  });

  // -------------------------------------------------------------------------
  // Debug controls
  //
  // These exist because the assignment requires a documented way to force any tier so
  // all three states can be demonstrated without relying on a bad network. They are
  // exposed over REST *as well as* over the WebSocket so a tier can be forced from a
  // terminal with curl, which is how the behaviour is verified without the app running.
  //
  // In a real deployment these would sit behind authentication or be compiled out. They
  // are open here deliberately: the whole point is that a reviewer can drive them.
  // -------------------------------------------------------------------------

  /** Every live connection with its tier, so a reviewer can see per-client state. */
  router.get('/debug/sessions', (_req: Request, res: Response) => {
    res.json({ count: hub.count, sessions: hub.list() });
  });

  /**
   * Force a tier on one connection, or on all of them.
   *
   * Body: { connId?: string, tier: 'full' | 'degraded' | 'minimal' | 'auto' }
   * Omitting connId applies to every connection, which is the convenient case when only
   * one device is attached.
   */
  router.post('/debug/tier', (req: Request, res: Response) => {
    const body: unknown = req.body;
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

    const tier = record['tier'];
    if (tier !== 'auto' && !isTier(tier)) {
      res.status(400).json({ error: 'tier must be full, degraded, minimal or auto', received: tier });
      return;
    }

    const connId = record['connId'];
    if (connId !== undefined && typeof connId !== 'string') {
      res.status(400).json({ error: 'connId must be a string when provided' });
      return;
    }

    const applied = hub.setTier(connId, tier);
    if (applied.length === 0) {
      res.status(404).json({ error: 'no matching connection', connId: connId ?? '(all)', liveConnections: hub.count });
      return;
    }

    res.json({ tier, applied });
  });

  /**
   * Add artificial delay to pong replies on a connection.
   *
   * This is the control that demonstrates the AUTOMATIC state machine rather than the
   * override: the client's measured RTT genuinely rises, so the tier transition happens
   * through the real measurement path, hysteresis and all.
   *
   * Body: { connId?: string, ms: number }
   */
  router.post('/debug/delay', (req: Request, res: Response) => {
    const body: unknown = req.body;
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

    const ms = record['ms'];
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      res.status(400).json({ error: 'ms must be a non-negative number', received: ms });
      return;
    }

    const connId = record['connId'];
    if (connId !== undefined && typeof connId !== 'string') {
      res.status(400).json({ error: 'connId must be a string when provided' });
      return;
    }

    const applied = hub.setInjectedDelay(connId, Math.min(ms, 5_000));
    if (applied.length === 0) {
      res.status(404).json({ error: 'no matching connection', connId: connId ?? '(all)', liveConnections: hub.count });
      return;
    }

    res.json({ ms: Math.min(ms, 5_000), applied });
  });

  return router;
}
