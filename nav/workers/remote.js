'use strict'

const { WorldMirror } = require('./mirror')

// Main-thread side of off-thread planning. Searches go to a worker with a
// snapshot of the bot state; the movement tick only polls for the result.
// A result is used only if the world has not changed since it was requested
// (same mirror epoch); otherwise the caller asks again.
class RemotePlanner {
  constructor (bot, terrain, planner, pool) {
    this.bot = bot
    this.terrain = terrain
    this.planner = planner
    this.pool = pool
    this.mirror = new WorldMirror(bot)
    this.results = new Map() // id -> message
    this.stats = { requests: 0, results: 0, stale: 0, workerMs: 0 }
  }

  // Once per tick: keep the mirror current and collect finished searches.
  sync () {
    const p = this.bot.entity.position
    this.mirror.sync(p.x, p.z)
    this.pool.broadcastColumns(this.mirror.takePending())
    for (const msg of this.pool.poll()) this.results.set(msg.id, msg)
  }

  blockChanged (x, y, z, stateId) {
    this.mirror.setBlock(x, y, z, stateId)
    this.pool.broadcastColumns(this.mirror.takePending())
  }

  snapshot () {
    const bot = this.bot
    const e = bot.entity
    const core = bot.vanilla
    return {
      pos: { x: e.position.x, y: e.position.y, z: e.position.z },
      vel: { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z },
      onGround: !!e.onGround,
      isInWater: !!e.isInWater,
      isInLava: !!e.isInLava,
      isCollidedHorizontally: !!e.isCollidedHorizontally,
      yawDegrees: Number(e.yawDegrees),
      pitchDegrees: Number(e.pitchDegrees),
      attributes: e.attributes,
      effects: e.effects || {},
      living: core ? { ...core.living } : null,
      prevSprint: core ? core.prevSprint : false,
      jumpTicks: bot.jumpTicks || 0,
      health: typeof bot.health === 'number' ? bot.health : 20,
      food: typeof bot.food === 'number' ? bot.food : 20
    }
  }

  // Returns a request id, or null if every worker is busy.
  request (goal, { maxNodes = 80000 } = {}) {
    this.sync()
    const id = this.pool.nextId
    const ok = this.pool.submit({
      type: 'search',
      mirror: this.mirror.id,
      epoch: this.mirror.epoch,
      origin: { ox: this.terrain.ox, oz: this.terrain.oz },
      bot: this.snapshot(),
      goal,
      penalties: [...this.planner.penalties],
      maxNodes
    }, 1)
    if (!ok) return null
    this.stats.requests++
    return { id, epoch: this.mirror.epoch }
  }

  // The finished result for a request: { status, path, ... }, 'stale' if the
  // world changed meanwhile, or null while still running. acceptStale keeps
  // the finished path anyway, so a search is not started over.
  take (req, { acceptStale = false } = {}) {
    const msg = this.results.get(req.id)
    if (!msg) return null
    this.results.delete(req.id)
    const changed = msg.mirror !== this.mirror.id || msg.epoch !== req.epoch || msg.epoch !== this.mirror.epoch
    if (!msg.result || (changed && !acceptStale)) {
      this.stats.stale++
      return 'stale'
    }
    this.stats.results++
    this.stats.workerMs += msg.ms
    msg.result.workerMs = msg.ms
    return msg.result
  }
}

module.exports = { RemotePlanner }

// Same interface as Planner.search() (step / done / start), backed by a
// worker. step() never blocks: it submits, then polls on later calls.
class RemoteSearch {
  constructor (remote, goal, opts = {}) {
    this.remote = remote
    this.goal = goal
    this.opts = opts
    this.req = null
    this.done = null
    this.start = { g: 0 }
    this.discarded = 0
    this.acceptStale = !!opts.acceptStale
  }

  step () {
    if (this.done) return this.done
    if (!this.req) {
      this.req = this.remote.request(this.goal, this.opts)
      return null
    }
    const r = this.remote.take(this.req, { acceptStale: this.acceptStale })
    if (r === null) return null
    if (r === 'stale') {
      this.discarded++
      this.req = null // world changed while it ran: search again
      return null
    }
    this.done = r
    this.start = { g: r.path && r.path.length ? r.path[0].g : 0 }
    return r
  }
}

module.exports.RemoteSearch = RemoteSearch
