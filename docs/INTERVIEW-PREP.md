# Backend Interview Preparation

Everything you need to explain, debug, and modify the backend under questioning.

---

## 1. The one sentence

> Every client sees the same correct market data, but each receives it at a speed
> matched to its own connection.

Correctness is **global**. Delivery speed is **per-client**. Every design decision follows
from keeping those two things separate, and the folder layout is that separation made
physical:

- `engine/` - global truth, one speed, knows nothing about clients
- `tier/` - the per-client decision, pure logic
- `ws/` - per-client delivery, reads from the engine and never writes

---

## 2. Numbers to know cold

**Market**
- Symbol `BTC-USDT`, seed `42`, port `8080`
- Tick size `0.01` -> `priceScale` 100. Lot size `0.0001` -> `qtyScale` 10000
- Start price `104523.45` = `10452345` ticks
- ~25 trades/sec (measured 24.8), engine step every 50ms
- 20 book levels per side (app shows top 10), depth published every 200ms
- Intervals `1s`, `5s`, `1m`

**Tiers**
- `full` 100ms = 10/s | `degraded` 250ms = 4/s | `minimal` 1000ms = 1/s
- Score = `latency + 2 x jitter`
- Demote boundaries: 150ms -> degraded, 400ms -> minimal
- Promote factor 0.7, so promote lines are 105ms and 280ms
- Dwell 5s, confirmations 3, report cadence 2s
- Silence: 6s demote one step, 12s force minimal
- New connection starts at `degraded`

**Limits**
- Backpressure threshold 256KB `bufferedAmount`
- Max inbound frame 4KB, `injectDelay` capped at 5s, JSON body 16KB
- `MAX_BACKFILL` 5000 candles, `maxTradesPerStep` 5000
- Protocol-ping heartbeat every 30s

**Verified results**
- Measured delivery: 9.0 / 4.0 / 1.0 per second (targets 10/4/1), ratio 9.0x
- 47 Jest tests, zero `pu` chain breaks, 8/8 malformed frames handled

---

## 3. File by file: purpose, and the one tricky thing

### `config.ts`
Every tunable in one place so the README cannot drift from reality. All overridable by
environment variable.

### `engine/types.ts`
Defines the precision model. **Tricky thing:** all prices are integer ticks and all
quantities integer lots, and integers travel over the wire. We deliberately do *not* send
decimal strings like `"104523.45"`, because that invites `parseFloat` on the client and
reintroduces float drift. Cross-tier candle equality would then depend on summation order.

### `engine/rng.ts`
Seeded mulberry32. **Tricky thing:** `Math.random()` cannot be seeded in JavaScript, so a
run could never be repeated - and the cross-tier test depends on replaying an identical
trade stream three times.

### `engine/generator.ts`
`PriceProcess` (geometric random walk, weak mean reversion, 5-25bps jumps) and
`TradeGenerator` (Poisson arrivals, AR(1) momentum).

**Tricky thing one:** the price state is a float, quantized to ticks only when read. The
*process* is continuous, the *observable* is discrete. Rounding every step would
accumulate bias and could pin the price if steps fell below half a tick.

**Tricky thing two:** each trade's timestamp comes from the arrival process, not from when
the timer fired. A late `setInterval` changes when we *notice* a trade, never when it
*occurred*.

**Why Poisson not a metronome:** evenly spaced trades would make coalescing look better
than it is, since every frame would fold in the same count. Poisson produces clusters and
gaps, which actually stresses the path.

### `engine/orderBook.ts`
**Tricky thing - the key insight:** levels sit on an *absolute* 5-tick price grid, not
relative to mid. If levels were `mid - spread - i*gap`, a one-tick mid move would rewrite
all 40 levels and every delta would be a full book. Real books have resting orders at
fixed prices that mid moves *through*. So when mid rises past a grid price, that price
stops being an ask and becomes a bid, and one new ask appears at the far end - a two-level
delta instead of forty.

**Second tricky thing:** deltas carry **absolute** quantities, never increments. This makes
applying the same delta twice harmless, which is what allows a client to safely replay
events buffered during a snapshot request, and what makes tier-level merging sound.

