import { MarketEngine } from '../src/engine/marketEngine';
import type { Candle, Interval } from '../src/engine/types';
import { ClientSession, type SocketLike } from '../src/ws/clientSession';
import { TIER_INTERVAL_MS, type Tier } from '../src/tier/tierMachine';
import type { ServerMessage } from '../src/ws/protocol';

const START = 1_700_000_000_000;
const STEP_MS = 50;
const DURATION_MS = 30_000;
const INTERVAL: Interval = '1s';

/** Records frames instead of writing to a socket. */
class FakeSocket implements SocketLike {
  readonly frames: ServerMessage[] = [];
  bufferedAmount = 0;
  closed = false;

  send(data: string): void {
    this.frames.push(JSON.parse(data) as ServerMessage);
  }

  close(): void {
    this.closed = true;
  }

  candleFrames(final?: boolean): Candle[] {
    return this.frames
      .filter((f): f is Extract<ServerMessage, { type: 'candle' }> => f.type === 'candle')
      .filter((f) => (final === undefined ? true : f.final === final))
      .map((f) => f.candle);
  }
}

interface Harness {
  engine: MarketEngine;
  sockets: Record<Tier, FakeSocket>;
  sessions: Record<Tier, ClientSession>;
}

/**
 * Build one engine plus three sessions, each forced to a different tier, and run the
 * simulation forward.
 *
 * Uses Jest's fake timers so the sessions' real `setInterval` flush loops are exercised
 * (rather than being bypassed by calling flush() directly), while 30 seconds of market
 * completes in milliseconds.
 */
function runHarness(): Harness {
  let now = START;
  const clock = () => now;

  const engine = new MarketEngine({ seed: 42, startTime: START, clock });

  const tiers: Tier[] = ['full', 'degraded', 'minimal'];
  const sockets = {} as Record<Tier, FakeSocket>;
  const sessions = {} as Record<Tier, ClientSession>;

  for (const tier of tiers) {
    const socket = new FakeSocket();
    const session = new ClientSession({ connId: `conn-${tier}`, engine, socket, clock, interval: INTERVAL });
    session.start();
    // Pin the tier via the documented debug control, which is exactly how the demo
    // forces tiers from the app.
    session.handleRaw(JSON.stringify({ type: 'setTier', tier }));
    sockets[tier] = socket;
    sessions[tier] = session;
  }

  for (let elapsed = 0; elapsed <= DURATION_MS; elapsed += STEP_MS) {
    now = START + elapsed;
    engine.step(now);
    // Let each session's flush timer fire if its interval elapsed during this step.
    jest.advanceTimersByTime(STEP_MS);
  }

  return { engine, sockets, sessions };
}

