# TwoSpoon — Real-Time Cryptocurrency Trading App

A simulated BTC-USDT market with a Node backend and a React Native Android app. The point of
the project is the bit in the middle: **every client sees the same correct market data, but each
receives it at a speed matched to its own connection.**

Correctness is global. Delivery speed is per-client. Every design decision below follows from
keeping those two things apart.

---

## Quick start

Two terminals. Nothing else to install, no database, no exchange account.

```bash
# 1. Backend (this is the one command that starts the market)
npm run backend

# 2. App
cd app && npx react-native run-android
```

`npm run dev` from the repository root starts both together.

### How the device reaches the backend

| Target | Base URL |
|---|---|
| Android emulator | `http://10.0.2.2:8080` |
| Physical device | `adb reverse tcp:8080 tcp:8080`, then `http://localhost:8080` |

`10.0.2.2` is the emulator's alias for the host machine; `localhost` inside an emulator means the
emulator itself. The backend prints both, plus your LAN address, in its startup banner.

**Cleartext HTTP.** Android blocks plain HTTP from API 28 onward, and it fails as a generic
network error that looks exactly like the server being down. The React Native template sets
`usesCleartextTraffic` from a Gradle placeholder that is `false` in release builds, so a release
APK could not reach the dev backend at all. Instead,
[app/android/app/src/main/res/xml/network_security_config.xml](app/android/app/src/main/res/xml/network_security_config.xml)
permits cleartext for `10.0.2.2` and `localhost` **only**, leaving TLS enforced everywhere else.

### Reproducing a market

The generator is seeded, so a run is exactly repeatable:

```bash
SEED=42 npm run backend      # the default
SEED=1337 npm run backend    # a different but equally deterministic market
```

### Verification commands

```bash
npm test                      # 129 tests (47 backend, 82 app)
cd server && npm run replay   # determinism + candles recomputed independently
cd server && npm run probe    # live protocol against a running backend
```

---

## Architecture

```
server/src/
  engine/     THE TRUTH. One speed, always. Knows nothing about clients.
  tier/       The per-client decision. Pure logic, no I/O, no clock.
  ws/         Per-client delivery. Reads from the engine; never writes.
  api/        REST snapshot endpoints.

app/src/
  protocol/   Wire types + total validators.
  net/        I/O only. Socket, REST, latency sampling. No app state.
  domain/     PURE functions. Order book reducer, candle window. No React, no I/O.
  state/      Zustand stores + the one controller that knows about both net and state.
  ui/         Components. Never touch a socket.
```

The directory split **is** the architecture, and the dependency arrows only point one way.

### The central invariant

> A slow client cannot corrupt a candle — and not because I was careful.

`ClientSession` has no method that writes to `MarketEngine`, and the engine returns copies from
every accessor. There is no code path to abuse, so this is structural rather than a rule someone
has to remember. It is also proved three ways:

1. [server/test/candleTiers.test.ts](server/test/candleTiers.test.ts) runs **one** engine into
   **three** sessions pinned to the three tiers, through the real coalescing code and real
   timers, and asserts every closed candle is byte-identical.
2. That same test also asserts the three tiers received **different frame counts** — without
   this, a completely broken throttle that sent everything to everyone would pass.
3. [server/src/tools/replay.ts](server/src/tools/replay.ts) recomputes candles from the raw trade
   stream using deliberately unrelated logic and requires agreement.

### State management: why Zustand

At `full` tier the screen receives ~10 chart frames, ~5 depth frames and ~25 trades per second.
The state library's only job is stopping those from re-rendering components that do not care.

- **React Context** fails at exactly that: one provider value makes every consumer eligible to
  re-render when the value identity changes, so an incoming trade would re-render the chart.
- **Redux** would work, but its boilerplate buys nothing here — the reducers already live in
  `domain/` as pure functions, and the immutable-update ceremony is duplicated effort.
- **Zustand** gives per-selector subscriptions. Every subscription in
  [TradingScreen.tsx](app/src/ui/TradingScreen.tsx) is narrow, so a trade re-renders only the
  trades list and a depth delta only the order book. The store methods cooperate by returning new
  references *only* for the slice they touched.

Three stores, split by update frequency and by who reads them. Not ten — narrow selectors already
prevent the re-renders that over-atomizing would chase.

