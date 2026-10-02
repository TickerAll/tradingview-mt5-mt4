/**
 * Position sizing from a risk budget — the only part of this integration that
 * can quietly cost you money, so it lives on its own and is unit-tested.
 *
 * The formula is the one TickerAll documents on `SymbolSpec.tickValue`:
 *
 *     risk = |entry - stop| / tickSize * tickValuePerLot * lots
 *
 * rearranged for `lots`. Everything else here is guard rails.
 */

/** The fields this module needs from `accounts.symbolSpecs()`. */
export interface VolumeSpec {
  volumeMin: number
  volumeMax: number
  volumeStep: number
  /** Smallest price increment. */
  tickSize?: number
  /**
   * Value of a one-point move on 1.00 lot, IN THE ACCOUNT'S CURRENCY.
   *
   * We deliberately use this and never `tickValue`. `tickValue` is in the
   * instrument's PROFIT currency, which is a different number whenever that
   * differs from your deposit currency (XAUUSD on a EUR account, EURGBP on a
   * USD account, every JPY cross...). Sizing off it silently risks the wrong
   * amount. The SDK's own docs say: do not default this — absent means unknown.
   */
  tickValueAccount?: number
}

export interface SizingInput {
  /** How much of the account currency you are willing to lose. Must be > 0. */
  riskAmount: number
  entryPrice: number
  stopPrice: number
  spec: VolumeSpec
}

export type SizingResult =
  | { ok: true; volume: number; riskAtStop: number; riskPerLot: number }
  | { ok: false; reason: string }

/** Decimal places implied by a step like 0.01 → 2. Used to undo float drift. */
function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 8
  const [mantissa = '', exponent = '0'] = step.toExponential().split('e')
  const mantissaDecimals = (mantissa.split('.')[1] ?? '').length
  return Math.max(0, mantissaDecimals - Number(exponent))
}

/** Round DOWN onto the broker's volume step. Down, never nearest: rounding up
 *  would place a trade that risks more than the budget you asked for. */
export function floorToStep(value: number, step: number): number {
  const d = decimalsOf(step)
  // + a hair of epsilon so 0.29999999999 lands on 0.30 rather than 0.29.
  const steps = Math.floor(value / step + 1e-9)
  return Number((steps * step).toFixed(d))
}

export function sizeFromRisk(input: SizingInput): SizingResult {
  const { riskAmount, entryPrice, stopPrice, spec } = input

  if (!Number.isFinite(riskAmount) || riskAmount <= 0) {
    return { ok: false, reason: `riskAmount must be a positive number (got ${riskAmount})` }
  }
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopPrice)) {
    return { ok: false, reason: 'entryPrice and stopPrice must both be numbers' }
  }

  const stopDistance = Math.abs(entryPrice - stopPrice)
  if (stopDistance === 0) {
    return { ok: false, reason: 'stop is at the entry price — that is a zero-distance stop, not a risk' }
  }

  const { tickSize, tickValueAccount, volumeMin, volumeMax, volumeStep } = spec

  // Refuse rather than guess. A missing tick value is the broker not telling us
  // what a point is worth; inventing one here is how an example silently sizes
  // a position 100x too large on a cross-currency symbol.
  if (!Number.isFinite(tickSize as number) || (tickSize as number) <= 0) {
    return { ok: false, reason: 'symbol spec has no usable tickSize — cannot size this trade' }
  }
  if (!Number.isFinite(tickValueAccount as number) || (tickValueAccount as number) <= 0) {
    return {
      ok: false,
      reason:
        'symbol spec has no tickValueAccount (value of a point in YOUR account currency). ' +
        'Refusing to size rather than guess — the profit-currency figure would be wrong ' +
        'for any symbol whose profit currency is not your deposit currency.',
    }
  }

  const points = stopDistance / (tickSize as number)
  const riskPerLot = points * (tickValueAccount as number)
  if (!Number.isFinite(riskPerLot) || riskPerLot <= 0) {
    return { ok: false, reason: 'computed risk-per-lot is not a usable positive number' }
  }

  const raw = riskAmount / riskPerLot
  let volume = floorToStep(raw, volumeStep)

  // Above the broker's ceiling: clamp. This risks LESS than the budget, which is
  // safe, so it proceeds — but the caller is told the real figure.
  if (volume > volumeMax) volume = floorToStep(volumeMax, volumeStep)

  // Below the broker's floor: REFUSE. Trading volumeMin here would risk MORE
  // than you asked to risk, which is the one direction an example must never
  // round. Widen the stop, raise the risk, or skip the trade.
  if (volume < volumeMin) {
    const riskAtMin = volumeMin * riskPerLot
    return {
      ok: false,
      reason:
        `risk budget ${riskAmount.toFixed(2)} is too small for this stop: the broker's minimum ` +
        `${volumeMin} lots would risk ${riskAtMin.toFixed(2)}. Refusing to exceed the budget.`,
    }
  }

  return { ok: true, volume, riskAtStop: volume * riskPerLot, riskPerLot }
}
