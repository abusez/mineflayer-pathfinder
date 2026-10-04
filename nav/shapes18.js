'use strict'

const { Vec3 } = require('vec3')
const { FastWorld } = require('prismarine-physics')

// Minecraft 1.8.9 block collision boxes: the one table the planner, the
// rollout simulator and the live physics all read, so they agree box for box.
//
// Transcribed from the 1.8.9 client (MCP 9.19, net.minecraft.block.*):
// addCollisionBoxesToList / getCollisionBoundingBox / setBlockBoundsBasedOnState.
// Every value is a multiple of 1/16 or 1/64, so the float maths in the client
// gives exactly these doubles.
//
// Static boxes (one shape list per state id) come from prismarine-physics'
// FastWorld table, which already matches 1.8 for everything checked (slabs,
// snow, carpet, lily pad, farmland, soul sand, cactus, cake, bed, trapdoors,
// fence gates, anvil, hopper, cauldron, brewing stand, end portal frame,
// cocoa, skulls, flower pot, ladders via scripts/patch-physics.js), with the
// 1.8 piston head on top. Blocks whose box depends on their neighbours are
// resolved per position by resolveShapes.

const FULL = [0, 0, 0, 1, 1, 1]

const FAMILY = {
  STATIC: 0,
  FENCE: 1, // BlockFence
  WALL: 2, // BlockWall
  PANE: 3, // BlockPane (glass panes, stained panes, iron bars)
  STAIRS: 4, // BlockStairs
  CHEST: 5, // BlockChest (chest, trapped chest)
  DOOR: 6 // BlockDoor
}

const NAMES = {
  fences: ['fence', 'spruce_fence', 'birch_fence', 'jungle_fence', 'acacia_fence', 'dark_oak_fence', 'nether_brick_fence'],
  gates: ['fence_gate', 'spruce_fence_gate', 'birch_fence_gate', 'jungle_fence_gate', 'acacia_fence_gate', 'dark_oak_fence_gate'],
  walls: ['cobblestone_wall'],
  panes: ['glass_pane', 'stained_glass_pane', 'iron_bars'],
  stairs: ['oak_stairs', 'stone_stairs', 'brick_stairs', 'stone_brick_stairs', 'nether_brick_stairs', 'sandstone_stairs',
    'spruce_stairs', 'birch_stairs', 'jungle_stairs', 'quartz_stairs', 'acacia_stairs', 'dark_oak_stairs', 'red_sandstone_stairs'],
  chests: ['chest', 'trapped_chest'],
  doors: ['wooden_door', 'iron_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door']
}

// Block.isFullCube() is false for these (BlockSlab: only half slabs).
const NOT_FULL_CUBE = [
  'air', 'anvil', 'standing_banner', 'wall_banner', 'stone_pressure_plate', 'wooden_pressure_plate',
  'light_weighted_pressure_plate', 'heavy_weighted_pressure_plate', 'beacon', 'bed', 'brewing_stand',
  // BlockBush
  'sapling', 'tallgrass', 'deadbush', 'yellow_flower', 'red_flower', 'brown_mushroom', 'red_mushroom', 'wheat',
  'carrots', 'potatoes', 'nether_wart', 'pumpkin_stem', 'melon_stem', 'waterlily', 'double_plant',
  'stone_button', 'wooden_button', 'cactus', 'cake', 'carpet', 'cauldron', 'chest', 'trapped_chest', 'cocoa',
  'daylight_detector', 'daylight_detector_inverted', 'dragon_egg', 'enchanting_table', 'end_portal', 'ender_chest',
  'farmland', 'fire', 'flower_pot', 'glass', 'stained_glass', 'hopper', 'ladder', 'lever',
  'flowing_water', 'water', 'flowing_lava', 'lava', 'portal', 'piston', 'sticky_piston', 'piston_head',
  'piston_extension', 'rail', 'golden_rail', 'detector_rail', 'activator_rail', 'unpowered_repeater',
  'powered_repeater', 'unpowered_comparator', 'powered_comparator', 'redstone_wire', 'reeds', 'standing_sign',
  'wall_sign', 'skull', 'stone_slab', 'wooden_slab', 'stone_slab2', 'snow_layer', 'torch', 'redstone_torch',
  'unlit_redstone_torch', 'trapdoor', 'iron_trapdoor', 'tripwire', 'tripwire_hook', 'vine', 'web',
  ...NAMES.fences, ...NAMES.gates, ...NAMES.walls, ...NAMES.panes, ...NAMES.stairs, ...NAMES.doors
]

