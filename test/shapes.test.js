'use strict'

// 1.8.9 collision boxes (nav/shapes18.js). Expected values are transcribed
// from the 1.8.9 client source (MCP 9.19, net.minecraft.block.*).

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { HarnessWorld } = require('./harness/world')
const { FakeBot } = require('./harness/fakeBot')
const { Terrain } = require('../nav/blocks')
const { ColumnCache, NavWorld } = require('../nav/world')
const { createSim } = require('../nav/sim')
const { emptyInput } = require('../nav/util')

function world (build) {
  const w = new HarnessWorld()
  w.loadArea(-16, -16, 31, 31)
  w.fill(-8, 63, -8, 16, 63, 16, 'stone')
  build(w)
  return w
}

function terrain (build) {
  const w = world(build)
  return new Terrain(new FakeBot(w))
}

// Order-free comparison: the client adds boxes in a fixed order, but
// collision only depends on the set.
function sorted (boxes) {
  return boxes.map(b => b.join(',')).sort()
}

function boxes (t, x, y, z) {
  return sorted(t.shapesAt(x, y, z))
}

test('static 1.8.9 boxes', () => {
  const t = terrain(w => {
    w.set(0, 64, 0, 'farmland')
    w.set(1, 64, 0, 'waterlily')
    w.set(2, 64, 0, 'soul_sand')
    w.set(3, 64, 0, 'cactus')
    w.set(4, 64, 0, 'snow_layer', 0)
    w.set(5, 64, 0, 'snow_layer', 7)
    w.set(6, 64, 0, 'cocoa', 0)
    w.set(7, 64, 0, 'end_portal_frame', 4)
    w.set(8, 64, 0, 'anvil', 1)
    w.set(9, 64, 0, 'piston_head', 0)
    w.set(10, 64, 0, 'piston_head', 13)
    w.set(11, 64, 0, 'fence_gate', 0)
    w.set(12, 64, 0, 'fence_gate', 4)
    w.set(13, 64, 0, 'vine', 1)
    w.set(14, 64, 0, 'trapdoor', 6)
  })
  // BlockFarmland.getCollisionBoundingBox is a full block (rendered 0.9375).
  assert.deepStrictEqual(boxes(t, 0, 64, 0), sorted([[0, 0, 0, 1, 1, 1]]))
  assert.deepStrictEqual(boxes(t, 1, 64, 0), sorted([[0, 0, 0, 1, 0.015625, 1]]))
  assert.deepStrictEqual(boxes(t, 2, 64, 0), sorted([[0, 0, 0, 1, 0.875, 1]]))
  assert.deepStrictEqual(boxes(t, 3, 64, 0), sorted([[0.0625, 0, 0.0625, 0.9375, 0.9375, 0.9375]]))
  // BlockSnow: (layers - 1) * 0.125, so one layer has no height.
  assert.deepStrictEqual(boxes(t, 4, 64, 0), [])
  assert.deepStrictEqual(boxes(t, 5, 64, 0), sorted([[0, 0, 0, 1, 0.875, 1]]))
  // BlockCocoa: facing south, age 0.
  assert.deepStrictEqual(boxes(t, 6, 64, 0), sorted([[0.375, 0.4375, 0.6875, 0.625, 0.75, 0.9375]]))
  assert.deepStrictEqual(boxes(t, 7, 64, 0), sorted([[0, 0, 0, 1, 0.8125, 1], [0.3125, 0.8125, 0.3125, 0.6875, 1, 0.6875]]))
  assert.deepStrictEqual(boxes(t, 8, 64, 0), sorted([[0, 0, 0.125, 1, 1, 0.875]]))
  // BlockPistonExtension: the arm stays inside the head block in 1.8.
  assert.deepStrictEqual(boxes(t, 9, 64, 0), sorted([[0, 0, 0, 1, 0.25, 1], [0.375, 0.25, 0.375, 0.625, 1, 0.625]]))
  assert.deepStrictEqual(boxes(t, 10, 64, 0), sorted([[0.75, 0, 0, 1, 1, 1], [0, 0.375, 0.25, 0.75, 0.625, 0.75]]))
  assert.deepStrictEqual(boxes(t, 11, 64, 0), sorted([[0, 0, 0.375, 1, 1.5, 0.625]]))
  assert.deepStrictEqual(boxes(t, 12, 64, 0), []) // open gate
  assert.deepStrictEqual(boxes(t, 13, 64, 0), []) // vines have no box
  assert.deepStrictEqual(boxes(t, 14, 64, 0), sorted([[0.8125, 0, 0, 1, 1, 1]])) // open trapdoor, west
})

