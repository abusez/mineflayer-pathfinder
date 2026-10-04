'use strict'

// Grim flag reporting with a short per-tick trace, ported from
// legacy/movement.js without the debug-server logging.

const { line, paint } = require('../log')

const RECORD_TICKS = 30
const FLAG_INTERVAL_MS = 1000
const FLAG_ALERT_COOLDOWN_MS = 500
const FLAG_JOIN_GRACE_MS = 2000
const FLAG_TELEPORT_DISTANCE_SQ = 9

function installGrimTrace (bot, print) {
  const record = []
  let current = null
  const lastFlagAt = new Map()

  bot.on('physicsTickBegin', () => {
    if (!bot.entity) return
    const e = bot.entity
    current = {
      pre: {
        pos: vec(e.position),
        vel: vec(e.velocity),
        yawDeg: Number(e.yawDegrees),
        keys: ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].filter(k => bot.getControlState(k)).join('+') || 'none',
        onGround: e.onGround,
        colH: e.isCollidedHorizontally,
        airAccel: bot.physics?.airborneAcceleration ?? 0,
        plan: bot.nav?.controller?.lastPlan?.cand || null
      }
    }
  })

  bot.on('physicsTick', () => {
    if (!current || !bot.entity) return
    const e = bot.entity
    current.post = { pos: vec(e.position), onGround: e.onGround, colH: e.isCollidedHorizontally }
    current.delta = {
      x: e.position.x - current.pre.pos.x,
      y: e.position.y - current.pre.pos.y,
      z: e.position.z - current.pre.pos.z
    }
    record.push(current)
    if (record.length > RECORD_TICKS) record.shift()
    current = null
  })

  bot.on('message', (message, position) => {
    if (position === 'game_info') return
    const flag = parseGrimFlag(message.toString())
    if (!flag || flag.check === 'TransactionOrder') return
    const now = Date.now()
    const previous = lastFlagAt.get(flag.check) || 0
    lastFlagAt.set(flag.check, now)
    if (now - previous < FLAG_INTERVAL_MS) {
      if (flag.check === 'Simulation') print(formatFlag(flag, []))
      return
    }
    print(formatFlag(flag, record))
  })

  installSetbackAlert(bot, print)
}

// A server position packet that isn't a real teleport is a setback.
function installSetbackAlert (bot, print) {
  let cooldown = Date.now() + FLAG_JOIN_GRACE_MS
  const arm = () => { cooldown = Date.now() + FLAG_JOIN_GRACE_MS }
  bot.on('login', arm)
  bot.on('respawn', arm)
  bot._client.prependListener('position', (packet) => {
    if (!bot.entity) return
    const now = Date.now()
    if (wasTeleported(bot.entity.position, packet)) return
    if (now - cooldown < FLAG_ALERT_COOLDOWN_MS) return
    cooldown = now
    print(line('warn', 'setback from server'))
  })
}

function wasTeleported (position, packet) {
  const bitflags = typeof packet.flags === 'object'
  const flagX = bitflags ? packet.flags.x : (packet.flags & 1) !== 0
  const flagZ = bitflags ? packet.flags.z : (packet.flags & 4) !== 0
  const dx = (flagX ? position.x : 0) + packet.x - position.x
  const dz = (flagZ ? position.z : 0) + packet.z - position.z
  return dx * dx + dz * dz > FLAG_TELEPORT_DISTANCE_SQ
}

function parseGrimFlag (text) {
  const match = text.match(/\[GrimAC\].*failed\s+([A-Za-z0-9_]+)(?:\s*\(vl:([0-9.]+)\))?(?::\s*(.*))?/)
  if (!match) return null
  return { check: match[1], vl: match[2] || '', detail: (match[3] || '').trim() }
}

function formatFlag (flag, record) {
  const detail = flag.detail ? ` ${flag.detail}` : ''
  const head = line('grim', `${paint('bold', flag.check)} vl=${flag.vl || '?'}${detail}`)
  if (!record.length) return head
  const body = record.map((entry, index) => {
    const age = record.length - 1 - index
    const { pre, post, delta } = entry
    const parts = [
      `  t-${String(age).padStart(2)}`,
      `pos=${num(pre.pos.x)},${num(pre.pos.y)},${num(pre.pos.z)}`,
      `vel=${num(pre.vel.x)},${num(pre.vel.y)},${num(pre.vel.z)}`,
      delta ? `d=${num(delta.x)},${num(delta.y)},${num(delta.z)}` : 'd=?',
      `g=${pre.onGround ? 1 : 0}${post ? '>' + (post.onGround ? 1 : 0) : ''}`,
      `cH=${pre.colH ? 1 : 0}${post ? '>' + (post.colH ? 1 : 0) : ''}`,
      `yaw=${Number.isFinite(pre.yawDeg) ? pre.yawDeg.toFixed(2) : '?'}`,
      `keys=${pre.keys}`,
      `air=${Number(pre.airAccel).toFixed(6)}`
    ]
    if (pre.plan) parts.push(`plan=${pre.plan}`)
    return parts.join(' ')
  })
  return head + '\n' + paint('gray', body.join('\n'))
}

function vec (v) {
  return { x: v.x, y: v.y, z: v.z }
}

function num (value) {
  return Number.isFinite(value) ? value.toFixed(4) : '?'
}

module.exports = { installGrimTrace, parseGrimFlag }
