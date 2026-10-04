'use strict'

const { f32, ROUNDING_GCD, wrapDegrees } = require('./util')

// A deterministic model of a skilled player's mouse. No noise: it looks human
// because of how real aiming works.
// - Reaction delay: a new target is acted on a couple of ticks after it appears.
// - Submovements: each turn follows a minimum-jerk (bell-shaped velocity)
//   profile whose duration grows with the angle (Fitts-like).
// - Consistent undershoot: large flicks stop a little short, then a small
//   corrective submovement finishes the turn.
// - Velocity continuity: a retarget mid-turn starts from the current angular
//   velocity, so tracking a moving target stays smooth.
// - Limits: peak speed and acceleration caps, and the sensitivity GCD grid.

const DEFAULTS = {
  gcd: ROUNDING_GCD,
  reactionTicks: 2,
  bigReactionTicks: 3,
  bigTurn: 35,
  maxSpeed: 40, // degrees/tick
  maxAccel: 14, // degrees/tick^2
  deadzone: 0.35, // degrees left alone
  retarget: 1.2, // degrees of target drift before a new submovement
  settleTicks: 1 // pause after a submovement before a correction starts
}

class Rotation {
  constructor (yaw = 0, pitch = 0, options = {}) {
    this.o = { ...DEFAULTS, ...options }
    this.yaw = yaw
    this.pitch = pitch
    this.vYaw = 0
    this.vPitch = 0
    this.queue = [] // pending targets: { yaw, pitch, at }
    this.target = null // perceived target
    this.move = null // active submovement
    this.settle = 0
    this.tick = 0
  }

  clone () {
    const r = new Rotation(this.yaw, this.pitch, this.o)
    r.vYaw = this.vYaw
    r.vPitch = this.vPitch
    r.queue = this.queue.slice()
    r.target = this.target
    // The submovement carries its own progress (t); a rollout must not
    // advance the real one.
    r.move = this.move ? { ...this.move } : null
    r.settle = this.settle
    r.tick = this.tick
    return r
  }

  // The bot's rotation changed under us (server teleport, manual look).
  sync (yaw, pitch) {
    this.yaw = yaw
    this.pitch = pitch
    this.vYaw = 0
    this.vPitch = 0
    this.move = null
    this.queue = []
    this.target = null
  }

  setTarget (yaw, pitch) {
    const last = this.queue.length ? this.queue[this.queue.length - 1] : this.target
    const yawGoal = last ? last.yaw + wrapDegrees(yaw - last.yaw) : this.yaw + wrapDegrees(yaw - this.yaw)
    const jump = last ? Math.abs(yawGoal - last.yaw) : Math.abs(yawGoal - this.yaw)
    const delay = jump > this.o.bigTurn ? this.o.bigReactionTicks : this.o.reactionTicks
    const at = this.tick + delay
    // A newer target supersedes anything not yet perceived that would land later.
    while (this.queue.length && this.queue[this.queue.length - 1].at >= at) this.queue.pop()
    this.queue.push({ yaw: yawGoal, pitch, at })
  }

  // Advance one tick. Returns the rotation to apply this tick.
  next () {
    while (this.queue.length && this.queue[0].at <= this.tick) this.target = this.queue.shift()
    this.tick++
    if (this.settle > 0) this.settle--
    else if (this.target) this.maybeReplan()

    let yawGoal = this.yaw
    let pitchGoal = this.pitch
    if (this.move) {
      const m = this.move
      m.t++
      const u = Math.min(1, m.t / m.T)
      yawGoal = quintic(m.yaw, u, m.T)
      pitchGoal = quintic(m.pitch, u, m.T)
      if (m.t >= m.T) {
        this.move = null
        this.settle = this.o.settleTicks
      }
    }

    const dy = this.limit(yawGoal - this.yaw, this.vYaw)
    const dp = this.limit(pitchGoal - this.pitch, this.vPitch)
    const g = this.o.gcd
    const stepYaw = Math.round(dy / g) * g
    const stepPitch = Math.round(dp / g) * g
    const yaw = this.quantize(this.yaw + stepYaw)
    const pitch = Math.max(-90, Math.min(90, this.quantize(this.pitch + stepPitch)))
    this.vYaw = yaw - this.yaw
    this.vPitch = pitch - this.pitch
    this.yaw = yaw
    this.pitch = pitch
    return { yaw, pitch }
  }

