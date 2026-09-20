/**
 * Engine verification harness.  Run with:  npm run replay
 *
 * This exists to prove three properties before any networking code is written, so that
 * when the app later misbehaves we already know the feed itself is sound:
 *
 *   1. DETERMINISM      - the same seed produces a byte-identical market.
 *   2. SEED SENSITIVITY  - a different seed produces a different market (i.e. the seed
 *                          is actually wired through, rather than something being
 *                          accidentally hard-coded).
 *   3. CANDLE CORRECTNESS - candles computed by the engine match candles recomputed
 *                          independently from the raw trade stream.
 *
 * Property 3 is the important one. The engine folds trades into candles incrementally
 * as they arrive; here we capture every emitted trade, aggregate it from scratch with a
 * completely separate implementation, and require the two to agree exactly. That is a
 * real check on the aggregation logic rather than a restatement of it.
 */
import { MarketEngine } from '../engine/marketEngine';
import { SYMBOL_INFO } from '../config';
import { candleOpenTime, INTERVAL_MS, type Candle, type Interval, type Trade } from '../engine/types';

/** A fixed start time so output does not depend on when the script is run. */
const START = 1_700_000_000_000;
const STEP_MS = 50;
const DURATION_MS = 60_000;

const fmtPrice = (ticks: number): string => (ticks / SYMBOL_INFO.priceScale).toFixed(SYMBOL_INFO.priceDecimals);
const fmtQty = (lots: number): string => (lots / SYMBOL_INFO.qtyScale).toFixed(SYMBOL_INFO.qtyDecimals);

interface RunResult {
  trades: Trade[];
  closed: Record<Interval, Candle[]>;
  finalBookTop: string;
}

function run(seed: number): RunResult {
  const engine = new MarketEngine({ seed, startTime: START, clock: () => START });

  const trades: Trade[] = [];
  engine.events.on('trades', (batch) => trades.push(...batch));

  for (let t = START; t <= START + DURATION_MS; t += STEP_MS) {
    engine.step(t);
  }

  const snapshot = engine.getDepthSnapshot(10);
  const bestBid = snapshot.bids[0];
  const bestAsk = snapshot.asks[0];

  return {
    trades,
    closed: {
      '1s': engine.getAllClosedCandles('1s'),
      '5s': engine.getAllClosedCandles('5s'),
      '1m': engine.getAllClosedCandles('1m'),
    },
    finalBookTop: `${bestBid ? fmtPrice(bestBid.price) : 'n/a'} / ${bestAsk ? fmtPrice(bestAsk.price) : 'n/a'}`,
  };
}

/**
 * Rebuild candles from a raw trade list, using logic deliberately unrelated to
 * CandleSeries: group by bucket, then reduce. If this disagrees with the engine, one of
 * the two is wrong.
 *
 * `openingPrices` supplies each bucket's open, because the engine's documented rule is
 * that a candle opens at the previous candle's close rather than at its first trade.
 */
function recomputeCandles(trades: Trade[], interval: Interval, engineCandles: Candle[]): string[] {
  const problems: string[] = [];
  const size = INTERVAL_MS[interval];

  const byBucket = new Map<number, Trade[]>();
  for (const trade of trades) {
    const bucket = candleOpenTime(trade.ts, interval);
    const list = byBucket.get(bucket);
    if (list) list.push(trade);
    else byBucket.set(bucket, [trade]);
  }

  for (const candle of engineCandles) {
    const bucketTrades = byBucket.get(candle.openTime) ?? [];

    // Close time must be exactly one interval minus a millisecond after open.
    if (candle.closeTime !== candle.openTime + size - 1) {
      problems.push(`${interval} @${candle.openTime}: closeTime ${candle.closeTime} inconsistent with openTime`);
    }

    if (bucketTrades.length === 0) {
      // A silent interval: must be a flat doji with no volume.
      if (candle.volume !== 0 || candle.trades !== 0) {
        problems.push(`${interval} @${candle.openTime}: no trades but volume=${candle.volume} trades=${candle.trades}`);
      }
      if (!(candle.open === candle.high && candle.high === candle.low && candle.low === candle.close)) {
        problems.push(`${interval} @${candle.openTime}: silent interval is not flat`);
      }
      continue;
    }

    const prices = bucketTrades.map((t) => t.price);
    const expectedHigh = Math.max(candle.open, ...prices);
    const expectedLow = Math.min(candle.open, ...prices);
    const expectedClose = prices[prices.length - 1];
    const expectedVolume = bucketTrades.reduce((sum, t) => sum + t.qty, 0);
    const expectedLastId = bucketTrades[bucketTrades.length - 1]?.id;

    if (candle.high !== expectedHigh) {
      problems.push(`${interval} @${candle.openTime}: high ${candle.high} != ${expectedHigh}`);
    }
    if (candle.low !== expectedLow) {
      problems.push(`${interval} @${candle.openTime}: low ${candle.low} != ${expectedLow}`);
    }
    if (candle.close !== expectedClose) {
      problems.push(`${interval} @${candle.openTime}: close ${candle.close} != ${expectedClose}`);
    }
    if (candle.volume !== expectedVolume) {
      problems.push(`${interval} @${candle.openTime}: volume ${candle.volume} != ${expectedVolume}`);
    }
    if (candle.trades !== bucketTrades.length) {
      problems.push(`${interval} @${candle.openTime}: trade count ${candle.trades} != ${bucketTrades.length}`);
    }
    if (candle.lastTradeId !== expectedLastId) {
      problems.push(`${interval} @${candle.openTime}: lastTradeId ${candle.lastTradeId} != ${expectedLastId}`);
    }
    if (candle.high < candle.low) {
      problems.push(`${interval} @${candle.openTime}: high below low`);
    }
  }

  return problems;
}

