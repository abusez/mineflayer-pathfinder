'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { HarnessWorld } = require('./harness/world')
const { FakeBot } = require('./harness/fakeBot')
const { Terrain } = require('../nav/blocks')
const { createSim } = require('../nav/sim')
const { Primitives } = require('../nav/primitives')
const { Planner } = require('../nav/planner')

function setup (build, botOpts = {}) {
  const w = new HarnessWorld()
  w.loadArea(-16, -16, 63, 63)
  build(w)
  const bot = new FakeBot(w, { position: new Vec3(0.5, 64, 0.5), ...botOpts })
  for (let i = 0; i < 3; i++) bot.tick()
  const terrain = new Terrain(bot)
  const sim = createSim(bot)
  const primitives = new Primitives(bot, terrain, sim)
  const planner = new Planner(bot, terrain, sim, primitives)
  return { w, bot, terrain, planner, primitives }
}

function kinds (path) {
  return path.map(p => p.kind)
}

test('flat ground goes straight', () => {
  const { planner } = setup(w => w.fill(-5, 63, -5, 40, 63, 40, 'stone'))
  const r = planner.plan({ x: 20, y: 64, z: 0 })
  assert.strictEqual(r.status, 'found')
  assert.ok(r.path.length >= 21 && r.path.length <= 22, `len ${r.path.length}`)
  assert.ok(!kinds(r.path).includes('gap'))
})

test('detours around a wall instead of a long parkour', () => {
  const { planner } = setup(w => {
    w.fill(-5, 63, -5, 40, 63, 40, 'stone')
    w.fill(10, 64, -3, 10, 66, 3, 'stone')
  })
  const r = planner.plan({ x: 20, y: 64, z: 0 })
  assert.strictEqual(r.status, 'found')
  assert.ok(r.path.every(p => p.x !== 10 || Math.abs(p.z) > 3))
})

test('crosses gaps of 1 to 3 with sprint jumps', () => {
  for (const gap of [1, 2, 3]) {
    const { planner } = setup(w => {
      w.fill(-5, 63, -2, 5, 63, 2, 'stone')
      w.fill(6 + gap, 63, -2, 30, 63, 2, 'stone')
    })
    const r = planner.plan({ x: 20, y: 64, z: 0 })
    assert.strictEqual(r.status, 'found', `gap ${gap}`)
    const g = r.path.find(p => p.kind === 'gap')
    assert.ok(g, `gap ${gap} uses a gap move: ${kinds(r.path)}`)
    assert.strictEqual(g.gap, gap)
  }
})

test('4 gap needs a run-up, speed makes 5 possible', () => {
  const four = setup(w => {
    w.fill(-5, 63, -2, 5, 63, 2, 'stone')
    w.fill(10, 63, -2, 30, 63, 2, 'stone')
  })
  const r4 = four.planner.plan({ x: 20, y: 64, z: 0 })
  assert.strictEqual(r4.status, 'found')

  // A flat 5 gap is out of reach even with Speed II (lands ~0.3 short), but
  // one block down it is only possible with Speed.
  const build = w => {
    w.fill(-5, 63, -2, 5, 63, 2, 'stone')
    w.fill(11, 62, -2, 30, 62, 2, 'stone')
  }
  assert.notStrictEqual(setup(build).planner.plan({ x: 20, y: 63, z: 0 }).status, 'found')
  const fast = setup(build, { speed: 2 }).planner.plan({ x: 20, y: 63, z: 0 })
  assert.strictEqual(fast.status, 'found')
  assert.ok(fast.path.some(p => p.kind === 'gap' && p.gap === 5))
})

test('climbs a block, stairs and a slab', () => {
  const { planner } = setup(w => {
    w.fill(-5, 63, -5, 40, 63, 40, 'stone')
    w.set(3, 64, 0, 'stone')
    w.set(4, 65, 0, 'oak_stairs', 0) // ascending east
    w.set(4, 64, 0, 'stone')
    w.fill(5, 64, -2, 9, 65, 2, 'stone')
    w.set(10, 66, 0, 'stone_slab')
    w.fill(10, 64, -2, 10, 65, 2, 'stone')
    w.fill(11, 64, -2, 14, 66, 2, 'stone')
  })
  const r = planner.plan({ x: 13, y: 67, z: 0 })
  assert.strictEqual(r.status, 'found')
  assert.ok(r.path.every(p => p.z === 0 || p.x > 4), kinds(r.path).join(' '))
})

