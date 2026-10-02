/**
 * Partial take-profit + break-even stop.
 *
 * TradingView gets you into a trade. This manages it afterwards: when a position
 * reaches a multiple of its original risk, close part of it and pull the stop up
 * to break-even, so the rest of the trade is running on the market's money.
 *
 *     TickerAll  ◀──poll── this service ──act──▶ TickerAll ──▶ your MT5 account
 *
 * It is a loop, not a webhook — there is no alert for "price reached 1R".
 *
 * Demo by default. It will not touch a live account unless ALLOW_LIVE=true, and
 * it re-checks the account's demo flag on every pass.
 */

import { Tickerall } from '@tickerall/sdk'
import { planFor, type ManagedPosition, type PlanConfig } from './plan'

// ── Config ───────────────────────────────────────────────────────────────────
const API_KEY = process.env.TICKERALL_API_KEY
const ACCOUNT_ID = process.env.TICKERALL_ACCOUNT_ID
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 10)
const TRIGGER_R = Number(process.env.TRIGGER_R ?? 1)
const PARTIAL_FRACTION = Number(process.env.PARTIAL_FRACTION ?? 0.5)
const BREAK_EVEN_OFFSET_POINTS = Number(process.env.BREAK_EVEN_OFFSET_POINTS ?? 0)
const SYMBOL_FILTER = (process.env.SYMBOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const DRY_RUN = process.env.DRY_RUN === 'true'
// Exact-string opt-in: `Boolean("false")` is true, which is how this sort of
// flag usually fails open.
const ALLOW_LIVE = process.env.ALLOW_LIVE === 'true'
const BASE_URL = process.env.TICKERALL_BASE_URL

if (!API_KEY || !ACCOUNT_ID) {
  console.error('Set TICKERALL_API_KEY and TICKERALL_ACCOUNT_ID (see .env.example).')
  process.exit(1)
}

const tickerall = new Tickerall({ apiKey: API_KEY, ...(BASE_URL ? { baseUrl: BASE_URL } : {}) })

/**
 * What we remember about a position between passes.
 *
 * IN MEMORY ONLY, and that is a real limitation, not an oversight — see the
 * README. Restarting forgets the original stop distance, so a position whose
 * stop has already moved to break-even reads as 0R and is simply left alone.
 * That fails safe (it never re-trades), but it does stop managing it.
 */
interface Tracked {
  initialStopDistance: number
  partialed: boolean
  movedToBreakEven: boolean
}
const tracked = new Map<number, Tracked>()

function log(msg: string, extra?: unknown): void {
  const line = `[${new Date().toISOString()}] ${msg}`
  if (extra === undefined) console.log(line)
  else console.log(line, extra)
}

async function pass(): Promise<void> {
  const detail = await tickerall.accounts.get(ACCOUNT_ID as string)
  if (detail.status !== 'online') {
    log(`account offline — skipping this pass (${detail.hint})`)
    return
  }

  // Re-checked every pass, not once at boot: the account an id points at can be
  // changed underneath a long-running process.
  if (!detail.isDemo && !ALLOW_LIVE) {
    log('REFUSING: account is LIVE and ALLOW_LIVE is not "true". Set it only to trade real money.')
    return
  }

  const positions = detail.positions ?? []
  // Forget tickets the broker no longer reports, so the map cannot grow forever.
  const open = new Set(positions.map((p) => p.ticket))
  for (const ticket of [...tracked.keys()]) if (!open.has(ticket)) tracked.delete(ticket)

  if (positions.length === 0) return

  const specs = await tickerall.accounts.symbolSpecs(ACCOUNT_ID as string)

  for (const p of positions) {
    if (SYMBOL_FILTER.length > 0 && !SYMBOL_FILTER.includes(p.symbol)) continue

    const spec = specs.find((s) => s.name === p.symbol)
    if (!spec) {
      log(`${p.symbol} #${p.ticket}: no symbol spec, skipping`)
      continue
    }
    // Without a tick size we cannot round a stop or compare on the price grid.
    const tickSize = spec.tickSize ?? spec.point
    if (!Number.isFinite(tickSize as number) || (tickSize as number) <= 0) {
      log(`${p.symbol} #${p.ticket}: no usable tickSize, skipping`)
      continue
    }
    if (typeof p.entryPrice !== 'number' || typeof p.currentPrice !== 'number') {
      log(`${p.symbol} #${p.ticket}: no entry/current price yet, skipping`)
      continue
    }

    // First sighting: record 1R from the stop the trade was opened with. A
    // position with no stop can never be managed by this service, because
    // without one there is no risk distance to take a multiple of.
    let state = tracked.get(p.ticket)
    if (!state) {
      if (p.stopLoss === 0) {
        log(`${p.symbol} #${p.ticket}: opened without a stop — cannot define 1R, not managing it`)
        continue
      }
      state = {
        initialStopDistance: Math.abs(p.entryPrice - p.stopLoss),
        partialed: false,
        movedToBreakEven: false,
      }
      tracked.set(p.ticket, state)
      log(`${p.symbol} #${p.ticket}: now managing (1R = ${state.initialStopDistance})`)
    }

    const position: ManagedPosition = {
      ticket: p.ticket,
      symbol: p.symbol,
      side: p.side,
      volume: p.volume,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice,
      stopLoss: p.stopLoss,
    }
    const config: PlanConfig = {
      triggerR: TRIGGER_R,
      partialFraction: PARTIAL_FRACTION,
      breakEvenOffsetPoints: BREAK_EVEN_OFFSET_POINTS,
      tickSize: tickSize as number,
      volumeMin: spec.volumeMin,
      volumeStep: spec.volumeStep,
      digits: spec.digits ?? 5,
    }

    const plan = planFor({
      position,
      initialStopDistance: state.initialStopDistance,
      alreadyPartialed: state.partialed,
      alreadyMovedToBreakEven: state.movedToBreakEven,
      config,
    })
    if (plan.actions.length === 0) continue
    log(`${p.symbol} #${p.ticket}: ${plan.reason}`)

    for (const action of plan.actions) {
      if (DRY_RUN) {
        log(`  DRY_RUN, would ${action.kind}`, action)
        continue
      }
      try {
        if (action.kind === 'partial-close') {
          await tickerall.positions.close(ACCOUNT_ID as string, action.ticket, { volume: action.volume })
          // Only marked after the broker accepted it, so a failure retries next
          // pass instead of being silently skipped forever.
          state.partialed = true
          log(`  closed ${action.volume}`)
        } else {
          await tickerall.positions.modify(ACCOUNT_ID as string, action.ticket, { stopLoss: action.stopLoss })
          state.movedToBreakEven = true
          log(`  stop moved to ${action.stopLoss}`)
        }
      } catch (err) {
        log(`  ${action.kind} FAILED, will retry next pass: ${(err as Error).message}`)
      }
    }
  }
}

let stopping = false
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { stopping = true; log(`${sig} — finishing the current pass then exiting`) })
}

async function main(): Promise<void> {
  log('partial-tp-breakeven starting')
  log(`  account   ${ACCOUNT_ID}`)
  log(`  trigger   ${TRIGGER_R}R → close ${PARTIAL_FRACTION * 100}% + stop to break-even` +
      (BREAK_EVEN_OFFSET_POINTS ? ` +${BREAK_EVEN_OFFSET_POINTS}pt` : ''))
  log(`  symbols   ${SYMBOL_FILTER.length ? SYMBOL_FILTER.join(', ') : 'all'}`)
  log(`  poll      every ${POLL_SECONDS}s`)
  log(`  live      ${ALLOW_LIVE ? 'ALLOWED (real money)' : 'blocked — demo accounts only'}`)
  if (DRY_RUN) log('  DRY_RUN   on — decisions logged, nothing sent')

  while (!stopping) {
    try {
      await pass()
    } catch (err) {
      // Never let one bad pass kill the loop; the next one re-reads everything.
      log(`pass failed: ${(err as Error).message}`)
    }
    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000))
  }
  log('stopped')
}

void main()
