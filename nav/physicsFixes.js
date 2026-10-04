'use strict'

const { f32 } = require('./util')

// EntityPlayer.onLivingUpdate sets jumpMovementFactor *after* the move, from
// isSprinting(). So the airborne acceleration a tick uses comes from the
// previous tick's sprint state. prismarine-physics reads the current one.
// Found while chasing Grim Simulation flags (see legacy/movement.js).
const AIR_ACCEL = f32(0.02)
const AIR_ACCEL_SPRINT = f32(AIR_ACCEL + AIR_ACCEL * 0.3)
// prismarine computes f32(x + x * 0.3), so this value makes its sprint branch
// produce the plain AIR_ACCEL that a non-sprinting tick would have used.
const AIR_ACCEL_UNSPRINT = AIR_ACCEL / 1.3

function sprintApplicable (control, inWater, inLava) {
  const forward = (control.forward ? 1 : 0) - (control.back ? 1 : 0)
  return forward > 0 && !control.sneak && !inWater && !inLava && !!control.sprint
}

// The airborne acceleration to put on the physics object for this tick.
function airborneAccelFor (sprinting, prevSprinting) {
  if (sprinting === prevSprinting) return AIR_ACCEL
  return sprinting ? AIR_ACCEL_UNSPRINT : AIR_ACCEL_SPRINT
}

module.exports = {
  AIR_ACCEL,
  sprintApplicable,
  airborneAccelFor
}