---

## Precision

**Every price and quantity is an integer, end to end.** A price is a count of ticks (tick size
0.01, so $104,523.45 is `10452345`); a quantity is a count of lots (lot size 0.0001).

Floats cannot represent decimal money: in IEEE-754, `0.1 + 0.2 !== 0.3`. If candle volumes
accumulated in floats, two clients folding the same trades in a different order could disagree —
which would break the cross-tier guarantee this project is built around. Integers make that
impossible rather than unlikely.

**Integers travel over the wire**, along with `priceScale` and `qtyScale` in the hello frame. We
deliberately do *not* send decimal strings like `"104523.45"`, because that invites `parseFloat`
on the client and reintroduces the drift we just eliminated. Conversion happens only in
[app/src/util/format.ts](app/src/util/format.ts), at the render edge.

JS numbers hold integers exactly to 2^53, which is nine orders of magnitude more headroom than
the largest value here (a candle volume).

---

## Generated data and API protocol

### Generation

- **Price**: geometric random walk — multiplicative, not additive, because a $50 move means
  something different at $100 than at $100,000, and it can never go negative. Weak mean reversion
  keeps an overnight run from wandering somewhere absurd. Occasional 5–25bp jumps.
  The internal state is a float, quantized to ticks only when read: the *process* is continuous,
  the *observable* is discrete. Rounding every step would accumulate bias.
- **Trades**: Poisson arrivals at ~25/s with AR(1) momentum, so flow arrives in one-sided bursts
  rather than as a balanced coin flip. Poisson rather than a metronome matters: evenly spaced
  trades would make coalescing look better than it is, since every frame would fold in the same
  count.
  Each trade's timestamp comes from the arrival process, **not** from when the timer fired — so a
  late `setInterval` on a loaded machine changes when we *notice* a trade, never when it occurred.
- **Order book**: 20 levels per side on an **absolute 5-tick price grid**. This is the key
  design choice. Levels relative to mid (`mid - spread - i*gap`) would mean a one-tick mid move
  rewrites all 40 levels, so every delta is a full book and the client's sync logic is never
  exercised. Real books have resting orders at fixed prices that mid moves *through*: when mid
  rises past a grid price, that price stops being an ask and becomes a bid, and one new ask
  appears at the far end. A one-tick move produces a two-level delta, not forty.
- **Candles**: 1s, 5s and 1m. The short ones make live formation and tier differences visible in
  a short recording; 1m is the realistic case.

### REST

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/info` | Symbol scales, intervals, live tier thresholds |
| `GET /api/v1/depth?limit=20` | Order book snapshot with `lastUpdateId` |
| `GET /api/v1/klines?interval=1s&limit=200` | History, oldest first, active candle last |
| `GET /api/v1/trades?limit=50` | Recent trades |
| `POST /api/v1/debug/tier` | Force a tier |
| `POST /api/v1/debug/delay` | Inject pong delay |

`limit` is **clamped**; an unknown `interval` is a **400**. Clamping partially satisfies a
reasonable request, whereas silently substituting a default interval would make the client render
the wrong data believing it was right.

### WebSocket `ws://host:8080/stream`

Server frames: `hello`, `pong`, `trades`, `depth`, `candle` (with `final`), `tier`, `error`.
Client frames: `subscribe`, `ping`, `netreport`, `setTier`, `injectDelay`, `pause`, `resume`.

---

## Chart and order book synchronization

### Chart

History is fetched over REST, then the active candle is updated from the live feed.

**Candles are upserted by `openTime`, never appended.** At `full` tier the same candle arrives up
to ten times a second as a *complete snapshot*; appending would produce ten bars per second
instead of one. This also makes duplicate frames free, which matters because resubscribing after
a reconnect re-sends the active candle.

**Late responses are guarded twice, independently.** Switch from 1s to 1m quickly and two fetches
are in flight; HTTP gives no ordering guarantee, so the 1s response can land second and paint 1s
candles under a 1m label.

1. `LatestRequest` in [app/src/net/rest.ts](app/src/net/rest.ts) compares a monotonic token on
   completion and discards a superseded result. `AbortController` alone is *not* sufficient —
   abort is asynchronous with respect to a response already being parsed, so a request can
   complete in the window before the abort is observed. Aborting saves bandwidth; the token check
   provides correctness.
