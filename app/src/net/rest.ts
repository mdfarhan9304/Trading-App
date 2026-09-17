import { CONFIG, getRestBase } from '../config';
import {
  isDepthSnapshot,
  isInterval,
  type Candle,
  type DepthSnapshot,
  type Interval,
  type SymbolInfo,
  type Trade,
} from '../protocol/types';
import { isCandle, isTrade } from '../protocol/types';

/**
 * REST access, plus the primitive that solves the "late response" requirement.
 *
 * Every response is validated before use. The server is ours, but a validated boundary means
 * a protocol change during development produces an empty chart with a logged reason rather
 * than a crash inside a render function.
 */

export class RequestFailure extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'RequestFailure';
    this.status = status;
  }
}

/** Outcome of a tracked request. `superseded` is a normal, expected result, not a failure. */
export type TrackedResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'superseded' | 'aborted' | 'failed'; error?: unknown };

/**
 * Runs requests such that only the NEWEST one can ever produce a usable result.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The assignment requires handling "requests that finish after the selected interval has
 * changed". Tap 1s then quickly 1m, and two fetches are in flight. HTTP gives no ordering
 * guarantee, so the 1s response can land second and overwrite the 1m data - leaving a chart
 * labelled 1m showing 1s candles, with no error anywhere.
 *
 * WHY NOT JUST AbortController
 * ----------------------------
 * Aborting is necessary but not sufficient. `abort()` is asynchronous with respect to a
 * response already being parsed: a request can complete successfully in the window between
 * the abort call and the rejection being observed. So there are two independent defences:
 * abort the old request to save the bandwidth, AND compare a monotonic token on completion
 * to decide whether the result is still wanted. The token check is the one that guarantees
 * correctness.
 *
 * The domain layer applies a third, different check (does the payload's interval match the
 * one being displayed), so a stale result would have to defeat all three.
 */
export class LatestRequest<T> {
  private token = 0;
  private controller: AbortController | null = null;

  async run(fn: (signal: AbortSignal) => Promise<T>): Promise<TrackedResult<T>> {
    // Cancel whatever was in flight; its result is already unwanted.
    this.controller?.abort();

    const myToken = ++this.token;
    const controller = new AbortController();
    this.controller = controller;

    try {
      const value = await fn(controller.signal);
      if (myToken !== this.token) return { ok: false, reason: 'superseded' };
      return { ok: true, value };
    } catch (error) {
      if (myToken !== this.token) return { ok: false, reason: 'superseded' };
      if (controller.signal.aborted) return { ok: false, reason: 'aborted' };
      return { ok: false, reason: 'failed', error };
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  /** Abort anything in flight and invalidate its result. Called on unmount. */
  cancel(): void {
    this.token++;
    this.controller?.abort();
    this.controller = null;
  }

  /** Current token, so a caller can correlate its own state with a request generation. */
  get generation(): number {
    return this.token;
  }
}

/**
 * fetch with a timeout, JSON parsing, and error mapping.
 *
 * A timeout is essential: React Native's fetch has no default one, so a request to a host
 * that silently drops packets (a laptop that went to sleep, wrong IP) hangs forever and the
 * UI waits with it. `AbortSignal` from the caller is combined with our own timer so either
 * can cancel.
 */
async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const url = `${getRestBase()}${path}`;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), CONFIG.REQUEST_TIMEOUT_MS);

  // Forward an external abort to our controller so one signal governs the fetch.
  const forward = () => timeout.abort();
  signal.addEventListener('abort', forward);

  try {
    const response = await fetch(url, {
      signal: timeout.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new RequestFailure(`${response.status} ${response.statusText} for ${path}`, response.status);
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof RequestFailure) throw error;
    if (signal.aborted) throw new RequestFailure('cancelled', null);
    if (timeout.signal.aborted) throw new RequestFailure(`timed out after ${CONFIG.REQUEST_TIMEOUT_MS}ms`, null);
    throw new RequestFailure(error instanceof Error ? error.message : 'network error', null);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forward);
  }
}

export interface InfoResponse {
  symbol: string;
  symbolInfo: SymbolInfo;
  intervals: Interval[];
  bookLevels: number;
  seed: number;
  serverTime: number;
}

export async function fetchInfo(signal: AbortSignal): Promise<InfoResponse> {
  const body = await getJson<unknown>('/info', signal);
  if (typeof body !== 'object' || body === null) throw new RequestFailure('malformed /info payload');
  const record = body as Record<string, unknown>;
  const info = record['symbolInfo'];
  if (typeof info !== 'object' || info === null) throw new RequestFailure('/info missing symbolInfo');
  return body as InfoResponse;
}

/** Order book snapshot. Validated because it seeds the entire local book. */
export async function fetchDepth(limit: number, signal: AbortSignal): Promise<DepthSnapshot> {
  const body = await getJson<unknown>(`/depth?limit=${limit}`, signal);
  if (!isDepthSnapshot(body)) throw new RequestFailure('malformed depth snapshot');
  return body;
}

/**
 * Candle history.
 *
 * Returns the requested interval alongside the candles so the caller can verify what it
 * received rather than assuming it matches what it asked for. Empty history is a valid
 * result, not an error: the caller renders an empty state.
 */
export async function fetchKlines(
  interval: Interval,
  limit: number,
  signal: AbortSignal
): Promise<{ interval: Interval; candles: Candle[] }> {
  const body = await getJson<unknown>(`/klines?interval=${interval}&limit=${limit}`, signal);
  if (typeof body !== 'object' || body === null) throw new RequestFailure('malformed klines payload');

  const record = body as Record<string, unknown>;
  const responseInterval = record['interval'];
  if (!isInterval(responseInterval)) throw new RequestFailure('klines response has no valid interval');

  const raw = record['candles'];
  if (!Array.isArray(raw)) throw new RequestFailure('klines response has no candles array');

  // Filter rather than reject: one bad candle should not discard the other 199. A count
  // mismatch is worth surfacing in the debug panel, which is why the caller gets both.
  const candles = raw.filter(isCandle);

  return { interval: responseInterval, candles };
}

export async function fetchTrades(limit: number, signal: AbortSignal): Promise<Trade[]> {
  const body = await getJson<unknown>(`/trades?limit=${limit}`, signal);
  if (typeof body !== 'object' || body === null) throw new RequestFailure('malformed trades payload');
  const raw = (body as Record<string, unknown>)['trades'];
  if (!Array.isArray(raw)) throw new RequestFailure('trades response has no trades array');
  return raw.filter(isTrade);
}

/** Force a tier from the app's debug panel, via REST rather than the socket. */
export async function postDebugTier(
  connId: string | undefined,
  tier: 'full' | 'degraded' | 'minimal' | 'auto',
  signal: AbortSignal
): Promise<void> {
  const url = `${getRestBase()}/debug/tier`;
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(connId ? { connId, tier } : { tier }),
  });
  if (!response.ok) throw new RequestFailure(`debug/tier returned ${response.status}`, response.status);
}