// Material.isOpaque() is false (translucent or non-solid material) for the
// remaining full cubes: leaves, glass (glowstone, sea lantern), ice, tnt.
const NOT_OPAQUE_MATERIAL = ['leaves', 'leaves2', 'glowstone', 'sea_lantern', 'ice', 'tnt']
// Fences and walls never join these (Material.gourd, Blocks.barrier).
const NEVER_JOIN = ['pumpkin', 'lit_pumpkin', 'melon_block', 'barrier']

// Block.fullBlock (= isOpaqueCube() when constructed) is false for these.
// Panes join any other block whose fullBlock is true. Leaves are true: their
// isOpaqueCube reads fancyGraphics before the field is set.
const NOT_FULL_BLOCK = [
  'air', 'anvil', 'standing_banner', 'wall_banner', 'barrier', 'stone_pressure_plate', 'wooden_pressure_plate',
  'light_weighted_pressure_plate', 'heavy_weighted_pressure_plate', 'beacon', 'bed',
  // BlockBreakable
  'glass', 'stained_glass', 'ice', 'slime', 'portal',
  'brewing_stand', 'sapling', 'tallgrass', 'deadbush', 'yellow_flower', 'red_flower', 'brown_mushroom',
  'red_mushroom', 'wheat', 'carrots', 'potatoes', 'nether_wart', 'pumpkin_stem', 'melon_stem', 'waterlily',
  'double_plant', 'stone_button', 'wooden_button', 'cactus', 'cake', 'carpet', 'cauldron', 'chest',
  'trapped_chest', 'cocoa', 'daylight_detector', 'daylight_detector_inverted', 'dragon_egg', 'enchanting_table',
  'end_portal', 'end_portal_frame', 'ender_chest', 'farmland', 'fire', 'flower_pot', 'hopper', 'ladder',
  'lever', 'flowing_water', 'water', 'flowing_lava', 'lava', 'mob_spawner', 'piston', 'sticky_piston',
  'piston_head', 'piston_extension', 'rail', 'golden_rail', 'detector_rail', 'activator_rail',
  'unpowered_repeater', 'powered_repeater', 'unpowered_comparator', 'powered_comparator', 'redstone_wire',
  'reeds', 'standing_sign', 'wall_sign', 'skull', 'stone_slab', 'wooden_slab', 'stone_slab2', 'snow_layer',
  'torch', 'redstone_torch', 'unlit_redstone_torch', 'trapdoor', 'iron_trapdoor', 'tripwire', 'tripwire_hook',
  'vine', 'web', ...NAMES.fences, ...NAMES.gates, ...NAMES.walls, ...NAMES.panes, ...NAMES.stairs, ...NAMES.doors
]

// BlockPistonExtension.applyHeadBounds / applyCoreBounds, by facing
// (down, up, north, south, west, east). In 1.8 the arm stays inside the head
// block; minecraft-data has the later arm that reaches 0.25 into the base.
const PISTON_HEAD = [
  [[0, 0, 0, 1, 0.25, 1], [0.375, 0.25, 0.375, 0.625, 1, 0.625]],
  [[0, 0.75, 0, 1, 1, 1], [0.375, 0, 0.375, 0.625, 0.75, 0.625]],
  [[0, 0, 0, 1, 1, 0.25], [0.25, 0.375, 0.25, 0.75, 0.625, 1]],
  [[0, 0, 0.75, 1, 1, 1], [0.25, 0.375, 0, 0.75, 0.625, 0.75]],
  [[0, 0, 0, 0.25, 1, 1], [0.375, 0.25, 0.25, 0.625, 0.75, 1]],
  [[0.75, 0, 0, 1, 1, 1], [0, 0.375, 0.25, 0.75, 0.625, 0.75]]
]

