import test from 'node:test'
import assert from 'node:assert/strict'

import { planFor, progressOf, floorToStep, type ManagedPosition, type PlanConfig } from '../src/plan'

const CONFIG: PlanConfig = {
  triggerR: 1,
  partialFraction: 0.5,
  breakEvenOffsetPoints: 0,
  tickSize: 0.00001,
  volumeMin: 0.01,
  volumeStep: 0.01,
  digits: 5,
}

/** A long entered at 1.10000 with a 20-point stop → 1R = 0.00020. */
function long(overrides: Partial<ManagedPosition> = {}): ManagedPosition {
  return {
    ticket: 1, symbol: 'EURUSDm', side: 'BUY', volume: 1.0,
    entryPrice: 1.1, currentPrice: 1.1, stopLoss: 1.0998,
    ...overrides,
  }
}

const R = 0.0002
const base = { initialStopDistance: R, alreadyPartialed: false, alreadyMovedToBreakEven: false, config: CONFIG }

test('does nothing before the trigger', () => {
  const plan = planFor({ ...base, position: long({ currentPrice: 1.10015 }) }) // +0.75R
  assert.equal(plan.actions.length, 0)
  assert.match(plan.reason, /0\.75R.*waiting/)
})

test('at the trigger it takes a partial AND moves the stop to break-even', () => {
  const plan = planFor({ ...base, position: long({ currentPrice: 1.1002 }) }) // +1R
  assert.equal(plan.actions.length, 2)
  assert.deepEqual(plan.actions[0], { kind: 'partial-close', ticket: 1, volume: 0.5 })
  assert.deepEqual(plan.actions[1], { kind: 'move-stop', ticket: 1, stopLoss: 1.1 })
})

test('a short triggers on price falling, by the same distance', () => {
  const short = long({ side: 'SELL', currentPrice: 1.0998, stopLoss: 1.1002 })
  assert.ok(Math.abs(progressOf(short) - R) < 1e-12)
  const plan = planFor({ ...base, position: short })
  assert.equal(plan.actions.length, 2)
  assert.deepEqual(plan.actions[1], { kind: 'move-stop', ticket: 1, stopLoss: 1.1 })
})

test('a losing position is left completely alone', () => {
  const plan = planFor({ ...base, position: long({ currentPrice: 1.0995 }) })
  assert.equal(plan.actions.length, 0)
})

// ── Idempotence: the loop re-sees the same position every tick ───────────────

test('does not take the partial twice', () => {
  const plan = planFor({ ...base, position: long({ currentPrice: 1.1002 }), alreadyPartialed: true })
  assert.equal(plan.actions.filter((a) => a.kind === 'partial-close').length, 0)
  assert.match(plan.reason, /already taken/)
})

test('does not re-move a stop already at break-even', () => {
  const plan = planFor({
    ...base,
    position: long({ currentPrice: 1.1002 }),
    alreadyPartialed: true,
    alreadyMovedToBreakEven: true,
  })
  assert.equal(plan.actions.length, 0)
})

// ── The partial-close edges that brokers actually reject ────────────────────

test('skips the partial when the REMAINDER would be below the broker minimum', () => {
  // 0.015 lots at 90%: the slice floors to 0.01, which IS tradable — but it
  // leaves 0.005 behind, which is not. The broker rejects that, and closing the
  // whole position instead would be inventing an exit nobody asked for.
  const plan = planFor({
    ...base,
    position: long({ volume: 0.015, currentPrice: 1.1002 }),
    config: { ...CONFIG, partialFraction: 0.9 },
  })
  assert.equal(plan.actions.filter((a) => a.kind === 'partial-close').length, 0)
  assert.match(plan.reason, /would leave .*below the broker minimum/)
  assert.equal(plan.actions.filter((a) => a.kind === 'move-stop').length, 1, 'break-even still happens')
})

