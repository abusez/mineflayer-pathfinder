'use strict'

// Packet traces against EntityPlayerSP.onUpdateWalkingPlayer (MCP 1.8.9).
// Every expectation below is derived from that source:
//  - per tick: C0B sprint (if isSprinting() != serverSprintState), then C0B
//    sneak (if isSneaking() != serverSneakState), then exactly one of
//    C06 (moved && rotated) / C04 (moved) / C05 (rotated) / C03 (neither)
//  - moved = dist^2 > 9.0E-4 || positionUpdateTicks >= 20, tested BEFORE
//    ++positionUpdateTicks; the counter resets only when a position-bearing
//    packet was sent.
// C03-family and C0B packets are asserted separately. S08 replies are
// checked on their own and are not counted as tick packets.

const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('events')
const { Vec3 } = require('vec3')
const { HarnessWorld, mcData } = require('./harness/world')
const { FakeBot } = require('./harness/fakeBot')
const { ACTION } = require('../nav/vanillaClient/emitter')
const { vanillaPhysics } = require('../nav/vanillaClient')
const { JavaFloat } = require('mineflayer/lib/javamath')

const MOVE = new Set(['flying', 'position', 'look', 'position_look'])
const CLS = { flying: 'C03', position: 'C04', look: 'C05', position_look: 'C06' }

function world () {
  const w = new HarnessWorld()
  w.loadArea(-32, -32, 64, 64)
  w.fill(-20, 63, -20, 40, 63, 40, 'stone')
  return w
}

// Runs `ticks` ticks; script(t, bot) sets keys/rotation in physicsTickBegin.
// Returns per-tick { move: [cls], actions: [actionId], packets, state }.
function run ({ w = world(), pos = new Vec3(0.5, 64, 0.5), yaw = 0, settle = 25, ticks, script, food = 20 }) {
  const bot = new FakeBot(w, { position: pos, yaw, food })
  let t = -1
  bot.prependListener('physicsTickBegin', () => { if (t >= 0 && script) script(t, bot) })
  for (let i = 0; i < settle; i++) bot.tick()
  const out = []
  for (t = 0; t < ticks; t++) {
    const from = bot.sent.length
    const prev = bot.vanilla.emitter.snapshot()
    bot.tick()
    const packets = bot.sent.slice(from)
    assertSourceSelection(prev, bot, packets)
    out.push({
      move: packets.filter(p => MOVE.has(p.name)).map(p => CLS[p.name]),
      actions: packets.filter(p => p.name === 'entity_action').map(p => p.params.actionId),
      order: packets.map(p => p.cls),
      packets,
      state: bot.vanilla.emitter.snapshot(),
      entity: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z, onGround: bot.entity.onGround },
      sprinting: bot.vanilla.living.sprinting
    })
  }
  return { bot, out }
}

// Independent restatement of the onUpdateWalkingPlayer selection, checked on
// every tick of every scenario: given lastReported state before the tick and
// the player's state after it, which C03-family class must be sent.
function assertSourceSelection (prev, bot, packets) {
  const e = bot.entity
  const d0 = e.position.x - prev.lastReportedPosX
  const d1 = e.position.y - prev.lastReportedPosY
  const d2 = e.position.z - prev.lastReportedPosZ
  const yaw = Math.fround(Number(e.yawDegrees))
  const pitch = Math.fround(Number(e.pitchDegrees))
  const moved = d0 * d0 + d1 * d1 + d2 * d2 > 9.0E-4 || prev.positionUpdateTicks >= 20
  const rotated = Math.fround(yaw - prev.lastReportedYaw) !== 0 || Math.fround(pitch - prev.lastReportedPitch) !== 0
  const expected = moved && rotated ? 'position_look' : moved ? 'position' : rotated ? 'look' : 'flying'
  const move = packets.filter(p => MOVE.has(p.name))
  assert.strictEqual(move.length, 1, 'one movement packet')
  assert.strictEqual(move[0].name, expected)
  const p = move[0].params
  assert.strictEqual(p.onGround, e.onGround)
  if ('x' in p) assert.deepStrictEqual([p.x, p.y, p.z], [e.position.x, e.position.y, e.position.z])
  if ('yaw' in p) assert.deepStrictEqual([p.yaw, p.pitch], [yaw, pitch])
}

