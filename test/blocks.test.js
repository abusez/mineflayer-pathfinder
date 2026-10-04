'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { HarnessWorld } = require('./harness/world')
const { FakeBot } = require('./harness/fakeBot')
const { Terrain } = require('../nav/blocks')

function terrainWith (build) {
  const w = new HarnessWorld()
  w.loadArea(0, 0, 31, 31)
  w.fill(0, 63, 0, 31, 63, 31, 'stone')
  build(w)
  return new Terrain(new FakeBot(w))
}

test('stand heights follow 1.8 collision shapes', () => {
  const t = terrainWith((w) => {
    w.set(2, 64, 2, 'stone_slab', 0)
    w.set(3, 64, 2, 'stone_slab', 8)
    w.set(4, 64, 2, 'snow_layer', 0)
    w.set(5, 64, 2, 'snow_layer', 3)
    w.set(6, 64, 2, 'carpet', 0)
    w.set(7, 64, 2, 'fence')
    w.set(8, 64, 2, 'cobblestone_wall')
    w.set(9, 64, 2, 'trapdoor', 0)
    w.set(10, 64, 2, 'oak_stairs', 0)
    w.set(11, 64, 2, 'soul_sand')
  })
  assert.strictEqual(t.cell(1, 64, 2).H, 64)
  assert.strictEqual(t.cell(2, 64, 2).H, 64.5)
  assert.strictEqual(t.cell(3, 64, 2).kind, 'solid')
  assert.strictEqual(t.cell(3, 65, 2).H, 65)
  assert.strictEqual(t.cell(4, 64, 2).H, 64) // one snow layer has no collision
  assert.strictEqual(t.cell(5, 64, 2).H, 64.375) // 4 layers collide at 3/8
  assert.strictEqual(t.cell(6, 64, 2).H, 64.0625)
  assert.strictEqual(t.cell(7, 64, 2).kind, 'solid')
  assert.strictEqual(t.cell(7, 65, 2).H, 65.5)
  assert.ok(t.cell(7, 65, 2).fenceTop)
  assert.strictEqual(t.cell(8, 65, 2).H, 65.5)
  assert.strictEqual(t.cell(9, 64, 2).H, 64.1875)
  assert.strictEqual(t.cell(10, 64, 2).kind, 'solid')
  assert.strictEqual(t.cell(11, 64, 2).H, 64.875)
  assert.ok(t.cell(11, 64, 2).awkward)
})

test('clearance, ladders, liquids and unloaded chunks', () => {
  const t = terrainWith((w) => {
    w.set(2, 66, 2, 'stone') // ceiling 2 blocks up: can stand, can't jump
    w.set(4, 65, 4, 'stone') // ceiling 1 block up: blocked
    w.fill(6, 64, 6, 6, 67, 6, 'ladder', 2)
    w.set(8, 64, 8, 'water')
  })
  assert.strictEqual(t.cell(2, 64, 2).kind, 'stand')
  assert.strictEqual(t.cell(2, 64, 2).jumpRoom, false)
  assert.strictEqual(t.cell(1, 64, 1).jumpRoom, true)
  assert.strictEqual(t.cell(4, 64, 4).kind, 'blocked')
  assert.strictEqual(t.cell(6, 65, 6).kind, 'ladder')
  assert.strictEqual(t.cell(8, 64, 8).kind, 'liquid')
  assert.strictEqual(t.cell(40, 64, 2).kind, 'unknown')
  assert.strictEqual(t.cell(1, 66, 1).kind, 'air')
  assert.deepStrictEqual(t.landing(1, 70, 1, 10).y, 64)
})
