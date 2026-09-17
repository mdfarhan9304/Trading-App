import {
  activeCandle,
  changeInterval,
  createCandleWindow,
  priceBounds,
  setHistory,
  upsertCandle,
} from '../src/domain/candles';
import { parseSymbolFromUrl } from '../src/util/deeplink';
import { parseServerFrame } from '../src/protocol/types';
import type { Candle, Interval } from '../src/protocol/types';

/**
 * Candle window behaviour, plus the frame validator and deep link parser.
 *
 * Covers three assignment requirements that are easy to claim and hard to demonstrate:
 * "duplicate candles", "empty history", and "requests that finish after the selected interval
 * has changed".
 */

let nextId = 1;
function candle(openTime: number, interval: Interval = '1s', overrides: Partial<Candle> = {}): Candle {
  return {
    interval,
    openTime,
    closeTime: openTime + 999,
    open: 10_000,
    high: 10_050,
    low: 9_950,
    close: 10_020,
    volume: 500,
    trades: 5,
    lastTradeId: nextId++,
    closed: false,
    ...overrides,
  };
}

const NOW = 1_700_000_000_000;

describe('history loading', () => {
  it('accepts an empty history as a valid result, not an error', () => {
    // A freshly started backend has no closed candles. The chart must render an empty state
    // rather than treating this as a failure.
    const window = setHistory(createCandleWindow('1s'), '1s', [], NOW);
    expect(window.candles).toEqual([]);
    expect(priceBounds(window)).toBeNull();
  });

  it('sorts and de-duplicates history defensively', () => {
    const window = setHistory(
      createCandleWindow('1s'),
      '1s',
      [candle(3_000), candle(1_000), candle(2_000), candle(2_000, '1s', { close: 99_999 })],
      NOW
    );

    expect(window.candles.map((c) => c.openTime)).toEqual([1_000, 2_000, 3_000]);
    // Last occurrence wins, because in a stream the later frame is the more current one.
    expect(window.candles[1]?.close).toBe(99_999);
  });

  it('discards candles whose own interval disagrees with the payload label', () => {
    const window = setHistory(
      createCandleWindow('1s'),
      '1s',
      [candle(1_000, '1s'), candle(2_000, '1m'), candle(3_000, '1s')],
      NOW
    );
    expect(window.candles).toHaveLength(2);
  });
});

describe('the interval-change race', () => {
  /**
   * The assignment requires handling "requests that finish after the selected interval has
   * changed". The network layer discards superseded requests, and this is the second,
   * independent guard: even if a stale response reached the store, it cannot be applied.
   */
  it('rejects history for an interval that is no longer displayed', () => {
    let window = createCandleWindow('1s');

    // The user switches to 1m while the 1s request is still in flight.
    window = changeInterval(window, '1m');
    expect(window.interval).toBe('1m');

    // The late 1s response arrives.
    const after = setHistory(window, '1s', [candle(1_000, '1s'), candle(2_000, '1s')], NOW);

    expect(after.candles).toHaveLength(0);
    expect(after.rejectedWrongInterval).toBe(1);
    // The reference is returned unchanged apart from the counter, so no chart repaint happens.
    expect(after.interval).toBe('1m');
  });

  it('rejects a live candle frame for the wrong interval', () => {
    const window = setHistory(createCandleWindow('1m'), '1m', [candle(0, '1m')], NOW);
    const after = upsertCandle(window, candle(1_000, '1s'), NOW);
    expect(after.rejectedWrongInterval).toBe(1);
    expect(after.candles).toHaveLength(1);
  });

  it('clears the window when the interval changes so no stale bars are shown', () => {
    const window = setHistory(createCandleWindow('1s'), '1s', [candle(1_000), candle(2_000)], NOW);
    expect(window.candles).toHaveLength(2);

    const switched = changeInterval(window, '5s');
    // A 1s candle has no meaning on a 5s chart, and leaving them would briefly render the wrong
    // bars under the new label.
    expect(switched.candles).toHaveLength(0);
    expect(switched.interval).toBe('5s');
  });

  it('is a no-op when the interval is unchanged', () => {
    const window = setHistory(createCandleWindow('1s'), '1s', [candle(1_000)], NOW);
    expect(changeInterval(window, '1s')).toBe(window);
  });
});