/** Every candle's close must equal the next candle's open, with no time gaps. */
function checkContinuity(candles: Candle[], interval: Interval): string[] {
  const problems: string[] = [];
  const size = INTERVAL_MS[interval];

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    if (!prev || !curr) continue;

    if (curr.openTime !== prev.openTime + size) {
      problems.push(`${interval}: gap between ${prev.openTime} and ${curr.openTime}`);
    }
    if (curr.open !== prev.close) {
      problems.push(`${interval}: open ${curr.open} at ${curr.openTime} != previous close ${prev.close}`);
    }
  }

  return problems;
}

function main(): void {
  console.log('='.repeat(78));
  console.log(`Engine replay: ${(DURATION_MS / 1000).toFixed(0)}s of simulated market, step ${STEP_MS}ms`);
  console.log('='.repeat(78));

  const a = run(42);
  const b = run(42);
  const c = run(1337);

  // ---- Property 1: determinism -------------------------------------------------
  const sameSeedIdentical = JSON.stringify(a) === JSON.stringify(b);
  console.log(`\n[1] Determinism (seed 42 twice)`);
  console.log(`    trades: ${a.trades.length} vs ${b.trades.length}`);
  console.log(`    identical: ${sameSeedIdentical ? 'YES' : 'NO  <-- FAIL'}`);

  // ---- Property 2: seed sensitivity -------------------------------------------
  const differentSeedDiffers = JSON.stringify(a) !== JSON.stringify(c);
  console.log(`\n[2] Seed sensitivity (42 vs 1337)`);
  console.log(`    trades: ${a.trades.length} vs ${c.trades.length}`);
  console.log(`    differs: ${differentSeedDiffers ? 'YES' : 'NO  <-- FAIL'}`);

  // ---- Property 3: candle correctness ----------------------------------------
  console.log(`\n[3] Candle correctness (engine vs independent recomputation)`);
  let allProblems: string[] = [];
  for (const interval of ['1s', '5s', '1m'] as Interval[]) {
    const candles = a.closed[interval];
    const problems = [
      ...recomputeCandles(a.trades, interval, candles),
      ...checkContinuity(candles, interval),
    ];
    allProblems = allProblems.concat(problems);
    console.log(`    ${interval.padEnd(3)} closed candles: ${String(candles.length).padStart(3)}  problems: ${problems.length}`);
  }
  if (allProblems.length > 0) {
    console.log('\n    PROBLEMS:');
    for (const p of allProblems.slice(0, 20)) console.log(`      - ${p}`);
    if (allProblems.length > 20) console.log(`      ... and ${allProblems.length - 20} more`);
  }

  // ---- Human-readable sample --------------------------------------------------
  console.log(`\n[4] Sample of 1s candles (seed 42)`);
  console.log('    openTime      open       high       low        close      volume     trades');
  const sample = a.closed['1s'];
  const show = [...sample.slice(0, 4), ...sample.slice(-3)];
  for (const candle of show) {
    const rel = ((candle.openTime - START) / 1000).toFixed(0).padStart(3);
    console.log(
      `    +${rel}s   ` +
        `${fmtPrice(candle.open).padStart(10)} ${fmtPrice(candle.high).padStart(10)} ` +
        `${fmtPrice(candle.low).padStart(10)} ${fmtPrice(candle.close).padStart(10)} ` +
        `${fmtQty(candle.volume).padStart(10)} ${String(candle.trades).padStart(6)}`
    );
  }

  const oneMinute = a.closed['1m'][0];
  if (oneMinute) {
    console.log(`\n[5] The 1m candle covering the same period`);
    console.log(
      `    O ${fmtPrice(oneMinute.open)}  H ${fmtPrice(oneMinute.high)}  ` +
        `L ${fmtPrice(oneMinute.low)}  C ${fmtPrice(oneMinute.close)}  ` +
        `V ${fmtQty(oneMinute.volume)}  trades ${oneMinute.trades}`
    );
  }

  console.log(`\n[6] Final book top (best bid / best ask): ${a.finalBookTop}`);
  console.log(`    Trade rate: ${(a.trades.length / (DURATION_MS / 1000)).toFixed(1)}/s`);

  const ok = sameSeedIdentical && differentSeedDiffers && allProblems.length === 0;
  console.log(`\n${'='.repeat(78)}`);
  console.log(ok ? 'RESULT: all checks passed' : 'RESULT: FAILURES PRESENT');
  console.log('='.repeat(78));

  process.exit(ok ? 0 : 1);
}

main();
