'use strict'

const fs = require('fs')
const { CONTROLS, emptyInput, copyInput, wrapDegrees } = require('./util')

// Movement recording and replay, for tuning only. Nothing in nav depends on it.
//
// A recording is { version, kind, ticks: [frame] } where each frame is the
// state at the start of a tick plus the input and rotation used for it:
//   { pos: [x,y,z], vel: [x,y,z], onGround, inWater, jumpTicks, yaw, pitch,
//     keys: 'FBLRJSN' flags }
// The same format can hold a human session captured elsewhere (a proxy or a
// client mod log), as long as frames are per client tick.

const KEY_CHARS = { forward: 'F', back: 'B', left: 'L', right: 'R', jump: 'J', sprint: 'S', sneak: 'N' }

function encodeKeys (input) {
  let s = ''
  for (const k of CONTROLS) s += input[k] ? KEY_CHARS[k] : '-'
  return s
}

function decodeKeys (s) {
  const input = emptyInput()
  CONTROLS.forEach((k, i) => { input[k] = s[i] === KEY_CHARS[k] })
  return input
}

// Records the bot every physics tick: state before the tick, keys and
// rotation the tick used.
function createRecorder (bot) {
  let frames = null
  let pending = null

  function onBegin () {
    if (!frames || !bot.entity) return
    const e = bot.entity
    pending = {
      pos: [e.position.x, e.position.y, e.position.z],
      vel: [e.velocity.x, e.velocity.y, e.velocity.z],
      onGround: !!e.onGround,
      inWater: !!e.isInWater,
      jumpTicks: bot.jumpTicks || 0,
      // vanilla client state the tick starts from (sprint latch, input)
      living: bot.vanilla ? { ...bot.vanilla.living } : null,
      prevSprint: bot.vanilla ? bot.vanilla.prevSprint : false
    }
  }

  // Keys and rotation are final once every physicsTickBegin listener ran;
  // physicsTick fires right after the simulation that used them.
  function onTick () {
    if (!frames || !pending) return
    pending.yaw = Number(bot.entity.yawDegrees)
    pending.pitch = Number(bot.entity.pitchDegrees)
    pending.keys = encodeKeys(bot.controlState)
    frames.push(pending)
    pending = null
  }

  bot.on('physicsTickBegin', onBegin)
  bot.on('physicsTick', onTick)

  return {
    get recording () { return frames != null },
    start () { frames = [] },
    stop () {
      const out = { version: 1, kind: 'bot', ticks: frames || [] }
      frames = null
      return out
    },
    save (file) {
      const rec = this.stop()
      fs.writeFileSync(file, JSON.stringify(rec))
      return rec
    }
  }
}

// Replays each recorded input through the simulator from the recorded state
// and reports how far the prediction lands from the next recorded frame.
// With the bot's own recordings in the same world this should be ~0.
function replay (recording, sim) {
  const errors = []
  for (let i = 0; i + 1 < recording.ticks.length; i++) {
    const f = recording.ticks[i]
    const next = recording.ticks[i + 1]
    const s = sim.fromBot()
    s.pos.set(f.pos[0], f.pos[1], f.pos[2])
    s.motion.set(f.vel[0], f.vel[1], f.vel[2])
    s.onGround = f.onGround
    s.jumpTicks = f.jumpTicks || 0
    s.isInWater = !!f.inWater
    s.isCollidedHorizontally = false
    if (f.living) s.living = { ...f.living }
    s.prevSprint = !!f.prevSprint
    sim.step(s, copyInput(decodeKeys(f.keys)), f.yaw, f.pitch)
    errors.push(Math.hypot(s.pos.x - next.pos[0], s.pos.y - next.pos[1], s.pos.z - next.pos[2]))
  }
  const sorted = errors.slice().sort((a, b) => a - b)
  return {
    ticks: errors.length,
    maxError: sorted[sorted.length - 1] || 0,
    p99Error: sorted[Math.floor(sorted.length * 0.99)] || 0,
    exact: errors.filter(e => e < 1e-9).length
  }
}

// Movement statistics, for comparing a human trace with a bot trace.
function stats (recording) {
  const t = recording.ticks
  const yawSpeeds = []
  const yawAccels = []
  let prev = null
  const holds = {}
  const keyStart = {}
  let jumps = 0
  let sprintTicks = 0
  let horizontal = 0
  for (let i = 0; i < t.length; i++) {
    const f = t[i]
    const keys = decodeKeys(f.keys)
    if (i > 0) {
      const d = wrapDegrees(f.yaw - t[i - 1].yaw)
      yawSpeeds.push(Math.abs(d))
      if (prev != null) yawAccels.push(Math.abs(d - prev))
      prev = d
      horizontal += Math.hypot(f.pos[0] - t[i - 1].pos[0], f.pos[2] - t[i - 1].pos[2])
    }
    if (keys.jump && f.onGround) jumps++
    if (keys.sprint) sprintTicks++
    for (const k of ['forward', 'back', 'left', 'right']) {
      if (keys[k] && keyStart[k] == null) keyStart[k] = i
      if (!keys[k] && keyStart[k] != null) {
        (holds[k] = holds[k] || []).push(i - keyStart[k])
        keyStart[k] = null
      }
    }
  }
  const pct = (list, p) => {
    if (!list.length) return 0
    const s = list.slice().sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(s.length * p))]
  }
  const moving = yawSpeeds.filter(v => v > 0)
  return {
    ticks: t.length,
    blocksPerTick: t.length > 1 ? horizontal / (t.length - 1) : 0,
    jumpsPer100Ticks: t.length ? jumps * 100 / t.length : 0,
    sprintShare: t.length ? sprintTicks / t.length : 0,
    turningShare: yawSpeeds.length ? moving.length / yawSpeeds.length : 0,
    yawSpeed: { p50: pct(moving, 0.5), p90: pct(moving, 0.9), max: pct(moving, 1) },
    yawAccel: { p50: pct(yawAccels, 0.5), p90: pct(yawAccels, 0.9), max: pct(yawAccels, 1) },
    keyHoldTicks: Object.fromEntries(Object.entries(holds).map(([k, v]) => [k, { p10: pct(v, 0.1), p50: pct(v, 0.5) }]))
  }
}

module.exports = { createRecorder, replay, stats, encodeKeys, decodeKeys }
