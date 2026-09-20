/**
 * End-to-end WebSocket verification.  Run with:  npm run probe
 * (requires the backend to be running)
 *
 * This is the "prove the feed before writing the app" step. If the app later misbehaves,
 * this script tells us whether to look at the client or the server.
 *
 * It checks:
 *   1. The hello handshake carries the precision scales the client needs.
 *   2. Pong echoes the client's timestamp verbatim, so RTT is computable.
 *   3. The depth `pu` chain is unbroken, i.e. a client can actually stay synchronised.
 *   4. Each forced tier delivers chart updates at roughly its documented rate.
 *   5. Closed candles arrive at every tier, including `minimal`.
 *   6. Malformed frames produce an error reply and do NOT drop the connection.
 *   7. Switching interval takes effect.
 */
import WebSocket from 'ws';
import { TIER_INTERVAL_MS, type Tier } from '../tier/tierMachine';
import type { ServerMessage } from '../ws/protocol';

const URL = process.env['PROBE_URL'] ?? 'ws://localhost:8080/stream';

interface Counters {
  liveCandles: number;
  finalCandles: number;
  trades: number;
  depth: number;
  errors: string[];
}

const problems: string[] = [];
const note = (ok: boolean, label: string, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log(`WebSocket probe -> ${URL}`);
  console.log('='.repeat(72));

  const ws = new WebSocket(URL);

  const counters: Counters = { liveCandles: 0, finalCandles: 0, trades: 0, depth: 0, errors: [] };
  let hello: Extract<ServerMessage, { type: 'hello' }> | undefined;
  let lastTierFrame: Extract<ServerMessage, { type: 'tier' }> | undefined;
  const pongs: Array<{ seq: number; t: number; rtt: number }> = [];

  // Depth chain state: every event's `pu` must equal the previous event's `u`.
  let previousU: number | null = null;
  let chainBreaks = 0;
  let firstDepthSeen = false;

  let currentInterval: string | undefined;

  ws.on('message', (raw) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw.toString()) as ServerMessage;
    } catch {
      counters.errors.push('client could not parse a server frame');
      return;
    }

    switch (message.type) {
      case 'hello':
        hello = message;
        break;

      case 'pong':
        pongs.push({ seq: message.seq, t: message.t, rtt: Date.now() - message.t });
        break;

      case 'candle':
        if (message.final) counters.finalCandles++;
        else counters.liveCandles++;
        currentInterval = message.candle.interval;
        break;

      case 'trades':
        counters.trades += message.trades.length;
        break;

      case 'depth':
        counters.depth++;
        if (previousU !== null && message.pu !== previousU) chainBreaks++;
        previousU = message.u;
        firstDepthSeen = true;
        break;

      case 'tier':
        lastTierFrame = message;
        break;

      case 'error':
        counters.errors.push(`${message.code}: ${message.message}`);
        break;
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  // ---- 1. handshake ---------------------------------------------------------
  await sleep(300);
  console.log('\n[1] Handshake');
  note(hello !== undefined, 'hello frame received');
  note(hello?.symbolInfo?.priceScale === 100, 'priceScale present', `priceScale=${hello?.symbolInfo?.priceScale}`);
  note(hello?.symbolInfo?.qtyScale === 10_000, 'qtyScale present', `qtyScale=${hello?.symbolInfo?.qtyScale}`);
  note((hello?.intervals?.length ?? 0) >= 2, 'at least two intervals offered', `${hello?.intervals?.join(', ')}`);
  note(typeof hello?.connId === 'string' && hello.connId.length > 0, 'connection id assigned', hello?.connId);

  // ---- 2. ping / pong -------------------------------------------------------
  console.log('\n[2] Latency probe');
  for (let seq = 1; seq <= 5; seq++) {
    ws.send(JSON.stringify({ type: 'ping', seq, t: Date.now() }));
    await sleep(120);
  }
  note(pongs.length === 5, 'every ping answered', `${pongs.length}/5`);
  note(
    pongs.every((p, i) => p.seq === i + 1),
    'pong sequence numbers echoed in order'
  );
  note(
    pongs.every((p) => p.rtt >= 0 && p.rtt < 1_000),
    'round-trip times plausible',
    `rtt=[${pongs.map((p) => p.rtt).join(', ')}]ms`
  );

  // ---- 3. depth chain -------------------------------------------------------
  console.log('\n[3] Order book delta chain');
  await sleep(2_000);
  note(firstDepthSeen, 'depth deltas flowing', `${counters.depth} events`);
  note(chainBreaks === 0, 'pu chain unbroken (client can stay synchronised)', `breaks=${chainBreaks}`);

  // ---- 4. tier rates --------------------------------------------------------
  console.log('\n[4] Delivery rate per forced tier (measured over 4s each)');
  const measured: Partial<Record<Tier, number>> = {};

  for (const tier of ['full', 'degraded', 'minimal'] as Tier[]) {
    ws.send(JSON.stringify({ type: 'setTier', tier }));
    await sleep(400); // let the new flush timer settle

    const before = counters.liveCandles;
    const finalsBefore = counters.finalCandles;
    const windowMs = 4_000;
    await sleep(windowMs);
    const frames = counters.liveCandles - before;
    const finals = counters.finalCandles - finalsBefore;

    const rate = frames / (windowMs / 1_000);
    measured[tier] = rate;
    const target = 1_000 / TIER_INTERVAL_MS[tier];

    console.log(
      `      ${tier.padEnd(9)} target ${String(target).padStart(2)}/s   measured ${rate.toFixed(1)}/s   ` +
        `closed candles delivered: ${finals}`
    );

    note(lastTierFrame?.tier === tier, `  tier frame confirms '${tier}'`, `reported=${lastTierFrame?.tier}`);
    // Allow generous slack: a frame is only sent when a trade actually moved the candle.
    note(rate <= target + 1.5, `  rate does not exceed the ${tier} ceiling`);
    note(finals >= 1, `  closed candles still delivered at ${tier}`, `${finals} in ${windowMs / 1000}s`);
  }

  const full = measured.full ?? 0;
  const minimal = measured.minimal ?? 1;
  note(full > (measured.degraded ?? 0), 'full delivers more than degraded');
  note((measured.degraded ?? 0) > minimal, 'degraded delivers more than minimal');
  note(full / Math.max(minimal, 0.01) > 4, 'full is several times faster than minimal', `ratio=${(full / Math.max(minimal, 0.01)).toFixed(1)}x`);

  // ---- 5. return to automatic ------------------------------------------------
  console.log('\n[5] Automatic control');
  ws.send(JSON.stringify({ type: 'setTier', tier: 'auto' }));
  await sleep(300);
  note(lastTierFrame?.override === null, 'override cleared', `override=${String(lastTierFrame?.override)}`);

  /**
   * A run of good reports must promote the connection, but NOT in one jump.
   *
   * Promotion deliberately moves one tier at a time, and each step needs three agreeing
   * reports plus the 5s dwell window. So climbing from `minimal` to `full` costs roughly
   * two full cycles. This loop watches the intermediate step rather than only the final
   * state, because observing `minimal -> degraded -> full` is what actually proves the
   * one-step-at-a-time rule is in force.
   */
  const climb: string[] = [];
  let sawDegradedOnTheWay = false;
  for (let i = 0; i < 16; i++) {
    ws.send(JSON.stringify({ type: 'netreport', latencyMs: 15, jitterMs: 2, samples: 10 }));
    await sleep(900);
    const tier = lastTierFrame?.tier;
    if (tier && climb[climb.length - 1] !== tier) climb.push(tier);
    if (tier === 'degraded') sawDegradedOnTheWay = true;
    if (tier === 'full') break;
  }
  note(lastTierFrame?.tier === 'full', 'good reports promoted to full automatically', `tier=${lastTierFrame?.tier}`);
  note(sawDegradedOnTheWay, 'promotion stepped through degraded rather than jumping', `path=${climb.join(' -> ')}`);
  note(lastTierFrame?.reason === 'measurement', 'promotion attributed to measurement', `reason=${lastTierFrame?.reason}`);

  // Now a sustained bad link must demote it.
  for (let i = 0; i < 8; i++) {
    ws.send(JSON.stringify({ type: 'netreport', latencyMs: 600, jitterMs: 80, samples: 10 }));
    await sleep(900);
  }
  note(lastTierFrame?.tier === 'minimal', 'bad reports demoted to minimal automatically', `tier=${lastTierFrame?.tier}`);
  note((lastTierFrame?.score ?? 0) > 400, 'score reflects latency + 2x jitter', `score=${lastTierFrame?.score}`);

  // ---- 6. malformed frames ---------------------------------------------------
  console.log('\n[6] Malformed input handling');
  const errorsBefore = counters.errors.length;
  ws.send('this is not json at all');
  ws.send('{"type":"nonsense"}');
  ws.send('{"type":"subscribe","interval":"3 fortnights"}');
  ws.send('{"type":"setTier","tier":"turbo"}');
  ws.send('{"type":"netreport","latencyMs":"fast","jitterMs":null}');
  ws.send('{"type":"ping"}');
  ws.send('[]');
  ws.send('null');
  await sleep(600);

  const newErrors = counters.errors.length - errorsBefore;
  note(newErrors === 8, 'every malformed frame produced exactly one error reply', `${newErrors}/8`);
  note(ws.readyState === WebSocket.OPEN, 'connection survived all malformed frames');
  console.log(`      sample replies: ${counters.errors.slice(errorsBefore, errorsBefore + 3).join(' | ')}`);

  // The feed must still be healthy afterwards.
  const liveBefore = counters.liveCandles;
  await sleep(1_500);
  note(counters.liveCandles > liveBefore, 'feed still delivering after malformed input');

  // ---- 7. interval switch ----------------------------------------------------
  console.log('\n[7] Interval switching');
  ws.send(JSON.stringify({ type: 'setTier', tier: 'full' }));
  ws.send(JSON.stringify({ type: 'subscribe', interval: '1m' }));
  await sleep(800);
  note(currentInterval === '1m', 'candles now arrive for 1m', `interval=${currentInterval}`);

  ws.send(JSON.stringify({ type: 'subscribe', interval: '5s' }));
  await sleep(800);
  note(currentInterval === '5s', 'candles now arrive for 5s', `interval=${currentInterval}`);

  // ---- summary ---------------------------------------------------------------
  ws.close();
  await sleep(200);

  console.log(`\n${'='.repeat(72)}`);
  if (problems.length === 0) {
    console.log('RESULT: all probe checks passed');
  } else {
    console.log(`RESULT: ${problems.length} check(s) failed:`);
    for (const p of problems) console.log(`  - ${p}`);
  }
  console.log('='.repeat(72));

  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('probe crashed:', error);
  process.exit(1);
});
