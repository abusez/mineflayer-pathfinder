const Vec3 = require('vec3').Vec3
const mcData = require('minecraft-data')('1.8.9')
const mcDataRegistry = require('minecraft-data')
const nbt = require('prismarine-nbt')

const AABB = require('./lib/aabb')
const features = require('./lib/features')
const attribute = require('./lib/attribute')
const { IntSet } = require('./lib/util')
const { f32, f32div, f32mul, f32sin, f32cos, f32add, f32sub, clamp } = require('./lib/math')

function makeSupportFeature () {
  return feature => features.some(({
    name,
    versions
  }) => name === feature && versions.includes(mcData.version.majorVersion))
}

// https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L1578C42-L1578C53
const DEG_TO_RAD = f32div(f32(Math.PI), f32(180.0))
const RAD_TO_DEG = 180.0 / Math.PI

function Physics (_mcData, world) {
  const supportFeature = makeSupportFeature(mcData)
  const blocksByName = mcData.blocksByName

  const physics = {
    yawSpeed: 60.0,
    pitchSpeed: 30.0,
    // this.motionY -= 0.08D;, EntityLivingBase.java
    gravity: 0.08,
    // this.motionY *= 0.9800000190734863D;, EntityLivingBase.java. 32 bit equivalent of 0.98
    airdrag: f32(0.98),
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/player/EntityPlayer.java#L163C5-L164C40
    playerSpeed: f32(0.1),
    airborneAcceleration: f32(0.02),
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L1610
    airborneInertia: f32(0.91),
    sprintSpeed: f32(0.3),
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/util/MovementInputFromOptions.java#L42C1-L46C10
    sneakSpeed: 0.3,
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L1974
    negligeableVelocity: 0.005,
    negligeableFlyingSpeed: f32(1.0E-4),
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L208
    stepHeight: f32(0.6), // how much height can the bot step on without jump
    ladderMaxSpeed: f32(0.15),
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L1594
    liquidMotionY: 0.03999999910593033,
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L1559
    jumpMotionY: f32(0.42),
    ladderClimbSpeed: 0.15,
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/Entity.java#L375
    playerHalfWidth: f32div(f32(0.6), f32(2)),
    playerHeight: f32(1.8),
    waterInertia: f32(0.8),
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L1689
    lavaInertia: 0.5,
    baseLiquidAcceleration: f32(0.02),
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/block/Block.java#L291
    defaultSlipperiness: f32(0.6),
    outOfLiquidImpulse: f32(0.3),
    autojumpCooldown: 10, // ticks (0.5s)
    movementSpeedAttribute: mcData.attributesByName.movementSpeed.resource,
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L56
    sprintingUUID: '662a6b8d-da3e-4c1c-8813-96ea6097278d',
    // default slipperiness * friction
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L1719C30-L1719C39
    magicFriction: f32(0.546),
    // seems like a different value is used for water??
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L1719C28-L1719C38
    magicFrictionWater: f32(0.54600006),
    magicFrictionCubed: f32(0.16277136),
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/block/BlockSoulSand.java#L30
    soulsandSpeed: 0.4,
    flowConstant: 0.014,
    jumpBoostConstant: f32(0.1),
    airSprintConstant: f32(0.2),
    waterGravity: 0.02,
    lavaGravity: 0.02,
    moveMultiplier: f32(0.98),
    striderConstant: f32(0.5)
  }

  const waterIds = [blocksByName.water.id, blocksByName.flowing_water ? blocksByName.flowing_water.id : -1]
  const lavaIds = [blocksByName.lava.id, blocksByName.flowing_lava ? blocksByName.flowing_lava.id : -1]
  const liquidIds = waterIds.concat(lavaIds)
  const blockSlipperiness = {}
  const slimeBlockId = blocksByName.slime_block ? blocksByName.slime_block.id : blocksByName.slime.id
  blockSlipperiness[slimeBlockId] = f32(0.8)
  blockSlipperiness[blocksByName.ice.id] = f32(0.98)
  blockSlipperiness[blocksByName.packed_ice.id] = f32(0.98)

  const soulsandId = blocksByName.soul_sand.id
  const webId = blocksByName.cobweb ? blocksByName.cobweb.id : blocksByName.web.id
  const ladderId = blocksByName.ladder.id
  const vineId = blocksByName.vine.id

  function getPlayerBB (pos) {
    const w = physics.playerHalfWidth
    return new AABB(-w, 0, -w, w, physics.playerHeight, w).offset(pos.x, pos.y, pos.z)
  }

  function resetPositionToBB (bb, pos) {
    pos.x = (bb.minX + bb.maxX) / 2.0
    pos.y = bb.minY
    pos.z = (bb.minZ + bb.maxZ) / 2.0
  }

  const wallIds = new IntSet([
    'cobblestone_wall'
  ].map(nameToId))

  const fenceIds = new IntSet([
    'fence',
    'spruce_fence',
    'birch_fence',
    'jungle_fence',
    'acacia_fence',
    'dark_oak_fence',
    'nether_brick_fence',
  ].map(nameToId))

  const fenceGateIds = new IntSet([
    'fence_gate',
    'spruce_fence_gate',
    'birch_fence_gate',
    'jungle_fence_gate',
    'acacia_fence_gate',
    'dark_oak_fence_gate',
  ].map(nameToId))

  const stairIds = new IntSet([
    'oak_stairs',
    'stone_stairs',
    'brick_stairs',
    'stone_brick_stairs',
    'nether_brick_stairs',
    'sandstone_stairs',
    'spruce_stairs',
    'birch_stairs',
    'jungle_stairs',
    'quartz_stairs',
    'acacia_stairs',
    'dark_oak_stairs',
    'red_sandstone_stairs',
  ].map(nameToId))

  const glassPaneIds = new IntSet([
    'glass_pane',
    'stained_glass_pane',
  ].map(nameToId))

  function nameToId (name) {
    const block = mcData.blocksByName[name]
    if (!block) throw new Error(`Block not found: ${name}`)
    return block.id
  }

  const CARDINAL = [
    // north -z
    new Vec3(0, 0, -1),
    // east +x
    new Vec3(1, 0, 0),
    // south +z
    new Vec3(0, 0, 1),
    // west -x
    new Vec3(-1, 0, 0)
  ]

  function updateWallBB (connectDirection, boundingBox) {
    switch (connectDirection) {
      case 0: // north
        boundingBox[0][2] = 0.0
        break
      case 1: // east
        boundingBox[0][3] = 1.0
        break
      case 2: // south
        boundingBox[0][5] = 1.0
        break
      case 3: // west
        boundingBox[0][0] = 0.0
        break
    }
  }

  function updateFenceBB (connectDirection, boundingBox) {
    switch (connectDirection) {
      case 0: // north (-z)
        // extends from center to full north edge
        boundingBox.push([0.375, 0.0, 0.0, 0.625, 1.5, 0.375])
        break
      case 1: // east (+x)
        // extends from center to full east edge
        boundingBox.push([0.625, 0.0, 0.375, 1.0, 1.5, 0.625])
        break
      case 2: // south (+z)
        // extends from center to full south edge
        boundingBox.push([0.375, 0.0, 0.625, 0.625, 1.5, 1.0])
        break
      case 3: // west (-x)
        // extends from center to full west edge
        boundingBox.push([0.0, 0.0, 0.375, 0.375, 1.5, 0.625])
        break
    }
  }

  function computeWallBB (world, origin) {
    const baseBoundingBox = [[0.25, 0.0, 0.25, 0.75, 1.5, 0.75]]

    // check north, east, south, west for neighboring walls to connect to
    for (let i = 0; i < CARDINAL.length; i++) {
      // update the wall properties and the bounding box
      const neighborBlock = world.getBlock(origin.plus(CARDINAL[i]))
      if (!neighborBlock || !wallIds.has(neighborBlock.type)) continue
      updateWallBB(i, baseBoundingBox)
    }
    return baseBoundingBox
  }

  function computeFenceBB (world, origin) {
    const baseBoundingBox = [[0.375, 0.0, 0.375, 0.625, 1.5, 0.625]]
    for (let i = 0; i < CARDINAL.length; i++) {
      // update the fence properties and the bounding box
      const neighborBlock = world.getBlock(origin.plus(CARDINAL[i]))
      if (!neighborBlock || (!fenceIds.has(neighborBlock.type) && !fenceGateIds.has(neighborBlock.type))) continue
      updateFenceBB(i, baseBoundingBox)
    }
    return baseBoundingBox
  }

  function rotateY (facing, right = true) {
    // 0=north, 1=east, 2=south, 3=west
    return right ? (facing + 1) % 4 : (facing + 3) % 4
  }

  const FACING_MAP = {
    north: 0,
    east: 1,
    south: 2,
    west: 3
  }

  function getFacing (block) {
    const facing = block._properties.facing
    return FACING_MAP[facing]
  }

  function isTopHalf (block) {
    return block._properties.half === 'top'
  }

  /**
   * Compute stair shape: straight / inner_left / inner_right / outer_left / outer_right
   */
  function computeStairShape (world, pos, facing, halfTop) {
    const forwardPos = pos.plus(CARDINAL[facing])
    const backPos = pos.minus(CARDINAL[facing])
    const forward = world.getBlock(forwardPos)
    const back = world.getBlock(backPos)

    function sameHalf (block) {
      return block && stairIds.has(block.type) && isTopHalf(block) === halfTop
    }

    // ---- OUTER CORNERS ----
    if (forward && sameHalf(forward)) {
      const nfacing = getFacing(forward)
      if (nfacing === rotateY(facing, false)) return 'outer_left'
      if (nfacing === rotateY(facing, true)) return 'outer_right'
    }

    // ---- INNER CORNERS ----
    if (back && sameHalf(back)) {
      const nfacing = getFacing(back)
      if (nfacing === rotateY(facing, false)) return 'inner_left'
      if (nfacing === rotateY(facing, true)) return 'inner_right'
    }

    return 'straight'
  }

  /**
   * Compute AABBs for a stair block
   */
  function computeStairBB (world, pos, block) {
    const facing = getFacing(block)
    const halfTop = isTopHalf(block)
    const shape = computeStairShape(world, pos, facing, halfTop)

    const baseY = halfTop ? 0.5 : 0.0
    const topY = halfTop ? 1.0 : 0.5
    const stepYMin = halfTop ? 0.0 : 0.5
    const stepYMax = halfTop ? 0.5 : 1.0

    const boxes = []

    // --- STRAIGHT / BASE STEP ---
    if (shape === 'straight') {
      boxes.push(...straightBoxes(facing, baseY, topY, stepYMin, stepYMax))
    }

    // --- OUTER CORNERS (convex) ---
    else if (shape === 'outer_left' || shape === 'outer_right') {
      boxes.push(...outerCornerBoxes(shape, facing, baseY, topY, stepYMin, stepYMax))
    }

    // --- INNER CORNERS (concave) ---
    else if (shape === 'inner_left' || shape === 'inner_right') {
      boxes.push(...innerCornerBoxes(shape, facing, baseY, topY, stepYMin, stepYMax))
    }

    return boxes
  }

  // === Base geometry tables ===
  // Straight stairs (two parts)
  function straightBoxes (facing, baseY, topY, stepYMin, stepYMax) {
    switch (facing) {
      case 0: // north
        return [
          [0, baseY, 0.5, 1, topY, 1],
          [0, stepYMin, 0, 1, stepYMax, 0.5]
        ]
      case 1: // east
        return [
          [0, baseY, 0, 1, topY, 1],
          [0.5, stepYMin, 0, 1, stepYMax, 1]
        ]
      case 2: // south
        return [
          [0, baseY, 0, 1, topY, 1],
          [0, stepYMin, 0.5, 1, stepYMax, 1]
        ]
      case 3: // west
        return [
          [0.5, baseY, 0, 1, topY, 1],
          [0, stepYMin, 0, 0.5, stepYMax, 1]
        ]
    }
  }

  // Outer corners (smaller L-shape)
  function outerCornerBoxes (shape, facing, baseY, topY, stepYMin, stepYMax) {
    const right = shape === 'outer_right'
    switch (facing) {
      case 0: // north
        return right
          ? [
            [0, baseY, 0.5, 1, topY, 1],
            [0.5, stepYMin, 0, 1, stepYMax, 0.5]
          ]
          : [
            [0, baseY, 0.5, 1, topY, 1],
            [0, stepYMin, 0, 0.5, stepYMax, 0.5]
          ]
      case 1: // east
        return right
          ? [
            [0, baseY, 0, 1, topY, 1],
            [0.5, stepYMin, 0.5, 1, stepYMax, 1]
          ]
          : [
            [0, baseY, 0, 1, topY, 1],
            [0.5, stepYMin, 0, 1, stepYMax, 0.5]
          ]
      case 2: // south
        return right
          ? [
            [0, baseY, 0, 1, topY, 1],
            [0, stepYMin, 0.5, 0.5, stepYMax, 1]
          ]
          : [
            [0, baseY, 0, 1, topY, 1],
            [0.5, stepYMin, 0.5, 1, stepYMax, 1]
          ]
      case 3: // west
        return right
          ? [
            [0.5, baseY, 0, 1, topY, 1],
            [0, stepYMin, 0, 0.5, stepYMax, 0.5]
          ]
          : [
            [0.5, baseY, 0, 1, topY, 1],
            [0, stepYMin, 0.5, 0.5, stepYMax, 1]
          ]
    }
  }

  // Inner corners (concave) — base + two step strips
  function innerCornerBoxes (shape, facing, baseY, topY, stepYMin, stepYMax) {
    const left = shape === 'inner_left'
    switch (facing) {
      case 0: // north (front = z[0..0.5], left = west x[0..0.5], right = east x[0.5..1])
        return left
          ? [
            // base slab (back half)
            [0, baseY, 0.5, 1, topY, 1],
            // facing strip (north/front)
            [0, stepYMin, 0, 1, stepYMax, 0.5],
            // side strip (west/left)
            [0, stepYMin, 0, 0.5, stepYMax, 1],
          ]
          : [
            [0, baseY, 0.5, 1, topY, 1],
            [0, stepYMin, 0, 1, stepYMax, 0.5],
            // side strip (east/right)
            [0.5, stepYMin, 0, 1, stepYMax, 1],
          ]

      case 1: // east (front = x[0.5..1], left = north z[0..0.5], right = south z[0.5..1])
        return left
          ? [
            // base slab (match your straight base for east = full slab)
            [0, baseY, 0, 1, topY, 1],
            // facing strip (east/front)
            [0.5, stepYMin, 0, 1, stepYMax, 1],
            // side strip (north/left)
            [0, stepYMin, 0, 1, stepYMax, 0.5],
          ]
          : [
            [0, baseY, 0, 1, topY, 1],
            [0.5, stepYMin, 0, 1, stepYMax, 1],
            // side strip (south/right)
            [0, stepYMin, 0.5, 1, stepYMax, 1],
          ]

      case 2: // south (front = z[0.5..1], left = east x[0.5..1], right = west x[0..0.5])
        return left
          ? [
            // base slab (match your straight base for south = full slab)
            [0, baseY, 0, 1, topY, 1],
            // facing strip (south/front)
            [0, stepYMin, 0.5, 1, stepYMax, 1],
            // side strip (east/left)
            [0.5, stepYMin, 0, 1, stepYMax, 1],
          ]
          : [
            [0, baseY, 0, 1, topY, 1],
            [0, stepYMin, 0.5, 1, stepYMax, 1],
            // side strip (west/right)
            [0, stepYMin, 0, 0.5, stepYMax, 1],
          ]

      case 3: // west (front = x[0..0.5], left = south z[0.5..1], right = north z[0..0.5])
        return left
          ? [
            // base slab (your straight base for west = x[0.5..1])
            [0.5, baseY, 0, 1, topY, 1],
            // facing strip (west/front)
            [0, stepYMin, 0, 0.5, stepYMax, 1],
            // side strip (south/left)
            [0, stepYMin, 0.5, 1, stepYMax, 1],
          ]
          : [
            [0.5, baseY, 0, 1, topY, 1],
            [0, stepYMin, 0, 0.5, stepYMax, 1],
            // side strip (north/right)
            [0, stepYMin, 0, 1, stepYMax, 0.5],
          ]
    }
  }

  const glassPaneCanConnect = new IntSet(['glass', 'stained_glass'].map(nameToId))

  function computePaneBB (world, origin) {
    const baseBoxes = []

    // Helper: determines if a glass pane connects to the given neighbor
    function canConnect (block) {
      if (!block) return false
      if (glassPaneIds.has(block.type) || glassPaneCanConnect.has(block.type)) return true
      if (block.boundingBox && block.boundingBox !== 'empty') return block.boundingBox !== 'empty'
      return false
    }

    // Get neighboring blocks
    const neighbors = CARDINAL.map(dir => world.getBlock(origin.plus(dir)))
    const [north, east, south, west] = neighbors

    const canConnectNorth = canConnect(north)
    const canConnectEast = canConnect(east)
    const canConnectSouth = canConnect(south)
    const canConnectWest = canConnect(west)
    const anyConnection = canConnectNorth || canConnectEast || canConnectSouth || canConnectWest

    // Handle east/west axis
    if ((!canConnectWest || !canConnectEast) && anyConnection) {
      if (canConnectWest) {
        baseBoxes.push([0.0, 0.0, 0.4375, 0.5, 1.0, 0.5625])
      } else if (canConnectEast) {
        baseBoxes.push([0.5, 0.0, 0.4375, 1.0, 1.0, 0.5625])
      }
    } else {
      // Either both connected or neither connected — add full NS plane
      baseBoxes.push([0.0, 0.0, 0.4375, 1.0, 1.0, 0.5625])
    }

    // Handle north/south axis
    if ((!canConnectNorth || !canConnectSouth) && anyConnection) {
      if (canConnectNorth) {
        baseBoxes.push([0.4375, 0.0, 0.0, 0.5625, 1.0, 0.5])
      } else if (canConnectSouth) {
        baseBoxes.push([0.4375, 0.0, 0.5, 0.5625, 1.0, 1.0])
      }
    } else {
      // Either both connected or neither connected — add full EW plane
      baseBoxes.push([0.4375, 0.0, 0.0, 0.5625, 1.0, 1.0])
    }

    return baseBoxes
  }

  const snowLayerId = blocksByName.snow_layer.id

  function getSurroundingBBs (world, queryBB) {
    const surroundingBBs = []
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(queryBB.minY) - 1; cursor.y <= Math.floor(queryBB.maxY); cursor.y++) {
      for (cursor.z = Math.floor(queryBB.minZ); cursor.z <= Math.floor(queryBB.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(queryBB.minX); cursor.x <= Math.floor(queryBB.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (block) {
            const blockPos = block.position
            let shapes = block.shapes
            if (wallIds.has(block.type)) {
              shapes = computeWallBB(world, blockPos)
            } else if (stairIds.has(block.type)) {
              shapes = computeStairBB(world, blockPos, block)
            } else if (fenceIds.has(block.type)) {
              shapes = computeFenceBB(world, blockPos)
            } else if (glassPaneIds.has(block.type)) {
              shapes = computePaneBB(world, blockPos)
            } else if (block.type === snowLayerId && block._properties.layers === 8) {
              const blockAbove = world.getBlock(blockPos.offset(0, 1, 0))
              if (blockAbove && blockAbove.type === snowLayerId) {
                shapes = [[0, 0, 0, 1, 1, 1]]
              }
            }
            for (const shape of shapes) {
              const blockBB = new AABB(shape[0], shape[1], shape[2], shape[3], shape[4], shape[5])
              blockBB.offset(blockPos.x, blockPos.y, blockPos.z)
              surroundingBBs.push(blockBB)
            }
          }
        }
      }
    }
    return surroundingBBs
  }

  // run one tick of player simulation
  // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L1948
  physics.simulatePlayer = (playerState, world) => {
    const { motion, pos } = playerState
    if (playerState.jumpTicks > 0) playerState.jumpTicks--
    if (!isNaN(playerState.yaw)) {
      playerState.yawDegrees = f32((Math.PI - playerState.yaw) * RAD_TO_DEG)
    }
    if (!isNaN(playerState.pitch)) {
      playerState.pitchDegrees = f32(-playerState.pitch * RAD_TO_DEG)
    }

    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/Entity.java#L1111
    const waterBB = getPlayerBB(pos).contract(
      0.001,
      f32(0.400),
      0.001
    )

    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/Entity.java#L1216
    const lavaBB = getPlayerBB(pos).contract(
      f32(0.1),
      f32(0.4),
      f32(0.1)
    )

    playerState.isInWater = isInWaterApplyCurrent(world, waterBB, motion)
    playerState.isInLava = isMaterialInBB(world, lavaBB, lavaIds)

    // Reset velocity component if it falls under the threshold
    if (Math.abs(motion.x) < physics.negligeableVelocity) motion.x = 0.0
    if (Math.abs(motion.y) < physics.negligeableVelocity) motion.y = 0.0
    if (Math.abs(motion.z) < physics.negligeableVelocity) motion.z = 0.0

    // Handle inputs
    if (playerState.control.jump || playerState.jumpQueued) {
      // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L1589
      if (playerState.isInWater || playerState.isInLava) {
        motion.y += physics.liquidMotionY
      } else if (playerState.onGround && playerState.jumpTicks === 0) {
        motion.y = physics.jumpMotionY
        if (playerState.jumpBoost > 0) {
          // compliance: can do += here, because it takes the double representation of the f32mul
          motion.y += f32mul(f32(playerState.jumpBoost), physics.jumpBoostConstant)
        }
        let forward = (playerState.control.forward - playerState.control.back)
        const isSprintingApplicable = forward > 0 && !playerState.control.sneak && !playerState.isInWater && !playerState.isInLava
        if (playerState.control.sprint && isSprintingApplicable) {
          // notchian yaw is inverted
          const notchianYaw = f32mul(playerState.yawDegrees, DEG_TO_RAD)
          // compliance: can do -= and += here, because it also takes the double representation of the f32mul
          motion.x -= f32mul(f32sin(notchianYaw), physics.airSprintConstant)
          motion.z += f32mul(f32cos(notchianYaw), physics.airSprintConstant)
        }
        playerState.jumpTicks = physics.autojumpCooldown
      }
    } else {
      playerState.jumpTicks = 0 // reset autojump cooldown
    }
    playerState.jumpQueued = false

    // movestrafing and moveforward are in range [-1.0, 1.0], already stored as F32
    let moveStrafing = f32(playerState.control.right - playerState.control.left)
    let moveForward = f32(playerState.control.forward - playerState.control.back)

    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/util/MovementInputFromOptions.java#L42C1-L46C10
    if (playerState.control.sneak) {
      moveStrafing = f32(moveStrafing * physics.sneakSpeed)
      moveForward = f32(moveForward * physics.sneakSpeed)
    }

    moveStrafing = f32mul(moveStrafing, physics.moveMultiplier)
    moveForward = f32mul(moveForward, physics.moveMultiplier)

    moveEntityWithHeading(playerState, world, moveStrafing, moveForward)

    return playerState
  }

  function moveEntity (playerState, world, dx, dy, dz) {
    const { motion, pos } = playerState

    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/Entity.java#L612
    if (playerState.isInWeb) {
      playerState.isInWeb = false
      // compliance: double * double
      dx *= 0.25
      dy *= f32(0.05)
      dz *= 0.25
      motion.x = 0.0
      motion.y = 0.0
      motion.z = 0.0
    }

    let oldVelX = dx
    let oldVelY = dy
    let oldVelZ = dz

    const validSneak = playerState.control.sneak && playerState.onGround

    if (validSneak) {
      const step = 0.05

      for (; dx !== 0 && getSurroundingBBs(world, getPlayerBB(pos).offset(dx, -1.0, 0)).length === 0; oldVelX = dx) {
        if (dx < step && dx >= -step) dx = 0
        else if (dx > 0) dx -= step
        else dx += step
      }

      for (; dz !== 0 && getSurroundingBBs(world, getPlayerBB(pos).offset(0, -1.0, dz)).length === 0; oldVelZ = dz) {
        if (dz < step && dz >= -step) dz = 0
        else if (dz > 0) dz -= step
        else dz += step
      }

      for (; dx !== 0 && dz !== 0 && getSurroundingBBs(world, getPlayerBB(pos).offset(dx, -1.0, dz)).length === 0; oldVelZ = dz) {
        if (dx < step && dx >= -step) dx = 0
        else if (dx > 0) dx -= step
        else dx += step

        // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/Entity.java#L679
        oldVelX = dx

        if (dz < step && dz >= -step) dz = 0
        else if (dz > 0) dz -= step
        else dz += step
      }
    }

    let playerBB = getPlayerBB(pos)
    const queryBB = playerBB.clone().extend(dx, dy, dz)
    const surroundingBBs = getSurroundingBBs(world, queryBB)
    const oldBB = playerBB.clone()

    for (const blockBB of surroundingBBs) {
      dy = blockBB.computeOffsetY(playerBB, dy)
    }

    playerBB.offset(0, dy, 0)

    for (const blockBB of surroundingBBs) {
      dx = blockBB.computeOffsetX(playerBB, dx)
    }
    playerBB.offset(dx, 0, 0)

    for (const blockBB of surroundingBBs) {
      dz = blockBB.computeOffsetZ(playerBB, dz)
    }

    playerBB.offset(0, 0, dz)

    const onGroundFlag = (playerState.onGround || (oldVelY !== dy && oldVelY < 0))

    // Step on block if height < stepHeight
    if (physics.stepHeight > 0 && onGroundFlag && (oldVelX !== dx || oldVelZ !== dz)) {
      const oldVelXCol = dx
      const oldVelYCol = dy
      const oldVelZCol = dz
      const AABB3 = playerBB.clone()
      dy = physics.stepHeight

      const surroundingBBs = getSurroundingBBs(world, oldBB.clone().extend(oldVelX, dy, oldVelZ))
      const AABB4 = oldBB.clone()
      const AABB5 = AABB4.clone().extend(oldVelX, 0, oldVelZ)

      let dy1 = dy
      for (const blockBB of surroundingBBs) {
        dy1 = blockBB.computeOffsetY(AABB5, dy1)
      }
      AABB4.offset(0, dy1, 0)

      let dx1 = oldVelX
      for (const blockBB of surroundingBBs) {
        dx1 = blockBB.computeOffsetX(AABB4, dx1)
      }
      AABB4.offset(dx1, 0, 0)

      let dz1 = oldVelZ
      for (const blockBB of surroundingBBs) {
        dz1 = blockBB.computeOffsetZ(AABB4, dz1)
      }
      AABB4.offset(0, 0, dz1)

      const AABB14 = oldBB.clone()

      let dy2 = dy
      for (const blockBB of surroundingBBs) {
        dy2 = blockBB.computeOffsetY(AABB14, dy2)
      }
      AABB14.offset(0, dy2, 0)

      let dx2 = oldVelX
      for (const blockBB of surroundingBBs) {
        dx2 = blockBB.computeOffsetX(AABB14, dx2)
      }
      AABB14.offset(dx2, 0, 0)

      let dz2 = oldVelZ
      for (const blockBB of surroundingBBs) {
        dz2 = blockBB.computeOffsetZ(AABB14, dz2)
      }
      AABB14.offset(0, 0, dz2)

      // compliance: javadouble mult
      const norm1 = dx1 * dx1 + dz1 * dz1
      const norm2 = dx2 * dx2 + dz2 * dz2

      if (norm1 > norm2) {
        dx = dx1
        dz = dz1
        dy = -dy1
        playerBB = AABB4
      } else {
        dx = dx2
        dz = dz2
        dy = -dy2
        playerBB = AABB14
      }
      for (const blockBB of surroundingBBs) {
        dy = blockBB.computeOffsetY(playerBB, dy)
      }
      playerBB.offset(0, dy, 0)

      // compliance: javadouble mult
      if (oldVelXCol * oldVelXCol + oldVelZCol * oldVelZCol >= dx * dx + dz * dz) {
        dx = oldVelXCol
        dy = oldVelYCol
        dz = oldVelZCol
        playerBB = AABB3
      }
    }

    // Update position (finally!)
    resetPositionToBB(playerBB, pos)

    playerState.isCollidedHorizontally = dx !== oldVelX || dz !== oldVelZ
    playerState.isCollidedVertically = dy !== oldVelY
    playerState.onGround = playerState.isCollidedVertically && oldVelY < 0

    let blockPos = pos.offset(0, -0.2, 0).floored()
    let blockAtFeet = world.getBlock(blockPos)

    if (blockAtFeet?.type === 0) {
      const downBlock = world.getBlock(blockPos.offset(0, -1, 0))

      if (wallIds.has(downBlock.type) || fenceIds.has(downBlock.type) || fenceGateIds.has(downBlock.type)) {
        blockAtFeet = downBlock
      }
    }

    // check if a collision happened in any of these directions
    if (dx !== oldVelX) {
      motion.x = 0.0
    }
    if (dz !== oldVelZ) {
      motion.z = 0.0
    }
    if (dy !== oldVelY) {
      if (blockAtFeet && blockAtFeet.type === slimeBlockId && !playerState.control.sneak) {
        motion.y = -motion.y
      } else {
        motion.y = 0
      }
    }

    // Finally, apply block collisions (web, soulsand...)
    doBlockCollisions(playerState)
  }

  function doBlockCollisions (playerState) {
    const { motion, pos } = playerState
    const playerBB = getPlayerBB(pos)
    playerBB.contract(0.001, 0.001, 0.001)
    const cursor = new Vec3(0, 0, 0)
    for (cursor.x = Math.floor(playerBB.minX); cursor.x <= Math.floor(playerBB.maxX); cursor.x++) {
      for (cursor.y = Math.floor(playerBB.minY); cursor.y <= Math.floor(playerBB.maxY); cursor.y++) {
        for (cursor.z = Math.floor(playerBB.minZ); cursor.z <= Math.floor(playerBB.maxZ); cursor.z++) {
          const block = world.getBlock(cursor)
          if (block) {
            if (block.type === soulsandId) {
              motion.x *= physics.soulsandSpeed
              motion.z *= physics.soulsandSpeed
            } else if (block.type === webId) {
              playerState.isInWeb = true
            }
          }
        }
      }
    }
  }

  // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/Entity.java#L1224
  function moveFlying (playerState, moveStrafe, moveForward, friction) {
    const { motion } = playerState

    const speedSquared = f32add(f32mul(moveStrafe, moveStrafe), f32mul(moveForward, moveForward))

    if (speedSquared >= physics.negligeableFlyingSpeed) {
      let speed = f32(Math.sqrt(speedSquared))
      if (speed < f32(1.0)) {
        speed = f32(1.0)
      }
      speed = f32div(friction, speed)
      moveStrafe = f32mul(moveStrafe, speed)
      moveForward = f32mul(moveForward, speed)

      const sin = f32sin(f32mul(playerState.yawDegrees, DEG_TO_RAD))
      const cos = f32cos(f32mul(playerState.yawDegrees, DEG_TO_RAD))
      // compliance: can do += and -= here, because it also takes the double representation of the f32mul
      motion.x += f32sub(f32mul(moveStrafe, cos), f32mul(moveForward, sin))
      motion.z += f32add(f32mul(moveForward, cos), f32mul(moveStrafe, sin))
    }
  }

  function isOnLadder (world, pos) {
    const block = world.getBlock(pos)
    if (!block) {
      return false
    }
    return block.type === ladderId || block.type === vineId

  }

  function isOffsetPositionInLiquid (world, pos) {
    const pBB = getPlayerBB(pos)
    return !getSurroundingBBs(world, pBB).some(x => pBB.intersects(x))
      // any materialliquid, which is lava and water
      && !isMaterialInBB(world, pBB, liquidIds)
  }

  function moveEntityWithHeading (playerState, world, strafe, forward) {
    const { motion, pos } = playerState

    let playerSpeedAttribute
    if (playerState.attributes && playerState.attributes[physics.movementSpeedAttribute]) {
      // Use server-side player attributes
      playerSpeedAttribute = playerState.attributes[physics.movementSpeedAttribute]
    } else {
      // Create an attribute if the player does not have it
      playerSpeedAttribute = attribute.createAttributeValue(physics.playerSpeed)
    }
    // Client-side sprinting (don't rely on server-side sprinting)
    // setSprinting in LivingEntity.java
    playerSpeedAttribute = attribute.deleteAttributeModifier(playerSpeedAttribute, physics.sprintingUUID) // always delete sprinting (if it exists)

    const isSprintingApplicable = forward > 0 && !playerState.control.sneak && !playerState.isInWater && !playerState.isInLava
    if (playerState.control.sprint && isSprintingApplicable && !attribute.checkAttributeModifier(playerSpeedAttribute, physics.sprintingUUID)) {
      playerSpeedAttribute = attribute.addAttributeModifier(playerSpeedAttribute, {
        uuid: physics.sprintingUUID,
        amount: physics.sprintSpeed,
        operation: 2
      })
    }

    const attributeSpeed = f32(attribute.getAttributeValue(playerSpeedAttribute))

    if (playerState.isInWater) {
      // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L1701
      const lastY = pos.y
      let inertia = physics.waterInertia
      let acceleration = physics.baseLiquidAcceleration
      let strider = f32(Math.min(playerState.depthStrider, 3))

      if (!playerState.onGround) {
        strider = f32mul(strider, physics.striderConstant)
      }

      if (strider > 0.0) {
        inertia = f32add(inertia,
          f32div(f32mul(f32sub(physics.magicFrictionWater, inertia), strider), f32(3.0))
        )
        acceleration = f32add(acceleration,
          f32div(f32mul(f32sub(attributeSpeed, acceleration), strider), f32(3.0))
        )
      }

      moveFlying(playerState, strafe, forward, acceleration)
      moveEntity(playerState, world, motion.x, motion.y, motion.z)

      motion.x *= inertia
      motion.y *= physics.waterInertia
      motion.z *= inertia
      motion.y -= physics.waterGravity
      if (playerState.isCollidedHorizontally && isOffsetPositionInLiquid(world, pos.offset(motion.x, motion.y + 0.6 - pos.y + lastY, motion.z))) {
        motion.y = physics.outOfLiquidImpulse
      }
    } else if (playerState.isInLava) {
      const lastY = pos.y
      moveFlying(playerState, strafe, forward, physics.baseLiquidAcceleration)
      moveEntity(playerState, world, motion.x, motion.y, motion.z)
      motion.x *= physics.lavaInertia
      motion.y *= physics.lavaInertia
      motion.z *= physics.lavaInertia
      motion.y *= physics.lavaGravity
      if (playerState.isCollidedHorizontally && isOffsetPositionInLiquid(world, pos.offset(motion.x, motion.y + 0.6 - pos.y + lastY, motion.z))) {
        motion.y = physics.outOfLiquidImpulse
      }
    } else {
      // Normal movement
      let inertia = physics.airborneInertia
      if (playerState.onGround) {
        const blockUnder = world.getBlock(pos.floored().offset(0, -1, 0))
        const slipperiness = blockUnder?.type && typeof blockSlipperiness[blockUnder.type] === 'number' ?
          blockSlipperiness[blockUnder.type] : physics.defaultSlipperiness
        inertia = f32mul(slipperiness, physics.airborneInertia)
      }

      const accelerationScale = f32div(physics.magicFrictionCubed, f32mul(inertia, f32mul(inertia, inertia)))
      // todo: change attributespeed to be javafloat
      let acceleration
      if (playerState.onGround) {
        acceleration = f32mul(attributeSpeed, accelerationScale)
      } else {
        // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/player/EntityPlayer.java#L631
        let jumpMovementFactor = physics.airborneAcceleration
        const isSprintingApplicable = forward > 0 && !playerState.control.sneak && !playerState.isInWater && !playerState.isInLava
        if (playerState.control.sprint && isSprintingApplicable) {
          jumpMovementFactor = f32(
            jumpMovementFactor + physics.airborneAcceleration * 0.3
          )
        }
        acceleration = jumpMovementFactor
      }

      moveFlying(playerState, strafe, forward, acceleration)

      if (isOnLadder(world, pos)) {
        motion.x = clamp(-physics.ladderMaxSpeed, motion.x, physics.ladderMaxSpeed)
        motion.z = clamp(-physics.ladderMaxSpeed, motion.z, physics.ladderMaxSpeed)
        if (motion.y < -physics.ladderClimbSpeed) {
          // clone it
          motion.y = -physics.ladderClimbSpeed
        }
        if (playerState.control.sneak && motion.y < 0) {
          motion.y = 0
        }
      }

      moveEntity(playerState, world, motion.x, motion.y, motion.z)

      if (isOnLadder(world, pos) && (playerState.isCollidedHorizontally ||
        (supportFeature('climbUsingJump') && playerState.control.jump))) {
        // EntityLivingBase sets motionY = 0.2D after the move. 0.15 is only the
        // pre-move fall clamp above. Gravity and air drag then leave 0.1176.
        motion.y = 0.2
      }

      // unloaded chunks 1.8 behavior
      // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/EntityLivingBase.java#L1664
      if (!world.getBlock(new Vec3(pos.x, 0, pos.z).floored())) {
        if (pos.y > 0) {
          motion.y = -0.1
        } else {
          motion.y = 0
        }
      } else {
        motion.y -= physics.gravity
      }

      motion.y *= physics.airdrag
      motion.x *= inertia
      motion.z *= inertia
    }
  }

  function isMaterialInBB (world, queryBB, types) {
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(queryBB.minY); cursor.y <= Math.floor(queryBB.maxY); cursor.y++) {
      for (cursor.z = Math.floor(queryBB.minZ); cursor.z <= Math.floor(queryBB.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(queryBB.minX); cursor.x <= Math.floor(queryBB.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (block && types.includes(block.type)) return true
        }
      }
    }
    return false
  }

  function getLiquidHeightPcent (block) {
    return (getRenderedDepth(block) + 1) / 9
  }

  function getRenderedDepth (block) {
    if (!block) return -1
    if (block.isWaterlogged) return 0
    if (!waterIds.includes(block.type)) return -1
    const meta = block.metadata
    return meta >= 8 ? 0 : meta
  }

  function getFlow (world, block) {
    const pos = block.position
    const curLevel = getRenderedDepth(block)
    const flow = new Vec3(0.0, 0.0, 0.0)

    const directions = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ]

    for (const [dx, dz] of directions) {
      const adjPos = pos.offset(dx, 0, dz)
      const adjBlock = world.getBlock(adjPos)
      let adjLevel = getRenderedDepth(adjBlock)

      if (adjLevel < 0) {
        // block is "solid" if it blocks movement (non-empty bbox)
        const adjBlockStateSolid = adjBlock && adjBlock.boundingBox !== 'empty'
        if (!adjBlockStateSolid) {
          const belowBlock = world.getBlock(adjPos.offset(0, -1, 0))
          adjLevel = getRenderedDepth(belowBlock)
          if (adjLevel >= 0) {
            const k = adjLevel - (curLevel - 8)
            flow.x += dx * k
            flow.z += dz * k
          }
        }
      } else {
        const l = adjLevel - curLevel
        flow.x += dx * l
        flow.z += dz * l
      }
    }

    // Falling water handling
    if (block.metadata >= 8) {
      for (const [dx, dz] of directions) {
        const side = pos.offset(dx, 0, dz)
        const sideUp = pos.offset(dx, 1, dz)
        const sideBlock = world.getBlock(side)
        const sideUpBlock = world.getBlock(sideUp)
        const solidSide = (sideBlock && sideBlock.boundingBox !== 'empty')
        const solidUp = (sideUpBlock && sideUpBlock.boundingBox !== 'empty')
        if (solidSide || solidUp) {
          flow.normalize()
          flow.y += -6.0
          break // only apply once!
        }
      }
    }

    return flow.normalize()
  }

  // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/world/World.java#L2077
  function isInWaterApplyCurrent (world, bb, motion) {
    const minX = Math.floor(bb.minX)
    const maxX = Math.floor(bb.maxX + 1)
    const minY = Math.floor(bb.minY)
    const maxY = Math.floor(bb.maxY + 1)
    const minZ = Math.floor(bb.minZ)
    const maxZ = Math.floor(bb.maxZ + 1)

    // Always assume area loaded
    let flag = false
    let vec3 = new Vec3(0.0, 0.0, 0.0)
    const cursor = new Vec3(0, 0, 0)

    for (cursor.x = minX; cursor.x < maxX; cursor.x++) {
      for (cursor.y = minY; cursor.y < maxY; cursor.y++) {
        for (cursor.z = minZ; cursor.z < maxZ; cursor.z++) {
          const block = world.getBlock(cursor)
          if (!block) continue
          if (waterIds.includes(block.type)) {
            const liquidHeight = (cursor.y + 1) - getLiquidHeightPcent(block)

            if (bb.maxY >= liquidHeight) {
              flag = true
              // equivalent to Block.modifyAcceleration(world, pos, entity, vec3)
              const flow = getFlow(world, block)
              vec3.add(flow)
            }
          }
        }
      }
    }

    // todo: technically, should check if entity.isPushedByWater (!this.capabilities.isFlying), but since flying is not implemented, ignore that part
    if (vec3.norm() > 0.0) {
      const normalized = vec3.normalize()
      motion.x += normalized.x * physics.flowConstant
      motion.y += normalized.y * physics.flowConstant
      motion.z += normalized.z * physics.flowConstant
    }

    return flag
  }

  return physics
}