// Horizontal facings, as indices into these.
const NORTH = 0
const EAST = 1
const SOUTH = 2
const WEST = 3
const DX = [0, 1, 0, -1]
const DZ = [-1, 0, 1, 0]
// BlockStairs.getStateFromMeta: EnumFacing.getFront(5 - (meta & 3)).
const STAIR_FACING = [EAST, WEST, SOUTH, NORTH]
// BlockDoor.getFacing: EnumFacing.getHorizontal(meta & 3).rotateYCCW().
const DOOR_FACING = [EAST, SOUTH, WEST, NORTH]

let cache = null

// Per state id: { type, meta, name, shapes, family } plus, per block id, the
// flags the neighbour rules read.
function buildShapeTable (registry) {
  if (cache && cache.registry === registry) return cache
  let probeState = 0
  const probe = new FastWorld({ world: { getColumnAt: () => ({ getBlockStateId: () => probeState }) } })
  const origin = new Vec3(0, 0, 0)
  const ids = (list) => new Set(list.map(n => registry.blocksByName[n]?.id).filter(id => id != null))

  const fences = ids(NAMES.fences)
  const gates = ids(NAMES.gates)
  const walls = ids(NAMES.walls)
  const panes = ids(NAMES.panes)
  const stairs = ids(NAMES.stairs)
  const chests = ids(NAMES.chests)
  const doors = ids(NAMES.doors)
  const notFullCube = ids(NOT_FULL_CUBE)
  const notOpaque = ids(NOT_OPAQUE_MATERIAL)
  const neverJoin = ids(NEVER_JOIN)
  const notFullBlock = ids(NOT_FULL_BLOCK)
  const netherFence = registry.blocksByName.nether_brick_fence?.id
  const pistonHead = registry.blocksByName.piston_head?.id

  // Per block id (0..4095).
  const joinsFence = new Uint8Array(4096) // opaque material, full cube, not gourd/barrier
  const fullBlock = new Uint8Array(4096)
  const family = new Uint8Array(4096)
  for (const b of registry.blocksArray) {
    if (!notFullCube.has(b.id) && !notOpaque.has(b.id) && !neverJoin.has(b.id)) joinsFence[b.id] = 1
    if (!notFullBlock.has(b.id)) fullBlock[b.id] = 1
    family[b.id] = fences.has(b.id)
      ? FAMILY.FENCE
      : walls.has(b.id)
        ? FAMILY.WALL
        : panes.has(b.id)
          ? FAMILY.PANE
          : stairs.has(b.id)
            ? FAMILY.STAIRS
            : chests.has(b.id) ? FAMILY.CHEST : doors.has(b.id) ? FAMILY.DOOR : FAMILY.STATIC
  }

  const states = new Array(65536).fill(null)
  for (const key in registry.blocksByStateId) {
    const stateId = Number(key)
    probeState = stateId
    const { position, ...data } = probe.getBlock(origin)
    const type = data.type
    const meta = stateId & 15
    let shapes = data.shapes || []
    if (type === pistonHead) shapes = (meta & 7) < 6 ? PISTON_HEAD[meta & 7] : []
    states[stateId] = {
      ...data,
      shapes,
      meta,
      name: registry.blocks[type]?.name || 'unknown',
      family: family[type]
    }
  }

  cache = { registry, states, family, joinsFence, fullBlock, fences, gates, walls, panes, stairs, chests, doors, netherFence, glass: registry.blocksByName.glass?.id, stainedGlass: registry.blocksByName.stained_glass?.id }
  return cache
}