function keys (bot, k) {
  for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) bot.setControlState(key, !!k[key])
}

test('exactly one C03-family packet per tick, and C0B always before it', () => {
  const { out } = run({ ticks: 60, script: (t, bot) => keys(bot, { forward: t > 5 && t < 40, sprint: t > 10, sneak: t > 45 && t < 50 }) })
  for (const tick of out) {
    assert.strictEqual(tick.move.length, 1)
    assert.strictEqual(tick.order[tick.order.length - 1], tick.move[0], 'movement packet is last')
  }
})

test('standing still: C03 every tick, C04 when positionUpdateTicks reaches 20', () => {
  const { out } = run({ ticks: 70 })
  // Settling ended with some position packet; find the last C04 and check
  // the 20-tick cadence from there.
  const firstC04 = out.findIndex(t => t.move[0] === 'C04')
  assert.ok(firstC04 >= 0 && firstC04 <= 20)
  for (let i = firstC04 + 1; i < out.length; i++) {
    const sinceLast = (i - firstC04) % 21
    // After a position packet the counter is 0; ticks with counter 0..19 send
    // C03 (and increment); the tick that sees 20 sends C04 and resets.
    assert.strictEqual(out[i].move[0], sinceLast === 0 ? 'C04' : 'C03', `tick ${i}`)
    assert.strictEqual(out[i].state.positionUpdateTicks, sinceLast === 0 ? 0 : sinceLast)
  }
  assert.ok(out.every(t => t.actions.length === 0))
})

test('lastReported changes only with the packet that reports it', () => {
  const { out } = run({ ticks: 40, script: (t, bot) => { keys(bot, { forward: t < 10 }); if (t >= 20 && t < 25) bot.setAngleDegrees(10 * (t - 19), 0) } })
  for (const tick of out) {
    const p = tick.packets.find(x => MOVE.has(x.name))
    if (p.name === 'position' || p.name === 'position_look') {
      assert.strictEqual(tick.state.lastReportedPosX, p.params.x)
      assert.strictEqual(tick.state.positionUpdateTicks, 0)
    }
    if (p.name === 'look' || p.name === 'position_look') assert.strictEqual(tick.state.lastReportedYaw, p.params.yaw)
  }
})

test('walking: C04 every tick with feet Y and onGround', () => {
  const { out } = run({ ticks: 20, script: (t, bot) => keys(bot, { forward: true }) })
  for (const tick of out) {
    assert.deepStrictEqual(tick.move, ['C04'])
    const p = tick.packets.find(x => x.name === 'position').params
    assert.strictEqual(p.y, tick.entity.y)
    assert.strictEqual(p.y, 64)
    assert.strictEqual(p.onGround, true)
  }
})

test('start sprint: START_SPRINTING then the movement packet, once', () => {
  const { out } = run({ ticks: 15, script: (t, bot) => keys(bot, { forward: t >= 2, sprint: t >= 2 }) })
  const starts = out.flatMap((tick, i) => tick.actions.map(a => [i, a]))
  assert.deepStrictEqual(starts, [[2, ACTION.START_SPRINTING]])
  assert.deepStrictEqual(out[2].order, ['C0B', 'C04'])
})

test('releasing the sprint key does not stop sprinting', () => {
  const { out } = run({ ticks: 30, script: (t, bot) => keys(bot, { forward: true, sprint: t < 5 }) })
  assert.ok(out.every(t => t.sprinting))
  assert.deepStrictEqual(out.flatMap(t => t.actions), [ACTION.START_SPRINTING])
})

