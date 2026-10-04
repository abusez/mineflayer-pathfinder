'use strict'

const fs = require('fs')
const path = require('path')

// Movement packet instrumentation. Records every outgoing movement-related
// packet with the client state it was produced from, grouped by tick, plus
// frame diagnostics from the vanilla Timer and a 1 s packet-rate meter.

const MOVEMENT = new Set(['flying', 'position', 'look', 'position_look', 'entity_action', 'steer_vehicle'])
const CLS = { flying: 'C03 Player', position: 'C04 Position', look: 'C05 Look', position_look: 'C06 PositionLook', entity_action: 'C0B EntityAction', steer_vehicle: 'C0C Input' }
const ACTIONS = ['START_SNEAKING', 'STOP_SNEAKING', 'STOP_SLEEPING', 'START_SPRINTING', 'STOP_SPRINTING', 'RIDING_JUMP', 'OPEN_INVENTORY']

function createNetTrace (bot) {
  let records = null
  const recent = [] // movement-family packet times for the saved trace
  let packetIds = null

  function packetId (name) {
    if (!packetIds) {
      packetIds = {}
      try {
        const proto = require('minecraft-data')(bot.version).protocol.play.toServer.types.packet[1][0].type[1].mappings
        for (const id in proto) packetIds[proto[id]] = Number(id)
      } catch {}
    }
    return packetIds[name]
  }

  const write = bot._client.write.bind(bot._client)
  bot._client.write = (name, params) => {
    if (MOVEMENT.has(name)) observe(name, params)
    return write(name, params)
  }

  function observe (name, params) {
    const now = performance.now()
    if (name !== 'entity_action') {
      recent.push(now)
      while (recent.length && now - recent[0] > 1000) recent.shift()
    }
    if (!records) return
    const core = bot.vanilla
    const e = bot.entity
    const em = core ? core.emitter.snapshot() : null
    records.push({
      tick: core ? core.tickCount : null,
      teleportReply: !!(core && core.inTeleport),
      t: Math.round(now * 1000) / 1000,
      cls: CLS[name],
      name,
      id: packetId(name),
      x: params.x,
      y: params.y,
      z: params.z,
      yaw: params.yaw,
      pitch: params.pitch,
      onGround: params.onGround,
      action: name === 'entity_action' ? ACTIONS[params.actionId] : undefined,
      sprinting: core ? core.living.sprinting : null,
      sneaking: core ? core.living.sneak : null,
      pos: [e.position.x, e.position.y, e.position.z],
      vel: [e.velocity.x, e.velocity.y, e.velocity.z],
      rot: [Number(e.yawDegrees), Number(e.pitchDegrees)],
      lastReported: em && [em.lastReportedPosX, em.lastReportedPosY, em.lastReportedPosZ, em.lastReportedYaw, em.lastReportedPitch],
      positionUpdateTicks: em ? em.positionUpdateTicks : null,
      frame: core && core.frame ? { ticks: core.frame.ticks, uncapped: core.frame.uncapped } : null,
      ratePerSec: recent.length
    })
  }

  function text (recs) {
    const lines = []
    let tick = null
    for (const r of recs) {
      if (r.tick !== tick) {
        tick = r.tick
        const f = r.frame ? `  (frame ran ${r.frame.ticks} tick${r.frame.ticks === 1 ? '' : 's'}${r.frame.uncapped > r.frame.ticks ? `, ${r.frame.uncapped - r.frame.ticks} dropped` : ''})` : ''
        lines.push(`tick ${tick}:${f}`)
      }
      const fields = []
      if (r.action) fields.push(r.action)
      if (r.x !== undefined) fields.push(`${r.x.toFixed(4)} ${r.y.toFixed(4)} ${r.z.toFixed(4)}`)
      if (r.yaw !== undefined) fields.push(`yaw ${r.yaw} pitch ${r.pitch}`)
      if (r.onGround !== undefined) fields.push(`ground ${r.onGround}`)
      lines.push(`  ${r.teleportReply ? '[S08 reply] ' : ''}${r.cls}  ${fields.join('  ')}  (put ${r.positionUpdateTicks}, ${r.ratePerSec}/s)`)
    }
    return lines.join('\n')
  }

  return {
    get recording () { return records != null },
    start () { records = [] },
    stop (name) {
      const recs = records || []
      records = null
      if (!name) return { records: recs }
      const dir = path.join(process.cwd(), 'traces')
      fs.mkdirSync(dir, { recursive: true })
      const base = path.join(dir, name.replace(/[^\w.-]/g, '_'))
      fs.writeFileSync(base + '.json', JSON.stringify(recs, null, 1))
      fs.writeFileSync(base + '.txt', text(recs))
      return { records: recs, file: base + '.txt' }
    },
    text
  }
}

module.exports = { createNetTrace }
