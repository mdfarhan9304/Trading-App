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

export class RequestFailure extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'RequestFailure';
    this.status = status;
  }
}

export type TrackedResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'superseded' | 'aborted' | 'failed'; error?: unknown };

// only the newest request wins. abort + token — abort alone can still finish
export class LatestRequest<T> {
  private token = 0;
  private controller: AbortController | null = null;

  async run(fn: (signal: AbortSignal) => Promise<T>): Promise<TrackedResult<T>> {
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

  cancel(): void {
    this.token++;
    this.controller?.abort();
    this.controller = null;
  }

  get generation(): number {
    return this.token;
  }
}

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const url = `${getRestBase()}${path}`;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), CONFIG.REQUEST_TIMEOUT_MS);

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

export async function fetchDepth(limit: number, signal: AbortSignal): Promise<DepthSnapshot> {
  const body = await getJson<unknown>(`/depth?limit=${limit}`, signal);
  if (!isDepthSnapshot(body)) throw new RequestFailure('malformed depth snapshot');
  return body;
}

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
