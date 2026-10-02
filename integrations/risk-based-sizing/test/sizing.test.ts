import test from 'node:test'
import assert from 'node:assert/strict'

import { sizeFromRisk, floorToStep } from '../src/sizing'

/** A plausible Exness-style FX spec: 5-digit, 0.01 lot step. */
const FX = { volumeMin: 0.01, volumeMax: 200, volumeStep: 0.01, tickSize: 0.00001, tickValueAccount: 1 }

test('sizes a trade so the stop costs exactly the risk budget', () => {
  // 20-point stop on a 5-digit symbol = 0.00020. At tickValueAccount 1 per point
  // per lot, one lot risks 20. A 100 budget should therefore buy 5 lots.
  const r = sizeFromRisk({ riskAmount: 100, entryPrice: 1.1, stopPrice: 1.0998, spec: FX })
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.equal(r.volume, 5)
  assert.ok(Math.abs(r.riskAtStop - 100) < 1e-6, `risk at stop = ${r.riskAtStop}`)
})

test('a wider stop buys a smaller position for the same budget', () => {
  const tight = sizeFromRisk({ riskAmount: 100, entryPrice: 1.1, stopPrice: 1.0998, spec: FX })
  const wide = sizeFromRisk({ riskAmount: 100, entryPrice: 1.1, stopPrice: 1.099, spec: FX })
  assert.ok(tight.ok && wide.ok)
  assert.ok(wide.volume < tight.volume, 'wider stop must size smaller')
  // Both still cost the same money — that is the whole point of the integration.
  assert.ok(Math.abs(wide.riskAtStop - tight.riskAtStop) < 1e-6)
})

test('rounds DOWN to the volume step, never up', () => {
  // Anything that rounds up risks more than the budget asked for.
  const r = sizeFromRisk({ riskAmount: 100, entryPrice: 1.1, stopPrice: 1.09977, spec: FX })
  assert.ok(r.ok)
  assert.ok(r.riskAtStop <= 100 + 1e-9, `risk ${r.riskAtStop} must not exceed the 100 budget`)
  assert.equal(r.volume, floorToStep(r.volume, FX.volumeStep), 'must land on the step')
})

test('REFUSES when the budget cannot even cover the broker minimum', () => {
  // A tiny budget against a wide stop: volumeMin would blow through it.
  const r = sizeFromRisk({ riskAmount: 1, entryPrice: 2000, stopPrice: 1900, spec: FX })
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.reason, /minimum|budget/i)
})

test('clamps to volumeMax, which risks less than asked and is therefore allowed', () => {
  const r = sizeFromRisk({
    riskAmount: 1_000_000, entryPrice: 1.1, stopPrice: 1.0999,
    spec: { ...FX, volumeMax: 2 },
  })
  assert.ok(r.ok)
  assert.equal(r.volume, 2)
  assert.ok(r.riskAtStop < 1_000_000)
})

// ── The refusals that stop an example losing someone money ───────────────────

test('REFUSES when tickValueAccount is missing instead of defaulting', () => {
  // The SDK is explicit: absent means unknown. Falling back to the
  // profit-currency figure mis-sizes every cross-currency symbol.
  const { tickValueAccount: _omitted, ...noTickValue } = FX
  const r = sizeFromRisk({ riskAmount: 100, entryPrice: 1.1, stopPrice: 1.0998, spec: noTickValue })
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.reason, /tickValueAccount/)
})

test('REFUSES a missing or zero tickSize', () => {
  const { tickSize: _omitted, ...noTick } = FX
  assert.equal(sizeFromRisk({ riskAmount: 100, entryPrice: 1.1, stopPrice: 1.0998, spec: noTick }).ok, false)
  assert.equal(
    sizeFromRisk({ riskAmount: 100, entryPrice: 1.1, stopPrice: 1.0998, spec: { ...FX, tickSize: 0 } }).ok,
    false,
  )
})

test('REFUSES a zero-distance stop rather than dividing by zero', () => {
  const r = sizeFromRisk({ riskAmount: 100, entryPrice: 1.1, stopPrice: 1.1, spec: FX })
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.reason, /zero-distance|stop is at/i)
})

test('REFUSES a non-positive risk budget', () => {
  for (const riskAmount of [0, -5, Number.NaN]) {
    assert.equal(sizeFromRisk({ riskAmount, entryPrice: 1.1, stopPrice: 1.0998, spec: FX }).ok, false)
  }
})

test('direction does not matter — a stop above entry sizes the same as below', () => {
  const long = sizeFromRisk({ riskAmount: 100, entryPrice: 1.1, stopPrice: 1.0998, spec: FX })
  const short = sizeFromRisk({ riskAmount: 100, entryPrice: 1.0998, stopPrice: 1.1, spec: FX })
  assert.ok(long.ok && short.ok)
  assert.equal(long.volume, short.volume)
})

test('floorToStep survives binary floating point', () => {
  // 0.1 + 0.2 territory: these must not fall a step short.
  assert.equal(floorToStep(0.3, 0.1), 0.3)
  assert.equal(floorToStep(0.07, 0.01), 0.07)
  assert.equal(floorToStep(1.005, 0.01), 1.0)
  assert.equal(floorToStep(2.999999999, 0.5), 2.5)
})
