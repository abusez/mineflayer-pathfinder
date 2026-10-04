'use strict'

const { Vec3 } = require('vec3')
const { FakeBot } = require('./fakeBot')
const { createNav } = require('../../nav')
const { DEFAULTS: ROT } = require('../../nav/rotation')
const { ROUNDING_GCD } = require('../../nav/util')

const DIRECTION_KEYS = ['forward', 'back', 'left', 'right']

// Runs one goto in a harness world and checks per-tick invariants.
// scenario: { world, start: Vec3, yaw, goal: {x,y,z}, speed, jumpBoost, maxTicks, onTick(bot, tick) }
function runScenario (scenario, { trace = false } = {}) {
  const bot = new FakeBot(scenario.world, {
    position: scenario.start,
    yaw: scenario.yaw || 0,
    speed: scenario.speed || 0,
    jumpBoost: scenario.jumpBoost || 0
  })
  scenario.world.onChange((x, y, z, oldState, newState) => {
    bot.emit('blockUpdate', { position: new Vec3(x, y, z), stateId: oldState }, { position: new Vec3(x, y, z), stateId: newState })
  })
  // Settle on the ground before starting.
  for (let i = 0; i < 4; i++) bot.tick()

  const nav = createNav(bot, { deterministic: true, expansionsPerTick: scenario.expansionsPerTick || 1500 , pool: scenario.pool })

  const m = {
    ticks: 0,
    maxYawDelta: 0,
    maxYawAccel: 0,
    snaps: 0,
    accelViolations: 0,
    offGrid: 0,
    constantTurnRuns: 0,
    keyFlicker: 0,
    sprintIntoWall: 0,
    teleports: 0,
    fallDamage: 0,
    falls: 0,
    maxFall: 0,
    jumps: 0
  }
  const traceLines = []
  let prevYaw = Number(bot.entity.yawDegrees)
  let prevDelta = 0
  let constantRun = 0
  let posAtBegin = null
  const lastChange = Object.fromEntries(DIRECTION_KEYS.map(k => [k, -100]))
  const prevKeys = {}
  let fallStart = null
  let prevColH = false
  let colHAtStart = false

  bot.prependListener('physicsTickBegin', () => { posAtBegin = bot.entity.position.clone() })
  bot.on('physicsTickBegin', () => {
    // Nothing but the simulator may move the body.
    if (posAtBegin && !posAtBegin.equals(bot.entity.position)) m.teleports++
    const c = bot.controlState
    for (const k of DIRECTION_KEYS) {
      if (prevKeys[k] !== undefined && prevKeys[k] !== c[k]) {
        if (m.ticks - lastChange[k] < 2) {
          m.keyFlicker++
          if (scenario.onViolation) scenario.onViolation('keyFlicker', { tick: m.ticks, key: k, to: c[k], plan: nav.controller.lastPlan, status: nav.lastStatus, cursor: nav.controller.cursor, onGround: bot.entity.onGround })
        }
        lastChange[k] = m.ticks
      }
      prevKeys[k] = c[k]
    }
    colHAtStart = bot.entity.isCollidedHorizontally
    if (c.jump && bot.entity.onGround) m.jumps++
  })
  bot.on('physicsTick', () => {
    // Vanilla's onLivingUpdate stops sprinting when the tick starts collided.
    if (bot.vanilla.living.sprinting && colHAtStart) m.sprintIntoWall++
    m.ticks++
    const yaw = Number(bot.entity.yawDegrees)
    const d = yaw - prevYaw
    const k = yaw / ROUNDING_GCD
    if (Math.abs(k - Math.round(k)) > 1e-3) m.offGrid++
    if (Math.abs(d) > m.maxYawDelta) m.maxYawDelta = Math.abs(d)
    if (Math.abs(d) > ROT.maxSpeed + ROUNDING_GCD) m.snaps++
    const accel = Math.abs(d - prevDelta)
    if (accel > m.maxYawAccel) m.maxYawAccel = accel
    if (accel > ROT.maxAccel + ROUNDING_GCD * 2) {
      m.accelViolations++
      if (scenario.onViolation) scenario.onViolation('accel', { tick: m.ticks, delta: d, prev: prevDelta })
    }
    // A run of identical turn rates, at a size an observer would notice.
    if (Math.abs(d) >= 0.5 && Math.abs(d - prevDelta) < 1e-6) {
      if (++constantRun === 6) {
        m.constantTurnRuns++
        if (scenario.onViolation) scenario.onViolation('constantTurn', { tick: m.ticks, delta: d })
      }
    } else constantRun = 0
    prevDelta = d
    prevYaw = yaw
    prevColH = bot.entity.isCollidedHorizontally

    const e = bot.entity
    if (!e.onGround) {
      if (fallStart == null) fallStart = e.position.y
      fallStart = Math.max(fallStart, e.position.y)
    } else if (fallStart != null) {
      const fall = fallStart - e.position.y
      if (fall > m.maxFall) m.maxFall = fall
      // Vanilla: damage = ceil(distance - 3 - jumpBoost).
      const safe = 3 + (scenario.jumpBoost || 0)
      if (fall > safe) {
        m.falls++
        m.fallDamage += Math.ceil(fall - safe)
      }
      fallStart = null
    }
    if (trace) {
      const p = e.position
      traceLines.push(`${m.ticks} pos=${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)} v=${e.velocity.x.toFixed(3)},${e.velocity.y.toFixed(3)},${e.velocity.z.toFixed(3)} g=${e.onGround ? 1 : 0} yaw=${yaw.toFixed(2)} keys=${Object.entries(bot.controlState).filter(([, v]) => v).map(([k]) => k).join('+') || '-'} cur=${nav.controller.cursor}/${nav.route ? nav.route.size : 0} plan=${nav.controller.lastPlan ? nav.controller.lastPlan.cand : '-'}`)
    }
  })

  // finish() fires these synchronously; the promise callbacks would only run
  // after this synchronous loop.
  let outcome = null
  bot.on('nav:arrived', () => { outcome = outcome || { status: 'arrived' } })
  bot.on('nav:failed', (err) => { outcome = outcome || { status: 'failed', reason: err.name } })
  nav.goto(scenario.goal.x, scenario.goal.y, scenario.goal.z).catch(() => {})

  const maxTicks = scenario.maxTicks || 2000
  let ran = 0
  let ticks = 0
  for (; ticks < maxTicks && !outcome; ticks++) {
    if (scenario.onTick) scenario.onTick(bot, ticks)
    const t0 = process.hrtime.bigint()
    const moved = bot.tick()
    ran += Number(process.hrtime.bigint() - t0)
    if (!moved) outcome = outcome || { status: 'failed', reason: 'UnloadedChunk' }
    else if (bot.entity.position.y < -10) outcome = outcome || { status: 'failed', reason: 'Void' }
  }
  if (!outcome) nav.stop()
  return finalize()

  function finalize () {
    const res = outcome && outcome.reason !== 'PathStopped' ? outcome : { status: 'timeout' }
    const p = bot.entity.position
    const g = scenario.goal
    const inGoal = Math.floor(p.x) === g.x && Math.floor(p.z) === g.z && Math.abs(Math.floor(p.y + 1e-3) - g.y) <= 1
    return {
      ...res,
      inGoal,
      ticks: m.ticks,
      msPerTick: ran / 1e6 / Math.max(1, ticks),
      metrics: m,
      nav: {
        searches: nav.stats.searches,
        expansions: nav.stats.expansions,
        replans: nav.stats.replans,
        fallbackTicks: nav.stats.fallbackTicks,
        predictionMisses: nav.stats.predictionMisses,
        rollouts: nav.controller.stats.rollouts
      },
      trace: trace ? traceLines : undefined
    }
  }
}

module.exports = { runScenario }
