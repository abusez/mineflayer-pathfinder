'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { HarnessWorld } = require('./harness/world')
const { FakeBot } = require('./harness/fakeBot')
const { createSim } = require('../nav/sim')
const { copyInput } = require('../nav/util')

function makeWorld () {
  const w = new HarnessWorld()
  w.loadArea(-32, -32, 64, 64)
  w.fill(-10, 63, -10, 40, 63, 40, 'stone')
  w.fill(6, 64, -2, 6, 64, 2, 'stone')
  w.set(9, 64, 0, 'stone_slab')
  w.fill(12, 63, -3, 14, 63, 3, 'air')
  w.fill(20, 64, -3, 20, 64, 3, 'fence')
  return w
}

function script (t) {
  return {
    input: {
      forward: true,
      back: false,
      left: t % 17 < 5,
      right: t % 23 > 19,
      jump: t % 9 === 0,
      sprint: t > 3 && t % 31 !== 0,
      sneak: t % 41 > 37
    },
    yaw: -90 + t * 1.35,
    pitch: 10
  }
}

test('sim rollout reproduces the live tick exactly', () => {
  for (const speed of [0, 1, 2]) {
    const bot = new FakeBot(makeWorld(), { position: new Vec3(0.5, 64, 0.5), speed, jumpBoost: speed })
    let t = 0
    bot.prependListener('physicsTickBegin', () => {
      const { input, yaw, pitch } = script(t)
      for (const key in input) bot.setControlState(key, input[key])
      bot.setAngleDegrees(yaw, pitch)
    })
    const sim = createSim(bot)

    // settle onto the floor first
    for (let i = 0; i < 5; i++) { t = -1; bot.tick() }
    bot.clearControlStates()

    const s = sim.fromBot()
    const states = []
    for (t = 0; t < 120; t++) {
      bot.tick()
      states.push({ p: bot.entity.position.clone(), v: bot.entity.velocity.clone(), g: bot.entity.onGround, yaw: bot.entity.yawDegrees })
    }

    for (let i = 0; i < 120; i++) {
      const { input } = script(i)
      sim.step(s, copyInput(input), states[i].yaw, 10)
      assert.strictEqual(s.pos.x, states[i].p.x, `speed ${speed} tick ${i} x`)
      assert.strictEqual(s.pos.y, states[i].p.y, `speed ${speed} tick ${i} y`)
      assert.strictEqual(s.pos.z, states[i].p.z, `speed ${speed} tick ${i} z`)
      assert.strictEqual(s.motion.x, states[i].v.x, `speed ${speed} tick ${i} vx`)
      assert.strictEqual(s.onGround, states[i].g, `speed ${speed} tick ${i} ground`)
    }
  }
})

test('1.8 ladder boxes are 0.125 thick', () => {
  const w = new HarnessWorld()
  w.loadArea(0, 0, 15, 15)
  w.set(3, 64, 3, 'ladder', 2)
  const bot = new FakeBot(w)
  const block = bot.blockAt(new Vec3(3, 64, 3))
  const shape = block.shapes[0]
  const thickness = Math.min(shape[3] - shape[0], shape[5] - shape[2])
  assert.strictEqual(thickness, 0.125)
})

test('NavWorld matches ShapeWorld block for block', () => {
  const { ColumnCache, NavWorld } = require('../nav/world')
  const w = makeWorld()
  w.fill(0, 64, 5, 8, 64, 5, 'fence')
  w.set(3, 65, 7, 'ladder', 3)
  w.set(4, 64, 7, 'snow_layer', 4)
  const bot = new FakeBot(w)
  const nav = new NavWorld(bot, new ColumnCache(bot))
  for (let x = -2; x < 25; x++) {
    for (let y = 62; y < 67; y++) {
      for (let z = -4; z < 9; z++) {
        const p = new Vec3(x + 0.3, y + 0.7, z + 0.2)
        assert.deepStrictEqual(nav.getBlock(p), bot.physicsWorld.getBlock(p))
      }
    }
  }
  assert.strictEqual(nav.getBlock(new Vec3(5000, 64, 0)), null)
})