describe('live candle updates', () => {
  it('upserts by openTime instead of appending', () => {
    let window = setHistory(createCandleWindow('1s'), '1s', [candle(1_000)], NOW);

    // At full tier the same candle arrives up to ten times a second as a full snapshot.
    for (let i = 0; i < 10; i++) {
      window = upsertCandle(window, candle(1_000, '1s', { close: 10_000 + i }), NOW);
    }

    // Appending would have produced eleven bars for one second of market.
    expect(window.candles).toHaveLength(1);
    expect(activeCandle(window)?.close).toBe(10_009);
  });

  it('extends the window when a genuinely new candle opens', () => {
    let window = setHistory(createCandleWindow('1s'), '1s', [candle(1_000)], NOW);
    window = upsertCandle(window, candle(2_000), NOW);
    expect(window.candles.map((c) => c.openTime)).toEqual([1_000, 2_000]);
  });

  it('treats a duplicate frame as a no-op, which makes resubscribe safe', () => {
    let window = setHistory(createCandleWindow('1s'), '1s', [candle(1_000)], NOW);
    const frame = candle(2_000, '1s', { close: 12_345 });
    window = upsertCandle(window, frame, NOW);
    window = upsertCandle(window, frame, NOW);
    expect(window.candles).toHaveLength(2);
    expect(activeCandle(window)?.close).toBe(12_345);
  });

  it('applies a final frame that arrives after the next candle already opened', () => {
    let window = setHistory(createCandleWindow('1s'), '1s', [candle(1_000)], NOW);
    window = upsertCandle(window, candle(2_000), NOW);

    // The authoritative closed version of candle 1_000 lands late. It must be applied, because
    // the server's final value is the correct one.
    window = upsertCandle(window, candle(1_000, '1s', { closed: true, close: 777 }), NOW);

    expect(window.candles).toHaveLength(2);
    expect(window.candles[0]?.closed).toBe(true);
    expect(window.candles[0]?.close).toBe(777);
    // Order is preserved.
    expect(window.candles.map((c) => c.openTime)).toEqual([1_000, 2_000]);
  });

  it('inserts an out-of-order candle in the correct position', () => {
    let window = setHistory(createCandleWindow('1s'), '1s', [candle(1_000), candle(3_000)], NOW);
    window = upsertCandle(window, candle(2_000), NOW);
    expect(window.candles.map((c) => c.openTime)).toEqual([1_000, 2_000, 3_000]);
  });

  it('rejects a candle older than the retained window', () => {
    const window = setHistory(createCandleWindow('1s'), '1s', [candle(5_000), candle(6_000)], NOW);
    const after = upsertCandle(window, candle(1_000), NOW);
    // Inserting it would grow the array leftward without bound as the window scrolls on.
    expect(after.rejectedTooOld).toBe(1);
    expect(after.candles).toHaveLength(2);
  });
});

describe('price bounds for the chart scale', () => {
  it('pads a normal range', () => {
    const window = setHistory(
      createCandleWindow('1s'),
      '1s',
      [candle(1_000, '1s', { low: 100, high: 200 })],
      NOW
    );
    const bounds = priceBounds(window);
    expect(bounds).not.toBeNull();
    expect(bounds!.min).toBeLessThan(100);
    expect(bounds!.max).toBeGreaterThan(200);
  });

  it('manufactures a band for a completely flat window', () => {
    // Our generator emits a flat doji for a silent interval. A zero-range domain would make the
    // chart's scale non-invertible and produce NaN pixel positions.
    const flat = candle(1_000, '1s', { open: 500, high: 500, low: 500, close: 500 });
    const window = setHistory(createCandleWindow('1s'), '1s', [flat], NOW);

    const bounds = priceBounds(window);
    expect(bounds).not.toBeNull();
    expect(bounds!.max).toBeGreaterThan(bounds!.min);
  });

  it('returns null for an empty window rather than a zero-to-zero axis', () => {
    expect(priceBounds(createCandleWindow('1s'))).toBeNull();
  });
});

