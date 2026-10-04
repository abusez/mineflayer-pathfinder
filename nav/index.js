'use strict'

const { Terrain } = require('./blocks')
const { ColumnCache, NavWorld } = require('./world')
const { RemotePlanner, RemoteSearch } = require('./workers/remote')
const { createSim, poseOf } = require('./sim')
const { Primitives } = require('./primitives')
const { Planner } = require('./planner')
const { Route } = require('./route')
const { Smoother } = require('./smoother')
const { Rotation } = require('./rotation')
const { Controller } = require('./controller')
const { Recovery } = require('./recovery')
const { CONTROLS, emptyInput } = require('./util')

const WAIT_CHUNKS_RETRY = 20

class NavError extends Error {
  constructor (name, message) {
    super(message)
    this.name = name
  }
}

// Wires pathfinder, simulator, controller, rotation and recovery into the
// bot's tick. Keys and rotation are set on physicsTickBegin, before the
// physics plugin simulates, using forced looks only.
//
// options.deterministic: plan with a fixed expansion budget per tick (tests and
// simulation). Otherwise the planner gets a time budget per tick.
function createNav (bot, options = {}) {
  const opts = {
    deterministic: false,
    expansionsPerTick: 1500,
    // Live planning budget per tick. The whole client tick (planning +
    // controller) must stay well under 50 ms or the Timer drops ticks.
    msPerTick: 8,
    // While a finished route is being followed, periodically search again and
    // switch if a clearly cheaper route shows up.
    recalc: true,
    ...options
  }
  const columns = new ColumnCache(bot)
  const terrain = new Terrain(bot, columns)
  const sim = createSim(bot, { world: new NavWorld(bot, columns) })
  const primitives = new Primitives(bot, terrain, sim)
  const planner = new Planner(bot, terrain, sim, primitives)
  // Optional worker pool (options.pool, a workers/pool WorkerPool). Live
  // (non-deterministic) searches then run entirely in a worker and the
  // movement tick only polls for results. Deterministic mode (tests) always
  // plans on this thread.
  const remote = opts.pool && !opts.deterministic ? new RemotePlanner(bot, terrain, planner, opts.pool) : null
  const newSearch = (g, o = {}) => remote
    ? new RemoteSearch(remote, g, { ...o, acceptStale: !allowRecalc })
    : planner.search(g, o)
  const smoother = new Smoother(bot, terrain, sim, primitives)
  const rotation = new Rotation(Number(bot.entity.yawDegrees), Number(bot.entity.pitchDegrees))
  const controller = new Controller(bot, sim, terrain, rotation)
  const recovery = new Recovery()

  let goal = null
  let route = null
  let search = null
  let betterSearch = null
  let allowRecalc = opts.recalc !== false
  let pending = null
  let waitUntil = 0
  let tick = 0
  let lastStatus = null
  let searchT0 = 0
  let searchCpu = 0
  let staleLogged = 0
  let staleLogAt = 0
  let betterT0 = 0
  let progressTick = 0
  let lastControlMs = 0
  const stats = { searches: 0, expansions: 0, replans: {}, fallbackTicks: 0, routes: 0, predictionMisses: 0 }

  const nav = {
    terrain,
    sim,
    planner,
    controller,
    rotation,
    recovery,
    stats,
    remote,
    get goal () { return goal },
    get route () { return route },
    get active () { return goal != null },
    get recalc () { return allowRecalc },
    setRecalc (on) {
      allowRecalc = !!on
      if (!allowRecalc) {
        betterSearch = null
        if (search) search.acceptStale = true
      }
    },
    // The state the controller sees this tick (with last tick's sprint).
    snapshot () { return sim.fromBot() },
    get lastStatus () { return lastStatus },
    // Where the bot could jump to from where it stands (physics validated).
    jumpTargets () {
      columns.clear()
      const start = planner.startNode()
      if (!start || start.state !== 'stand') return { start, jumps: [], rejected: [] }
      const report = []
      const jumps = primitives.jumpTargets(start, report).sort((a, b) => a.cost - b.cost)
      return { start, jumps, rejected: report.filter(r => r.reason !== 'ok') }
    },
    goto,
    stop
  }

  function goto (x, y, z) {
    if (goal) finish(new NavError('GoalChanged', 'goal changed'))
    goal = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
    columns.clear()
    recovery.reset()
    planner.penalties.clear()
    route = null
    betterSearch = null
    rotation.sync(Number(bot.entity.yawDegrees), Number(bot.entity.pitchDegrees))
    progressTick = tick
    // The promise must exist before the first search slice: a search that
    // fails immediately settles it from inside beginSearch().
    const promise = new Promise((resolve, reject) => {
      pending = { resolve, reject }
    })
    beginSearch()
    return promise
  }

  function stop () {
    if (!goal) return
    finish(new NavError('PathStopped', 'stopped'))
  }

  function finish (err) {
    const p = pending
    goal = null
    route = null
    search = null
    betterSearch = null
    pending = null
    releaseKeys()
    coasting = true
    if (!p) return
    if (err) {
      bot.emit('nav:failed', err)
      p.reject(err)
    } else {
      bot.emit('nav:arrived')
      p.resolve()
    }
  }

  function releaseKeys () {
    for (const k of CONTROLS) {
      if (bot.getControlState(k)) bot.setControlState(k, false)
    }
  }

  function beginSearch () {
    stats.searches++
    search = newSearch(goal)
    searchT0 = performance.now()
    searchCpu = 0
    staleLogged = 0
    const p = bot.entity.position
    bot.emit('nav:stage', {
      stage: 'start',
      from: { x: p.x, y: p.y, z: p.z },
      goal: { x: goal.x, y: goal.y, z: goal.z },
      dist: Math.hypot(goal.x + 0.5 - p.x, goal.y - p.y, goal.z + 0.5 - p.z)
    })
    runSearch()
  }

  // Keep the latest simulated player from a local search. Workers publish
  // their own pose; this only sees steps on this thread.
  function sampleSearch (fn) {
    let pending = null
    const prev = sim.sample
    sim.sample = (s) => { pending = s }
    try {
      return fn()
    } finally {
      sim.sample = prev
      if (pending) nav.simPose = { at: Date.now(), ...poseOf(pending) }
    }
  }

  function runSearch () {
    if (!search) return
    const t0 = performance.now()
    let result = search.done
    if (opts.deterministic) {
      if (!result) result = sampleSearch(() => search.step(opts.expansionsPerTick))
    } else {
      result = sampleSearch(() => search.step(Infinity, performance.now() + opts.msPerTick))
    }
    searchCpu += performance.now() - t0
    if (search && search.discarded > staleLogged && performance.now() - staleLogAt > 1000) {
      const count = search.discarded - staleLogged
      staleLogged = search.discarded
      staleLogAt = performance.now()
      bot.emit('nav:stage', { stage: 'stale', count })
    }
    if (result) {
      const timing = {
        wall: performance.now() - searchT0,
        compute: result.workerMs != null ? result.workerMs : searchCpu,
        worker: result.workerMs != null
      }
      stats.expansions += result.expanded || 0
      search = null
      onSearchDone(result, timing)
    }
  }

  function onSearchDone (result, timing = {}) {
    if (!goal) return
    const path = result.path
    bot.emit('nav:search', result.status, path ? path.length : 0, result.expanded)
    bot.emit('nav:stage', {
      stage: 'search',
      status: result.status,
      nodes: result.expanded || 0,
      waypoints: path ? path.length : 0,
      kinds: kindCounts(path),
      cost: path && path.length ? path[path.length - 1].g - path[0].g : null,
      wall: timing.wall,
      compute: timing.compute,
      worker: !!timing.worker
    })
    if (result.status === 'found' || result.status === 'partial' || result.status === 'uncertain') {
      // A one-node path: we are at the goal, or coming down onto it.
      if (result.status === 'found' && result.path && result.path.length === 1) {
        if (atGoal()) return finish(null)
        adopt([result.path[0], result.path[0]], 'found')
        return
      }
      if (!result.path || result.path.length < 2) {
        if (result.status === 'uncertain') return waitForChunks()
        return finish(new NavError('NoPath', 'no path'))
      }
      adopt(result.path, result.status)
      return
    }
    if (result.status === 'waitChunks') return waitForChunks()
    finish(new NavError('NoPath', result.status === 'noStart' ? 'not standing anywhere walkable' : 'no path'))
  }

  function adopt (path, status) {
    const t0 = performance.now()
    const smoothed = smoother.smooth(path)
    const smoothMs = performance.now() - t0
    if (smoothed.length !== path.length || smoothMs >= 2) {
      bot.emit('nav:stage', { stage: 'smooth', before: path.length, after: smoothed.length, ms: smoothMs })
    }
    route = new Route(smoothed, { goal, uncertain: status !== 'found' })
    route.status = status
    stats.routes++
    bot.emit('nav:route', status, route.size)
    bot.emit('nav:stage', { stage: 'route', status, waypoints: route.size, length: route.length })
    controller.setRoute(route, sim.fromBot())
    recovery.routeChanged(tick)
  }

  function waitForChunks () {
    route = null
    waitUntil = tick + WAIT_CHUNKS_RETRY
    bot.emit('nav:stage', { stage: 'chunks', ticks: WAIT_CHUNKS_RETRY })
  }

  function replan (reason) {
    stats.replans[reason] = (stats.replans[reason] || 0) + 1
    const spot = place()
    let penalty = 0
    // Never give up: make the spot that keeps failing expensive and search
    // again, so each retry tries a different way through.
    if (reason === 'stuck' || reason === 'fallback' || recovery.givingUp()) penalty = penalizeStuckSpot()
    bot.emit('nav:replan', reason)
    bot.emit('nav:stage', { stage: 'replan', reason, penalty, ...spot })
    // A route we have fallen off is no guide; one that is just stale still is.
    if (reason === 'fallen' || reason === 'liquid' || reason === 'offRoute' || reason === 'forced' || reason === 'prediction') route = null
    betterSearch = null
    beginSearch()
  }

  function penalizeStuckSpot () {
    if (!route) return 0
    const wps = route.waypoints
    const target = wps[Math.min(controller.cursor, wps.length - 1)]
    const p = bot.entity.position
    const cells = [target, { x: Math.floor(p.x), y: Math.floor(p.y + 1e-3), z: Math.floor(p.z) }]
    let applied = 0
    for (const c of cells) {
      const key = terrain.key(c.x, c.y, c.z)
      const prev = planner.penalties.get(key) || 0
      const next = Math.min(400, prev ? prev * 2 : 20)
      planner.penalties.set(key, next)
      if (next > applied) applied = next
    }
    return applied
  }

  function place (s) {
    const p = (s && s.pos) || bot.entity.position
    const size = route ? route.size : 0
    const cursor = controller.cursor
    const w = size ? route.waypoints[Math.min(Math.max(cursor, 0), size - 1)] : null
    return {
      pos: { x: p.x, y: p.y, z: p.z },
      cursor,
      size,
      kind: w ? w.kind : null
    }
  }

  function noteStatus (status, s) {
    if (status === lastStatus) return
    const prev = lastStatus
    lastStatus = status
    if (status === 'complete') return
    if (status === 'waiting' && prev === 'complete') return
    if (status === 'ok' && prev != null && prev !== 'fallback' && prev !== 'risky' && prev !== 'waiting') return
    bot.emit('nav:stage', {
      stage: 'status',
      status,
      prev,
      plan: controller.lastPlan && controller.lastPlan.cand,
      ...place(s)
    })
  }

  function maybeProgress () {
    if (!goal || tick - progressTick < 40) return
    progressTick = tick
    const p = bot.entity.position
    bot.emit('nav:stage', {
      stage: 'progress',
      ...place(),
      left: Math.hypot(goal.x + 0.5 - p.x, goal.y - p.y, goal.z + 0.5 - p.z),
      mode: route ? 'move' : (search ? 'planning' : 'chunks'),
      plan: controller.lastPlan && controller.lastPlan.cand,
      controlMs: route ? lastControlMs : null,
      searching: !!(search || betterSearch),
      searchingFor: search ? performance.now() - searchT0 : (betterSearch ? performance.now() - betterT0 : 0)
    })
  }

  function atGoal () {
    const p = bot.entity.position
    if (!bot.entity.onGround) return false
    if (Math.floor(p.x) !== goal.x || Math.floor(p.z) !== goal.z) return false
    const c = terrain.cell(goal.x, goal.y, goal.z)
    const H = c.H ?? goal.y
    return Math.abs(p.y - H) < 0.05 || Math.floor(p.y + 1e-3) === goal.y
  }

  function apply (input, look) {
    for (const k of CONTROLS) {
      const v = !!input[k]
      if (bot.getControlState(k) !== v) bot.setControlState(k, v)
    }
    controller.observe(input, tick)
    // setControlState('jump', true) latches jumpQueued; never leave it set
    // on a tick where the controller chose not to jump.
    if (!input.jump) bot.jumpQueued = false
    if (look) applyLook(look)
  }

  function applyLook (look) {
    const yawRad = euclideanMod(Math.PI - look.yaw * Math.PI / 180, Math.PI * 2)
    const pitchRad = euclideanMod(-look.pitch * Math.PI / 180 + Math.PI, Math.PI * 2) - Math.PI
    bot.look(yawRad, pitchRad, true)
    const actual = Number(bot.entity.yawDegrees)
    if (actual !== look.yaw) rotation.yaw = actual
  }

  // After a goal ends mid-turn, let the hand finish its motion instead of
  // freezing the camera at full speed.
  let coasting = false

  function coast () {
    if (!rotation.move && Math.abs(rotation.vYaw) < 1e-6 && Math.abs(rotation.vPitch) < 1e-6) {
      coasting = false
      return
    }
    const actualYaw = Number(bot.entity.yawDegrees)
    if (Math.abs(actualYaw - rotation.yaw) > 1e-3) {
      coasting = false
      return
    }
    applyLook(rotation.next())
  }

  function onTickBegin () {
    columns.clear()
    if (remote && goal && bot.entity) remote.sync()
    if (!goal && coasting && bot.entity) return coast()
    if (!goal || !bot.entity) return
    tick++
    try {
      const actualYaw = Number(bot.entity.yawDegrees)
      if (Math.abs(actualYaw - rotation.yaw) > 1e-3) rotation.sync(actualYaw, Number(bot.entity.pitchDegrees))

      if (search) runSearch()
      else if (!route && waitUntil && tick >= waitUntil) {
        waitUntil = 0
        beginSearch()
      }
      if (!goal) return

      if (betterSearch) {
        const r = opts.deterministic
          ? sampleSearch(() => betterSearch.step(300))
          : remote
            ? betterSearch.step()
            : sampleSearch(() => betterSearch.step(Infinity, performance.now() + 3))
        if (r) {
          const elapsed = r.workerMs != null ? r.workerMs : performance.now() - betterT0
          const s = betterSearch
          betterSearch = null
          if (r.status === 'found' && route && r.path && r.path.length > 1) {
            const remaining = route.remainingCost(controller.cursor, bot.entity.position)
            const startG = s.start ? s.start.g : 0
            const cost = r.path[r.path.length - 1].g - startG
            if (cost < remaining * 0.85 - 4) {
              stats.replans.better = (stats.replans.better || 0) + 1
              bot.emit('nav:stage', { stage: 'better', waypoints: r.path.length, cost, remaining, ms: elapsed })
              adopt(r.path, r.status)
            }
          }
        }
      }

      const s = sim.fromBot()
      if (!route) {
        // Waiting for a plan: let go of everything, keep afloat in water.
        const input = emptyInput()
        if (s.isInWater || s.isInLava) input.jump = true
        apply(input, rotation.next())
        recovery.predicted = null
        noteStatus('waiting', s)
        return
      }

      if (atGoal() && controller.cursor >= route.size - 1 && route.status === 'found') {
        return finish(null)
      }

      const c0 = performance.now()
      const out = controller.tick(s)
      lastControlMs = performance.now() - c0
      noteStatus(out.status, s)
      if (out.status === 'fallback') stats.fallbackTicks++
      if (out.status === 'risky') stats.riskyTicks = (stats.riskyTicks || 0) + 1
      if (out.status === 'complete') {
        apply(emptyInput(), out.look)
        recovery.predicted = null
        // Still in the air over the end of the route: wait for the landing.
        if (!bot.entity.onGround && !bot.entity.isInWater) return
        if (route.status === 'found') {
          if (atGoal()) return finish(null)
          return replan('stuck')
        }
        // Partial or uncertain route done: plan the next stretch from here.
        if (atGoal()) return finish(null)
        const prevStatus = route.status
        route = null
        bot.emit('nav:stage', { stage: 'continue', status: prevStatus })
        beginSearch()
        return
      }
      apply(out.input, out.look)
      recovery.predicted = out.predicted
      if (allowRecalc && !search && !betterSearch && route.status === 'found' && recovery.wantsBetterRouteCheck(tick)) {
        betterSearch = newSearch(goal, { maxNodes: 20000 })
        betterT0 = performance.now()
      }
    } finally {
      if (goal) maybeProgress()
    }
  }

  function onTick () {
    if (!goal || !bot.entity) return
    if (!route) return
    const s = {
      pos: bot.entity.position,
      onGround: bot.entity.onGround,
      isInWater: bot.entity.isInWater,
      isInLava: bot.entity.isInLava
    }
    const before = recovery.mismatches
    // The controller only advances its cursor next tick; judge this state
    // against where it actually is on the route now.
    const cursor = route.advance(s, controller.cursor)
    const reason = recovery.check({ tick, state: s, route, cursor, status: lastStatus })
    if (recovery.mismatches !== before) stats.predictionMisses++
    recovery.predicted = null
    if (reason && !search) replan(reason)
  }

  function onBlockUpdate (oldBlock, newBlock) {
    const pos = (newBlock && newBlock.position) || (oldBlock && oldBlock.position)
    if (!pos) return
    columns.clear()
    if (remote) remote.blockChanged(pos.x, pos.y, pos.z, newBlock && newBlock.stateId != null ? newBlock.stateId : 0)
    terrain.invalidateAround(pos.x, pos.y, pos.z)
    if (!route || search) return
    const wps = route.waypoints
    for (let i = Math.max(0, controller.cursor - 1); i < Math.min(wps.length, controller.cursor + 40); i++) {
      const w = wps[i]
      if (Math.abs(w.x - pos.x) <= 1 && Math.abs(w.z - pos.z) <= 1 && pos.y >= w.y - 2 && pos.y <= w.y + 2) {
        recovery.replan('blocks')
        replan('blocks')
        return
      }
    }
  }

  function onForcedMove () {
    rotation.sync(Number(bot.entity.yawDegrees), Number(bot.entity.pitchDegrees))
    if (goal && !search) {
      recovery.replan('forced')
      replan('forced')
    }
  }

  // Runs before anything else on physicsTickBegin (e.g. the physics fixes).
  bot.prependListener('physicsTickBegin', onTickBegin)
  bot.on('physicsTick', onTick)
  bot.on('blockUpdate', onBlockUpdate)
  bot.on('forcedMove', onForcedMove)
  bot.on('end', () => { if (goal) finish(new NavError('Disconnected', 'disconnected')) })

  bot.nav = nav
  return nav
}

function kindCounts (path) {
  if (!path) return []
  const counts = new Map()
  for (const n of path) {
    if (!n.kind || n.kind === 'start') continue
    counts.set(n.kind, (counts.get(n.kind) || 0) + 1)
  }
  return [...counts]
}

function euclideanMod (numerator, denominator) {
  const result = numerator % denominator
  return result < 0 ? result + denominator : result
}

module.exports = { createNav, NavError }