Update ids: `U` first id in event, `u` final id, `pu` previous event's final id. `pu` is the
only mechanism that lets a client detect a *gap* rather than merely noticing it fell behind.

### `engine/candles.ts`
**Tricky thing one:** `open` is the *previous candle's close*, not the first trade's price
(which is what a real exchange reports). Chosen so every candle always holds valid OHLC -
even before its first trade, even if none arrives. That deletes an entire family of NaN and
half-initialized-candle bugs and keeps the series visually continuous.

**Tricky thing two - the bug that was found:** boundaries compare against an **exclusive**
end (`openTime + intervalMs`), not `closeTime` (`openTime + intervalMs - 1`). With a
fractional timestamp like `1999.7`, `1999.7 > 1999` closed the candle early and the trade
was then rejected as out-of-order against the next candle's `openTime` of 2000. Five of
sixty 1s candles silently lost their last trade.

### `engine/marketEngine.ts`
**Tricky thing:** one shared RNG for all components, not one each. The whole simulation is
a single deterministic stream from one seed. Separate RNGs would also be deterministic, but
adding a component later would silently change every other component's output, making a
recorded demo unreproducible after a refactor.

`step(now)` interleaves: advance price to the trade's exact timestamp, align the book,
emit the trade, consume liquidity, fold into all three candle series. So a trade prices
against the book *at that instant*.

### `util/emitter.ts`
Typed emitter where `on()` returns an unsubscribe function. Node's `EventEmitter` is
untyped - `emit('candl', x)` compiles and fails silently.

### `tier/tierMachine.ts`
**Tricky thing:** it never calls `Date.now()`. Every method takes the time as an argument.
That is why 37 hysteresis tests run in under a second with no fake timers and no sleeping.

Three hysteresis mechanisms, each defeating a *different* failure:
1. **Asymmetric bands** - defeats a score parked on a boundary (149/151 flapping)
2. **3-report confirmation** - defeats a one-off spike from a GC pause
3. **5s dwell** - defeats oscillation across a wide range

Demotion may skip a step; promotion moves one at a time. Reacting fast to a degrading
network protects the client; reacting slowly to improvement costs nothing.

### `ws/protocol.ts`
Hand-written validators over a schema library: no dependency, the accepted shape is
readable in one place, and it costs nothing on the hot path. Every guard takes `unknown`
and never throws.

**Tricky thing:** `Number.isFinite` is used rather than a `> 0` check, because `NaN` fails
every comparison *silently* and would poison the tier score into permanent NaN.

### `ws/clientSession.ts`
The most important file. Three buffer strategies:

- **Candle updates overwrite** rather than queue. The frame is a full snapshot, so only the
  newest matters - *that is what makes coalescing lossless.*
- **Candle closes bypass everything** - throttling, backpressure, even the paused flag. A
  closed candle is the final record of an interval; delaying it past the next candle's open
  would let the client's history permanently disagree with the server's. A dropped *live*
  frame is only a missed refresh. That asymmetry is the whole justification.
- **Depth deltas merge, not drop.** Dropping breaks the `pu` chain and forces a resnapshot,
  which at `minimal` would happen continuously. Merging keeps the first event's `pu` and the
  last event's `u`, so the chain stays exactly correct.

### `ws/wsServer.ts`
**Tricky thing - two kinds of ping is not redundancy:**
- **Protocol ping** (here) detects a *half-open socket*. If a phone loses power or a NAT
  drops the flow, TCP may never deliver a FIN. Uses `terminate()`, not `close()`, because a
  closing handshake with an unreachable peer never completes.
- **Application ping** (session) measures RTT. Must be application-level because React
  Native's WebSocket API does not expose protocol pong timing at all.

### `api/routes.ts`
**Tricky thing:** `limit` is *clamped* but an unknown `interval` is a *400*. Clamping a
limit partially satisfies a reasonable request; silently substituting a default interval
would make the client render the wrong data believing it was right.

### `index.ts`
REST and WebSocket share one HTTP server and one port, so the app needs one base URL and
the emulator needs one host mapping.

---

## 4. The central invariant, and how to prove it

**Claim:** a slow client cannot corrupt a candle.

**Proof, in order of strength:**

