# Integrations

Runnable examples that do things a TradingView alert can't express on its own.

The rest of this repo is **payloads** — JSON you paste into an alert, which
TickerAll executes as-is. These are **services**: small programs that sit beside
your alerts and add logic. Each is self-contained, runs on its own, and is MIT
licensed like everything else here.

| | What it adds | Shape |
|---|---|---|
| [**risk-based-sizing**](./risk-based-sizing) | Replaces the alert's fixed `volume` with a size computed from your balance, risk percentage and stop distance — so every trade risks the same money | webhook, sits in front of TickerAll |
| [**partial-tp-breakeven**](./partial-tp-breakeven) | Once a position makes a multiple of what it risked, closes part of it and pulls the stop to break-even | polling loop, runs alongside |

Use them together — one to enter, one to manage — or either alone.

## Conventions

Anything added here should follow the same shape:

- **One folder per integration**, self-contained and runnable on its own.
- **A README** covering: what it does, the exact alert message it expects (if
  any), the environment variables, how to run it, and a plain list of what it
  deliberately *doesn't* handle. Being clear about the edges beats looking
  complete.
- **`.env.example` with placeholders.** No secrets in the repo; read config from
  the environment.
- **Demo by default.** Live trading must require an explicit, obvious opt-in —
  people copy these and run them, and a stray alert should not be able to place
  a real trade on a funded account.
- **MT5 only** for now.
- **The logic that can cost money lives in its own tested module.** Both of
  these put their arithmetic in a pure function with unit tests, because that is
  the part a reader will copy and the part that fails quietly.

## Running either one

```bash
cd <integration>
cp .env.example .env     # fill it in
npm install
npm test
npm start
```

Both need a TickerAll API key with trade permission and an account id — the
dashboard has both. Start with a demo account.