// Collision boxes of the block at (x, y, z), including the neighbour-dependent
// families. stateAt(x, y, z) returns a state id, or a negative number / null
// for an unloaded block (treated as air, like the client's empty chunk).
function resolveShapes (t, stateAt, x, y, z, stateId = stateAt(x, y, z)) {
  if (stateId == null || stateId < 0) return null
  const type = stateId >> 4
  switch (t.family[type]) {
    case FAMILY.FENCE: return fenceShapes(t, stateAt, x, y, z, type)
    case FAMILY.WALL: return wallShapes(t, stateAt, x, y, z)
    case FAMILY.PANE: return paneShapes(t, stateAt, x, y, z)
    case FAMILY.STAIRS: return stairShapes(t, stateAt, x, y, z, stateId)
    case FAMILY.CHEST: return chestShapes(stateAt, x, y, z, type)
    case FAMILY.DOOR: return doorShapes(stateAt, x, y, z, stateId)
    default: {
      const s = t.states[stateId]
      return s ? s.shapes : []
    }
  }
}

function typeAt (stateAt, x, y, z) {
  const id = stateAt(x, y, z)
  return id == null || id < 0 ? 0 : id >> 4
}

function metaAt (stateAt, x, y, z) {
  const id = stateAt(x, y, z)
  return id == null || id < 0 ? 0 : id & 15
}

// BlockFence.canConnectTo: same-material fence, any fence gate, or an opaque
// full cube that is not a gourd or a barrier. Nether brick (rock) and wooden
// fences do not join each other.
function fenceJoins (t, stateAt, x, y, z, selfType) {
  const n = typeAt(stateAt, x, y, z)
  if (t.fences.has(n)) return (n === t.netherFence) === (selfType === t.netherFence)
  return t.gates.has(n) || t.joinsFence[n] === 1
}

// BlockFence.addCollisionBoxesToList: a north-south bar and an east-west bar,
// 1.5 tall; an unconnected fence is the east-west bar's post only.
function fenceShapes (t, stateAt, x, y, z, type) {
  const n = fenceJoins(t, stateAt, x, y, z - 1, type)
  const s = fenceJoins(t, stateAt, x, y, z + 1, type)
  const w = fenceJoins(t, stateAt, x - 1, y, z, type)
  const e = fenceJoins(t, stateAt, x + 1, y, z, type)
  const boxes = []
  if (n || s) boxes.push([0.375, 0, n ? 0 : 0.375, 0.625, 1.5, s ? 1 : 0.625])
  if (w || e || (!n && !s)) boxes.push([w ? 0 : 0.375, 0, 0.375, e ? 1 : 0.625, 1.5, 0.625])
  return boxes
}

// BlockWall.canConnectTo: another wall, a fence gate, or an opaque full cube
// that is not a gourd or a barrier.
function wallJoins (t, stateAt, x, y, z) {
  const n = typeAt(stateAt, x, y, z)
  return t.walls.has(n) || t.gates.has(n) || t.joinsFence[n] === 1
}

// BlockWall.getCollisionBoundingBox: one box (not a cross), 1.5 tall. A
// straight run with no post is 0.3125..0.6875 wide.
function wallShapes (t, stateAt, x, y, z) {
  const n = wallJoins(t, stateAt, x, y, z - 1)
  const s = wallJoins(t, stateAt, x, y, z + 1)
  const w = wallJoins(t, stateAt, x - 1, y, z)
  const e = wallJoins(t, stateAt, x + 1, y, z)
  let x0 = w ? 0 : 0.25
  let x1 = e ? 1 : 0.75
  let z0 = n ? 0 : 0.25
  let z1 = s ? 1 : 0.75
  if (n && s && !w && !e) {
    x0 = 0.3125
    x1 = 0.6875
  } else if (!n && !s && w && e) {
    z0 = 0.3125
    z1 = 0.6875
  }
  return [[x0, 0, z0, x1, 1.5, z1]]
}

// BlockPane.canPaneConnectToBlock: a full block (Block.fullBlock), glass,
// stained glass, or any pane (glass panes and iron bars join each other).
function paneJoins (t, stateAt, x, y, z) {
  const n = typeAt(stateAt, x, y, z)
  return t.fullBlock[n] === 1 || n === t.glass || n === t.stainedGlass || t.panes.has(n)
}

