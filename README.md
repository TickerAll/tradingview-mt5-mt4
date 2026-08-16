# TradingView → MT4 / MT5 (via TickerAll)

Turn a **TradingView alert** into a **live trade** on your MetaTrader 4 or 5 broker
account — no VPS, no Expert Advisor, no MetaTrader terminal left running.

[TickerAll](https://tickerall.com) keeps a live connection to your broker. When your
TradingView alert fires, it POSTs to a private webhook URL; TickerAll places the order
on your account. That's the whole loop.

```
TradingView alert  ──POST──▶  your TickerAll webhook  ──▶  order on your MT4/MT5 account
```

This repo is the **companion guide**: ready-to-use alert payloads, Pine Script
templates, and a full field reference. You don't install anything from here — you paste
a URL and a message into a TradingView alert.

---

## Why

TradingView can send an alert to a webhook, but MetaTrader can't receive one. The usual
workarounds — a Windows VPS running the terminal, a custom EA bridge, a self-hosted
relay — are heavy, fragile, and always-on infrastructure you have to babysit.

TickerAll is the hosted piece in the middle. Your account stays connected on our side,
so an alert can trade the moment it fires — even with your laptop closed.

- **No terminal, no EA, no VPS.** Nothing to install or keep running.
- **MT4 and MT5.** Same webhook, same payloads.
- **Full order control.** Market & pending entries, stop-loss / take-profit, close,
  close-all, modify.
- **Demo or live.** Point an alert at a demo account to paper-trade a strategy, or a
  live account when you're ready. (Free accounts can trade demo; live trading needs Pro.)

---

## Quickstart (~5 minutes)

1. **Create a TickerAll account** at **[tickerall.com](https://tickerall.com)** and
   connect your MT4/MT5 broker account (server, login, password — the password is held
   only while connected, never stored).
2. **Make the account always-hot** (a Pro feature). A TradingView alert carries no
   broker password, so the account has to be *already connected* when the alert fires —
   always-hot keeps it live 24/7.
3. On your dashboard, open **TradingView**, **create a webhook**, and **copy its URL**.
   It looks like `https://tickerall.com/api/webhooks/tv/<your-token>`.
4. In TradingView, create an **alert**. Set **Webhook URL** to the URL you copied, and
   set the alert **Message** to one of the JSON payloads below.
5. **Test it.** Back on the dashboard, hit **Test** next to your webhook — a dry run
   confirms your symbol resolves and the account is live, *without placing a trade*.

That's it. When the alert fires, the trade lands on your account.

> **Heads-up:** the bound account trades for real when you point a live account at it —
> demo trades demo, live trades real money. Double-check which account a webhook is
> bound to before you arm an alert.

---

## Alert payloads

The alert **Message** is a single JSON object. The most common one:

```json
{ "action": "buy", "symbol": "BTCUSD", "volume": 0.10 }
```

More examples (also in [`examples/`](./examples)):

```json
// Limit sell with stop-loss & take-profit
{ "action": "sell", "type": "limit", "symbol": "BTCUSD", "volume": 0.10, "price": 65000, "sl": 66000, "tp": 63000 }

// Close the open position on a symbol
{ "action": "close", "symbol": "BTCUSD" }

// Close everything
{ "action": "close_all" }

// Move the stop-loss / take-profit on an open position
{ "action": "modify", "symbol": "BTCUSD", "sl": 64000, "tp": 70000 }
```

You can build the message dynamically from TradingView placeholders — see
[`pine/`](./pine) for strategy and indicator templates that emit these automatically.

---

## Actions & fields

| `action` | What it does | Required | Optional |
|---|---|---|---|
| `buy` / `sell` | Open a position or place a pending order | `symbol`, `volume` | `type` (`market`\|`limit`\|`stop`), `price` (required for `limit`/`stop`), `sl`, `tp`, `comment` |
| `close` | Close one open position | `ticket` **or** `symbol` | `volume` (partial close) |
| `close_all` | Close all open positions | — | `symbol` (limit to one instrument) |
| `modify` | Change SL/TP of a position, or price/SL/TP of a pending order | `ticket` **or** `symbol`, + at least one of `sl` / `tp` / `price` | — |

Full details, precedence rules, and responses: **[docs/payload-reference.md](./docs/payload-reference.md)**.

---

## Symbols

Your TradingView symbol is matched to your broker's instrument name automatically —
`BTCUSD` resolves to `BTCUSDm`, `EURUSD.r`, etc., depending on your broker. If a name is
exotic and doesn't auto-resolve, add a **symbol alias** on the webhook's **Settings**
(e.g. `GER40 → DE40.cash`). If nothing matches, the alert is rejected with a clear
reason (never a wrong-symbol guess) — visible in your dashboard's fire log.

---

## Security

The webhook URL *is* the key — treat it like a password. For a second factor, turn on
**Require a secret** in the webhook's Settings and include it in the alert:

```json
{ "action": "buy", "symbol": "BTCUSD", "volume": 0.10, "secret": "your-secret" }
```

Now a leaked URL alone can't place a trade.

---

## Requirements & limits

- An always-hot account (**Pro**) — a webhook can only bind to an account that's kept
  connected, so it has a live session when an alert fires.
- Trading follows your account: **demo accounts trade demo; live trading needs Pro.**
  TickerAll doesn't change your risk — it passes your order through. You size and manage
  risk in your strategy.
- Payloads are capped at 8 KB.

---

## Links

- **TickerAll** — [tickerall.com](https://tickerall.com)
- **Your dashboard** — [tickerall.com/dashboard/tradingview](https://tickerall.com/dashboard/tradingview)
- **API docs** — [tickerall.com/docs](https://tickerall.com/docs)
- **Field reference** — [docs/payload-reference.md](./docs/payload-reference.md)
- **Troubleshooting** — [docs/troubleshooting.md](./docs/troubleshooting.md)

---

Questions or a bug? Open an issue here, or reach us from
[tickerall.com/contact](https://tickerall.com/contact).