describe('candle correctness across delivery tiers', () => {
  let harness: Harness;

  beforeAll(() => {
    jest.useFakeTimers();
    harness = runHarness();
  });

  afterAll(() => {
    for (const session of Object.values(harness.sessions)) session.dispose();
    jest.useRealTimers();
  });

  it('actually delivered different numbers of chart updates per tier', () => {
    // Live (non-final) frames are the ones the tier throttles.
    const full = harness.sockets.full.candleFrames(false).length;
    const degraded = harness.sockets.degraded.candleFrames(false).length;
    const minimal = harness.sockets.minimal.candleFrames(false).length;

    expect(full).toBeGreaterThan(degraded);
    expect(degraded).toBeGreaterThan(minimal);

    // And roughly in line with the configured rates, allowing slack for the fact that a
    // frame is only sent when a trade actually moved the candle.
    const expectedFull = DURATION_MS / TIER_INTERVAL_MS.full;
    const expectedMinimal = DURATION_MS / TIER_INTERVAL_MS.minimal;
    expect(full).toBeLessThanOrEqual(expectedFull + 5);
    expect(minimal).toBeLessThanOrEqual(expectedMinimal + 5);

    // The whole point of the exercise: the fast client got roughly an order of magnitude
    // more frames than the slow one.
    expect(full / Math.max(1, minimal)).toBeGreaterThan(4);
  });

  it('delivered every closed candle to every tier, dropping none', () => {
    const engineClosed = harness.engine.getAllClosedCandles(INTERVAL);
    expect(engineClosed.length).toBeGreaterThan(20); // ~30 one-second candles

    for (const tier of ['full', 'degraded', 'minimal'] as Tier[]) {
      const finals = harness.sockets[tier].candleFrames(true);
      expect(finals).toHaveLength(engineClosed.length);
    }
  });

  it('produced byte-identical closed candles on every tier', () => {
    const full = harness.sockets.full.candleFrames(true);
    const degraded = harness.sockets.degraded.candleFrames(true);
    const minimal = harness.sockets.minimal.candleFrames(true);

    // A single deep comparison would report only the first difference; comparing the
    // serialised arrays makes any mismatch anywhere fail loudly.
    expect(JSON.stringify(degraded)).toBe(JSON.stringify(full));
    expect(JSON.stringify(minimal)).toBe(JSON.stringify(full));
  });

  it('matches the engine\'s own record of every closed candle', () => {
    const engineClosed = harness.engine.getAllClosedCandles(INTERVAL);

    for (const tier of ['full', 'degraded', 'minimal'] as Tier[]) {
      const delivered = harness.sockets[tier].candleFrames(true);
      delivered.forEach((candle, i) => {
        const expected = engineClosed[i];
        expect(expected).toBeDefined();
        if (!expected) return;
        // Spelled out field by field so a failure names the offending value rather than
        // dumping two large objects.
        expect(candle.openTime).toBe(expected.openTime);
        expect(candle.open).toBe(expected.open);
        expect(candle.high).toBe(expected.high);
        expect(candle.low).toBe(expected.low);
        expect(candle.close).toBe(expected.close);
        expect(candle.volume).toBe(expected.volume);
        expect(candle.trades).toBe(expected.trades);
        expect(candle.lastTradeId).toBe(expected.lastTradeId);
        expect(candle.closed).toBe(true);
      });
    }
  });

  it('kept volume exact, so coalescing lost no trade', () => {
    // Total volume across closed candles must equal the sum of every trade's quantity
    // that fell inside those candles. This is the check that a dropped or double-counted
    // trade would fail, and it is exact because quantities are integers.
    const engineClosed = harness.engine.getAllClosedCandles(INTERVAL);
    const totalTrades = engineClosed.reduce((sum, c) => sum + c.trades, 0);
    const totalVolume = engineClosed.reduce((sum, c) => sum + c.volume, 0);

    expect(totalTrades).toBeGreaterThan(500);
    expect(Number.isInteger(totalVolume)).toBe(true);

    for (const tier of ['full', 'degraded', 'minimal'] as Tier[]) {
      const delivered = harness.sockets[tier].candleFrames(true);
      expect(delivered.reduce((sum, c) => sum + c.volume, 0)).toBe(totalVolume);
      expect(delivered.reduce((sum, c) => sum + c.trades, 0)).toBe(totalTrades);
    }
  });

  it('kept every candle internally consistent and continuous', () => {
    for (const tier of ['full', 'degraded', 'minimal'] as Tier[]) {
      const candles = harness.sockets[tier].candleFrames(true);

      candles.forEach((c, i) => {
        expect(c.high).toBeGreaterThanOrEqual(c.low);
        expect(c.high).toBeGreaterThanOrEqual(c.open);
        expect(c.high).toBeGreaterThanOrEqual(c.close);
        expect(c.low).toBeLessThanOrEqual(c.open);
        expect(c.low).toBeLessThanOrEqual(c.close);
        expect(c.volume).toBeGreaterThanOrEqual(0);

        if (i > 0) {
          const prev = candles[i - 1];
          if (!prev) return;
          // No gaps in time, and no discontinuity in price.
          expect(c.openTime).toBe(prev.openTime + 1_000);
          expect(c.open).toBe(prev.close);
        }
      });
    }
  });
});

