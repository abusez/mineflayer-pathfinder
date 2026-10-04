'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Rotation, DEFAULTS } = require('../nav/rotation')
const { ROUNDING_GCD } = require('../nav/util')

function onGrid (delta) {
  const k = delta / ROUNDING_GCD
  return Math.abs(k - Math.round(k)) < 1e-3
}

function run (r, ticks) {
  const out = []
  let prev = r.yaw
  for (let i = 0; i < ticks; i++) {
    const { yaw } = r.next()
    out.push(yaw - prev)
    prev = yaw
  }
  return out
}

test('turns are smooth, capped, on the GCD grid and land on target', () => {
  for (const angle of [3, 20, 45, 90, 135, 180, -170]) {
    const r = new Rotation(0, 0)
    r.setTarget(angle, 10)
    const deltas = run(r, 40)
    assert.strictEqual(deltas[0], 0, 'reaction delay: nothing on the first tick')
    for (let i = 0; i < deltas.length; i++) {
      assert.ok(Math.abs(deltas[i]) <= DEFAULTS.maxSpeed + ROUNDING_GCD, `speed ${deltas[i]}`)
      assert.ok(onGrid(deltas[i]), `grid ${deltas[i]}`)
      if (i > 0) assert.ok(Math.abs(deltas[i] - deltas[i - 1]) <= DEFAULTS.maxAccel + ROUNDING_GCD, `accel at ${i}`)
    }
    const err = Math.abs(((r.yaw - angle) % 360 + 540) % 360 - 180)
    assert.ok(err <= DEFAULTS.deadzone + ROUNDING_GCD, `angle ${angle} err ${err}`)
  }
})

test('large flicks undershoot then correct, consistently', () => {
  const a = new Rotation(0, 0)
  a.setTarget(120, 0)
  const b = new Rotation(0, 0)
  b.setTarget(120, 0)
  const da = run(a, 30)
  const db = run(b, 30)
  assert.deepStrictEqual(da, db, 'deterministic')
  // A pause (or near pause) between the primary movement and the correction.
  let moving = 0
  for (let i = 1; i < da.length; i++) if (da[i] !== 0 && da[i - 1] === 0 && i > 3) moving++
  assert.ok(moving >= 1, 'has a corrective submovement')
})

test('predict matches what next() will do', () => {
  const r = new Rotation(10, 5)
  r.setTarget(80, 20)
  r.next()
  const predicted = r.predict(15)
  const actual = []
  for (let i = 0; i < 15; i++) actual.push(r.next().yaw)
  assert.deepStrictEqual(predicted, actual)
})

test('predicting does not disturb the real rotation mid-turn', () => {
  const a = new Rotation(0, 0)
  const b = new Rotation(0, 0)
  a.setTarget(150, 0)
  b.setTarget(150, 0)
  for (let i = 0; i < 6; i++) { a.next(); b.next() }
  for (let k = 0; k < 20; k++) a.predict(25)
  for (let i = 0; i < 20; i++) assert.strictEqual(a.next().yaw, b.next().yaw)
})