test('skips the partial when the slice itself is below the broker minimum', () => {
  // The classic: half of a 0.01 lot position is 0.005.
  const plan = planFor({ ...base, position: long({ volume: 0.01, currentPrice: 1.1002 }) })
  assert.equal(plan.actions.filter((a) => a.kind === 'partial-close').length, 0)
  assert.match(plan.reason, /below the broker minimum/)
  assert.equal(plan.actions.filter((a) => a.kind === 'move-stop').length, 1)
})

test('never closes the entire position via the partial path', () => {
  for (const volume of [0.01, 0.02, 0.03, 0.15, 1, 7.77]) {
    const plan = planFor({ ...base, position: long({ volume, currentPrice: 1.1002 }) })
    for (const a of plan.actions) {
      if (a.kind === 'partial-close') {
        assert.ok(a.volume < volume, `${volume}: partial ${a.volume} must leave something behind`)
        assert.ok(volume - a.volume >= CONFIG.volumeMin - 1e-9, `${volume}: remainder below minimum`)
      }
    }
  }
})

test('the partial lands on the broker volume step', () => {
  const plan = planFor({
    ...base,
    position: long({ volume: 0.07, currentPrice: 1.1002 }),
    config: { ...CONFIG, partialFraction: 1 / 3 },
  })
  const partial = plan.actions.find((a) => a.kind === 'partial-close')
  assert.ok(partial && partial.kind === 'partial-close')
  assert.equal(partial.volume, floorToStep(partial.volume, CONFIG.volumeStep))
  assert.equal(partial.volume, 0.02) // 0.0233… floored onto 0.01
})

// ── The stop must only ever tighten ─────────────────────────────────────────

test('does NOT drag a trailed stop backwards toward entry', () => {
  // Stop already at 1.1005, better than break-even. Moving it to 1.10000 would
  // re-expose a winning trade to a loss.
  const plan = planFor({ ...base, position: long({ currentPrice: 1.1009, stopLoss: 1.1005 }) })
  assert.equal(plan.actions.filter((a) => a.kind === 'move-stop').length, 0)
  assert.match(plan.reason, /already better than break-even/)
})

test('same protection for a short, where better means lower', () => {
  const plan = planFor({
    ...base,
    position: long({ side: 'SELL', currentPrice: 1.0991, stopLoss: 1.0995 }),
  })
  assert.equal(plan.actions.filter((a) => a.kind === 'move-stop').length, 0)
})

test('a position with NO stop still gets one at break-even', () => {
  const plan = planFor({ ...base, position: long({ currentPrice: 1.1002, stopLoss: 0 }) })
  const move = plan.actions.find((a) => a.kind === 'move-stop')
  assert.ok(move && move.kind === 'move-stop')
  assert.equal(move.stopLoss, 1.1)
})

test('the break-even offset pushes the stop past entry, in the right direction', () => {
  const cfg = { ...CONFIG, breakEvenOffsetPoints: 10 } // 10 × 0.00001 = 0.0001
  const up = planFor({ ...base, position: long({ currentPrice: 1.1002 }), config: cfg })
  assert.deepEqual(up.actions[1], { kind: 'move-stop', ticket: 1, stopLoss: 1.1001 })

  const down = planFor({
    ...base,
    position: long({ side: 'SELL', currentPrice: 1.0998, stopLoss: 1.1002 }),
    config: cfg,
  })
  assert.deepEqual(down.actions[1], { kind: 'move-stop', ticket: 1, stopLoss: 1.0999 })
})

test('refuses to act with no recorded initial stop distance', () => {
  const plan = planFor({ ...base, initialStopDistance: 0, position: long({ currentPrice: 1.2 }) })
  assert.equal(plan.actions.length, 0)
  assert.match(plan.reason, /no initial stop distance/)
})

test('a plan with no actions always explains itself', () => {
  for (const p of [
    planFor({ ...base, position: long({ currentPrice: 1.0995 }) }),
    planFor({ ...base, initialStopDistance: 0, position: long() }),
    planFor({ ...base, position: long({ currentPrice: 1.1002 }), alreadyPartialed: true, alreadyMovedToBreakEven: true }),
  ]) {
    assert.ok(p.reason.length > 0, 'silent no-op is a debugging dead end')
  }
})
