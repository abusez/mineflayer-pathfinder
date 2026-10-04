'use strict'

const EventEmitter = require('events')
const { Vec3 } = require('vec3')
const { Physics } = require('prismarine-physics')
const { ShapeWorld } = require('../../nav/world')
const { createCore } = require('../../nav/vanillaClient/core')
const { mcData } = require('./world')
const { f32, ROUNDING_GCD, emptyInput } = require('../../nav/util')

const SPEED_UUID = '91AEAA56-376B-4498-935B-2F7F68070635'

// A bot-shaped object that ticks exactly like mineflayer's physics plugin:
// physicsTickBegin -> simulatePlayer(new PlayerState(bot, controls)) -> physicsTick.
// Rotation goes through the same GCD rounding as the plugin's setAngleDegrees.
class FakeBot extends EventEmitter {
  constructor (world, { position, yaw = 0, pitch = 0, speed = 0, jumpBoost = 0, food = 20 } = {}) {
    super()
    this.setMaxListeners(50)
    this.version = '1.8.9'
    this.registry = mcData
    this.world = world
    this.food = food
    this.health = 20
    this.inventory = { slots: [] }
    this.jumpTicks = 0
    this.jumpQueued = false
    this.tickCount = 0
    this.controlState = emptyInput()

    const effects = {}
    if (speed > 0) effects[1] = { id: 1, amplifier: speed - 1, duration: 1e9 }
    if (jumpBoost > 0) effects[8] = { id: 8, amplifier: jumpBoost - 1, duration: 1e9 }
    const modifiers = speed > 0 ? [{ uuid: SPEED_UUID, amount: 0.2 * speed, operation: 2 }] : []

    this.entity = {
      id: 1,
      position: position ? position.clone() : new Vec3(0.5, 64, 0.5),
      velocity: new Vec3(0, 0, 0),
      onGround: false,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: false,
      yawDegrees: 0,
      pitchDegrees: 0,
      yaw: 0,
      pitch: 0,
      height: 1.8,
      eyeHeight: 1.62,
      effects,
      attributes: { 'generic.movementSpeed': { value: 0.1, modifiers } }
    }
    this.setAngleDegrees(yaw, pitch)

    this.physicsWorld = new ShapeWorld(this)
    this.physics = Physics(this.registry, this.physicsWorld)
    // Packets the vanilla emitter would send, in order: { tick, name, cls, params }.
    this.sent = []
    this.vanilla = createCore(this, {
      physics: this.physics,
      world: this.physicsWorld,
      write: (packet) => this.sent.push({ tick: this.vanilla.tickCount, ...packet })
    })
  }

  setControlState (control, state) {
    if (!(control in this.controlState)) throw new Error(`invalid control: ${control}`)
    if (typeof state !== 'boolean') throw new Error(`invalid state: ${state}`)
    if (this.controlState[control] === state) return
    this.controlState[control] = state
    if (control === 'jump' && state) this.jumpQueued = true
  }

  getControlState (control) {
    return this.controlState[control]
  }

  clearControlStates () {
    for (const control in this.controlState) this.setControlState(control, false)
  }

  // physics.js setAngleDegrees with autoround, in float32 like JavaFloat.
  setAngleDegrees (newYaw, newPitch) {
    const cur = f32(this.entity.yawDegrees)
    let dYaw = f32(f32(f32(newYaw) - cur) % f32(360))
    if (dYaw < -180) dYaw = f32(dYaw + 360)
    else if (dYaw > 180) dYaw = f32(dYaw - 360)
    const norm = f32(cur + dYaw)
    this.entity.yawDegrees = f32(f32(Math.round(f32(norm / ROUNDING_GCD))) * ROUNDING_GCD)
    let pitch = f32(f32(Math.round(f32(f32(newPitch) / ROUNDING_GCD))) * ROUNDING_GCD)
    pitch = Math.max(-90, Math.min(90, pitch))
    this.entity.pitchDegrees = pitch
    this.entity.yaw = euclideanMod(Math.PI - this.entity.yawDegrees * Math.PI / 180, Math.PI * 2)
    this.entity.pitch = euclideanMod(-this.entity.pitchDegrees * Math.PI / 180 + Math.PI, Math.PI * 2) - Math.PI
  }

  // Same conversions as mineflayer's bot.look(yaw, pitch, true).
  look (yaw, pitch) {
    const yawNotchian = (Math.PI - yaw) * 180 / Math.PI
    const pitchNotchian = -pitch * 180 / Math.PI
    this.setAngleDegrees(yawNotchian, pitchNotchian)
    return Promise.resolve()
  }

  blockAt (pos) {
    const block = this.physicsWorld.getBlock(pos)
    if (!block) return null
    const info = this.registry.blocks[block.type]
    return { ...block, name: info ? info.name : 'unknown', boundingBox: info ? info.boundingBox : 'empty' }
  }

  quit () {
    this.emit('end', 'quit')
  }

  // One EntityPlayerSP.onUpdate through the same core the live client uses.
  tick () {
    const ran = this.vanilla.tick()
    if (ran) this.tickCount++
    return ran
  }
}

function euclideanMod (numerator, denominator) {
  const result = numerator % denominator
  return result < 0 ? result + denominator : result
}

module.exports = { FakeBot }
