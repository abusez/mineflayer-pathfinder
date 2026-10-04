'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { buildSnapshot } = require('../nav/debugServer')

test('snapshot is the followed route, in order', () => {
  const bot = {
    entity: { position: { x: 1.2, y: 64, z: 2.8 } },
    nav: {
      active: true,
      lastStatus: 'ok',
      goal: { x: 5, y: 64, z: 6 },
      terrain: { cell: () => ({ kind: 'stand', H: 65 }) },
      controller: { cursor: 1 },
      route: {
        status: 'found',
        waypoints: [
          { index: 0, kind: 'start', anchor: false, pos: { x: 1.5, y: 65, z: 2.5 } },
          { index: 1, kind: 'gap', anchor: true, pos: { x: 5.5, y: 65, z: 6.5 } }
        ]
      }
    }
  }
  const snap = buildSnapshot(bot)
  assert.strictEqual(snap.v, 1)
  assert.strictEqual(snap.active, true)
  assert.strictEqual(snap.status, 'found')
  assert.strictEqual(snap.cursor, 1)
  assert.deepStrictEqual(snap.goal, { x: 5.5, y: 65, z: 6.5 })
  assert.strictEqual(snap.nodes.length, 2)
  assert.strictEqual(snap.nodes[1].kind, 'gap')
  assert.strictEqual(snap.nodes[1].anchor, true)
  assert.strictEqual(snap.bot.x, 1.2)
  assert.strictEqual(snap.sim, null)

  bot.nav.simPose = { at: Date.now(), x: 3.5, y: 64, z: 4.25, yaw: 90, pitch: -10, sneak: true, sprint: false, vx: 0.1, vz: -0.2 }
  const live = buildSnapshot(bot)
  assert.deepStrictEqual(live.sim, { x: 3.5, y: 64, z: 4.25, yaw: 90, pitch: -10, sneak: true, sprint: false, vx: 0.1, vz: -0.2 })

  bot.nav.simPose.at = Date.now() - 5000
  assert.strictEqual(buildSnapshot(bot).sim, null)
})