describe('frame validation', () => {
  it('rejects malformed JSON without throwing', () => {
    expect(parseServerFrame('not json')).toBeNull();
    expect(parseServerFrame('')).toBeNull();
    expect(parseServerFrame('[]')).toBeNull();
    expect(parseServerFrame('null')).toBeNull();
  });

  it('rejects a frame with no usable type', () => {
    expect(parseServerFrame('{}')).toBeNull();
    expect(parseServerFrame('{"type":123}')).toBeNull();
  });

  it('ignores an unknown frame type rather than treating it as corruption', () => {
    // It may simply be a frame from a newer server version.
    expect(parseServerFrame('{"type":"somethingNew","data":1}')).toBeNull();
  });

  it('rejects a candle frame with a NaN field', () => {
    // NaN cannot be expressed in JSON, but null can, and it must not slip through to the chart
    // where it would silently blank a Skia path.
    const frame = parseServerFrame('{"type":"candle","candle":{"interval":"1s","openTime":0,"closeTime":999,"open":null,"high":1,"low":1,"close":1,"volume":0,"trades":0,"lastTradeId":0,"closed":false},"final":false}');
    expect(frame).toBeNull();
  });

  it('keeps the valid trades in a batch containing one bad entry', () => {
    const frame = parseServerFrame('{"type":"trades","trades":[{"id":1,"ts":1,"price":10,"qty":1,"side":"buy"},{"id":"oops"},{"id":3,"ts":3,"price":30,"qty":3,"side":"sell"}]}');
    expect(frame?.type).toBe('trades');
    // One malformed trade should not cost us the others in the same frame.
    expect(frame?.type === 'trades' && frame.trades).toHaveLength(2);
  });

  it('rejects a depth frame missing an update id', () => {
    expect(parseServerFrame('{"type":"depth","U":1,"u":2,"bids":[],"asks":[]}')).toBeNull();
  });
});

describe('deep link parsing', () => {
  it('extracts a valid symbol', () => {
    expect(parseSymbolFromUrl('twospoon://symbol/BTC-USDT')).toBe('BTC-USDT');
  });

  it('normalises case', () => {
    expect(parseSymbolFromUrl('twospoon://symbol/btc-usdt')).toBe('BTC-USDT');
  });

  it('strips a query string and fragment', () => {
    expect(parseSymbolFromUrl('twospoon://symbol/BTC-USDT?ref=push')).toBe('BTC-USDT');
    expect(parseSymbolFromUrl('twospoon://symbol/BTC-USDT#chart')).toBe('BTC-USDT');
  });

  it('returns null for anything unrecognised instead of throwing', () => {
    expect(parseSymbolFromUrl(null)).toBeNull();
    expect(parseSymbolFromUrl(undefined)).toBeNull();
    expect(parseSymbolFromUrl('')).toBeNull();
    expect(parseSymbolFromUrl('https://example.com/BTC-USDT')).toBeNull();
    expect(parseSymbolFromUrl('twospoon://symbol/')).toBeNull();
    expect(parseSymbolFromUrl('twospoon://other/BTC-USDT')).toBeNull();
  });

  it('rejects a symbol that is not plausibly a trading pair', () => {
    // So a link cannot inject arbitrary text into the UI.
    expect(parseSymbolFromUrl('twospoon://symbol/<script>')).toBeNull();
    expect(parseSymbolFromUrl('twospoon://symbol/NOPAIR')).toBeNull();
  });

  it('survives a malformed percent escape', () => {
    // decodeURIComponent throws on these; a link delivered at cold start must not crash startup.
    expect(parseSymbolFromUrl('twospoon://symbol/%E0%A4%A')).toBeNull();
  });
});
