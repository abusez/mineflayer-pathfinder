'use strict'

// Fixed-seed courses that the nav stack must keep completing cleanly. Each
// is a full closed-loop run in the harness; failures replay with
//   npm run simulate -- --replay <id> --trace

const test = require('node:test')
const assert = require('node:assert')
const { makeCourse, VARIANTS } = require('./harness/courses')
const { runScenario } = require('./harness/run')

const SCENARIOS = [
  'open:700000:base', 'open:700008:speed1', 'open:700016:speed2',
  'hills:700001:base', 'hills:700009:speed1', 'hills:700017:speed2',
  'parkour:700002:base', 'parkour:700010:speed1', 'parkour:700018:speed2',
  'partial:700003:base', 'partial:700019:speed2', 'partial:700027:jump1',
  'ladders:700004:base', 'ladders:700012:speed1', 'ladders:700020:speed2',
  'cliffs:700005:base', 'cliffs:700013:speed1', 'cliffs:700021:speed2',
  'maze:700006:base', 'maze:700014:speed1', 'maze:700022:speed2',
  'mixed:700015:speed1', 'mixed:700023:speed2', 'mixed:700039:jump2'
]

for (const id of SCENARIOS) {
  test(`arrives cleanly: ${id}`, () => {
    const [kind, seed, variant] = id.split(':')
    const course = makeCourse(kind, Number(seed), VARIANTS.find(v => v.name === variant))
    const r = runScenario({ ...course, maxTicks: 3000 })
    assert.strictEqual(r.status, 'arrived', `${id}: ${r.status} ${r.reason || ''}`)
    const m = r.metrics
    // Hard physics/rotation invariants.
    assert.strictEqual(m.teleports, 0, 'position changed outside the simulator')
    assert.strictEqual(m.snaps, 0, 'rotation snap')
    assert.strictEqual(m.offGrid, 0, 'rotation off the GCD grid')
    assert.strictEqual(m.accelViolations, 0, 'rotation acceleration cap')
    assert.strictEqual(m.sprintIntoWall, 0, 'sprinting into a wall')
    // The controller may break the 2-tick key hold only as a safety override
    // (every compliant plan predicted to fail); allow a couple per run.
    assert.ok(m.keyFlicker <= 2, `direction key flicked faster than the hold time ${m.keyFlicker}x`)
  })
}

// Live cases: a long jump down onto a lower block, and a 4 block gap that
// needs the momentum of the jump before it.
const { Vec3 } = require('vec3')
const { HarnessWorld } = require('./harness/world')

function liveCourse (build, start, goal) {
  const world = new HarnessWorld()
  world.loadArea(-40, -60, 40, 20)
  build(world)
  return runScenario({ world, start: new Vec3(...start), goal, maxTicks: 600 })
}

function assertClean (r, name) {
  assert.strictEqual(r.status, 'arrived', `${name}: ${r.status} ${r.reason || ''}`)
  const m = r.metrics
  assert.strictEqual(m.teleports, 0)
  assert.strictEqual(m.snaps, 0)
  assert.strictEqual(m.offGrid, 0)
  assert.strictEqual(m.accelViolations, 0)
  assert.strictEqual(m.sprintIntoWall, 0)
  assert.ok(m.keyFlicker <= 2)
}

test('arrives cleanly: 5+4 jump dropping 5 blocks (green 6 127 -37 to red 11 122 -33)', () => {
  const r = liveCourse(w => {
    w.set(6, 127, -37, 'wool', 5)
    w.set(11, 122, -33, 'wool', 14)
  }, [6.5, 128, -36.5], { x: 11, y: 123, z: -33 })
  assertClean(r, 'drop jump')
})

test('arrives cleanly: 4 block gap using the momentum of the jump before it', () => {
  // Slab 1 121 -14 and brick 2 121 -14 behind brick1 (-2), brick2 at -7.
  // There is no straight run-up on brick1, so a standing jump can't make it.
  const course = w => {
    w.fill(-12, 118, -20, 8, 118, -8, 'grass')
    w.set(1, 121, -14, 'stone_slab', 0)
    w.set(2, 121, -14, 'brick_block')
    w.set(-2, 121, -14, 'brick_block')
    w.set(-7, 121, -14, 'brick_block')
  }
  assertClean(liveCourse(course, [2.5, 122, -13.5], { x: -7, y: 122, z: -14 }), 'from the far brick')
  assertClean(liveCourse(course, [-1.5, 122, -13.5], { x: -7, y: 122, z: -14 }), 'from brick1')
})
