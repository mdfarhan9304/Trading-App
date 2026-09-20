import { Platform } from 'react-native';

// emulator: 10.0.2.2 is the host machine. phone: use the LAN ip from the server banner
const DEFAULT_HOST = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
const DEFAULT_PORT = 8080;

let host = DEFAULT_HOST;
let port = DEFAULT_PORT;

export function setBackendHost(nextHost: string, nextPort = DEFAULT_PORT): void {
  host = nextHost.trim() || DEFAULT_HOST;
  port = nextPort;
}

export function getBackendHost(): { host: string; port: number } {
  return { host, port };
}

export function getRestBase(): string {
  return `http://${host}:${port}/api/v1`;
}

export function getWsUrl(interval: string): string {
  return `ws://${host}:${port}/stream?interval=${encodeURIComponent(interval)}`;
}

export const CONFIG = {
  HISTORY_LIMIT: 200,
  BOOK_ROWS: 10,
  TRADE_ROWS: 40,
  PING_INTERVAL_MS: 2_000,
  RTT_WINDOW: 10,
  RTT_OUTLIER_MS: 10_000, // 10s rtt is a stall, not latency
  PONG_TIMEOUT_MS: 7_000,
  RECONNECT_MIN_MS: 500,
  RECONNECT_MAX_MS: 15_000,
  RECONNECT_JITTER: 0.3,
  REQUEST_TIMEOUT_MS: 8_000,
  RESNAPSHOT_MIN_INTERVAL_MS: 1_000,
  MAX_CANDLES: 400,
  BACKGROUND_GRACE_MS: 20_000,
} as const;
