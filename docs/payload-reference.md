# Payload reference

Everything a TradingView alert can send to a TickerAll webhook.

- **Method:** `POST`
- **URL:** `https://tickerall.com/api/webhooks/tv/<your-token>` (copy it from your
  dashboard — it's the webhook's only key)
- **Body:** a single JSON object (the TradingView alert **Message**), max **8 KB**
- **Content-Type:** `application/json` (TradingView sends this automatically for a
  JSON message)

The account the order runs on is **bound to the webhook** on your dashboard — it is
never taken from the payload. One webhook → one account.

---

## `action`

The only required top-level field. One of:

| `action` | Effect |
|---|---|
| `buy` | Open a long, or place a buy pending order |
| `sell` | Open a short, or place a sell pending order |
| `close` | Close one open position |
| `close_all` | Close open positions (optionally just one symbol) |
| `modify` | Change SL/TP of a position, or price/SL/TP of a pending order |

---

## `buy` / `sell`

| Field | Required | Notes |
|---|---|---|
| `symbol` | ✅ | TradingView symbol; auto-resolved to your broker's name (see [Symbols](#symbols)) |
| `volume` | ✅ | Lots, a number `> 0` (e.g. `0.10`) |
| `type` | — | `market` (default), `limit`, or `stop` |
| `price` | for `limit`/`stop` | Trigger price |
| `sl` | — | Stop-loss price |
| `tp` | — | Take-profit price |
| `comment` | — | Order comment (trimmed to 31 chars) |

```json
{ "action": "buy",  "symbol": "BTCUSD", "volume": 0.10 }
{ "action": "sell", "type": "limit", "symbol": "BTCUSD", "volume": 0.10, "price": 65000, "sl": 66000, "tp": 63000 }
```

> `stop_limit` isn't supported yet — it returns `400`.

---

## `close`

Close one open position — targeted by `ticket` (exact) **or** `symbol`.

| Field | Required | Notes |
|---|---|---|
| `ticket` | one of these | The position ticket |
| `symbol` | one of these | Closes the open position on that symbol |
| `volume` | — | Partial close (lots); omit to close the whole position |

```json
{ "action": "close", "symbol": "BTCUSD" }
{ "action": "close", "ticket": 123456789, "volume": 0.05 }
```

> On a **hedging** account a symbol may have several positions — prefer `ticket` there
> so you close exactly the one you mean.

---

## `close_all`

Close every open position, or only those on one symbol.

| Field | Required | Notes |
|---|---|---|
| `symbol` | — | Limit to one instrument; omit to close everything |

```json
{ "action": "close_all" }
{ "action": "close_all", "symbol": "BTCUSD" }
```

If some closes succeed and others fail, you get `207` with a per-position breakdown;
the successful closes are **not** retried.

---

## `modify`

Change an existing position or pending order. Targeted by `ticket` **or** `symbol`;
supply at least one of `sl` / `tp` (positions) or `price` / `sl` / `tp` (pending).

| Field | Required | Notes |
|---|---|---|
| `ticket` | one of these | Position or pending-order ticket |
| `symbol` | one of these | The open position on that symbol |
| `sl` | at least one | New stop-loss |
| `tp` | at least one | New take-profit |
| `price` | — | New trigger price (pending orders only) |

```json
{ "action": "modify", "symbol": "BTCUSD", "sl": 64000, "tp": 70000 }
{ "action": "modify", "ticket": 123456789, "price": 64500 }
```

---

## Symbols

Your TradingView symbol is matched to your broker's instrument name:

1. Exact match (case-insensitive), else
2. The broker instrument whose base name equals your symbol (`BTCUSD` → `BTCUSDm`,
   `EURUSD` → `EURUSD.r`), shortest match wins.

If it can't be matched, the alert is **rejected** with `symbol not found: …` — never a
wrong-symbol guess. For exotic names, add a **symbol alias** on the webhook's Settings
(e.g. `GER40 → DE40.cash`); the alias is applied before matching.

---

## Secret (optional)

If the webhook has **Require a secret** turned on, include it — otherwise the request is
rejected with `401`:

```json
{ "action": "buy", "symbol": "BTCUSD", "volume": 0.10, "secret": "your-secret" }
```

The URL token is already a secret; this is a second factor so a leaked URL alone can't
trade.

---

## Dry run (`test`)

Add `"test": true` to **validate without trading**. TickerAll checks your payload,
confirms the account is live, and resolves the symbol — then returns what it *would* do
and places nothing (and records no fire). Great from the dashboard **Test** button, or
straight from a TradingView alert while you're setting up.

```json
{ "action": "buy", "symbol": "BTCUSD", "volume": 0.10, "test": true }
```

```json
{ "ok": true, "dryRun": true, "account": "…", "wouldRun": { "action": "buy", "requested": "BTCUSD", "symbol": "BTCUSDm", "volume": 0.10 }, "message": "Setup OK — the account is live…" }
```

---

## Responses

Every response is JSON. TradingView shows it in the alert's log.

| Status | Meaning |
|---|---|
| `200` | Done — `{ "ok": true, … }` (or a dry run) |
| `207` | `close_all` partially succeeded — `{ "ok": false, "closed": N, "failed": M, … }` |
| `400` | Invalid payload (bad/missing field, unsupported `action` or `type`) |
| `401` | A secret is required and yours was missing or wrong |
| `404` | Unknown or disabled webhook |
| `409` | The bound account isn't connected — re-arm it (always-hot + reconnect) |
| `413` | Payload larger than 8 KB |
| `422` | The broker rejected the order, or the target symbol/position wasn't found |

Every fire — success or rejection — is logged in your dashboard so you can see exactly
why an alert did or didn't act.