// BlockPane.addCollisionBoxesToList.
function paneShapes (t, stateAt, x, y, z) {
  const n = paneJoins(t, stateAt, x, y, z - 1)
  const s = paneJoins(t, stateAt, x, y, z + 1)
  const w = paneJoins(t, stateAt, x - 1, y, z)
  const e = paneJoins(t, stateAt, x + 1, y, z)
  const any = n || s || w || e
  const boxes = []
  if ((!w || !e) && any) {
    if (w) boxes.push([0, 0, 0.4375, 0.5, 1, 0.5625])
    else if (e) boxes.push([0.5, 0, 0.4375, 1, 1, 0.5625])
  } else {
    boxes.push([0, 0, 0.4375, 1, 1, 0.5625])
  }
  if ((!n || !s) && any) {
    if (n) boxes.push([0.4375, 0, 0, 0.5625, 1, 0.5])
    else if (s) boxes.push([0.4375, 0, 0.5, 0.5625, 1, 1])
  } else {
    boxes.push([0.4375, 0, 0, 0.5625, 1, 1])
  }
  return boxes
}

// Stair state at a position: null when not a stair.
function stairAt (t, stateAt, x, y, z) {
  const id = stateAt(x, y, z)
  if (id == null || id < 0 || !t.stairs.has(id >> 4)) return null
  return { top: (id & 4) !== 0, facing: STAIR_FACING[id & 3] }
}

function sameStair (t, stateAt, x, y, z, self) {
  const o = stairAt(t, stateAt, x, y, z)
  return !!o && o.top === self.top && o.facing === self.facing
}

// BlockStairs.addCollisionBoxesToList: the half slab, the step from
// func_176306_h (shortened at an outer corner), and the extra quarter from
// func_176304_i at an inner corner (only when the step was not shortened).
function stairShapes (t, stateAt, x, y, z, stateId) {
  const self = { top: (stateId & 4) !== 0, facing: STAIR_FACING[stateId & 3] }
  const y0 = self.top ? 0 : 0.5
  const y1 = self.top ? 0.5 : 1
  const boxes = [self.top ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1]]

  // func_176306_h: the step, cut to a quarter by a stair in front of it.
  let x0 = 0
  let x1 = 1
  let z0 = 0
  let z1 = 0.5
  let straight = true
  const f = self.facing
  if (f === EAST) {
    x0 = 0.5
    z1 = 1
  } else if (f === WEST) {
    x1 = 0.5
    z1 = 1
  } else if (f === SOUTH) {
    z0 = 0.5
    z1 = 1
  }
  const front = stairAt(t, stateAt, x + DX[f], y, z + DZ[f])
  if (front && front.top === self.top) {
    if (f === EAST || f === WEST) {
      if (front.facing === NORTH && !sameStair(t, stateAt, x, y, z + 1, self)) {
        z1 = 0.5
        straight = false
      } else if (front.facing === SOUTH && !sameStair(t, stateAt, x, y, z - 1, self)) {
        z0 = 0.5
        straight = false
      }
    } else {
      if (front.facing === WEST && !sameStair(t, stateAt, x + 1, y, z, self)) {
        x1 = 0.5
        straight = false
      } else if (front.facing === EAST && !sameStair(t, stateAt, x - 1, y, z, self)) {
        x0 = 0.5
        straight = false
      }
    }
  }
  boxes.push([x0, y0, z0, x1, y1, z1])
  if (!straight) return boxes

  // func_176304_i: the inner-corner quarter, from a stair behind.
  const back = stairAt(t, stateAt, x - DX[f], y, z - DZ[f])
  if (!back || back.top !== self.top) return boxes
  let ix0 = 0
  let ix1 = 0.5
  let iz0 = 0.5
  let iz1 = 1
  let inner = false
  if (f === EAST) {
    if (back.facing === NORTH && !sameStair(t, stateAt, x, y, z - 1, self)) {
      iz0 = 0
      iz1 = 0.5
      inner = true
    } else if (back.facing === SOUTH && !sameStair(t, stateAt, x, y, z + 1, self)) {
      inner = true
    }
  } else if (f === WEST) {
    ix0 = 0.5
    ix1 = 1
    if (back.facing === NORTH && !sameStair(t, stateAt, x, y, z - 1, self)) {
      iz0 = 0
      iz1 = 0.5
      inner = true
    } else if (back.facing === SOUTH && !sameStair(t, stateAt, x, y, z + 1, self)) {
      inner = true
    }
  } else if (f === SOUTH) {
    iz0 = 0
    iz1 = 0.5
    if (back.facing === WEST && !sameStair(t, stateAt, x - 1, y, z, self)) {
      inner = true
    } else if (back.facing === EAST && !sameStair(t, stateAt, x + 1, y, z, self)) {
      ix0 = 0.5
      ix1 = 1
      inner = true
    }
  } else {
    if (back.facing === WEST && !sameStair(t, stateAt, x - 1, y, z, self)) {
      inner = true
    } else if (back.facing === EAST && !sameStair(t, stateAt, x + 1, y, z, self)) {
      ix0 = 0.5
      ix1 = 1
      inner = true
    }
  }
  if (inner) boxes.push([ix0, y0, iz0, ix1, y1, iz1])
  return boxes
}