  // The physics plugin stores absolute angles on the GCD grid in float32.
  // Matching its rounding keeps predicted and applied yaw bit-identical.
  quantize (value) {
    const g = this.o.gcd
    return f32(f32(Math.round(f32(f32(value) / g))) * g)
  }

  limit (delta, v) {
    const { maxSpeed, maxAccel } = this.o
    let d = Math.max(v - maxAccel, Math.min(v + maxAccel, delta))
    d = Math.max(-maxSpeed, Math.min(maxSpeed, d))
    return d
  }

  maybeReplan () {
    const t = this.target
    const yawTarget = this.yaw + wrapDegrees(t.yaw - this.yaw)
    const err = yawTarget - this.yaw
    const pitchErr = t.pitch - this.pitch
    const endYaw = this.move ? this.move.endYaw : this.yaw
    const endPitch = this.move ? this.move.endPitch : this.pitch
    const drift = Math.max(Math.abs(yawTarget - endYaw), Math.abs(t.pitch - endPitch))
    if (this.move && drift < this.o.retarget) return
    if (!this.move && Math.abs(err) < this.o.deadzone && Math.abs(pitchErr) < this.o.deadzone) return
    if (!this.move && drift < this.o.retarget && Math.abs(err) < 2 && Math.abs(pitchErr) < 2) {
      // Small residual: a single gentle correction, no undershoot.
      this.start(yawTarget, t.pitch, false)
      return
    }
    this.start(yawTarget, t.pitch, true)
  }

  start (yawTarget, pitchTarget, allowUndershoot) {
    const dYaw = yawTarget - this.yaw
    const dPitch = pitchTarget - this.pitch
    const amp = Math.max(Math.abs(dYaw), Math.abs(dPitch))
    // Large flicks consistently stop a few percent short.
    const short = allowUndershoot && amp > 15 ? Math.min(0.08, 0.025 + amp / 3000) : 0
    const endYaw = this.yaw + dYaw * (1 - short)
    const endPitch = this.pitch + dPitch * (1 - short)
    // Fitts-like duration, stretched when needed so the bell profile peaks
    // below the speed and acceleration caps (a flat-topped profile at the
    // cap would be a robotic constant turn rate).
    const fitts = Math.round(1 + 1.3 * Math.log2(1 + amp / 5))
    const bySpeed = Math.ceil(1.875 * amp / (0.85 * this.o.maxSpeed))
    const byAccel = Math.ceil(Math.sqrt(5.77 * amp / (0.85 * this.o.maxAccel)))
    const T = Math.max(2, Math.min(14, Math.max(fitts, bySpeed, byAccel)))
    this.move = {
      t: 0,
      T,
      endYaw,
      endPitch,
      yaw: coefficients(this.yaw, this.vYaw, endYaw, T),
      pitch: coefficients(this.pitch, this.vPitch, endPitch, T)
    }
  }

  // Deterministic look ahead: the rotation this model will apply on each of the
  // next n ticks, given the targets it has been told about so far. An optional
  // targetFn(i) can feed a new target before tick i.
  predict (n, targetFn) {
    const r = this.clone()
    const out = new Array(n)
    for (let i = 0; i < n; i++) {
      if (targetFn) {
        const t = targetFn(i, r)
        if (t) r.setTarget(t.yaw, t.pitch)
      }
      out[i] = r.next().yaw
    }
    return out
  }
}

// Minimum-jerk path from p0 with velocity v0 (per tick) to p1 at rest, over T
// ticks. Returns coefficients for p(u), u in [0, 1].
function coefficients (p0, v0, p1, T) {
  const v = v0 * T // velocity in u units
  const d = p1 - p0
  // p(u) = p0 + v u + c3 u^3 + c4 u^4 + c5 u^5, with p(1)=p1, p'(1)=0, p''(1)=0, p''(0)=0
  const c3 = 10 * d - 6 * v
  const c4 = -15 * d + 8 * v
  const c5 = 6 * d - 3 * v
  return { p0, v, c3, c4, c5 }
}

function quintic (c, u) {
  const u2 = u * u
  const u3 = u2 * u
  return c.p0 + c.v * u + c.c3 * u3 + c.c4 * u3 * u + c.c5 * u3 * u2
}

module.exports = { Rotation, DEFAULTS }