test('stop sprint: releasing forward sends STOP_SPRINTING before the movement packet', () => {
  const { out } = run({ ticks: 20, script: (t, bot) => keys(bot, { forward: t < 10, sprint: t < 10 }) })
  assert.deepStrictEqual(out.flatMap((tick, i) => tick.actions.map(a => [i, a])), [[0, ACTION.START_SPRINTING], [10, ACTION.STOP_SPRINTING]])
  assert.strictEqual(out[10].order[0], 'C0B')
})

test('a horizontal collision stops sprinting the tick after it happens', () => {
  const w = world()
  w.fill(4, 64, -5, 4, 66, 5, 'stone')
  const { out } = run({ w, yaw: -90, ticks: 40, script: (t, bot) => keys(bot, { forward: true, sprint: true }) })
  const stop = out.findIndex(t => t.actions.includes(ACTION.STOP_SPRINTING))
  assert.ok(stop > 0, 'stopped')
  // The tick before, the move ended collided.
  const collidedTick = stop - 1
  assert.ok(out[collidedTick].entity.x > 3.6)
})

test('sneak start/stop, and sprint+sneak changing on the same tick keep vanilla order', () => {
  const { out } = run({ ticks: 30, script: (t, bot) => keys(bot, { forward: true, sprint: t < 10, sneak: t >= 10 && t < 20 }) })
  // Tick 10: sneaking scales forward to 0.3 (< 0.8) so sprint stops: sprint packet first, then sneak.
  assert.deepStrictEqual(out[10].actions, [ACTION.STOP_SPRINTING, ACTION.START_SNEAKING])
  assert.deepStrictEqual(out[10].order.slice(0, 2), ['C0B', 'C0B'])
  assert.deepStrictEqual(out[20].actions, [ACTION.STOP_SNEAKING])
  assert.ok(out.slice(11, 20).every(t => t.actions.length === 0), 'no resends while sneaking')
})

test('double-tapping forward starts a sprint without the sprint key', () => {
  const pattern = [1, 1, 0, 0, 1, 1, 1, 1] // press, release, press within 7 ticks
  const { out } = run({ ticks: pattern.length, script: (t, bot) => keys(bot, { forward: !!pattern[t] }) })
  const start = out.findIndex(t => t.actions.includes(ACTION.START_SPRINTING))
  assert.strictEqual(start, 4)
})

test('sprint expires after 600 ticks (sprintingTicksLeft)', () => {
  const { newLiving, livingUpdate } = require('../nav/vanillaClient/player')
  const l = newLiving()
  const ctx = { onGround: true, collidedHorizontally: false, food: 20 }
  const changes = []
  let was = false
  for (let t = 0; t < 605; t++) {
    livingUpdate(l, { forward: true, sprint: t === 0 }, ctx)
    if (l.sprinting !== was) changes.push([t, l.sprinting])
    was = l.sprinting
  }
  // Started on tick 0 with 600 ticks left; the 600th decrement (tick 600)
  // reaches 0 and calls setSprinting(false). Forward is still held, but with
  // flag2 (previous forward >= 0.8) true and no sprint key, nothing restarts it.
  assert.deepStrictEqual(changes, [[0, true], [600, false]])
})

test('food at 6 stops and prevents sprinting', () => {
  const { out } = run({ food: 6, ticks: 10, script: (t, bot) => keys(bot, { forward: true, sprint: true }) })
  assert.ok(out.every(t => t.actions.length === 0 && !t.sprinting))
})

test('jumping and falling: no jump packet, onGround reported as simulated', () => {
  const w = world()
  w.fill(-20, 63, 6, 40, 63, 40, 'air') // ledge 2 blocks ahead (+z)
  w.fill(-20, 60, 6, 40, 60, 40, 'stone')
  const { out } = run({ w, ticks: 70, script: (t, bot) => keys(bot, { forward: true, jump: t === 0 }) })
  for (const tick of out) {
    assert.deepStrictEqual(tick.move, ['C04'])
    assert.strictEqual(tick.packets.find(p => p.name === 'position').params.onGround, tick.entity.onGround)
  }
  assert.ok(out.some(t => !t.entity.onGround), 'went airborne')
  assert.ok(out[out.length - 1].entity.onGround && out[out.length - 1].entity.y === 61, 'landed lower')
})

