# Troubleshooting

Every alert TickerAll receives — whether it traded or not — is logged on your dashboard
under the webhook. That fire log is the first place to look: it shows the payload we
received and the exact reason for the outcome.

---

### The alert fired but nothing happened

- **Check the fire log.** If there's no entry at all, TradingView didn't reach the
  webhook — re-check the **Webhook URL** in the alert (a trailing space or a truncated
  token is the usual culprit), and that the alert's condition actually triggered.
- If there **is** an entry, its status/reason tells you what to fix (below).

### `account is not connected — re-arm it…` (409)

The bound account's live session has dropped. An alert carries no broker password, so we
can't reconnect it for you. In the dashboard: turn on **always-hot** (Pro) and
**reconnect** the account. Once it's live, the next alert trades. The dashboard **Test**
button surfaces this state immediately.

### `symbol not found: …` (422)

Your TradingView symbol didn't match a broker instrument. Either send the broker's exact
name in the alert, or add a **symbol alias** on the webhook's Settings
(e.g. `GER40 → DE40.cash`, `XBTUSD → BTCUSD`).

### `bad secret` (401)

The webhook has **Require a secret** on, but the alert didn't include the matching
`"secret"`. Add it to the payload, or turn the requirement off in Settings.

### `404`

The webhook URL is wrong, or the webhook was deleted or disabled. Copy the URL again
from the dashboard, and make sure the webhook's toggle is **Enabled**.

### `Pro required` / can't create a webhook

Webhooks bind to an **always-hot** account, which is a **Pro** feature — the account has
to stay connected so it's live when an alert fires. Upgrade, enable always-hot on the
account, then create the webhook.

### The broker rejected the order (422)

The order reached your broker and it declined — e.g. `INVALID_STOPS` (SL/TP too close or
on the wrong side), `INVALID_PRICE`, market closed, or not enough margin. The broker's
reason is passed straight through to the fire log. Fix the values in your strategy and
re-send.

### `close` / `modify` hit the wrong position

On a **hedging** account, one symbol can hold several positions, and targeting by
`symbol` acts on the first match. Target by **`ticket`** to be exact. (On a netting
account there's only one position per symbol, so `symbol` is unambiguous.)

### `stop-limit not yet supported` (400)

Stop-limit entries aren't available yet — use `market`, `limit`, or `stop`.

---

## Test before you arm it

Add `"test": true` to any payload (or click **Test** on the dashboard) to dry-run it: we
validate the payload, confirm the account is live, and resolve the symbol **without
placing a trade**. It's the fastest way to prove a new alert is wired correctly.

Still stuck? Reach us from [tickerall.com/contact](https://tickerall.com/contact) or open
an issue on this repo.
