import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { MarketEngine } from '../engine/marketEngine';
import type { Interval } from '../engine/types';
import { isInterval } from '../engine/types';
import type { Tier } from '../tier/tierMachine';
import { ClientSession } from './clientSession';

/**
 * Owns the WebSocket server and the set of live sessions.
 *
 * TWO KINDS OF PING, AND WHY BOTH EXIST
 * -------------------------------------
 * This file uses the WebSocket protocol's own ping/pong control frames, while
 * ClientSession handles an application-level `ping`/`pong` JSON message. They look
 * redundant but solve different problems:
 *
 *   - Protocol ping (here): detects a HALF-OPEN socket. If a device loses power or a NAT
 *     silently drops the flow, TCP may never deliver a FIN, so the server would hold the
 *     connection and its session open indefinitely. An unanswered protocol ping is the
 *     only reliable way to notice. This runs on a fixed schedule regardless of tier.
 *
 *   - Application ping (ClientSession): measures round-trip time for the tier decision.
 *     It has to be application-level because the client needs to timestamp it with its
 *     own clock and correlate the reply; the browser and React Native WebSocket APIs do
 *     not expose protocol-level pong timing at all.
 */
export class WsHub {
  private readonly engine: MarketEngine;
  private readonly sessions = new Map<string, ClientSession>();
  private readonly sockets = new Map<string, WebSocket>();

  /** Connections that have not answered the most recent protocol ping. */
  private readonly awaitingPong = new Set<string>();

  private wss: WebSocketServer | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private nextId = 1;

  /**
   * Interval between protocol pings. 30s is the usual choice: frequent enough to reclaim
   * a dead connection promptly, infrequent enough to be irrelevant to battery life.
   */
  private static readonly HEARTBEAT_MS = 30_000;

  constructor(engine: MarketEngine) {
    this.engine = engine;
  }

  /**
   * Attach to an existing HTTP server so REST and WebSocket share one port. Sharing a
   * port is a real convenience for mobile: the app needs one base URL, and an Android
   * emulator needs only one host mapping.
   */
  attach(server: HttpServer, path = '/stream'): void {
    this.wss = new WebSocketServer({ server, path });

    this.wss.on('connection', (socket, request) => {
      const connId = `c${this.nextId++}`;

      // An initial interval may be supplied on the query string so the very first frames
      // are already for the interval the app intends to display.
      const requested = new URL(request.url ?? '/', 'http://localhost').searchParams.get('interval');
      const interval: Interval = isInterval(requested) ? requested : '1s';

      const session = new ClientSession({ connId, engine: this.engine, socket, interval });
      this.sessions.set(connId, session);
      this.sockets.set(connId, socket);

      socket.on('message', (data: RawData, isBinary: boolean) => {
        // We speak JSON only. A binary frame is either a different protocol or a bug, and
        // decoding it as text could produce arbitrary garbage.
        if (isBinary) {
          socket.send(JSON.stringify({ type: 'error', code: 'bad-message', message: 'binary frames are not supported' }));
          return;
        }
        session.handleRaw(data.toString());
      });

      socket.on('pong', () => {
        this.awaitingPong.delete(connId);
      });

      socket.on('close', () => this.drop(connId));

      // An error is always followed by a close, but dropping here too makes teardown
      // idempotent rather than depending on that ordering.
      socket.on('error', () => this.drop(connId));

      session.start();
    });

    this.heartbeat = setInterval(() => this.sweep(), WsHub.HEARTBEAT_MS);
  }

  /**
   * Terminate connections that did not answer the previous ping, then ping the rest.
   *
   * `terminate()` rather than `close()`: close performs a closing handshake, which a
   * socket that is already unreachable will never complete, leaving us exactly where we
   * started.
   */
  private sweep(): void {
    for (const [connId, socket] of this.sockets) {
      if (this.awaitingPong.has(connId)) {
        socket.terminate();
        this.drop(connId);
        continue;
      }
      this.awaitingPong.add(connId);
      try {
        socket.ping();
      } catch {
        this.drop(connId);
      }
    }
  }

  /** Dispose a session and forget the connection. Safe to call more than once. */
  private drop(connId: string): void {
    this.sessions.get(connId)?.dispose();
    this.sessions.delete(connId);
    this.sockets.delete(connId);
    this.awaitingPong.delete(connId);
  }

  get count(): number {
    return this.sessions.size;
  }

  list(): ReturnType<ClientSession['stats']>[] {
    return [...this.sessions.values()].map((session) => session.stats());
  }

  /**
   * Force a tier on one connection, or on all of them when connId is omitted.
   * Returns the connection ids actually affected, so the caller can 404 on no match.
   */
  setTier(connId: string | undefined, tier: Tier | 'auto'): string[] {
    const targets = connId === undefined ? [...this.sessions.keys()] : this.sessions.has(connId) ? [connId] : [];
    for (const id of targets) {
      // Routed through the same message handler the app uses, so the REST control and
      // the WebSocket control cannot drift apart in behaviour.
      this.sessions.get(id)?.handleRaw(JSON.stringify({ type: 'setTier', tier }));
    }
    return targets;
  }

  /** Set artificial pong delay on one or all connections. */
  setInjectedDelay(connId: string | undefined, ms: number): string[] {
    const targets = connId === undefined ? [...this.sessions.keys()] : this.sessions.has(connId) ? [connId] : [];
    for (const id of targets) {
      this.sessions.get(id)?.handleRaw(JSON.stringify({ type: 'injectDelay', ms }));
    }
    return targets;
  }

  /** Shut everything down. Used on SIGINT so the process exits promptly. */
  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;

    for (const connId of [...this.sessions.keys()]) {
      this.sockets.get(connId)?.close();
      this.drop(connId);
    }

    this.wss?.close();
    this.wss = undefined;
  }
}