// BlockChest.setBlockBoundsBasedOnState: 1/16 inset, 0.875 tall, reaching the
// shared side of a double chest (first match of north, south, west, east).
function chestShapes (stateAt, x, y, z, type) {
  if (typeAt(stateAt, x, y, z - 1) === type) return [[0.0625, 0, 0, 0.9375, 0.875, 0.9375]]
  if (typeAt(stateAt, x, y, z + 1) === type) return [[0.0625, 0, 0.0625, 0.9375, 0.875, 1]]
  if (typeAt(stateAt, x - 1, y, z) === type) return [[0, 0, 0.0625, 0.9375, 0.875, 0.9375]]
  if (typeAt(stateAt, x + 1, y, z) === type) return [[0.0625, 0, 0.0625, 1, 0.875, 0.9375]]
  return [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]]
}

// BlockDoor.combineMetadata + setBoundBasedOnMeta: facing and open come from
// the lower half, the hinge from the upper half. The slab is 0.1875 thick.
function doorShapes (stateAt, x, y, z, stateId) {
  const meta = stateId & 15
  const top = (meta & 8) !== 0
  const lower = top ? metaAt(stateAt, x, y - 1, z) : meta
  const upper = top ? meta : metaAt(stateAt, x, y + 1, z)
  const facing = DOOR_FACING[lower & 3]
  const open = (lower & 4) !== 0
  const hingeLeft = (upper & 1) !== 0
  const t = 0.1875
  if (open) {
    if (facing === EAST) return [hingeLeft ? [0, 0, 1 - t, 1, 1, 1] : [0, 0, 0, 1, 1, t]]
    if (facing === SOUTH) return [hingeLeft ? [0, 0, 0, t, 1, 1] : [1 - t, 0, 0, 1, 1, 1]]
    if (facing === WEST) return [hingeLeft ? [0, 0, 0, 1, 1, t] : [0, 0, 1 - t, 1, 1, 1]]
    return [hingeLeft ? [1 - t, 0, 0, 1, 1, 1] : [0, 0, 0, t, 1, 1]]
  }
  if (facing === EAST) return [[0, 0, 0, t, 1, 1]]
  if (facing === SOUTH) return [[0, 0, 0, 1, 1, t]]
  if (facing === WEST) return [[1 - t, 0, 0, 1, 1, 1]]
  return [[0, 0, 1 - t, 1, 1, 1]]
}

function isFullCube (shapes) {
  if (shapes.length !== 1) return false
  const s = shapes[0]
  return s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1
}

module.exports = { buildShapeTable, resolveShapes, isFullCube, FAMILY, FULL }
