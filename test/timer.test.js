'use strict'

// net.minecraft.util.Timer behaviour (MCP 1.8.9), with injected clocks.

const test = require('node:test')
const assert = require('node:assert')
const { VanillaTimer } = require('../nav/vanillaClient/timer')

function clockedTimer (startMs = 100000) {
  const clock = { t: startMs }
  const timer = new VanillaTimer(20, { sysClock: () => clock.t, hrClockMs: () => clock.t })
  return { clock, timer, frame (ms) { clock.t += ms; timer.updateTimer(); return timer.elapsedTicks } }
}

test('a steady clock runs exactly 20 ticks per second', () => {
  const { frame } = clockedTimer()
  let ticks = 0
  for (let i = 0; i < 2000; i++) ticks += frame(5) // 10 s of 5 ms frames
  assert.ok(Math.abs(ticks - 200) <= 1, `ticks ${ticks}`)
})

test('frame rate does not change the tick rate', () => {
  for (const ms of [1, 4, 16, 33, 50, 100]) {
    const { frame } = clockedTimer()
    let ticks = 0
    for (let t = 0; t < 10000; t += ms) ticks += frame(ms)
    assert.ok(Math.abs(ticks - 200) <= 1, `${ms} ms frames: ${ticks} ticks`)
  }
})

test('a stall under a second runs at most 10 ticks, then real time continues (no backlog)', () => {
  const { frame } = clockedTimer()
  for (let i = 0; i < 100; i++) frame(5)
  assert.strictEqual(frame(800), 10) // 16 ticks due, capped at 10, rest dropped
  let after = 0
  for (let i = 0; i < 200; i++) after += frame(5) // 1 s
  assert.ok(Math.abs(after - 20) <= 1, `after the stall: ${after}`)
})

test('a stall over a second resets the clock: no ticks for that frame', () => {
  const { frame, timer } = clockedTimer()
  for (let i = 0; i < 100; i++) frame(5)
  // j > 1000: vanilla sets lastHRTime = now, so the delta is 0.
  assert.strictEqual(frame(3000), 0)
  // The stall is outside `counter` but inside the HR delta, so the next sync
  // pulls timeSyncAdjustment below 1 and ticks run slow, never fast...
  let first = 0
  for (let i = 0; i < 200; i++) first += frame(5)
  assert.ok(first <= 20, `first second after: ${first}`)
  assert.ok(timer.timeSyncAdjustment < 1)
  // ...and it converges back to 20 TPS.
  for (let i = 0; i < 200 * 20; i++) frame(5)
  let later = 0
  for (let i = 0; i < 200; i++) later += frame(5)
  assert.ok(Math.abs(later - 20) <= 1, `after recovery: ${later}`)
})

test('the first frame after creation does not burst', () => {
  const { frame } = clockedTimer()
  assert.ok(frame(5) <= 1)
})
