'use strict'

const { Vec3 } = require('vec3')
const { Physics } = require('prismarine-physics')
const { ShapeWorld } = require('./world')
const { f32, emptyInput } = require('./util')

const { newLiving, cloneLiving, stepPlayer } = require('./vanillaClient/player')

const SPEED_EFFECT = 1
const JUMP_BOOST_EFFECT = 8

// Predictive copy of the 1.8.9 client physics. It owns its own Physics
// instance so rollouts never touch the live bot's airborne acceleration.
function createSim (bot, { world } = {}) {
  const physicsWorld = world || bot.physicsWorld || new ShapeWorld(bot)
  const physics = Physics(bot.registry, physicsWorld)

  function effectLevel (id) {
    const effect = bot.entity?.effects?.[id]
    return effect ? effect.amplifier + 1 : 0
  }

  function abilities () {
    return {
      speed: effectLevel(SPEED_EFFECT),
      jumpBoost: effectLevel(JUMP_BOOST_EFFECT)
    }
  }

  // State in the shape simulatePlayer reads. There is deliberately no `yaw`
  // field: simulatePlayer would recompute yawDegrees from it.
  // Includes the client's vanilla sprint/input state (bot.vanilla), so a
  // rollout continues exactly where the real client is.
  function fromBot () {
    const e = bot.entity
    const core = bot.vanilla
    return {
      pos: new Vec3(e.position.x, e.position.y, e.position.z),
      motion: new Vec3(e.velocity.x, e.velocity.y, e.velocity.z),
      onGround: !!e.onGround,
      isInWater: !!e.isInWater,
      isInLava: !!e.isInLava,
      isInWeb: !!e.isInWeb,
      isCollidedHorizontally: !!e.isCollidedHorizontally,
      isCollidedVertically: !!e.isCollidedVertically,
      jumpTicks: bot.jumpTicks || 0,
      jumpQueued: false,
      fireworkRocketDuration: 0,
      attributes: e.attributes,
      yawDegrees: f32(Number(e.yawDegrees)),
      pitchDegrees: f32(Number(e.pitchDegrees)),
      control: emptyInput(),
      jumpBoost: effectLevel(JUMP_BOOST_EFFECT),
      depthStrider: 0,
      living: core ? cloneLiving(core.living) : newLiving(),
      prevSprint: core ? core.prevSprint : false
    }
  }

  function clone (s) {
    return {
      pos: new Vec3(s.pos.x, s.pos.y, s.pos.z),
      motion: new Vec3(s.motion.x, s.motion.y, s.motion.z),
      onGround: s.onGround,
      isInWater: s.isInWater,
      isInLava: s.isInLava,
      isInWeb: s.isInWeb,
      isCollidedHorizontally: s.isCollidedHorizontally,
      isCollidedVertically: s.isCollidedVertically,
      jumpTicks: s.jumpTicks,
      jumpQueued: false,
      fireworkRocketDuration: 0,
      attributes: s.attributes,
      yawDegrees: s.yawDegrees,
      pitchDegrees: s.pitchDegrees,
      control: s.control,
      jumpBoost: s.jumpBoost,
      depthStrider: s.depthStrider,
      living: cloneLiving(s.living),
      prevSprint: s.prevSprint
    }
  }

  // One client tick, in place, through the same stepPlayer the live client
  // runs. input holds keys (input.sprint is the sprint KEY; whether the
  // player sprints is the vanilla state in s.living).
  function step (s, input, yawDeg, pitchDeg) {
    if (yawDeg != null) s.yawDegrees = f32(yawDeg)
    if (pitchDeg != null) s.pitchDegrees = f32(pitchDeg)
    stepPlayer(physics, physicsWorld, s, input, { food: bot.food })
    return s
  }

  return { physics, world: physicsWorld, abilities, fromBot, clone, step }
}

module.exports = { createSim }