test('rotating without moving: C05, and C06 when the 20-tick position update coincides', () => {
  const { out } = run({ ticks: 45, script: (t, bot) => bot.setAngleDegrees(1.5 * (t + 1), 10) })
  for (const tick of out) {
    assert.ok(tick.move[0] === 'C05' || tick.move[0] === 'C06')
  }
  const c06 = out.map((t, i) => t.move[0] === 'C06' ? i : -1).filter(i => i >= 0)
  assert.ok(c06.length >= 1)
  for (let i = 1; i < c06.length; i++) assert.strictEqual(c06[i] - c06[i - 1], 21)
})

test('large rotation and diagonal movement: C06 with the exact float rotation', () => {
  // The yaw flip reverses the push, so that tick's displacement can fall
  // under 0.03 blocks: the source then sends C05, not C06. The per-tick
  // oracle checks the class; here check the rotation is carried exactly.
  const { out, bot } = run({ ticks: 10, script: (t, b) => { keys(b, { forward: true, left: true }); if (t === 3) b.setAngleDegrees(170, -30) } })
  const p = out[3].packets.find(x => x.name === 'look' || x.name === 'position_look').params
  assert.strictEqual(p.yaw, Math.fround(Number(bot.entity.yawDegrees)))
  assert.strictEqual(p.pitch, Math.fround(Number(bot.entity.pitchDegrees)))
  assert.ok(out.slice(5).every(t => t.move[0] === 'C04'), 'then plain position updates')
})

test('stopping after movement: C04 while sliding, then C03', () => {
  const { out } = run({ ticks: 30, script: (t, bot) => keys(bot, { forward: t < 10 }) })
  const firstC03 = out.findIndex(t => t.move[0] === 'C03')
  assert.ok(firstC03 > 10 && firstC03 < 16, `first C03 at ${firstC03}`)
  assert.ok(out.slice(10, firstC03).every(t => t.move[0] === 'C04'))
})

test('S08: immediate C06 reply with onGround false, lastReported untouched, next tick reports the move', () => {
  const w = world()
  const client = new EventEmitter()
  const written = []
  client.write = (name, params) => written.push({ name, params })
  const bot = new EventEmitter()
  Object.assign(bot, {
    registry: mcData,
    version: '1.8.9',
    world: w,
    _client: client,
    isAlive: true,
    food: 20,
    inventory: { slots: [] },
    game: { gameMode: 'survival' },
    entity: {
      id: 7,
      position: new Vec3(0.5, 64, 0.5),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      yawDegrees: new JavaFloat(0),
      pitchDegrees: new JavaFloat(0),
      effects: {},
      attributes: { 'generic.movementSpeed': { value: 0.1, modifiers: [] } },
      eyeHeight: 1.62
    }
  })
  vanillaPhysics(bot, {})
  for (let i = 0; i < 25; i++) bot.vanilla.tick()
  const before = bot.vanilla.emitter.snapshot()
  written.length = 0

  client.emit('position', { x: 10.5, y: 64, z: 3.5, yaw: 45, pitch: 0, flags: 0 })
  assert.strictEqual(written.length, 1)
  assert.strictEqual(written[0].name, 'position_look')
  assert.deepStrictEqual(written[0].params, { x: 10.5, y: 64, z: 3.5, yaw: 45, pitch: 0, onGround: false })
  assert.deepStrictEqual(bot.vanilla.emitter.snapshot(), before, 'lastReported untouched by S08')

  written.length = 0
  bot.vanilla.tick()
  // Position and yaw differ from lastReported, so vanilla sends C06 now.
  assert.deepStrictEqual(written.map(p => p.name), ['position_look'])
  assert.strictEqual(written[0].params.x, 10.5)
})