test('climbs a ladder to a roof', () => {
  const { planner } = setup(w => {
    w.fill(-5, 63, -5, 40, 63, 40, 'stone')
    w.fill(8, 64, -3, 14, 69, 3, 'stone')
    w.fill(7, 64, 0, 7, 69, 0, 'ladder', 4) // on the east wall
  })
  const r = planner.plan({ x: 10, y: 70, z: 0 })
  assert.strictEqual(r.status, 'found', r.status)
  assert.ok(kinds(r.path).includes('climb'), kinds(r.path).join(' '))
})

test('jump boost reaches a 2 block ledge', () => {
  const build = w => {
    w.fill(-5, 63, -5, 40, 63, 40, 'stone')
    w.fill(5, 64, -20, 5, 65, 20, 'stone')
    w.fill(6, 64, -20, 20, 65, 20, 'stone')
  }
  assert.notStrictEqual(setup(build).planner.plan({ x: 10, y: 66, z: 0 }).status, 'found')
  const r = setup(build, { jumpBoost: 2 }).planner.plan({ x: 10, y: 66, z: 0 })
  assert.strictEqual(r.status, 'found')
})

test('stops at unloaded terrain as uncertain', () => {
  const { planner, w } = setup(w => w.fill(-5, 63, -5, 47, 63, 10, 'stone'))
  w.unloadColumn(2, 0)
  w.unloadColumn(2, -1)
  const r = planner.plan({ x: 45, y: 64, z: 0 })
  assert.strictEqual(r.status, 'uncertain')
  const last = r.path[r.path.length - 1]
  assert.ok(last.x <= 31, `last x ${last.x}`)
})

test('hops a shallow trench instead of climbing through it', () => {
  const { planner } = setup(w => {
    w.fill(-5, 63, -1, 30, 63, 1, 'stone')
    w.fill(6, 63, -1, 8, 63, 1, 'air') // 1-deep trench, 3 wide
    w.fill(6, 62, -1, 8, 62, 1, 'stone')
  })
  const r = planner.plan({ x: 20, y: 64, z: 0 })
  assert.strictEqual(r.status, 'found')
  assert.ok(kinds(r.path).includes('gap'), kinds(r.path).join(' '))
})

test('jumps down across a gap onto a lower platform', () => {
  const { planner } = setup(w => {
    w.fill(-5, 63, -1, 5, 63, 1, 'stone')
    w.fill(9, 61, -1, 20, 61, 1, 'stone')
  })
  const r = planner.plan({ x: 15, y: 62, z: 0 })
  assert.strictEqual(r.status, 'found')
  assert.ok(r.path.some(p => p.kind === 'gap' && p.H === 62), kinds(r.path).join(' '))
})

test('lists the jumps reachable from where it stands', () => {
  const { planner, primitives } = setup(w => {
    w.fill(-2, 63, -2, 2, 63, 2, 'stone')
    w.set(5, 63, 0, 'stone')
    w.set(0, 64, 4, 'stone')
    w.set(-5, 62, -1, 'stone')
  }, { position: new Vec3(2.5, 64, 0.5) })
  const node = planner.startNode()
  const landings = primitives.jumpTargets(node).filter(m => m.verified).map(m => `${m.x},${m.y},${m.z}`)
  assert.ok(landings.includes('5,64,0'), landings.join(' '))
})

test('jumps at any angle, not just straight, diagonal and N+1', () => {
  // Live case: red -1 125 -11 to green 2 126 -13 is a 3+2 jump, one block up.
  const { planner } = setup(w => {
    w.fill(-10, 121, -20, 10, 121, 0, 'grass')
    w.fill(-1, 122, -11, -1, 125, -11, 'stone')
    w.fill(2, 122, -13, 2, 126, -13, 'stone')
  }, { position: new Vec3(-0.5, 126, -10.5) })
  const r = planner.plan({ x: 2, y: 127, z: -13 })
  assert.strictEqual(r.status, 'found')
  assert.deepStrictEqual(kinds(r.path), ['start', 'gap'])

  // Same level, landing offsets the old hand-written list skipped.
  for (const [dx, dz] of [[3, 2], [2, -3], [-4, 2], [4, 3]]) {
    const { planner } = setup(w => {
      w.set(0, 63, 0, 'stone')
      w.set(dx, 63, dz, 'stone')
    })
    const r = planner.plan({ x: dx, y: 64, z: dz })
    assert.strictEqual(r.status, 'found', `${dx},${dz}`)
    assert.deepStrictEqual(kinds(r.path), ['start', 'gap'], `${dx},${dz}`)
  }
})
