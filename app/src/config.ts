import { Platform } from 'react-native';

/**
 * How the app reaches the backend.
 *
 * ANDROID EMULATOR
 * ----------------
 * `localhost` inside the emulator refers to the emulator itself, not your Mac. Android
 * exposes the host machine at the special alias 10.0.2.2, so that is the default here.
 *
 * The emulator also blocks plain HTTP by default from Android 9 onward, which fails
 * silently in a way that looks exactly like the server being down. That is handled in
 * android/app/src/main/res/xml/network_security_config.xml.
 *
 * PHYSICAL DEVICE
 * ---------------
 * Use your Mac's LAN address; the backend prints it in its startup banner. The debug panel
 * lets you type a different host at runtime so a device can be pointed at your machine
 * without a rebuild.
 */
const DEFAULT_HOST = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
const DEFAULT_PORT = 8080;

/** Mutable at runtime via the debug panel; read through getBaseUrls(). */
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
  // The initial interval rides on the query string so the very first frames the server
  // sends are already for the interval we intend to display, rather than a default we
  // would immediately switch away from.
  return `ws://${host}:${port}/stream?interval=${encodeURIComponent(interval)}`;
}

export const CONFIG = {
  /** Candles requested from REST on load and on interval change. */
  HISTORY_LIMIT: 200,

  /** Order book rows displayed per side. The server maintains 20. */
  BOOK_ROWS: 10,

  /** Recent trades retained for display. Bounded so the list cannot grow without limit. */
  TRADE_ROWS: 40,

  /**
   * How often to send a latency probe. Matches the cadence the server's tier machine
   * assumes: its silence thresholds are 6s and 12s, i.e. three and six missed reports.
   */
  PING_INTERVAL_MS: 2_000,

  /**
   * RTT samples retained. Ten samples at 2s is a 20-second view: long enough for the
   * median to be stable, short enough to react to a genuine change within one tier
   * confirmation cycle.
   */
  RTT_WINDOW: 10,

  /**
   * Samples above this are discarded rather than averaged in. A 10-second round trip is
   * not latency, it is a stalled connection, and letting it into the median would swamp
   * the window for the next 20 seconds.
   */
  RTT_OUTLIER_MS: 10_000,

  /**
   * Close the socket if no pong arrives for this long.
   *
   * This is the client-side half-open socket guard. Three missed pings means either the
   * server is gone or the TCP connection is dead without having delivered a FIN. Without
   * this the app would sit forever believing it was connected.
   */
  PONG_TIMEOUT_MS: 7_000,

  /** Reconnect backoff: first delay, cap, and the jitter fraction applied to each. */
  RECONNECT_MIN_MS: 500,
  RECONNECT_MAX_MS: 15_000,
  RECONNECT_JITTER: 0.3,

  /** REST request timeout. */
  REQUEST_TIMEOUT_MS: 8_000,

  /**
   * Minimum gap between order book snapshot requests.
   *
   * Rate limiting matters: a genuinely broken feed would otherwise trigger gap -> refetch
   * -> gap -> refetch in a tight loop and hammer the server while never recovering.
   */
  RESNAPSHOT_MIN_INTERVAL_MS: 1_000,

  /** Candles held in the chart window. */
  MAX_CANDLES: 400,

  /**
   * How long the app may sit backgrounded before the socket is closed.
   *
   * A brief switch away should not cost a full resync, but holding a socket open
   * indefinitely in the background wastes battery and the OS may kill it anyway.
   */
  BACKGROUND_GRACE_MS: 20_000,
} as const;
