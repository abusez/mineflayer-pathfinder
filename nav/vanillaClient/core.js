'use strict'

const { Vec3 } = require('vec3')
const { PlayerState } = require('prismarine-physics')
const { newLiving, stepPlayer } = require('./player')
const { WalkingEmitter } = require('./emitter')

// One EntityPlayerSP.onUpdate per call, in vanilla order:
//
//   EntityPlayerSP.onUpdate
//     -> loaded-chunk check at (posX, 0, posZ)
//     -> [bot input selection: 'physicsTickBegin' -- NOT a vanilla event; it
//         plays the role of the keyboard/mouse state that movementInput and
//         rotation are read from]
//     -> super.onUpdate -> EntityPlayerSP.onLivingUpdate (sprint timers,
//        movementInput.updatePlayerMoveState, sprint start/stop)
//     -> EntityLivingBase.onLivingUpdate (updateEntityActionState, jump,
//        movement damping, moveEntityWithHeading: prismarine-physics)
//     -> EntityPlayerSP.onUpdateWalkingPlayer -> packets
//   'physicsTick' fires after the packets are queued.
//
// Shared by the live plugin and the test harness, so both run identical code.
function createCore (bot, { physics, world, write, canSend = () => true }) {
  const emitter = new WalkingEmitter(bot.entity ? bot.entity.id : 0)
  const probe = new Vec3(0, 0, 0)

  const core = {
    emitter,
    living: newLiving(),
    prevSprint: false,
    tickCount: 0,
    lastPackets: [],

    // A fresh EntityPlayerSP (login / respawn).
    reset () {
      core.living = newLiving()
      core.prevSprint = false
      emitter.reset()
      emitter.entityId = bot.entity ? bot.entity.id : 0
    },

    columnLoaded () {
      const p = bot.entity.position
      probe.set(p.x, 0, p.z)
      return !!bot.world.getColumnAt(probe)
    },

    tick () {
      if (!bot.entity || !core.columnLoaded()) return false

      bot.emit('physicsTickBegin')

      const keys = { ...bot.controlState }
      const s = new PlayerState(bot, keys)
      s.living = core.living
      s.prevSprint = core.prevSprint
      stepPlayer(physics, world, s, keys, { food: bot.food })
      s.apply(bot)
      core.prevSprint = s.prevSprint
      core.tickCount++

      const packets = canSend()
        ? emitter.update({
          x: bot.entity.position.x,
          y: bot.entity.position.y, // feet: getEntityBoundingBox().minY
          z: bot.entity.position.z,
          yaw: Number(bot.entity.yawDegrees),
          pitch: Number(bot.entity.pitchDegrees),
          onGround: bot.entity.onGround,
          sprinting: core.living.sprinting,
          sneaking: core.living.sneak
        })
        : []
      core.lastPackets = packets
      for (const packet of packets) write(packet)

      bot.emit('physicsTick')
      return true
    }
  }
  return core
}

module.exports = { createCore }
