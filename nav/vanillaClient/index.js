'use strict'

// Replacement for mineflayer's internal physics plugin with vanilla 1.8.9
// client timing and packets:
//   createBot({ ..., plugins: { physics: vanillaPhysics } })
//
// - Ticks come from a port of net.minecraft.util.Timer (20 TPS, delta clamped
//   to 1 s, at most 10 ticks per frame, the rest dropped), driven by a frame
//   loop like Minecraft.runGameLoop.
// - Each tick is EntityPlayerSP.onUpdate (see core.js); packets come from the
//   onUpdateWalkingPlayer port (emitter.js).
// - S08 is answered like NetHandlerPlayClient.handlePlayerPosLook.
// The public API matches the plugin it replaces (setControlState, look,
// lookAt, waitForTicks, physicsTick events...).

const assert = require('assert')
const { Physics } = require('prismarine-physics')
const { ShapeWorld } = require('../world')
const conv = require('mineflayer/lib/conversions')
const math = require('mineflayer/lib/math')
const { createDoneTask, createTask } = require('mineflayer/lib/promise_utils')
const { JavaFloat } = require('mineflayer/lib/javamath')
const { createCore } = require('./core')
const { VanillaTimer } = require('./timer')
const { teleportReply } = require('./emitter')

const f = new JavaFloat(100.0).divide(new JavaFloat(200.0)).multiply(new JavaFloat(0.6)).add(new JavaFloat(0.2))
const roundingGCD = new JavaFloat(0.15).multiply(new JavaFloat(8.0)).multiply(f).multiply(f).multiply(f)

// How often the frame loop runs. A frame only runs the ticks the Timer says
// are due, so this is a render-rate stand-in, not a packet rate.
const FRAME_MS = 4

