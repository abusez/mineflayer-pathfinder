'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { makeCourse, VARIANTS } = require('./harness/courses')
const { runScenario } = require('./harness/run')
const { createRecorder, replay, stats } = require('../nav/recorder')

test('a recorded bot run replays exactly through the simulator', () => {
  const course = makeCourse('parkour', 4242, VARIANTS[0])
  let recorder = null
  let nav = null
  const res = runScenario({
    ...course,
    maxTicks: 1500,
    onTick (bot, t) {
      if (t === 0) {
        recorder = createRecorder(bot)
        recorder.start()
        nav = bot.nav
      }
    }
  })
  assert.strictEqual(res.status, 'arrived')
  const rec = recorder.stop()
  assert.ok(rec.ticks.length > 50)
  const r = replay(rec, nav.sim)
  assert.ok(r.maxError < 1e-6, `max replay error ${r.maxError}`)
  const st = stats(rec)
  assert.ok(st.blocksPerTick > 0.15)
  assert.ok(st.yawSpeed.max <= 40.2)
})