// already accounts for the + 1
function getEffectLevel (mcData, effectName, effects) {
  const effectDescriptor = mcData.effectsByName[effectName]
  if (!effectDescriptor) {
    return 0
  }
  const effectInfo = effects[effectDescriptor.id]
  if (!effectInfo) {
    return 0
  }
  return effectInfo.amplifier + 1
}

function getEnchantmentLevel (mcData, enchantmentName, enchantments) {
  const enchantmentDescriptor = mcData.enchantmentsByName[enchantmentName]
  if (!enchantmentDescriptor) {
    return 0
  }

  for (const enchInfo of enchantments) {
    if (typeof enchInfo.id === 'string') {
      if (enchInfo.id.includes(enchantmentName)) {
        return enchInfo.lvl
      }
    } else if (enchInfo.id === enchantmentDescriptor.id) {
      return enchInfo.lvl
    }
  }
  return 0
}

class PlayerState {
  constructor (bot, control) {
    this.pos = bot.entity.position.clone()
    this.motion = bot.entity.velocity.clone()

    this.onGround = bot.entity.onGround
    this.isInWater = bot.entity.isInWater
    this.isInLava = bot.entity.isInLava
    this.isInWeb = bot.entity.isInWeb
    this.isCollidedHorizontally = bot.entity.isCollidedHorizontally
    this.isCollidedVertically = bot.entity.isCollidedVertically
    this.jumpTicks = bot.jumpTicks
    this.jumpQueued = bot.jumpQueued
    this.fireworkRocketDuration = bot.fireworkRocketDuration

    // Input only (not modified)
    this.attributes = bot.entity.attributes
    // both rotational values in degrees (notchian format). they should be float32 to replicate what the server should receive
    this.yawDegrees = typeof bot.entity.yawDegrees?.valueOf() === 'number' ? f32(bot.entity.yawDegrees) : f32((Math.PI - bot.entity.yaw) * RAD_TO_DEG)
    this.pitchDegrees = typeof bot.entity.pitchDegrees?.valueOf() === 'number' ? f32(bot.entity.pitchDegrees) : f32(-bot.entity.pitch * RAD_TO_DEG)

    this.control = control

    // effects
    const effects = bot.entity.effects
    this.jumpBoost = getEffectLevel(mcData, 'JumpBoost', effects)
    // armour enchantments
    const boots = bot.inventory.slots[8]
    if (boots && boots.nbt) {
      const simplifiedNbt = nbt.simplify(boots.nbt)
      const enchantments = simplifiedNbt.Enchantments ?? simplifiedNbt.ench ?? []
      const enchantmentsMap = boots?.componentMap?.get('enchantments')
      const strider = enchantmentsMap?.data?.enchantments?.find(({ id, level }) => id === 7)
      this.depthStrider = strider ? strider.level : getEnchantmentLevel(mcData, 'depth_strider', enchantments)
    } else {
      this.depthStrider = 0
    }
  }

