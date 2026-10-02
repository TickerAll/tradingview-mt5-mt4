# Partial take-profit + break-even stop

TradingView gets you into a trade. Nothing gets you out of half of it.

This service watches your open positions and, once one has made a multiple of
what it was risking, **closes part of it** and **pulls the stop up to
break-even** — so the rest of the trade is running on the market's money.

```
TickerAll  ◀──poll──  this service  ──act──▶  TickerAll  ──▶  your MT5 account
```

It is a **loop, not a webhook**: there is no TradingView alert for "price
reached 1R", so this has to look for itself.

**MT5 only.** Demo by default, and `DRY_RUN=true` out of the box so the first
thing you see is what it *would* do.

---

## What it does

For each open position, every `POLL_SECONDS`:

1. On first sight, record **1R** = `|entry − stop|`, the distance the trade was
   opened risking. A position opened with **no stop** is left alone — without
   one there is no risk to take a multiple of.
2. Once profit reaches `TRIGGER_R × 1R`:
   - close `PARTIAL_FRACTION` of the position, and
   - move the stop to entry (± `BREAK_EVEN_OFFSET_POINTS`).
3. Never do either twice.

Nothing is configured per-trade — it manages whatever is open, optionally
filtered to `SYMBOLS`.

---

## Setup

```bash
cp .env.example .env     # then fill it in
npm install
npm test                 # the decision logic, 16 cases
npm start                # DRY_RUN=true by default — watch it first
```

Leave `DRY_RUN=true` until the log says what you expect. Then set it to `false`.

### Environment

| Variable | Default | Notes |
|---|---|---|
| `TICKERALL_API_KEY` | — | Required. Needs trade permission. |
| `TICKERALL_ACCOUNT_ID` | — | Required. Start with a demo account. |
| `TRIGGER_R` | `1` | Act at this multiple of the original stop distance. |
| `PARTIAL_FRACTION` | `0.5` | Fraction to close. `0` = break-even move only. |
| `BREAK_EVEN_OFFSET_POINTS` | `0` | Points past entry, to cover commission/swap. |
| `SYMBOLS` | all | Comma-separated broker symbol names. |
| `POLL_SECONDS` | `10` | How often to check. |
| `DRY_RUN` | `true` | Log decisions, send nothing. |
| `ALLOW_LIVE` | `false` | Must be exactly `true` to manage a live account. |

---

## The two edges that actually bite

Both are covered by tests, because both silently break real trades:

**A partial close that leaves an untradable stub.** Half of a `0.01` lot
position is `0.005`, which no broker will accept. Worse is `0.015` at 90%: the
slice itself is a valid `0.01`, but it leaves `0.005` behind. This service
skips the partial in both cases and still moves the stop — it will not "round
up" into closing your whole position, because that is an exit you did not ask
for.

**A break-even that moves a stop backwards.** If something else has already
trailed your stop past entry, setting it to entry would *widen* the risk on a
winning trade. The stop here only ever tightens.

---

## What it deliberately does not do

- **State is in memory only.** Restarting forgets each position's original stop
  distance. A position whose stop has already been moved then reads as 0R and is
  simply left alone — it fails safe and never re-trades, but it also stops being
  managed. Persist `tracked` to a file or Redis if you need restarts to be
  transparent.
- **It is not a trailing stop.** One move, to break-even, once.
- **One trigger, one partial.** There are no ladders — no "25% at 1R, 25% at 2R".
  Run a second copy with a different `TRIGGER_R` and `SYMBOLS`, or extend
  `planFor` in `src/plan.ts`; the shape is deliberately easy to add a rung to.
- **It polls, so it is not instant.** A fast spike through your trigger and back
  is missed. This manages positions, it does not scalp them.
- **It does not reconcile with your broker's own ideas.** If you also move stops
  by hand or from an EA, the last writer wins.
- **It never opens anything.** The only calls it makes are a partial close and a
  stop modification, both on positions that already exist. For entries, see
  [`../risk-based-sizing`](../risk-based-sizing).

## Safety

The live-account check runs on **every pass**, not once at startup, because the
account an id points at can change under a long-running process. If the account
is live and `ALLOW_LIVE` is not exactly `true`, the pass does nothing and says so.

A failed close or modify is logged and retried on the next pass — the state flag
is only set after the broker accepts, so an error cannot make the service
believe it has already acted.

MIT licensed, like the rest of this repo.
