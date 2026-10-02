# Risk-based lot sizing

A TradingView alert carries a fixed `volume`. That means a 10-point stop and a
200-point stop risk wildly different amounts of money from the same alert.

This service sits between TradingView and TickerAll and replaces the fixed lot
size with one computed from your **account balance**, your **risk percentage**
and the **distance to your stop** — so every trade risks the same amount.

```
TradingView alert  ──POST──▶  this service  ──▶  TickerAll  ──▶  your MT5 account
```

**MT5 only.** Demo by default — it refuses to trade a live account unless you
explicitly opt in, and it re-checks with the broker before every order.

---

## The alert message it expects

Set your TradingView alert's **Message** to this JSON. Note there is no
`volume` field — that is the whole point.

```json
{
  "action": "buy",
  "symbol": "EURUSDm",
  "price": {{close}},
  "stop": 1.0820,
  "takeProfit": 1.0920,
  "secret": "the-value-of-WEBHOOK_SECRET"
}
```

| Field | Required | What it does |
|---|---|---|
| `action` | ✅ | `buy` or `sell` |
| `symbol` | ✅ | Your **broker's** symbol name, suffix and all (`EURUSDm`, `XAUUSDs`, `EURUSD.r`). `GET /v1/accounts/:id/symbols` lists yours. |
| `price` | ✅ | The entry price to measure the stop from. Send `{{close}}`. |
| `stop` | ✅ | Stop-loss price. The distance from `price` to here **is** the risk. |
| `type` | — | `market` (default), `limit` or `stop`. For a pending order, `price` is also the order price. |
| `takeProfit` | — | Take-profit price. |
| `riskPercent` | — | Overrides `RISK_PERCENT` for this alert. |
| `comment` | — | Order comment. |
| `secret` | — | Required when `WEBHOOK_SECRET` is set. |

Point the alert's **Webhook URL** at this service, not at TickerAll.

---

## How it sizes

```
points   = |price − stop| / tickSize
riskPerLot = points × tickValueAccount        ← value of a point, in YOUR currency
lots     = (balance × riskPercent / 100) / riskPerLot
```

then rounds **down** onto the broker's `volumeStep` and checks it against
`volumeMin` / `volumeMax`.

Two details that matter more than they look:

- It uses **`tickValueAccount`**, the value of a point in your deposit currency —
  never `tickValue`, which is in the instrument's profit currency. Those differ
  for XAUUSD on a EUR account, for every JPY cross, for EURGBP on a USD account.
  Sizing off the wrong one silently risks the wrong amount. If the broker has not
  supplied it, this service **refuses the trade** rather than guessing.
- It rounds **down**, never to nearest. Rounding up would place a trade that
  risks more than you asked to risk.

---

## Setup

```bash
cp .env.example .env     # then fill it in
npm install
npm test                 # the sizing maths, 11 cases
npm start
```

Expose it to TradingView however you normally would (a small VPS, a tunnel, a
container). It needs no inbound access to anything but itself.

### Environment

| Variable | Required | Notes |
|---|---|---|
| `TICKERALL_API_KEY` | ✅ | Needs trade permission. |
| `TICKERALL_ACCOUNT_ID` | ✅ | The account to trade. Start with a demo one. |
| `RISK_PERCENT` | — | Default percent of balance per trade (default `1`). |
| `WEBHOOK_SECRET` | — | **Set this.** Without it, anyone with the URL can trade your account. |
| `ALLOW_LIVE` | — | Must be exactly `true` to allow a live account. Anything else stays demo-only. |
| `PORT` | — | Default `8080`. |
| `TICKERALL_BASE_URL` | — | Only for staging / self-hosted. |

---

## What it deliberately does not do

Being clear about the edges is more useful than looking complete:

- **It does not guarantee the exact risk on a market order.** It sizes off the
  `price` in the alert; the broker fills at the market. Slippage and spread move
  the real figure a little. A pending order does not have this problem.
- **It sizes off `balance`, not `equity`.** Floating P/L from other open trades
  does not change the size. If you want equity-based sizing, change the one line
  in `handleAlert` — it is deliberately not a config knob, because the two
  behave very differently once you are in drawdown.
- **It does not know about your other positions.** Each alert is sized on its
  own. Ten alerts firing at once will each risk their percentage; there is no
  portfolio cap, no correlation check and no max-open-trades limit.
- **It does not retry.** A failed order returns an error to TradingView and is
  gone. TradingView does not retry webhooks either.
- **It holds no state and has no queue.** Restart it and nothing is lost,
  because nothing was being kept.
- **It does not manage the trade after entry.** For moving stops and taking
  partial profit, see [`../partial-tp-breakeven`](../partial-tp-breakeven).

## Safety

The live-account check runs against the broker on **every** alert, not once at
startup, because the account an id points at can change. If the account is live
and `ALLOW_LIVE` is not exactly `true`, the order is refused with `403`.

Keep `WEBHOOK_SECRET` set. The webhook URL is a bearer credential; a secret in
the body means a leaked URL alone is not enough to trade.

MIT licensed, like the rest of this repo.