function vanillaPhysics (bot, { physicsEnabled } = {}) {
  // FastWorld with the 1.8.9 collision boxes (nav/shapes18.js).
  const world = new ShapeWorld(bot)
  const physics = Physics(bot.registry, world)

  bot.jumpQueued = false
  bot.jumpTicks = 0
  bot.physicsEnabled = physicsEnabled ?? true
  bot.physics = physics
  bot.physicsWorld = world

  const controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  let shouldUsePhysics = false
  let deadTicks = 21
  let frameTimer = null
  let timer = null
  const listeners = new Set()

  function write (packet) {
    for (const l of listeners) l(packet, 'tick')
    bot._client.write(packet.name, packet.params)
    if (packet.name !== 'entity_action' && packet.name !== 'flying') bot.emit('move', bot.entity.position.clone())
  }

  // Mineflayer behaviour kept: stop reporting 20 ticks after death.
  function canSend () {
    if (bot.isAlive === true) deadTicks = 0
    if (bot.isAlive === false && deadTicks <= 20) deadTicks++
    return deadTicks < 20
  }

  const core = createCore(bot, { physics, world, write, canSend })
  bot.vanilla = core
  core.onPacket = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }

  function runTick () {
    if (!bot.entity || !bot.physicsEnabled || !shouldUsePhysics) return
    if (typeof bot.entity.yawDegrees === 'undefined') {
      bot.entity.yawDegrees = new JavaFloat(0)
      bot.entity.pitchDegrees = new JavaFloat(0)
    }
    core.tick()
  }

  // Minecraft.runGameLoop: timer.updateTimer(); for (j < timer.elapsedTicks) runTick();
  function frame () {
    timer.updateTimer()
    core.frame = { ticks: timer.elapsedTicks, uncapped: timer.uncappedTicks, at: performance.now() }
    for (let j = 0; j < timer.elapsedTicks; ++j) runTick()
    frameTimer = setTimeout(frame, FRAME_MS)
  }

  function startLoop () {
    if (frameTimer) return
    timer = new VanillaTimer(20)
    core.timer = timer
    frameTimer = setTimeout(frame, FRAME_MS)
  }

  function stopLoop () {
    if (frameTimer) clearTimeout(frameTimer)
    frameTimer = null
  }

  // --- controls -------------------------------------------------------------

  bot.setControlState = (control, state) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    assert.ok(typeof state === 'boolean', `invalid state: ${state}`)
    if (controlState[control] === state) return
    controlState[control] = state
    if (control === 'jump' && state) bot.jumpQueued = true
  }

  bot.getControlState = (control) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    return controlState[control]
  }

  bot.clearControlStates = () => {
    for (const control in controlState) bot.setControlState(control, false)
  }

  bot.controlState = {}
  for (const control of Object.keys(controlState)) {
    Object.defineProperty(bot.controlState, control, {
      get () { return controlState[control] },
      set (state) { bot.setControlState(control, state); return state },
      enumerable: true
    })
  }

  // --- rotation ---------------------------------------------------------------

  let lookingTask = createDoneTask()
  let targetYaw = null
  let targetPitch = null

  function deltaYawDegrees (yaw1, yaw2) {
    let dYaw = new JavaFloat((yaw1.subtract(yaw2)) % new JavaFloat(360))
    if (dYaw < new JavaFloat(-180).valueOf()) dYaw = dYaw.add(new JavaFloat(360))
    else if (dYaw.valueOf() > new JavaFloat(180).valueOf()) dYaw = dYaw.subtract(new JavaFloat(360))
    return dYaw
  }

  function setAngleDegrees (newYaw, newPitch, autoround = true) {
    if (autoround) {
      const dYaw = deltaYawDegrees(new JavaFloat(newYaw), bot.entity.yawDegrees)
      const normYaw = bot.entity.yawDegrees.add(dYaw)
      bot.entity.yawDegrees = normYaw.divide(roundingGCD).round().multiply(roundingGCD)
      bot.entity.pitchDegrees = new JavaFloat(newPitch).divide(roundingGCD).round().multiply(roundingGCD)
    } else {
      bot.entity.yawDegrees = new JavaFloat(newYaw)
      bot.entity.pitchDegrees = new JavaFloat(newPitch)
    }
    bot.entity.pitchDegrees = bot.entity.pitchDegrees.clamp(new JavaFloat(-90.0), new JavaFloat(90.0))
    bot.entity.yaw = conv.fromNotchianYaw(bot.entity.yawDegrees)
    bot.entity.pitch = conv.fromNotchianPitch(bot.entity.pitchDegrees)
  }

  bot.on('physicsTick', () => {
    if (lookingTask.done) return
    const deltaYaw = deltaYawDegrees(targetYaw, bot.entity.yawDegrees).valueOf()
    const deltaPitch = targetPitch.subtract(bot.entity.pitchDegrees).valueOf()
    if (Math.abs(deltaYaw) < 0.1 && Math.abs(deltaPitch) < 0.1) {
      lookingTask.finish()
      return
    }
    const yawChange = math.clamp(-physics.yawSpeed, deltaYaw, physics.yawSpeed)
    const pitchChange = math.clamp(-physics.pitchSpeed, deltaPitch, physics.pitchSpeed)
    setAngleDegrees(bot.entity.yawDegrees.valueOf() + yawChange, bot.entity.pitchDegrees.valueOf() + pitchChange)
  })

  bot.look = async (yaw, pitch, force) => {
    if (!lookingTask.done) {
      lookingTask.finish()
      targetYaw = null
      targetPitch = null
    }
    const yawNotchian = conv.toNotchianYaw(yaw)
    const pitchNotchian = conv.toNotchianPitch(pitch)
    if (force) {
      setAngleDegrees(yawNotchian, pitchNotchian)
      return
    }
    lookingTask = createTask()
    targetYaw = new JavaFloat(yawNotchian)
    targetPitch = new JavaFloat(pitchNotchian)
    return await lookingTask.promise
  }

  bot.lookAt = async (point, force) => {
    const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
    const yaw = Math.atan2(-delta.x, -delta.z)
    const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
    const pitch = Math.atan2(delta.y, groundDistance)
    await bot.look(yaw, pitch, force)
  }

  bot.elytraFly = async () => { throw new Error('elytra does not exist in 1.8') }

  // --- server packets ---------------------------------------------------------

  bot._client.on('explosion', explosion => {
    if (bot.physicsEnabled && bot.game.gameMode !== 'creative' && 'playerMotionX' in explosion) {
      bot.entity.velocity.x += explosion.playerMotionX
      bot.entity.velocity.y += explosion.playerMotionY
      bot.entity.velocity.z += explosion.playerMotionZ
    }
  })

  // NetHandlerPlayClient.handlePlayerPosLook: relative/absolute position and
  // rotation, absolute axes zero that motion component, then reply with C06
  // (onGround false). EntityPlayerSP's lastReported* are left untouched.
  bot._client.on('position', (packet) => {
    const { velocity, position } = bot.entity
    const bitflags = typeof packet.flags === 'object'
    const flagX = bitflags ? packet.flags.x : (packet.flags & 1) !== 0
    const flagY = bitflags ? packet.flags.y : (packet.flags & 2) !== 0
    const flagZ = bitflags ? packet.flags.z : (packet.flags & 4) !== 0
    const flagYaw = bitflags ? packet.flags.yaw : (packet.flags & 8) !== 0
    const flagPitch = bitflags ? packet.flags.pitch : (packet.flags & 16) !== 0

    const newX = (flagX ? position.x : 0) + packet.x
    const newY = (flagY ? position.y : 0) + packet.y
    const newZ = (flagZ ? position.z : 0) + packet.z

    if (typeof bot.entity.yawDegrees === 'undefined') {
      bot.entity.yawDegrees = new JavaFloat(0.0)
      bot.entity.pitchDegrees = new JavaFloat(0.0)
    }
    const newYaw = (flagYaw ? bot.entity.yawDegrees : new JavaFloat(0)).add(new JavaFloat(packet.yaw))
    const newPitch = (flagPitch ? bot.entity.pitchDegrees : new JavaFloat(0)).add(new JavaFloat(packet.pitch))

    velocity.set(flagX ? velocity.x : 0, flagY ? velocity.y : 0, flagZ ? velocity.z : 0)
    position.set(newX, newY, newZ)
    setAngleDegrees(newYaw, newPitch, false)

    const reply = teleportReply(position.x, position.y, position.z, Number(bot.entity.yawDegrees), Number(bot.entity.pitchDegrees))
    for (const l of listeners) l(reply, 'teleport')
    bot._client.write(reply.name, reply.params)

    shouldUsePhysics = true
    bot.jumpTicks = 0
    bot.emit('forcedMove')
  })

  bot.waitForTicks = async function (ticks) {
    if (ticks <= 0) return
    await new Promise(resolve => {
      const tickListener = () => {
        ticks--
        if (ticks === 0) {
          bot.removeListener('physicsTick', tickListener)
          resolve()
        }
      }
      bot.on('physicsTick', tickListener)
    })
  }

  bot.on('mount', () => { shouldUsePhysics = false })

  function forceResetControls () {
    for (const control in controlState) controlState[control] = false
  }

  bot.on('respawn', () => {
    bot.entity.yawDegrees = new JavaFloat(0)
    bot.entity.pitchDegrees = new JavaFloat(0)
    shouldUsePhysics = false
    forceResetControls()
    core.reset()
  })

  bot.on('login', () => {
    bot.entity.yawDegrees = new JavaFloat(0)
    bot.entity.pitchDegrees = new JavaFloat(0)
    shouldUsePhysics = false
    forceResetControls()
    core.reset()
    startLoop()
  })

  bot.on('end', stopLoop)
}

module.exports = { vanillaPhysics }
