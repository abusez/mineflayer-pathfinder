'use strict'

const f32 = Math.fround

const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

// Mouse sensitivity 100% (GameSettings 0.5F), same as the physics plugin.
// EntityRenderer: f = sens * 0.6 + 0.2, step = f^3 * 8 * 0.15 degrees per count.
const SENS_F = f32(f32(f32(f32(100) / f32(200)) * f32(0.6)) + f32(0.2))
const ROUNDING_GCD = f32(f32(f32(f32(f32(0.15) * f32(8)) * SENS_F) * SENS_F) * SENS_F)

function emptyInput () {
  return { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
}

function copyInput (input) {
  return {
    forward: !!input.forward,
    back: !!input.back,
    left: !!input.left,
    right: !!input.right,
    jump: !!input.jump,
    sprint: !!input.sprint,
    sneak: !!input.sneak
  }
}

function sameInput (a, b) {
  for (const key of CONTROLS) {
    if (!!a[key] !== !!b[key]) return false
  }
  return true
}

function inputKey (input) {
  let s = ''
  for (const key of CONTROLS) s += input[key] ? key[0].toUpperCase() : '-'
  return s
}

// Notchian yaw: 0 faces +z, 90 faces -x. Forward motion is (-sin, cos).
function yawToward (dx, dz) {
  return Math.atan2(-dx, dz) * 180 / Math.PI
}

function wrapDegrees (deg) {
  let d = deg % 360
  if (d >= 180) d -= 360
  if (d < -180) d += 360
  return d
}

function horizontalDist (ax, az, bx, bz) {
  const dx = ax - bx
  const dz = az - bz
  return Math.sqrt(dx * dx + dz * dz)
}

// Direction a single key set pushes, in world space, for a given yaw. This is
// moveFlying's strafe/forward mix in prismarine-physics (strafe = right - left).
function inputDirection (input, yawDeg) {
  let strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0)
  let forward = (input.forward ? 1 : 0) - (input.back ? 1 : 0)
  if (strafe === 0 && forward === 0) return null
  const len = Math.hypot(strafe, forward)
  strafe /= len
  forward /= len
  const rad = yawDeg * Math.PI / 180
  const sin = Math.sin(rad)
  const cos = Math.cos(rad)
  return { x: strafe * cos - forward * sin, z: forward * cos + strafe * sin }
}

// Deterministic PRNG for course generation and tests. Never used for rotation.
function mulberry32 (seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

module.exports = {
  f32,
  CONTROLS,
  ROUNDING_GCD,
  emptyInput,
  copyInput,
  sameInput,
  inputKey,
  yawToward,
  wrapDegrees,
  horizontalDist,
  inputDirection,
  mulberry32
}
