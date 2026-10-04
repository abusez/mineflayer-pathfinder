'use strict'

const net = require('net')

const DEFAULT_PORT = 28765
const SIM_HOLD_MS = 500

function round (value) {
  return Math.round(Number(value) * 1000) / 1000
}

function point (x, y, z) {
  return { x: round(x), y: round(y), z: round(z) }
}

// One snapshot of the route the bot is following. Waypoints are the nodes;
// in order they are the path. The Forge mod on 127.0.0.1 draws this.
function buildSnapshot (bot) {
  const nav = bot.nav
  const route = nav && nav.route
  const goal = nav && nav.goal
  const nodes = []
  if (route && route.waypoints) {
    for (const w of route.waypoints) {
      const pos = w.pos || { x: w.x + 0.5, y: w.H != null ? w.H : w.y, z: w.z + 0.5 }
      nodes.push({
        i: w.index != null ? w.index : nodes.length,
        x: round(pos.x),
        y: round(pos.y),
        z: round(pos.z),
        kind: w.kind || 'walk',
        anchor: !!w.anchor
      })
    }
  }
  let goalPoint = null
  if (goal) {
    let y = goal.y
    try {
      const cell = nav.terrain && nav.terrain.cell(goal.x, goal.y, goal.z)
      if (cell && Number.isFinite(cell.H)) y = cell.H
    } catch {}
    goalPoint = point(goal.x + 0.5, y, goal.z + 0.5)
  }
  const entity = bot.entity
  const feet = entity && entity.position
  return {
    v: 1,
    type: 'path',
    active: !!(nav && nav.active),
    status: (route && route.status) || (nav && nav.lastStatus) || 'idle',
    cursor: nav && nav.controller ? nav.controller.cursor : 0,
    goal: goalPoint,
    bot: feet ? point(feet.x, feet.y, feet.z) : null,
    sim: simGhost(nav),
    nodes
  }
}

// The player the pathfinder is simulating right now, if a search stepped one recently.
function simGhost (nav) {
  if (!nav) return null
  const now = Date.now()
  const remote = nav.remote && nav.remote.pool && nav.remote.pool.simPose
  const local = nav.simPose
  let pose = null
  if (local && now - local.at <= SIM_HOLD_MS) pose = local
  if (remote && now - remote.at <= SIM_HOLD_MS && (!pose || remote.at > pose.at)) pose = remote
  if (!pose) return null
  return {
    x: pose.x,
    y: pose.y,
    z: pose.z,
    yaw: pose.yaw,
    pitch: pose.pitch,
    sneak: !!pose.sneak,
    sprint: !!pose.sprint,
    vx: pose.vx || 0,
    vz: pose.vz || 0
  }
}

function startDebugServer (bot, { port = DEFAULT_PORT, log = () => {} } = {}) {
  let latest = JSON.stringify(buildSnapshot(bot))
  const clients = new Set()
  let stopped = false

  function broadcast (json) {
    latest = json
    if (clients.size === 0) return
    const line = latest + '\n'
    for (const socket of clients) {
      try {
        socket.write(line)
      } catch {
        clients.delete(socket)
      }
    }
  }

  function publish () {
    if (stopped) return
    try {
      const next = JSON.stringify(buildSnapshot(bot))
      if (next === latest) return
      broadcast(next)
    } catch {}
  }

  const server = net.createServer((socket) => {
    socket.setNoDelay(true)
    clients.add(socket)
    socket.write(latest + '\n')
    const drop = () => clients.delete(socket)
    socket.on('close', drop)
    socket.on('error', drop)
  })

  server.on('error', (err) => {
    log(`path view failed to listen on 127.0.0.1:${port} (${err.code || err.message})`)
  })

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address()
    log(`path view listening on 127.0.0.1:${addr.port}`)
  })

  const timer = setInterval(publish, 50)
  if (timer.unref) timer.unref()
  bot.on('nav:route', publish)
  bot.on('end', () => {
    stopped = true
    clearInterval(timer)
    broadcast(JSON.stringify({ v: 1, type: 'path', active: false, status: 'idle', cursor: 0, goal: null, bot: null, sim: null, nodes: [] }))
    server.close()
    for (const socket of clients) {
      try { socket.end() } catch {}
    }
    clients.clear()
  })

  return { port, server }
}

module.exports = { buildSnapshot, startDebugServer, DEFAULT_PORT }