  apply (bot) {
    bot.entity.position = new Vec3(
      this.pos.x.valueOf(),
      this.pos.y.valueOf(),
      this.pos.z.valueOf()
    )
    bot.entity.velocity = new Vec3(
      this.motion.x.valueOf(),
      this.motion.y.valueOf(),
      this.motion.z.valueOf()
    )
    bot.entity.onGround = this.onGround
    bot.entity.isInWater = this.isInWater
    bot.entity.isInLava = this.isInLava
    bot.entity.isInWeb = this.isInWeb
    bot.entity.isCollidedHorizontally = this.isCollidedHorizontally
    bot.entity.isCollidedVertically = this.isCollidedVertically
    bot.jumpTicks = this.jumpTicks
    bot.jumpQueued = this.jumpQueued
    bot.fireworkRocketDuration = this.fireworkRocketDuration
  }
}

// a fast implementation of only the parts of the prismarine world needed for physics
class FastWorld {
  static #stateToBlock = {}

  static {
    const shapes = mcData.blockCollisionShapes
    const legacyPcBlocksByIdmeta = Object.entries(mcDataRegistry.legacy.pc.blocks).reduce((obj, [idmeta, name]) => {
      const s = name.split('[')[1]?.replace(']', '')
      obj[idmeta] = s
        ? Object.fromEntries(s.split(',').map(s => {
          let [k, v] = s.split('=')
          if (!isNaN(parseInt(v))) v = parseInt(v)
          return [k, v]
        }))
        : {}
      return obj // array of { '255:0': { mode: 'save' }, }
    }, {})

    // 1.8 BlockLadder uses 0.125; minecraft-data ships the later 0.1875 boxes.
    // New arrays so doors and trapdoors that share shape ids 27-30 stay thick.
    const LADDER_18 = {
      27: [[0, 0, 0.875, 1, 1, 1]], // NORTH
      28: [[0, 0, 0, 0.125, 1, 1]], // EAST
      29: [[0, 0, 0, 1, 1, 0.125]], // SOUTH
      30: [[0.875, 0, 0, 1, 1, 1]] // WEST
    }

    for (const stateId in mcData.blocksByStateId) {
      const block = mcData.blocksByStateId[stateId]
      const shapesId = shapes.blocks[block.name]
      const baseShape = (shapesId instanceof Array) ? shapes.shapes[shapesId[0]] : shapes.shapes[shapesId]
      const minStateId = block.minStateId

      let blockShapes = baseShape
      if (shapesId instanceof Array) {
        blockShapes = shapes.shapes[shapesId[stateId - minStateId]]
      }
      if (block.name === 'ladder' && shapesId instanceof Array) {
        blockShapes = LADDER_18[shapesId[stateId - minStateId]] || blockShapes
      }
      if (!blockShapes) {
        console.warn(`No shape for block ${block.name}, stateId ${stateId}!`)
        blockShapes = [[0, 0, 0, 1, 1, 1]]
      }
      // equivalent to stateId % 16 or stateId - minStateId
      const metadata = stateId & 15
      let _properties = legacyPcBlocksByIdmeta[block.id + ':' + metadata] || legacyPcBlocksByIdmeta[block.id + ':0']
      if (!_properties) {
        for (let i = 0; i <= 15; i++) {
          _properties = legacyPcBlocksByIdmeta[block.id + ':' + i]
          if (_properties) break
        }
      }
      if (!_properties) {
        console.warn(`No legacy properties for block ${block.name}, stateId ${stateId}, id:meta ${block.id}:${metadata}`)
      }
      FastWorld.#stateToBlock[stateId] = {
        type: block.id,
        boundingBox: block.boundingBox,
        shapes: blockShapes,
        _properties
      }
    }
  }

  constructor (bot) {
    this.bot = bot
  }

  getBlock (pos) {
    pos = pos.floored()
    const chunk = this.bot.world.getColumnAt(pos)
    if (!chunk) return null
    const section = chunk.getBlockStateId(pos)
    if (section === undefined) return null
    const blockData = FastWorld.#stateToBlock[section]
    if (!blockData) throw new Error(`No block data for state ID ${section}`)
    return {
      ...blockData,
      position: pos,
    }
  }
}

module.exports = { Physics, PlayerState, FastWorld }