test('ladders are 1/8 slabs on the attached face', () => {
  const t = terrain(w => {
    w.set(0, 64, 2, 'ladder', 2)
    w.set(1, 64, 2, 'ladder', 3)
    w.set(2, 64, 2, 'ladder', 4)
    w.set(3, 64, 2, 'ladder', 5)
  })
  assert.deepStrictEqual(boxes(t, 0, 64, 2), sorted([[0, 0, 0.875, 1, 1, 1]]))
  assert.deepStrictEqual(boxes(t, 1, 64, 2), sorted([[0, 0, 0, 1, 1, 0.125]]))
  assert.deepStrictEqual(boxes(t, 2, 64, 2), sorted([[0.875, 0, 0, 1, 1, 1]]))
  assert.deepStrictEqual(boxes(t, 3, 64, 2), sorted([[0, 0, 0, 0.125, 1, 1]]))
})

test('fences join fences of the same material, gates and opaque full cubes', () => {
  const t = terrain(w => {
    w.set(0, 64, 0, 'fence') // alone
    w.set(3, 64, 0, 'fence')
    w.set(4, 64, 0, 'stone') // east: joins
    w.set(3, 64, -1, 'glass') // north: glass is not a full cube
    w.set(2, 64, 0, 'pumpkin') // west: gourds never join
    w.set(3, 64, 1, 'barrier') // south: barriers never join
    w.set(6, 64, 0, 'fence')
    w.set(7, 64, 0, 'nether_brick_fence') // different material: no join
    w.set(6, 64, 1, 'fence_gate') // south: gates join
    w.set(6, 64, -1, 'leaves') // north: leaves are translucent
    w.set(5, 64, 0, 'soul_sand') // west: opaque, isFullCube
  })
  assert.deepStrictEqual(boxes(t, 0, 64, 0), sorted([[0.375, 0, 0.375, 0.625, 1.5, 0.625]]))
  assert.deepStrictEqual(boxes(t, 3, 64, 0), sorted([[0.375, 0, 0.375, 1, 1.5, 0.625]]))
  assert.deepStrictEqual(boxes(t, 6, 64, 0), sorted([[0.375, 0, 0.375, 0.625, 1.5, 1], [0, 0, 0.375, 0.625, 1.5, 0.625]]))
  assert.deepStrictEqual(boxes(t, 7, 64, 0), sorted([[0.375, 0, 0.375, 0.625, 1.5, 0.625]]))
})

test('walls are one box, thin when straight, and join gates and full cubes', () => {
  const t = terrain(w => {
    w.fill(0, 64, 0, 0, 64, 2, 'cobblestone_wall') // north-south run
    w.set(4, 64, 0, 'cobblestone_wall')
    w.set(5, 64, 0, 'fence_gate')
    w.set(4, 64, 1, 'stone')
    w.set(8, 64, 0, 'cobblestone_wall')
    w.set(9, 64, 0, 'cobblestone_wall')
    w.set(7, 64, 0, 'cobblestone_wall')
  })
  assert.deepStrictEqual(boxes(t, 0, 64, 1), sorted([[0.3125, 0, 0, 0.6875, 1.5, 1]]))
  assert.deepStrictEqual(boxes(t, 0, 64, 0), sorted([[0.25, 0, 0.25, 0.75, 1.5, 1]]))
  // Corner: east to the gate, south to stone. One box covering both arms.
  assert.deepStrictEqual(boxes(t, 4, 64, 0), sorted([[0.25, 0, 0.25, 1, 1.5, 1]]))
  assert.deepStrictEqual(boxes(t, 8, 64, 0), sorted([[0, 0, 0.3125, 1, 1.5, 0.6875]]))
})

