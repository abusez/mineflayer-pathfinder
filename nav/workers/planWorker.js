'use strict'

// Planner worker: runs whole A* searches off the movement thread, with the
// same Terrain / simulator / Primitives / Planner code, over a mirrored copy
// of the world (workers/mirror.js). A search is a pure function of the world,
// the bot's state and the goal, so its result is the path the main thread
// would have found. Caches (validations, transposition table) are kept
// between jobs as long as the world epoch and abilities are unchanged.

const { parentPort, workerData } = require('worker_threads')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')(workerData.version || '1.8.9')
const { Terrain } = require('../blocks')
const { createSim } = require('../sim')
const { Primitives } = require('../primitives')
const { Planner } = require('../planner')
const { ColumnCache, NavWorld } = require('../world')
const { MirrorColumn } = require('./mirror')

const MAX_WORLDS = 2
const worlds = new Map() // mirror id -> Map(column key -> MirrorColumn)
const key = (cx, cz) => (cx + 2097152) * 4194304 + (cz + 2097152)
let reply = null

let columns = new Map()
// Bot-shaped context: only what the planner stack reads.
const bot = {
  registry: mcData,
  world: { getColumn: (cx, cz) => columns.get(key(cx, cz)) || null },
  entity: null,
  vanilla: null,
  jumpTicks: 0,
  health: 20,
  food: 20
}
const columnCache = new ColumnCache(bot)
let stack = null // { mirror, epoch, terrain, primitives, planner }

function setBot (b) {
  bot.entity = {
    position: new Vec3(b.pos.x, b.pos.y, b.pos.z),
    velocity: new Vec3(b.vel.x, b.vel.y, b.vel.z),
    onGround: b.onGround,
    isInWater: b.isInWater,
    isInLava: b.isInLava,
    isInWeb: false,
    isCollidedHorizontally: b.isCollidedHorizontally,
    yawDegrees: b.yawDegrees,
    pitchDegrees: b.pitchDegrees,
    attributes: b.attributes,
    effects: b.effects
  }
  bot.vanilla = { living: b.living, prevSprint: b.prevSprint }
  bot.jumpTicks = b.jumpTicks
  bot.health = b.health
  bot.food = b.food
}

function ensure (job) {
  columns = worlds.get(job.mirror) || new Map()
  if (stack && stack.mirror === job.mirror && stack.epoch === job.epoch) return
  columnCache.clear()
  const terrain = new Terrain(bot, columnCache)
  // Same cell keys as the main thread (penalties are keyed by them).
  terrain.ox = job.origin.ox
  terrain.oz = job.origin.oz
  const sim = createSim(bot, { world: new NavWorld(bot, columnCache) })
  const primitives = new Primitives(bot, terrain, sim)
  const planner = new Planner(bot, terrain, sim, primitives)
  stack = { mirror: job.mirror, epoch: job.epoch, terrain, primitives, planner }
}

parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    reply = msg.port
    return
  }
  if (msg.type === 'columns') {
    let world = worlds.get(msg.mirror)
    if (!world) {
      world = new Map()
      worlds.set(msg.mirror, world)
      while (worlds.size > MAX_WORLDS) worlds.delete(worlds.keys().next().value)
    }
    for (const c of msg.columns) {
      if (c.sections) world.set(key(c.cx, c.cz), new MirrorColumn(c.sections))
      else world.delete(key(c.cx, c.cz))
    }
    if (stack && stack.mirror === msg.mirror) stack = null
    return
  }
  if (msg.type === 'search') {
    if (!worlds.has(msg.mirror)) {
      reply.postMessage({ id: msg.id, mirror: msg.mirror, epoch: -1, result: null })
      return
    }
    setBot(msg.bot)
    ensure(msg)
    const planner = stack.planner
    planner.penalties = new Map(msg.penalties)
    const t0 = performance.now()
    const result = planner.plan(msg.goal, { maxNodes: msg.maxNodes })
    reply.postMessage({ id: msg.id, mirror: msg.mirror, epoch: msg.epoch, ms: performance.now() - t0, result })
  }
})
