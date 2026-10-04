'use strict'

const f32 = Math.fround

// C0BPacketEntityAction.Action ids on the 1.8 wire.
const ACTION = {
  START_SNEAKING: 0,
  STOP_SNEAKING: 1,
  STOP_SLEEPING: 2,
  START_SPRINTING: 3,
  STOP_SPRINTING: 4,
  RIDING_JUMP: 5,
  OPEN_INVENTORY: 6
}

// EntityPlayerSP.onUpdateWalkingPlayer() (MCP 1.8.9), ported line for line:
//
//   boolean flag = this.isSprinting();
//   if (flag != this.serverSprintState) { send C0B START/STOP_SPRINTING; serverSprintState = flag; }
//   boolean flag1 = this.isSneaking();
//   if (flag1 != this.serverSneakState) { send C0B START/STOP_SNEAKING; serverSneakState = flag1; }
//   if (this.isCurrentViewEntity()) {
//     d0..d2 = pos - lastReportedPos (Y is getEntityBoundingBox().minY)
//     d3, d4 = (double)(rotationYaw - lastReportedYaw), (double)(rotationPitch - lastReportedPitch)
//     flag2 = d0*d0 + d1*d1 + d2*d2 > 9.0E-4D || positionUpdateTicks >= 20;
//     flag3 = d3 != 0.0D || d4 != 0.0D;
//     if (ridingEntity == null) {
//       flag2 && flag3 -> C06; flag2 -> C04; flag3 -> C05; else -> C03(onGround)
//     } else { C06(motionX, -999.0D, motionZ, ...); flag2 = false; }
//     ++positionUpdateTicks;
//     if (flag2) { lastReportedPos = pos; positionUpdateTicks = 0; }
//     if (flag3) { lastReportedYaw/Pitch = rotation; }
//   }
//
// Pure state machine: update() returns the packets for one tick, in order.
// Field names (lastReportedPosX ...) follow the vanilla source.
class WalkingEmitter {
  constructor (entityId = 0) {
    this.entityId = entityId
    this.reset()
  }

  // A fresh EntityPlayerSP: every field at its Java default.
  reset () {
    this.lastReportedPosX = 0
    this.lastReportedPosY = 0
    this.lastReportedPosZ = 0
    this.lastReportedYaw = f32(0)
    this.lastReportedPitch = f32(0)
    this.serverSneakState = false
    this.serverSprintState = false
    this.positionUpdateTicks = 0
  }

  // p: { x, y (bounding box minY), z, yaw, pitch (float degrees), onGround,
  //      sprinting (isSprinting()), sneaking (isSneaking()) }
  update (p) {
    const out = []

    const flag = !!p.sprinting
    if (flag !== this.serverSprintState) {
      out.push(action(this.entityId, flag ? ACTION.START_SPRINTING : ACTION.STOP_SPRINTING))
      this.serverSprintState = flag
    }

    const flag1 = !!p.sneaking
    if (flag1 !== this.serverSneakState) {
      out.push(action(this.entityId, flag1 ? ACTION.START_SNEAKING : ACTION.STOP_SNEAKING))
      this.serverSneakState = flag1
    }

    const yaw = f32(p.yaw)
    const pitch = f32(p.pitch)
    const d0 = p.x - this.lastReportedPosX
    const d1 = p.y - this.lastReportedPosY
    const d2 = p.z - this.lastReportedPosZ
    const d3 = f32(yaw - this.lastReportedYaw)
    const d4 = f32(pitch - this.lastReportedPitch)
    const flag2 = d0 * d0 + d1 * d1 + d2 * d2 > 9.0E-4 || this.positionUpdateTicks >= 20
    const flag3 = d3 !== 0 || d4 !== 0
    const onGround = !!p.onGround

    if (flag2 && flag3) {
      out.push({ name: 'position_look', cls: 'C06', params: { x: p.x, y: p.y, z: p.z, yaw, pitch, onGround } })
    } else if (flag2) {
      out.push({ name: 'position', cls: 'C04', params: { x: p.x, y: p.y, z: p.z, onGround } })
    } else if (flag3) {
      out.push({ name: 'look', cls: 'C05', params: { yaw, pitch, onGround } })
    } else {
      out.push({ name: 'flying', cls: 'C03', params: { onGround } })
    }

    ++this.positionUpdateTicks

    if (flag2) {
      this.lastReportedPosX = p.x
      this.lastReportedPosY = p.y
      this.lastReportedPosZ = p.z
      this.positionUpdateTicks = 0
    }

    if (flag3) {
      this.lastReportedYaw = yaw
      this.lastReportedPitch = pitch
    }

    return out
  }

  snapshot () {
    return {
      lastReportedPosX: this.lastReportedPosX,
      lastReportedPosY: this.lastReportedPosY,
      lastReportedPosZ: this.lastReportedPosZ,
      lastReportedYaw: this.lastReportedYaw,
      lastReportedPitch: this.lastReportedPitch,
      serverSprintState: this.serverSprintState,
      serverSneakState: this.serverSneakState,
      positionUpdateTicks: this.positionUpdateTicks
    }
  }
}

function action (entityId, actionId) {
  return { name: 'entity_action', cls: 'C0B', params: { entityId, actionId, jumpBoost: 0 } }
}

// NetHandlerPlayClient.handlePlayerPosLook replies with this C06 directly,
// outside onUpdateWalkingPlayer, and does not touch lastReported*.
function teleportReply (x, y, z, yaw, pitch) {
  return { name: 'position_look', cls: 'C06', params: { x, y, z, yaw: f32(yaw), pitch: f32(pitch), onGround: false } }
}

module.exports = { WalkingEmitter, ACTION, teleportReply }