2. [app/src/domain/candles.ts](app/src/domain/candles.ts) rejects any payload whose interval no
   longer matches what is displayed.

### Order book — the snapshot/delta race

The book comes from two channels with independent latency: a REST snapshot (a photograph of one
instant) and a delta stream (a continuous film). It is only correct if the film starts on exactly
the frame after the photograph. Three obvious approaches all fail:

- Discard deltas until the snapshot lands → permanently lose those in flight.
- Apply deltas, then the snapshot on top → stale data overwrites newer data.
- Fetch the snapshot first, then subscribe → an undetectable hole between them.

So the order is forced: **subscribe and buffer first, then request the snapshot.** You must be
recording before you take the photograph.

Update ids follow Binance's futures scheme: `U` (first id in event), `u` (final id), `pu`
(previous event's final id). `pu` is the only mechanism that lets a client detect a genuine *gap*
rather than merely noticing it fell behind.

On snapshot with `lastUpdateId = S`:

1. Discard buffered deltas where `u <= S` — already contained in the snapshot.
2. **The first surviving delta must satisfy `U <= S+1 <= u`** (a *range* check).
3. Every delta thereafter must satisfy `pu === lastAppliedU` (a *chain* check).

**The first delta and later deltas use different rules, deliberately.** Our snapshot's
`lastUpdateId` includes mutations not yet published, so the next delta can legitimately arrive
with a `pu` *lower* than `S`. A naive `pu === S` check would reject a perfectly valid event and
resync for nothing. There is a test named exactly that: *"accepts a first delta whose pu is below
the snapshot id"*.

This is only safe because **deltas carry absolute quantities, not increments**, so replaying
events the snapshot already contained is a no-op. That single protocol decision is what makes the
whole recovery path work.

Also handled: duplicates, out-of-order events, zero quantity as *deletion*, crossed book
(best bid ≥ best ask) as corruption, buffer overflow tracked explicitly rather than trusting a
bracket check that might coincidentally pass across a hole, and resnapshots rate-limited to one
per second so a broken feed degrades instead of hammering the server.

---

## Latency and jitter measurement

The app sends `{type:'ping', seq, t}` every 2 seconds, where `t` is a reading of **its own**
clock. The server echoes `t` back **untouched**. RTT is `now - t`, computed entirely against the
device's clock.

That is why `t` is opaque to the server: no clock synchronization is needed and device/server skew
cannot corrupt the measurement. Comparing a device timestamp against a server timestamp would
make a phone whose clock is two minutes fast report a latency of minus two minutes.

Over a sliding window of the last 10 samples (a 20-second view):

**Latency = median.** Not the mean. One stalled sample — a radio wake-up, a GC pause, a single TCP
retransmit — can be a hundred times the typical RTT. There is a test showing nine samples around
20ms plus one 2-second stall: the mean reads 218ms and would push a healthy connection most of the
way to `minimal`, while the median stays under 25ms.

**Jitter = mean absolute successive difference**, `mean(|rtt[i] - rtt[i-1]|)`. This is packet
delay variation — the same idea as RFC 3550's smoothed jitter, but over a plain window so it is
trivial to explain and to test against a known array.

Standard deviation was the alternative and is worse here: it measures spread around the mean, so a
connection drifting smoothly from 20ms to 200ms scores high while being perfectly stable frame to
frame. A test contrasts a smooth drift (jitter 20) against an alternating 20/200 pattern
(jitter 180) where standard deviation rates both similarly.

Samples above 10s are discarded as outliers, and negative samples (an NTP correction mid-flight)
are discarded rather than clamped to zero, which would look like a perfect connection.

**A report is withheld until two samples exist**, because jitter is undefined with one. Reporting
jitter 0 off a single sample would claim a stability we have not observed and could earn a
promotion the link has not demonstrated.

---

## Tier thresholds, hysteresis, and fallback

**Score = `latency + 2 × jitter`.** Jitter is weighted double because an unstable link is worse for
a live chart than a uniformly slow one: a steady 200ms delay looks like a smooth chart shifted
slightly in time, whereas 100ms ± 100ms stutters.

| Tier | Score | Chart updates |
|---|---|---|
| `full` | < 150ms | every 100ms (10/s) |
| `degraded` | 150–400ms | every 250ms (4/s) |
| `minimal` | > 400ms | every 1000ms (1/s) |

10/s is above the point where the eye reads a growing candle as continuous; 30/s would cost three
times the bandwidth for a difference nobody can see on a candlestick body that moves a pixel per
update. 4/s still reads as live while cutting messages ~60%. 1/s keeps the chart honest on a bad
link without queueing work the client cannot drain.

These are **ceilings on delivery frequency, not promises to send something.** If no trade moved
the candle, nothing is sent — we never invent market activity to hit a rate. This is why the
`wsProbe` measures 9.0/s against a 10/s target and that is correct, not a shortfall.

### Hysteresis — three mechanisms, each defeating a different failure

1. **Asymmetric bands** (factor 0.7): having fallen to `degraded` at 150ms, you must reach 105ms
   to earn `full` back. Defeats a score parked on a boundary, where 149/151 would otherwise flip
   the decision every report.
2. **Three-report confirmation**: defeats a one-off spike from a GC pause or a single retransmit.
3. **Five-second dwell**: defeats oscillation across a wide range.

**Demotion may skip a step; promotion moves one tier at a time.** Reacting fast to a degrading
network protects the client; reacting slowly to improvement costs almost nothing and avoids
declaring victory early. Consequence worth knowing: recovering `minimal → full` takes ~12 seconds
at the 2s report cadence. That is deliberate and measured, not sluggishness.

A test flaps the score across the boundary 30 times and asserts the tier never moves — then
asserts a *sustained* change still does, so the machine is not simply frozen.

### Missing reports and disconnection

- No report for **6s** → demote one step, once per silent episode (not repeatedly), re-arming when
  reports resume.
- No report for **12s** → force `minimal`.
- A client sending *invalid* reports counts as silent. A rejected report does not register as a
  sign of life — otherwise spamming garbage would keep a dead connection pinned at a fast tier.
- On disconnect the session and its tier state are destroyed. A reconnect starts at **`degraded`**,
  not `full`: we know nothing about the new link, and the failure modes are asymmetric. Guessing
  optimistically and being wrong floods a weak link at exactly the moment the client is also
  fetching REST snapshots. Guessing conservatively costs one promotion cycle.

### What the tier throttles, and what it never does

**Throttled**: active-candle updates (coalesced), trade batches, depth deltas (merged).

**Never throttled**:

- **Closed-candle frames bypass throttling, backpressure, and even the paused flag.** A closed
  candle is the final record of an interval; delaying it past the next candle's open would let the
  client's history permanently disagree with the server's. A dropped *live* frame is only a missed
  refresh. That asymmetry is the entire justification, and it is the single most important line in
  the tier system.
- **Pongs**, so latency measurement stays accurate at every tier.

**Coalescing is lossless** because a candle frame is a full *snapshot*, not a delta: the buffer
overwrites rather than queues, so ten trades collapse into one frame whose OHLCV is identical to
what an unthrottled client sees.

**Depth deltas are merged, not dropped.** Dropping one breaks the client's `pu` chain and forces a
REST resnapshot, which at `minimal` would happen continuously. Merging keeps the first event's
`pu` and the last event's `u`, so the chain the client validates stays exactly correct. It is
sound only because quantities are absolute. The probe confirms zero chain breaks over a live run.

Under **backpressure** (`bufferedAmount` over 256KB) live frames are dropped and counted; depth is
too, and the client's gap detection recovers. That is the pressure valve, not a failure mode.

---

## Reconnect and app lifecycle

- **Exponential backoff with jitter** (500ms → 15s cap). Jitter matters even for one client:
  without it, every client that dropped at the same moment (a server restart) returns in a
  synchronized wave.
- **Half-open sockets** are detected from both ends. The app closes and reconnects if no pong
  arrives for 7s; the server sends WebSocket **protocol-level** pings every 30s and calls
  `terminate()` (not `close()`, whose handshake an unreachable peer will never complete).
  Two kinds of ping is not redundancy: protocol ping detects a dead socket, application ping
  measures RTT — and it *must* be application-level because React Native's WebSocket API does not
  expose protocol pong timing at all.
- **Every reconnect triggers a full resync**: fresh history and a fresh depth snapshot. Cached
  state after an unknown gap is not worth patching up.
- **Backgrounding** does not close the socket immediately. A brief switch away should not cost a
  resync, so the app tells the server to pause chart delivery and only closes after a 20s grace
  period. Coming back always resyncs. The `suspended` flag is set *before* closing so the close
  handler knows it was intentional — otherwise backgrounding starts a reconnect loop that drains
  the battery it was meant to save.
- **Stale vs live**: a single predicate drives dimming across the chart, book and trades, so they
  can never disagree about whether what they show is current. The badge shows both socket state
  *and* data age, because a socket can report itself open while nothing flows.

---

## Debug controls

Open with the **DEBUG** button or by tapping the tier badge. Two deliberately different
mechanisms:

**Force tier** (`full` / `degraded` / `minimal` / `auto`) overrides the decision outright. Proves
the three delivery states exist. The server keeps running its automatic machine underneath, so
`AUTO` resumes from *current* conditions rather than a stale decision.

**Inject pong delay** (`+120` / `+300` / `+600ms`) makes the server delay its replies, so measured
RTT genuinely rises and the tier changes through the **real** measurement path, hysteresis and all.
This is the only practical way to demonstrate automatic behaviour on a good network, and it is the
more convincing demonstration.

Also: **force book resync** and **drop connection (3s)**, so order-book recovery and the
stale-then-reconnect cycle can be shown on demand.

Equivalent REST controls, usable from a terminal without the app:

```bash
curl -X POST localhost:8080/api/v1/debug/tier  -H 'Content-Type: application/json' -d '{"tier":"minimal"}'
curl -X POST localhost:8080/api/v1/debug/delay -H 'Content-Type: application/json' -d '{"ms":600}'
curl localhost:8080/api/v1/debug/sessions      # per-connection tier state
```

Deep link:

```bash
adb shell am start -a android.intent.action.VIEW -d "twospoon://symbol/BTC-USDT"
```

---

## Packages used

**Backend**: `express` 5, `ws` 8, `typescript` 5.9, `tsx`, `jest` + `ts-jest`. No database, no
Redis, nothing external — the assignment requires one-command startup, and in-process determinism
is what makes the cross-tier candle test meaningful. (The typed emitter in `util/emitter.ts` is the
seam where a Redis pub/sub layer would go if this ever needed to scale past one machine; no session
code would change.)

**App**: `react-native` 0.87, `victory-native` 42, `@shopify/react-native-skia` 2.12,
`react-native-reanimated` 4.6, `react-native-worklets` 0.12, `react-native-gesture-handler` 3.3,
`zustand` 5, `zod` 4, `jest`.

**Deliberately not used**: `decimal.js` or any big-decimal library — integer ticks and lots make
arithmetic exact without object overhead. And no charting library that fetches its own data.

### Chart library compliance

The assignment permits "a chart library to render data supplied by your own application" and
forbids embedded charts, WebViews, and components that fetch or stream data themselves.
`victory-native` was checked against that by inspecting the published package, not by trusting
documentation:

- Grepping its entire `src` and `dist` for `fetch(`, `XMLHttpRequest`, `WebSocket`, `WebView` and
  `axios` returns **zero matches**. It has no networking code at all.
- Its runtime dependencies are `d3-scale`, `d3-shape`, `d3-zoom`, `its-fine`,
  `react-fast-compare` — pure maths and React helpers.
- It is not a WebView: it renders through Skia into a native canvas.
- `Candlestick`'s entire data input is `openPoints`, `highPoints`, `lowPoints`, `closePoints` and
  `chartBounds` — arrays we compute.

Everything the assignment insists we own stays ours: fetching history, switching intervals,
forming and updating candles, and discarding late responses. The library turns finished numbers
into pixels. `useChartPressState` supplies the crosshair's timestamp and OHLC on the UI thread;
`useChartTransformState` supplies pan and pinch-zoom.

`react-native-wagmi-charts` was also compliant but rejected: it renders one component per candle
with a `withTiming` animation per property, and its y-domain derives from the data — so a single
price tick re-animates every candle on screen. It also has no viewport concept
(`step = width / data.length`), so there is no pan or zoom.

---

## Tests

129 tests. `npm test` runs both suites.

| Suite | Covers |
|---|---|
| [server/test/tierMachine.test.ts](server/test/tierMachine.test.ts) | 37 tests: bands, flapping, dwell, confirmation, silence ladder, overrides, malformed reports, per-connection independence |
| [server/test/candleTiers.test.ts](server/test/candleTiers.test.ts) | Cross-tier candle equality through real sessions, backpressure, pause, session isolation |
| [app/\_\_tests\_\_/orderBook.test.ts](app/__tests__/orderBook.test.ts) | 33 tests: the in-flight race, bracket vs chain checks, gaps, duplicates, crossed book, buffer overflow, recovery cycles |
| [app/\_\_tests\_\_/latency.test.ts](app/__tests__/latency.test.ts) | Median vs mean under an outlier, jitter vs standard deviation, sequence matching, outlier rejection |
| [app/\_\_tests\_\_/candles.test.ts](app/__tests__/candles.test.ts) | Upsert vs append, duplicates, empty history, interval race, flat-window scale, frame validation, deep links |

The tier machine never calls `Date.now()` — every method takes the time as an argument — which is
why 37 hysteresis tests run in under a second with no fake timers and no sleeping.

### Bugs these actually caught

**Fractional-millisecond candle boundaries.** `replay.ts` recomputed candles independently and
found five of sixty 1s candles silently missing their last trade. Trade timestamps were floats, so
a trade at `1999.7` satisfied `> 1999` (`closeTime`), closed the candle early, and was then
rejected as out-of-order against the next candle's `openTime` of `2000`. Fixed twice over, because
both are independently correct: boundaries now compare against an *exclusive* end, and arrivals
round to whole milliseconds like a real exchange. Two trades sharing a millisecond is left
possible on purpose — that is exactly why a trade needs a monotonic `id`.

**Resync discarded deltas.** The order book reducer ignored deltas while awaiting a replacement
snapshot, which guarantees a *second* gap the moment it lands — the book would oscillate between
resyncing and synced forever. Now every non-synced state buffers, and the delta that revealed the
gap is retained.

**Order book columns collided** (`104713.80104713.85`) — found only by looking at the running app,
which no test would have caught.

---

## Known limitations

- **In memory only.** Restarting the backend loses all history and resets the market.
- **Single symbol**, hard-coded. Multi-symbol would mean a `Map<string, MarketEngine>` and a symbol
  field on subscriptions; it touches routes, protocol and session.
- **No auth or TLS on the debug endpoints** — deliberate, so a reviewer can drive them with curl.
  Would be gated or compiled out in production.
- **1s candles are unrealistic** for a real exchange. Chosen so live formation and tier differences
  are visible in a short recording.
- **A candle's `open` is the previous close**, not the first trade's price as a real exchange
  reports. Chosen so every candle always holds valid OHLC even before its first trade, which
  removes a whole family of NaN and empty-chart cases and keeps the series visually continuous.
  Documented deviation, not an oversight.
- **Per-session delivery timers** rather than one shared scheduler. Fine here; at 10k connections
  a single 50ms ticker checking per-session deadlines would be the change.
- **Chart data flows through a React prop**, so a live update re-renders the chart subtree. Bounded
  by the tier ceiling and by the chart being the only subscriber to the candle slice. A hand-written
  Skia renderer would avoid the React commit entirely.
- **arm64-v8a only.** Skia's debug `.so` is ~115MB per architecture and Gradle keeps three copies,
  so building all four exhausted the disk. Override with
  `-PreactNativeArchitectures=x86_64` for an Intel-host emulator.
- **iOS is untested.** No build was produced; the approach is explainable but unverified.

---

## Verified behaviour

Running on an Android emulator (API 37, arm64), the app loaded 217 candles of history, synchronized
the order book from snapshot plus deltas, measured rtt 36ms / jitter 42ms, reported them, and the
backend promoted it `degraded → full` through the real hysteresis path — 510 chart frames
delivered, zero dropped.

Measured delivery rates against targets: **9.0 / 4.0 / 1.0 per second** for 10/4/1. The measured
figure can sit ~1/s *above* target at the 1s interval, because closed-candle frames bypass
throttling by design.