describe('per-connection isolation', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('gives two connections independent tiers from one engine', () => {
    jest.useFakeTimers();
    let now = START;
    const clock = () => now;
    const engine = new MarketEngine({ seed: 7, startTime: START, clock });

    const fastSocket = new FakeSocket();
    const slowSocket = new FakeSocket();
    const fast = new ClientSession({ connId: 'fast', engine, socket: fastSocket, clock, interval: INTERVAL });
    const slow = new ClientSession({ connId: 'slow', engine, socket: slowSocket, clock, interval: INTERVAL });

    fast.start();
    slow.start();
    fast.handleRaw(JSON.stringify({ type: 'setTier', tier: 'full' }));
    slow.handleRaw(JSON.stringify({ type: 'setTier', tier: 'minimal' }));

    for (let elapsed = 0; elapsed <= 10_000; elapsed += STEP_MS) {
      now = START + elapsed;
      engine.step(now);
      jest.advanceTimersByTime(STEP_MS);
    }

    expect(fast.stats().tier).toBe('full');
    expect(slow.stats().tier).toBe('minimal');
    expect(fastSocket.candleFrames(false).length).toBeGreaterThan(slowSocket.candleFrames(false).length * 3);

    // Yet both saw the same closed candles.
    expect(JSON.stringify(slowSocket.candleFrames(true))).toBe(JSON.stringify(fastSocket.candleFrames(true)));

    fast.dispose();
    slow.dispose();
  });

  it('stops delivering to a disposed session without affecting the other', () => {
    jest.useFakeTimers();
    let now = START;
    const clock = () => now;
    const engine = new MarketEngine({ seed: 9, startTime: START, clock });

    const aSocket = new FakeSocket();
    const bSocket = new FakeSocket();
    const a = new ClientSession({ connId: 'a', engine, socket: aSocket, clock, interval: INTERVAL });
    const b = new ClientSession({ connId: 'b', engine, socket: bSocket, clock, interval: INTERVAL });
    a.start();
    b.start();

    for (let elapsed = 0; elapsed <= 3_000; elapsed += STEP_MS) {
      now = START + elapsed;
      engine.step(now);
      jest.advanceTimersByTime(STEP_MS);
    }

    a.dispose();
    const aFramesAtDispose = aSocket.frames.length;
    const bFramesAtDispose = bSocket.frames.length;

    for (let elapsed = 3_000; elapsed <= 8_000; elapsed += STEP_MS) {
      now = START + elapsed;
      engine.step(now);
      jest.advanceTimersByTime(STEP_MS);
    }

    // The disposed session received nothing further: its engine listeners were removed.
    expect(aSocket.frames.length).toBe(aFramesAtDispose);
    // The survivor kept going.
    expect(bSocket.frames.length).toBeGreaterThan(bFramesAtDispose);

    b.dispose();
  });
});

describe('backpressure and pause behaviour', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('drops chart frames while the socket is not draining, then resumes', () => {
    jest.useFakeTimers();
    let now = START;
    const clock = () => now;
    const engine = new MarketEngine({ seed: 11, startTime: START, clock });

    const socket = new FakeSocket();
    const session = new ClientSession({ connId: 'slow-consumer', engine, socket, clock, interval: INTERVAL });
    session.start();
    session.handleRaw(JSON.stringify({ type: 'setTier', tier: 'full' }));

    // Simulate a client that has stopped reading.
    socket.bufferedAmount = 1_000_000;
    for (let elapsed = 0; elapsed <= 5_000; elapsed += STEP_MS) {
      now = START + elapsed;
      engine.step(now);
      jest.advanceTimersByTime(STEP_MS);
    }
    expect(session.stats().framesDropped).toBeGreaterThan(0);

    // Closed candles were still delivered, because the bypass does not consult
    // backpressure: losing one would corrupt the client's history permanently, whereas a
    // dropped live frame is merely a missed refresh.
    expect(socket.candleFrames(true).length).toBeGreaterThan(0);

    // Once the client drains, live delivery resumes.
    const before = socket.candleFrames(false).length;
    socket.bufferedAmount = 0;
    for (let elapsed = 5_000; elapsed <= 8_000; elapsed += STEP_MS) {
      now = START + elapsed;
      engine.step(now);
      jest.advanceTimersByTime(STEP_MS);
    }
    expect(socket.candleFrames(false).length).toBeGreaterThan(before);

    session.dispose();
  });

  it('withholds live updates while paused but still delivers closed candles', () => {
    jest.useFakeTimers();
    let now = START;
    const clock = () => now;
    const engine = new MarketEngine({ seed: 13, startTime: START, clock });

    const socket = new FakeSocket();
    const session = new ClientSession({ connId: 'backgrounded', engine, socket, clock, interval: INTERVAL });
    session.start();
    session.handleRaw(JSON.stringify({ type: 'pause' }));

    const liveBefore = socket.candleFrames(false).length;
    for (let elapsed = 0; elapsed <= 5_000; elapsed += STEP_MS) {
      now = START + elapsed;
      engine.step(now);
      jest.advanceTimersByTime(STEP_MS);
    }

    // No new live frames while backgrounded...
    expect(socket.candleFrames(false).length).toBe(liveBefore);
    // ...but the history has no holes in it.
    expect(socket.candleFrames(true).length).toBeGreaterThanOrEqual(4);

    // Resuming immediately sends the current candle so the chart is not blank.
    session.handleRaw(JSON.stringify({ type: 'resume' }));
    expect(socket.candleFrames(false).length).toBeGreaterThan(liveBefore);

    session.dispose();
  });
});