test('panes and iron bars follow BlockPane', () => {
  const t = terrain(w => {
    w.set(0, 64, 0, 'glass_pane') // alone: full cross
    w.set(3, 64, 0, 'glass_pane')
    w.set(4, 64, 0, 'glass') // east only: half arm
    w.set(3, 64, 1, 'stone_slab') // half slab is not a full block
    w.set(6, 64, 0, 'iron_bars')
    w.set(6, 64, -1, 'stained_glass_pane')
    w.set(6, 64, 1, 'stone') // north and south: one full north-south bar
    w.set(9, 64, 0, 'glass_pane')
    w.set(9, 64, 1, 'leaves') // leaves are a full block for panes
  })
  assert.deepStrictEqual(boxes(t, 0, 64, 0), sorted([[0, 0, 0.4375, 1, 1, 0.5625], [0.4375, 0, 0, 0.5625, 1, 1]]))
  assert.deepStrictEqual(boxes(t, 3, 64, 0), sorted([[0.5, 0, 0.4375, 1, 1, 0.5625]]))
  assert.deepStrictEqual(boxes(t, 6, 64, 0), sorted([[0.4375, 0, 0, 0.5625, 1, 1]]))
  assert.deepStrictEqual(boxes(t, 9, 64, 0), sorted([[0.4375, 0, 0.5, 0.5625, 1, 1]]))
})

test('stairs: straight, outer and inner corners', () => {
  const t = terrain(w => {
    w.set(0, 64, 0, 'oak_stairs', 0) // facing east, alone
    w.set(3, 64, 0, 'oak_stairs', 0) // facing east...
    w.set(4, 64, 0, 'oak_stairs', 3) // ...with a north-facing stair in front: outer corner
    w.set(8, 64, 0, 'oak_stairs', 0) // facing east...
    w.set(7, 64, 0, 'oak_stairs', 3) // ...with a north-facing stair behind: inner corner
    w.set(11, 64, 0, 'oak_stairs', 4) // upside-down, facing east
  })
  assert.deepStrictEqual(boxes(t, 0, 64, 0), sorted([[0, 0, 0, 1, 0.5, 1], [0.5, 0.5, 0, 1, 1, 1]]))
  assert.deepStrictEqual(boxes(t, 3, 64, 0), sorted([[0, 0, 0, 1, 0.5, 1], [0.5, 0.5, 0, 1, 1, 0.5]]))
  assert.deepStrictEqual(boxes(t, 8, 64, 0), sorted([[0, 0, 0, 1, 0.5, 1], [0.5, 0.5, 0, 1, 1, 1], [0, 0.5, 0, 0.5, 1, 0.5]]))
  assert.deepStrictEqual(boxes(t, 11, 64, 0), sorted([[0, 0.5, 0, 1, 1, 1], [0.5, 0, 0, 1, 0.5, 1]]))
})

test('double chests reach the shared side; ender chests never join', () => {
  const t = terrain(w => {
    w.set(0, 64, 0, 'chest')
    w.set(1, 64, 0, 'chest')
    w.set(3, 64, 0, 'chest')
    w.set(4, 64, 0, 'trapped_chest') // different block: no join
    w.set(6, 64, 0, 'ender_chest')
    w.set(7, 64, 0, 'ender_chest')
  })
  assert.deepStrictEqual(boxes(t, 0, 64, 0), sorted([[0.0625, 0, 0.0625, 1, 0.875, 0.9375]]))
  assert.deepStrictEqual(boxes(t, 1, 64, 0), sorted([[0, 0, 0.0625, 0.9375, 0.875, 0.9375]]))
  assert.deepStrictEqual(boxes(t, 3, 64, 0), sorted([[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]]))
  assert.deepStrictEqual(boxes(t, 6, 64, 0), sorted([[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]]))
})

