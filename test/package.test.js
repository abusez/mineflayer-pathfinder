'use strict'

// The library surface: index.js exports, navPlugin, and the physics patch.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { HarnessWorld } = require('./harness/world')
const { FakeBot } = require('./harness/fakeBot')

test('index exports the public API without connecting anywhere', () => {
  const lib = require('..')
  for (const name of ['createBot', 'navPlugin', 'createNav', 'vanillaPhysics', 'sessionFromRefreshToken',
    'resolveGameHost', 'attachCommands', 'startDebugServer', 'buildShapeTable', 'resolveShapes', 'Terrain', 'createSim']) {
    assert.strictEqual(typeof lib[name], 'function', name)
  }
})

test('prismarine-physics carries every 1.8.9 patch', () => {
  assert.ok(require('../scripts/patch-physics').isPatched())
})

function world () {
  const w = new HarnessWorld()
  w.loadArea(-16, -16, 31, 31)
  w.fill(-5, 63, -5, 20, 63, 20, 'stone')
  return w
}

test('navPlugin adds bot.nav and emits nav:ready', async () => {
  const { navPlugin } = require('..')
  const bot = new FakeBot(world(), { position: new Vec3(0.5, 64, 0.5) })
  let ready = null
  bot.on('nav:ready', (nav) => { ready = nav })
  navPlugin({ workers: 0 })(bot)
  assert.ok(bot.nav)
  assert.strictEqual(ready, bot.nav)
  assert.strictEqual(typeof bot.nav.goto, 'function')
  // A route over flat ground resolves once the bot arrives.
  const arrived = bot.nav.goto(8, 64, 0)
  for (let i = 0; i < 400 && bot.nav.active; i++) bot.tick()
  await arrived
  assert.strictEqual(Math.floor(bot.entity.position.x), 8)
})

test('navPlugin waits for spawn and needs the vanilla physics plugin', () => {
  const { navPlugin } = require('..')
  const bot = new FakeBot(world(), { position: new Vec3(0.5, 64, 0.5) })
  const entity = bot.entity
  bot.entity = null
  navPlugin({ workers: 0 })(bot)
  assert.strictEqual(bot.nav, undefined)
  bot.entity = entity
  bot.emit('spawn')
  assert.ok(bot.nav)

  const plain = new FakeBot(world(), { position: new Vec3(0.5, 64, 0.5) })
  plain.vanilla = null
  let error = null
  plain.on('error', (err) => { error = err })
  navPlugin({ workers: 0 })(plain)
  assert.strictEqual(plain.nav, undefined)
  assert.match(error.message, /vanilla 1\.8\.9 physics/)
})