1. **Structural.** `ClientSession` has no method that writes to `MarketEngine`. The engine
   returns copies from every accessor. There is no path to abuse, so this is not a rule
   anyone has to remember.
2. **Tested.** `candleTiers.test.ts` runs one engine into three sessions pinned to the
   three tiers, through the real coalescing code and real timers, then asserts every closed
   candle is byte-identical and that total volume and trade counts match exactly.
3. **The test cannot pass vacuously.** It *also* asserts the three tiers received
   *different* frame counts. Without that, a completely broken throttle sending everything
   to everyone would pass.
4. **Independently verified.** `replay.ts` recomputes candles from the raw trade stream
   using unrelated logic (group by bucket, then reduce) and requires agreement.

---

## 5. Debugging drills

Practise saying where you would look. This is the "debug" half of the interview.

**"The chart is frozen but the connection shows live."**
Order: is `engine.start()` running (does `/health` uptime advance)? Is the session's flush
timer alive, or did a tier change leave it cleared? Is `paused` stuck true from a `pause`
that never got a `resume`? Is `bufferedAmount` above 256KB, so every flush is being dropped
(check `framesDropped` via `GET /api/v1/debug/sessions`)?

**"Candle volume disagrees between two devices."**
This should be impossible. First check they are on the same `interval` and the same
`openTime`. Then confirm both are reading `final: true` frames rather than live ones - a
live frame is a mid-flight snapshot and *should* differ. If genuinely different final
candles, suspect the engine, not delivery: run `npm run replay`, which recomputes
independently.

**"The order book goes crossed."**
Best bid >= best ask means the client applied deltas out of order or missed one. Check the
client detected the `pu` mismatch at all. On the server, confirm `alignTo` is being called
before each trade is priced. `GET /api/v1/depth` shows whether the *server's* book is
crossed - if the server is clean, the bug is client-side.

**"Tier flaps between degraded and full every few seconds."**
Confirm reports are arriving at ~2s (`lastReportAt` in the tier frame). Then check the
score against the band: it must be crossing 105 and 150 with *3 consecutive* reports each
way, which the dwell of 5s should also block. If it genuinely flaps, either
`CONFIRM_REPORTS` or `DWELL_MS` is not being applied - the test for this is
`'holds its tier when the score oscillates across a boundary'`.

**"Server memory grows over hours."**
The suspects, in order: engine listeners not unsubscribed on socket close (check
`dispose()` runs - `hub.count` should drop), `recentTrades` or `closed` candle arrays not
being trimmed, `pongTimers` accumulating from `injectDelay`, or sockets never terminated
because the heartbeat sweep stopped.

**"A client connected but receives nothing."**
Did `start()` send `hello`? Is the client subscribed to an interval the engine has? Is the
socket in `awaitingPong` and about to be terminated? Are frames being sent but failing to
parse client-side (the frame is JSON with integer ticks - a client expecting decimal
strings would render nothing).

---

## 6. "Now modify it" scenarios

**Add a fourth tier.** `Tier` union in `tierMachine.ts`, add to `TIER_INTERVAL_MS`, add a
boundary constant, extend the `switch` in `desiredTier`, extend `oneStepDown`. Nothing in
`engine/` or `clientSession.ts` changes, because delivery reads `tierMachine.intervalMs`.

**Change the jitter weight.** One constant: `TIER_CONFIG.JITTER_WEIGHT`. The score function
is static and separately tested.

**Add a second symbol.** This is the honest weak point: `SYMBOL` is a module constant and
the engine holds one book and one candle set. The correct change is to make `MarketEngine`
per-symbol, hold a `Map<string, MarketEngine>`, and add a symbol field to subscriptions so
a session can subscribe per symbol. Roughly a day, and it touches routes, protocol, and
session.

**Support a 15m interval.** Add to the `Interval` union and `INTERVAL_MS`. The series is
created generically in the engine constructor, so nothing else changes.

**Make delivery push-based instead of timer-based.** Replace the per-session
`setInterval` with one shared 50ms ticker checking each session's deadline. Scales to many
more connections with one timer. I chose per-session timers for clarity and would name this
as the change if asked about 10k connections.

**Persist candle history.** Everything is in memory. Add a store behind `CandleSeries`, or
snapshot to disk periodically. This is a listed limitation, not an oversight.

