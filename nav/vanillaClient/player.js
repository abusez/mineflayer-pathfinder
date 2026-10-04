'use strict'

const { sprintApplicable, airborneAccelFor } = require('../physicsFixes')

const f32 = Math.fround

// The client-side player state that EntityPlayerSP keeps between ticks and
// that the movement packets depend on.
function newLiving () {
  return {
    sprinting: false, // Entity flag 3, isSprinting()
    sprintingTicksLeft: 0,
    sprintToggleTimer: 0,
    // MovementInput (the values left over from the previous tick)
    moveStrafe: f32(0),
    moveForward: f32(0),
    jump: false,
    sneak: false
  }
}

function cloneLiving (l) {
  return { ...l }
}

// EntityPlayerSP.setSprinting
function setSprinting (l, sprinting) {
  l.sprinting = sprinting
  l.sprintingTicksLeft = sprinting ? 600 : 0
}

// MovementInputFromOptions.updatePlayerMoveState, from held keys.
function updatePlayerMoveState (l, keys) {
  let moveStrafe = 0
  let moveForward = 0
  if (keys.forward) ++moveForward
  if (keys.back) --moveForward
  if (keys.left) ++moveStrafe
  if (keys.right) --moveStrafe
  l.jump = !!keys.jump
  l.sneak = !!keys.sneak
  if (l.sneak) {
    moveStrafe = f32(moveStrafe * 0.3)
    moveForward = f32(moveForward * 0.3)
  }
  l.moveStrafe = f32(moveStrafe)
  l.moveForward = f32(moveForward)
}

// The sprint part of EntityPlayerSP.onLivingUpdate (MCP 1.8.9), in order:
//
//   if (sprintingTicksLeft > 0) { --sprintingTicksLeft; if (== 0) setSprinting(false); }
//   if (sprintToggleTimer > 0) --sprintToggleTimer;
//   boolean flag = movementInput.jump;            (read, unused for sprint)
//   boolean flag1 = movementInput.sneak;
//   float f = 0.8F;
//   boolean flag2 = movementInput.moveForward >= f;
//   movementInput.updatePlayerMoveState();
//   if (isUsingItem() && !isRiding()) { moveStrafe *= 0.2F; moveForward *= 0.2F; sprintToggleTimer = 0; }
//   pushOutOfBlocks(...)                          (no-op for a body that is not inside blocks)
//   boolean flag3 = foodLevel > 6.0F || capabilities.allowFlying;
//   if (onGround && !flag1 && !flag2 && moveForward >= f && !isSprinting() && flag3 && !isUsingItem() && !blindness) {
//     if (sprintToggleTimer <= 0 && !keyBindSprint.isKeyDown()) sprintToggleTimer = 7; else setSprinting(true);
//   }
//   if (!isSprinting() && moveForward >= f && flag3 && !isUsingItem() && !blindness && keyBindSprint.isKeyDown()) setSprinting(true);
//   if (isSprinting() && (moveForward < f || isCollidedHorizontally || !flag3)) setSprinting(false);
//
// keys: held keys incl. the sprint key. ctx: { onGround, collidedHorizontally,
// food, allowFlying, usingItem, blind } from the state before this tick moves.
function livingUpdate (l, keys, ctx) {
  if (l.sprintingTicksLeft > 0) {
    --l.sprintingTicksLeft
    if (l.sprintingTicksLeft === 0) setSprinting(l, false)
  }
  if (l.sprintToggleTimer > 0) --l.sprintToggleTimer

  const flag1 = l.sneak
  const f = f32(0.8)
  const flag2 = l.moveForward >= f
  updatePlayerMoveState(l, keys)

  const usingItem = !!ctx.usingItem
  if (usingItem) {
    l.moveStrafe = f32(l.moveStrafe * f32(0.2))
    l.moveForward = f32(l.moveForward * f32(0.2))
    l.sprintToggleTimer = 0
  }

  const food = typeof ctx.food === 'number' ? ctx.food : 20
  const flag3 = food > 6 || !!ctx.allowFlying
  const blind = !!ctx.blind

  if (ctx.onGround && !flag1 && !flag2 && l.moveForward >= f && !l.sprinting && flag3 && !usingItem && !blind) {
    if (l.sprintToggleTimer <= 0 && !keys.sprint) l.sprintToggleTimer = 7
    else setSprinting(l, true)
  }

  if (!l.sprinting && l.moveForward >= f && flag3 && !usingItem && !blind && keys.sprint) {
    setSprinting(l, true)
  }

  if (l.sprinting && (l.moveForward < f || ctx.collidedHorizontally || !flag3)) {
    setSprinting(l, false)
  }
}

// The controls prismarine-physics consumes: movement keys as held, sprint as
// the vanilla isSprinting() state (not the key).
function physicsControl (keys, l) {
  return {
    forward: !!keys.forward,
    back: !!keys.back,
    left: !!keys.left,
    right: !!keys.right,
    jump: !!keys.jump,
    sneak: !!keys.sneak,
    sprint: l.sprinting
  }
}

// One client tick of the local player, shared by the live client and nav's
// simulator: EntityPlayerSP.onLivingUpdate's sprint/input update, then
// EntityLivingBase.onLivingUpdate (jump, damping, moveEntityWithHeading) as
// prismarine-physics implements it. s is a prismarine PlayerState-shaped
// object carrying s.living and s.prevSprint.
function stepPlayer (physics, world, s, keys, ctx) {
  livingUpdate(s.living, keys, {
    onGround: s.onGround,
    collidedHorizontally: s.isCollidedHorizontally,
    food: ctx.food,
    allowFlying: ctx.allowFlying,
    usingItem: ctx.usingItem,
    blind: ctx.blind
  })
  const control = physicsControl(keys, s.living)
  s.control = control
  const sprinting = sprintApplicable(control, s.isInWater, s.isInLava)
  physics.airborneAcceleration = airborneAccelFor(sprinting, s.prevSprint)
  physics.simulatePlayer(s, world)
  s.prevSprint = sprinting
  return s
}

module.exports = {
  newLiving,
  cloneLiving,
  setSprinting,
  updatePlayerMoveState,
  livingUpdate,
  physicsControl,
  stepPlayer
}
