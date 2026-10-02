/**
 * Risk-based lot sizing from a TradingView alert.
 *
 * TradingView alerts carry a fixed `volume`. This sits in front of TickerAll and
 * replaces that with a size computed from your account balance, your risk
 * percentage and the distance to your stop — so the same alert risks the same
 * money whether the stop is 10 points away or 200.
 *
 *     TradingView alert ──▶ this service ──▶ TickerAll ──▶ your MT5 account
 *
 * Demo by default. It will not touch a live account unless you explicitly set
 * ALLOW_LIVE=true, and it re-checks the account's demo flag before every order.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Tickerall } from '@tickerall/sdk'
import { sizeFromRisk } from './sizing'

// ── Config ───────────────────────────────────────────────────────────────────
const API_KEY = process.env.TICKERALL_API_KEY
const ACCOUNT_ID = process.env.TICKERALL_ACCOUNT_ID
const PORT = Number(process.env.PORT ?? 8080)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? ''
const DEFAULT_RISK_PERCENT = Number(process.env.RISK_PERCENT ?? 1)
// Opt-in, and deliberately strict: anything other than the exact string "true"
// keeps you on demo. `Boolean("false")` is true, which is how this kind of flag
// usually fails open.
const ALLOW_LIVE = process.env.ALLOW_LIVE === 'true'
const BASE_URL = process.env.TICKERALL_BASE_URL

if (!API_KEY || !ACCOUNT_ID) {
  console.error('Set TICKERALL_API_KEY and TICKERALL_ACCOUNT_ID (see .env.example).')
  process.exit(1)
}

const tickerall = new Tickerall({ apiKey: API_KEY, ...(BASE_URL ? { baseUrl: BASE_URL } : {}) })

/** The alert body. `volume` is intentionally absent — this service computes it. */
interface Alert {
  action: 'buy' | 'sell'
  symbol: string
  /**
   * The entry price to measure the stop distance from. Required, because the
   * stop distance IS the risk and we will not guess at it. Send TradingView's
   * `{{close}}`. For a limit/stop order it is also the order price; for a market
   * order it is only the sizing reference, and the real fill may slip a little —
   * so treat the resulting risk as close, not exact.
   */
  price: number
  /** Where the stop goes. Required: without it there is no risk to size against. */
  stop: number
  /** Defaults to a market order. */
  type?: 'market' | 'limit' | 'stop'
  takeProfit?: number
  /** Overrides RISK_PERCENT for this one alert. */
  riskPercent?: number
  secret?: string
  comment?: string
}

function isAlert(v: unknown): v is Alert {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Record<string, unknown>
  const typeOk = a.type === undefined || a.type === 'market' || a.type === 'limit' || a.type === 'stop'
  return (
    (a.action === 'buy' || a.action === 'sell') &&
    typeof a.symbol === 'string' && a.symbol.length > 0 &&
    typeof a.price === 'number' && Number.isFinite(a.price) &&
    typeof a.stop === 'number' && Number.isFinite(a.stop) &&
    typeOk
  )
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 8 * 1024) throw new Error('payload too large') // TradingView caps at 8 KB
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
  console.log(`[${status}] ${text}`)
}

