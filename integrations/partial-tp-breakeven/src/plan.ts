/**
 * Decide what to do with one open position: take partial profit, move the stop
 * to break-even, or nothing yet.
 *
 * Pure on purpose. Everything that talks to a broker lives in index.ts; this is
 * the part worth testing, because two of its edges quietly break real trades:
 * a partial close that leaves a remainder below the broker's minimum, and a
 * "break-even" that moves a stop BACKWARDS.
 */

export type Side = 'BUY' | 'SELL'

export interface ManagedPosition {
  ticket: number
  symbol: string
  side: Side
  volume: number
  entryPrice: number
  currentPrice: number
  /** The broker's current stop. 0 means "no stop set". */
  stopLoss: number
}

export interface PlanConfig {
  /** Act once profit reaches this multiple of the original stop distance. */
  triggerR: number
  /** Fraction of the position to close at the trigger, 0–1. */
  partialFraction: number
  /** Points BEYOND entry to place the break-even stop, to cover costs. */
  breakEvenOffsetPoints: number
  tickSize: number
  volumeMin: number
  volumeStep: number
  /** Price decimals, for rounding the new stop. */
  digits: number
}

export interface PlanInput {
  position: ManagedPosition
  /**
   * |entry − stop| as it was when we FIRST saw the position. Recorded then,
   * because once the stop moves to break-even the original distance — and with
   * it the definition of 1R — is gone from the broker's record.
   */
  initialStopDistance: number
  alreadyPartialed: boolean
  alreadyMovedToBreakEven: boolean
  config: PlanConfig
}

export type Action =
  | { kind: 'partial-close'; ticket: number; volume: number }
  | { kind: 'move-stop'; ticket: number; stopLoss: number }

export interface Plan {
  actions: Action[]
  /** Always populated — a plan with no actions still says why. */
  reason: string
}

function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 8
  const [mantissa = '', exponent = '0'] = step.toExponential().split('e')
  const mantissaDecimals = (mantissa.split('.')[1] ?? '').length
  return Math.max(0, mantissaDecimals - Number(exponent))
}

export function floorToStep(value: number, step: number): number {
  const steps = Math.floor(value / step + 1e-9)
  return Number((steps * step).toFixed(decimalsOf(step)))
}

/** Profit so far, in price terms. Negative when the trade is losing. */
export function progressOf(p: ManagedPosition): number {
  return p.side === 'BUY' ? p.currentPrice - p.entryPrice : p.entryPrice - p.currentPrice
}

export function planFor(input: PlanInput): Plan {
  const { position, initialStopDistance, alreadyPartialed, alreadyMovedToBreakEven, config } = input
  const actions: Action[] = []

  if (!(initialStopDistance > 0)) {
    return { actions, reason: 'no initial stop distance recorded — cannot define 1R, leaving the position alone' }
  }
  if (!(config.triggerR > 0)) {
    return { actions, reason: `triggerR must be positive (got ${config.triggerR})` }
  }

  const progress = progressOf(position)
  const target = config.triggerR * initialStopDistance
  // Compare on the tick grid, not on exact floats. Prices and distances are
  // both quantised to tickSize, but subtracting them is not: a position sitting
  // exactly at the trigger computes 0.00019999999999997797 against a 0.0002
  // target and would wait forever. Half a tick is below anything the broker can
  // actually quote, so this changes no real decision.
  const tolerance = config.tickSize / 2
  if (progress < target - tolerance) {
    return {
      actions,
      reason: `at ${(progress / initialStopDistance).toFixed(2)}R, waiting for ${config.triggerR}R`,
    }
  }

  const notes: string[] = []

  // ── Partial take-profit ────────────────────────────────────────────────────
  if (alreadyPartialed) {
    notes.push('partial already taken')
  } else if (!(config.partialFraction > 0)) {
    notes.push('partial disabled')
  } else {
    const want = floorToStep(position.volume * config.partialFraction, config.volumeStep)
    const remainder = Number((position.volume - want).toFixed(decimalsOf(config.volumeStep)))
    if (want < config.volumeMin) {
      // e.g. half of a 0.01-lot position is 0.005 — not tradable.
      notes.push(`partial skipped: ${want} is below the broker minimum ${config.volumeMin}`)
    } else if (remainder < config.volumeMin) {
      // Closing this much would leave an untradable stub. Brokers reject it,
      // and closing the WHOLE position instead would be us inventing an exit
      // the user never asked for.
      notes.push(
        `partial skipped: it would leave ${remainder}, below the broker minimum ${config.volumeMin}`,
      )
    } else {
      actions.push({ kind: 'partial-close', ticket: position.ticket, volume: want })
      notes.push(`closing ${want} of ${position.volume}`)
    }
  }

  // ── Break-even stop ───────────────────────────────────────────────────────
  if (alreadyMovedToBreakEven) {
    notes.push('stop already at break-even')
  } else {
    const offset = config.breakEvenOffsetPoints * config.tickSize
    const raw = position.side === 'BUY' ? position.entryPrice + offset : position.entryPrice - offset
    const newStop = Number(raw.toFixed(config.digits))

    // Only ever tighten. A position whose stop has already been trailed past
    // break-even must not have it dragged back toward entry — that would widen
    // the risk on a winning trade, the exact opposite of the intent.
    // `stopLoss === 0` means no stop at all, so anything is an improvement.
    const hasStop = position.stopLoss !== 0
    const improves = position.side === 'BUY'
      ? !hasStop || newStop > position.stopLoss
      : !hasStop || newStop < position.stopLoss

    if (improves) {
      actions.push({ kind: 'move-stop', ticket: position.ticket, stopLoss: newStop })
      notes.push(`stop → ${newStop}`)
    } else {
      notes.push(`stop left at ${position.stopLoss} (already better than break-even ${newStop})`)
    }
  }

  return { actions, reason: notes.join('; ') }
}