test('doors combine both halves: facing and open below, hinge above', () => {
  const t = terrain(w => {
    w.set(0, 64, 0, 'wooden_door', 0) // closed, facing east
    w.set(0, 65, 0, 'wooden_door', 8) // upper, hinge right
    w.set(2, 64, 0, 'wooden_door', 4) // open, facing east
    w.set(2, 65, 0, 'wooden_door', 8) // hinge right
    w.set(4, 64, 0, 'wooden_door', 4)
    w.set(4, 65, 0, 'wooden_door', 9) // hinge left
    w.set(6, 64, 0, 'iron_door', 3) // closed, facing north
    w.set(6, 65, 0, 'iron_door', 8)
  })
  assert.deepStrictEqual(boxes(t, 0, 64, 0), sorted([[0, 0, 0, 0.1875, 1, 1]]))
  assert.deepStrictEqual(boxes(t, 0, 65, 0), sorted([[0, 0, 0, 0.1875, 1, 1]]))
  assert.deepStrictEqual(boxes(t, 2, 64, 0), sorted([[0, 0, 0, 1, 1, 0.1875]]))
  assert.deepStrictEqual(boxes(t, 2, 65, 0), sorted([[0, 0, 0, 1, 1, 0.1875]]))
  assert.deepStrictEqual(boxes(t, 4, 64, 0), sorted([[0, 0, 0.8125, 1, 1, 1]]))
  assert.deepStrictEqual(boxes(t, 6, 64, 0), sorted([[0, 0, 0.8125, 1, 1, 1]]))
})

test('planner, rollout world and live world resolve the same boxes', () => {
  // A random jumble of every neighbour-dependent family next to joiners.
  const names = ['fence', 'nether_brick_fence', 'fence_gate', 'cobblestone_wall', 'glass_pane', 'iron_bars',
    'stained_glass_pane', 'glass', 'stone', 'leaves', 'pumpkin', 'stone_slab', 'oak_stairs', 'stone_stairs',
    'chest', 'trapped_chest', 'wooden_door', 'air', 'air']
  let seed = 12345
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  const w = world(w => {
    for (let x = 0; x < 12; x++) {
      for (let z = 0; z < 12; z++) {
        for (let y = 64; y < 66; y++) w.set(x, y, z, names[rand(names.length)], rand(16))
      }
    }
  })
  const bot = new FakeBot(w)
  const t = new Terrain(bot)
  const nav = new NavWorld(bot, new ColumnCache(bot))
  for (let x = -1; x < 13; x++) {
    for (let z = -1; z < 13; z++) {
      for (let y = 63; y < 67; y++) {
        const p = new Vec3(x, y, z)
        const live = bot.physicsWorld.resolveShapes(bot.physicsWorld.getBlock(p))
        assert.deepStrictEqual(nav.resolveShapes(nav.getBlock(p)), live, `${x} ${y} ${z}`)
        assert.deepStrictEqual(t.shapesAt(x, y, z), live, `${x} ${y} ${z}`)
      }
    }
  }
})

// The physics really collides with the resolved boxes (the patched
// getSurroundingBBs), not prismarine's own fence/stair rules.
function dropOnto (build, x, z) {
  const w = world(build)
  const bot = new FakeBot(w, { position: new Vec3(x, 67, z) })
  const sim = createSim(bot)
  const s = sim.fromBot()
  for (let i = 0; i < 60 && !s.onGround; i++) sim.step(s, emptyInput(), null)
  return s.pos.y
}

test('physics lands on 1.8 joined fences and stair corners', () => {
  // Over the east arm of a fence joined to stone: 1.5 high. prismarine's own
  // rule only joins fences to fences and would let the body fall past.
  assert.strictEqual(dropOnto(w => { w.set(0, 64, 0, 'fence'); w.set(1, 64, 0, 'stone') }, 1.04, 0.5), 65.5)
  assert.strictEqual(dropOnto(w => { w.set(0, 64, 0, 'fence') }, 1.1, 0.5), 64)
  // An east-facing stair: over the south half of its step it is a full
  // block high, unless a north-facing stair in front makes an outer corner.
  assert.strictEqual(dropOnto(w => w.set(3, 64, 0, 'oak_stairs', 0), 3.75, 0.85), 65)
  assert.strictEqual(dropOnto(w => { w.set(3, 64, 0, 'oak_stairs', 0); w.set(4, 64, 0, 'oak_stairs', 3) }, 3.75, 0.85), 64.5)
})