async function handleAlert(alert: Alert): Promise<{ status: number; body: unknown }> {
  // ── 1. Read the account: balance to size against, and the demo flag ────────
  const detail = await tickerall.accounts.get(ACCOUNT_ID as string)
  if (detail.status !== 'online') {
    return { status: 503, body: { ok: false, error: 'account-offline', hint: detail.hint } }
  }

  // The live guard, checked against the broker on EVERY alert rather than once
  // at boot — the account this id points at can be changed under you.
  if (!detail.isDemo && !ALLOW_LIVE) {
    return {
      status: 403,
      body: {
        ok: false,
        error: 'live-account-blocked',
        message:
          'This account is live and ALLOW_LIVE is not "true". Refusing to trade. ' +
          'Set ALLOW_LIVE=true only when you intend to trade real money.',
      },
    }
  }

  const info = detail.account
  // `balance` can legitimately be 0 on an unfunded account, so test for the
  // field being present rather than truthy, then reject zero for a real reason.
  if (!info || typeof info.balance !== 'number') {
    return { status: 503, body: { ok: false, error: 'no-account-snapshot' } }
  }
  if (info.balance <= 0) {
    return { status: 422, body: { ok: false, error: 'zero-balance', message: 'Nothing to risk.' } }
  }

  // ── 2. Find the symbol's volume + tick spec ───────────────────────────────
  const specs = await tickerall.accounts.symbolSpecs(ACCOUNT_ID as string)
  const spec = specs.find((s) => s.name === alert.symbol)
  if (!spec) {
    return {
      status: 422,
      body: {
        ok: false,
        error: 'symbol-not-found',
        message:
          `No spec for "${alert.symbol}". Broker symbol names carry suffixes ` +
          `(EURUSDm, XAUUSDs, EURUSD.r) — use GET /v1/accounts/:id/symbols to find yours.`,
      },
    }
  }

  // ── 3. Size it ────────────────────────────────────────────────────────────
  const riskPercent = Number.isFinite(alert.riskPercent as number)
    ? (alert.riskPercent as number)
    : DEFAULT_RISK_PERCENT
  if (!(riskPercent > 0)) {
    return { status: 422, body: { ok: false, error: 'bad-risk-percent', riskPercent } }
  }

  // Sanity-check the stop is on the correct side of the entry. A buy whose stop
  // sits ABOVE entry is a mis-built alert, and sizing it would "work" — producing
  // a confident lot size for a trade that is stopped out instantly.
  const side = alert.action === 'buy' ? 'BUY' : 'SELL'
  if ((side === 'BUY' && alert.stop >= alert.price) || (side === 'SELL' && alert.stop <= alert.price)) {
    return {
      status: 422,
      body: {
        ok: false,
        error: 'stop-on-wrong-side',
        message: `A ${alert.action} stop must be ${side === 'BUY' ? 'below' : 'above'} the entry (entry ${alert.price}, stop ${alert.stop}).`,
      },
    }
  }

  const sized = sizeFromRisk({
    riskAmount: (info.balance * riskPercent) / 100,
    entryPrice: alert.price,
    stopPrice: alert.stop,
    spec,
  })
  if (!sized.ok) {
    return { status: 422, body: { ok: false, error: 'cannot-size', message: sized.reason } }
  }

  // ── 4. Place it ───────────────────────────────────────────────────────────
  // `price` goes on the wire only for a pending order. A market order takes the
  // price the broker fills at; sending one would be meaningless at best.
  const type = alert.type ?? 'market'
  const result = await tickerall.orders.place(ACCOUNT_ID as string, {
    type,
    symbol: alert.symbol,
    side,
    volume: sized.volume,
    ...(type === 'market' ? {} : { price: alert.price }),
    stopLoss: alert.stop,
    ...(alert.takeProfit !== undefined ? { takeProfit: alert.takeProfit } : {}),
    ...(alert.comment ? { comment: alert.comment } : {}),
  })

  return {
    status: 200,
    body: {
      ok: true,
      ticket: result.ticket,
      volume: sized.volume,
      riskRequested: Number(((info.balance * riskPercent) / 100).toFixed(2)),
      riskAtStop: Number(sized.riskAtStop.toFixed(2)),
      currency: info.currency ?? null,
      demo: detail.isDemo,
    },
  }
}

createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true })
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method-not-allowed' })

    let alert: Alert
    try {
      const parsed: unknown = JSON.parse(await readBody(req))
      if (!isAlert(parsed)) {
        return send(res, 400, {
          ok: false,
          error: 'bad-alert',
          message: 'Need { action: "buy"|"sell", symbol: string, stop: number }.',
        })
      }
      alert = parsed
    } catch (err) {
      return send(res, 400, { ok: false, error: 'bad-json', message: (err as Error).message })
    }

    // Compared before anything else happens. The URL alone should not be enough
    // to make a trade on your account.
    if (WEBHOOK_SECRET && alert.secret !== WEBHOOK_SECRET) {
      return send(res, 401, { ok: false, error: 'bad-secret' })
    }

    try {
      const { status, body } = await handleAlert(alert)
      send(res, status, body)
    } catch (err) {
      // Never echo the raw error to the caller — it can carry request detail.
      console.error('[alert] failed', err)
      send(res, 502, { ok: false, error: 'upstream-failed' })
    }
  })()
}).listen(PORT, () => {
  console.log(`risk-based-sizing listening on :${PORT}`)
  console.log(`  account   ${ACCOUNT_ID}`)
  console.log(`  risk      ${DEFAULT_RISK_PERCENT}% of balance per trade`)
  console.log(`  live      ${ALLOW_LIVE ? 'ALLOWED (real money)' : 'blocked — demo accounts only'}`)
  console.log(`  secret    ${WEBHOOK_SECRET ? 'required' : 'NOT SET (anyone with the URL can trade)'}`)
})