---

## 7. Weaknesses to own before they are pointed out

Volunteering these reads as confidence; being caught by them does not.

1. **In-memory only.** Restarting the server loses all history and resets the market.
2. **Single symbol.** Hard-coded, as described above.
3. **No auth and no TLS on the debug endpoints.** Deliberate - a reviewer must be able to
   drive them with curl. Would be gated or compiled out in production.
4. **1s candles are unrealistic** for a real exchange. Chosen so live candle formation and
   tier differences are visible in a short recording.
5. **`open` is previous close, not first trade price.** A documented deviation from exchange
   semantics, chosen to eliminate invalid-candle states.
6. **Per-session timers** rather than one shared scheduler. Fine for a demo, not for 10k
   connections.
7. **The comment-to-code ratio is high** (976 comment lines against 1463 code lines)
   because design reasoning was written inline. It belongs in the README.
8. **Depth is dropped under backpressure**, deliberately relying on client resync. That is
   the pressure valve, but it does mean a saturated client sees brief book resyncs.

---

## 8. Trap questions and correct answers

**"You said `full` is 10 updates a second, but the probe measured 9.0. Isn't that a bug?"**
No. Tier rates are *ceilings on delivery frequency*, not promises to send something. A frame
goes out only if a trade actually moved the candle. The assignment explicitly says the
targets are "not a requirement to invent trades when no market event occurs."

**"If you collapse ten trades into one message, haven't you lost nine trades?"**
No, because the message is a full snapshot of the candle, not a delta. The buffer
*overwrites*. All ten trades were folded into the candle by the engine before any delivery
decision was made.

**"Why not just throttle everything by tier, including depth?"**
Because the client's book sync needs an unbroken `pu` chain. Dropping depth forces a full
REST resnapshot, which at `minimal` would happen continuously. Merging gives the same
bandwidth saving with no broken book, and it is only sound because quantities are absolute.

**"How do you know the tier code cannot affect candles?"**
There is no write path. `ClientSession` only reads, and the engine returns copies. It is
structural rather than disciplinary - plus the cross-tier test would fail loudly.

**"Your snapshot's `lastUpdateId` includes unpublished changes. Isn't that a bug?"**
No, and it is why the client's *first* delta uses a range-bracket check (`U <= S+1 <= u`)
rather than a `pu === S` check. The next delta can legitimately have `pu` lower than `S`. A
naive chain check on the first delta would reject a valid event and resync pointlessly.

**"What if the client lies about its latency?"**
It can only harm itself. The tier is per-connection, so a false report changes that one
client's delivery rate and nothing else. Reports are validated for finiteness and sign, and
a rejected report does not count as a sign of life - so spamming garbage gets you demoted
by the silence ladder, not promoted.

**"Why did you start new connections at `degraded` rather than `full`?"**
The failure modes are asymmetric. Guessing optimistically and being wrong floods a weak
link at exactly the moment the client is also fetching REST snapshots. Guessing
conservatively and being wrong costs one promotion cycle of slightly less smooth chart.

**"Why does recovery to `full` take about 12 seconds?"**
Promotion is one step at a time and each step needs 3 confirmations plus a 5s dwell, at a
2s report cadence. Deliberate: fast reaction to degradation protects the client, slow
reaction to improvement avoids declaring victory early. I measured it with the probe.

**"Why 47 tests when the assignment asks for two?"**
The two recommended ones are there. Because the tier machine is pure and takes its clock as
an argument, the rest were nearly free - the whole suite runs in under a second.

---

## 9. How the whole thing was verified

- `npm run replay` - determinism (same seed twice byte-identical), seed sensitivity, and
  candles recomputed from the raw trade stream by independent logic. **This found the
  fractional-timestamp bug.**
- `npm test` - 37 tier tests + 10 cross-tier candle tests.
- `npm run probe` - live protocol against a running server: handshake, RTT echo, `pu` chain
  integrity, measured rate per forced tier, automatic promotion path observed as
  `minimal -> degraded -> full`, 8 malformed frames each answered without dropping the
  connection, interval switching.

If asked "how do you know it works", the honest and strongest answer is: an independent
recomputation caught a real bug that no amount of looking at the UI would have revealed.
