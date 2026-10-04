'use strict'

const { Vec3 } = require('vec3')
const { buildShapeTable, resolveShapes, isFullCube, FAMILY } = require('./shapes18')

// Terrain analysis for the planner. Collision boxes come from nav/shapes18.js,
// the same 1.8.9 table (and neighbour rules for fences, walls, panes, stairs,
// chests and doors) the simulator uses, so the planner and the simulator agree.

const HALF = 0.3
const HEIGHT = 1.8
const EPS = 1e-4

const GATES = ['fence_gate', 'spruce_fence_gate', 'birch_fence_gate', 'jungle_fence_gate', 'acacia_fence_gate', 'dark_oak_fence_gate']
const LIQUIDS = ['water', 'flowing_water', 'lava', 'flowing_lava']
const CLIMBABLE = ['ladder', 'vine']
// Hurts, traps or teleports. The body must never enter these.
const HAZARDS = ['fire', 'web', 'cactus', 'portal', 'end_portal', 'lava', 'flowing_lava']
// Fine to stand on but changes movement. Costed, not forbidden.
const AWKWARD = ['soul_sand', 'ice', 'packed_ice', 'slime', 'slime_block']
// Families whose boxes depend on neighbours (resolved per position).
const DYNAMIC = { [FAMILY.FENCE]: 'fence', [FAMILY.WALL]: 'wall', [FAMILY.PANE]: 'pane', [FAMILY.STAIRS]: 'stairs', [FAMILY.CHEST]: 'chest', [FAMILY.DOOR]: 'door' }

const UNKNOWN = -1

let tableCache = null

function buildTable (registry) {
  if (tableCache && tableCache.registry === registry) return tableCache
  const shapes = buildShapeTable(registry)
  const byName = (list) => new Set(list.map(n => registry.blocksByName[n]?.id).filter(id => id != null))
  const gates = byName(GATES)
  const liquids = byName(LIQUIDS)
  const climbable = byName(CLIMBABLE)
  const hazards = byName(HAZARDS)
  const awkward = byName(AWKWARD)

  const table = new Array(65536).fill(null)
  for (let stateId = 0; stateId < 65536; stateId++) {
    const block = shapes.states[stateId]
    if (!block) continue
    const type = block.type
    const dynamic = DYNAMIC[block.family] || null
    table[stateId] = {
      type,
      name: block.name,
      shapes: block.shapes,
      dynamic,
      gate: gates.has(type),
      fenceLike: dynamic === 'fence' || gates.has(type),
      liquid: liquids.has(type),
      climbable: climbable.has(type),
      hazard: hazards.has(type),
      awkward: awkward.has(type),
      // Stairs, slabs, snow, fences... anything that is not empty or a full cube.
      partial: !!dynamic || (block.shapes.length > 0 && !isFullCube(block.shapes))
    }
  }
  tableCache = { registry, table, shapes }
  return tableCache
}

const AIR_INFO = { type: 0, name: 'air', shapes: [], dynamic: null, liquid: false, climbable: false, hazard: false, awkward: false, partial: false }

class Terrain {
  constructor (bot, columns = null) {
    this.bot = bot
    this.columns = columns
    const { table, shapes } = buildTable(bot.registry)
    this.table = table
    this.shapeTable = shapes
    this._stateAt = (x, y, z) => this.stateAt(x, y, z)
    this.cells = new Map()
    const p = bot.entity?.position
    this.ox = p ? Math.floor(p.x) : 0
    this.oz = p ? Math.floor(p.z) : 0
    this._pos = new Vec3(0, 0, 0)
    this.version = 0
  }

  // Numeric key, valid within about a million blocks of where the bot started.
  key (x, y, z) {
    return ((x - this.ox + 1048576) * 2097152 + (z - this.oz + 1048576)) * 512 + (y + 64)
  }

  column (x, z) {
    if (this.columns) return this.columns.get(x >> 4, z >> 4)
    const world = this.bot.world
    if (world.getColumn) return world.getColumn(x >> 4, z >> 4)
    this._pos.set(x, 0, z)
    return world.getColumnAt(this._pos)
  }

  // State id, 0 for air (including outside 0..255), UNKNOWN for unloaded chunks.
  stateAt (x, y, z) {
    const column = this.column(x, z)
    if (!column) return UNKNOWN
    if (y < 0 || y > 255) return 0
    this._pos.set(x, y, z)
    return column.getBlockStateId(this._pos) || 0
  }

  infoAt (x, y, z) {
    const id = this.stateAt(x, y, z)
    if (id === UNKNOWN) return null
    return this.table[id] || AIR_INFO
  }

  // Collision boxes for one block (1.8.9, including neighbour-dependent
  // shapes), or null in an unloaded chunk.
  shapesAt (x, y, z) {
    const id = this.stateAt(x, y, z)
    if (id === UNKNOWN) return null
    const info = this.table[id]
    if (!info) return []
    if (!info.dynamic) return info.shapes
    return resolveShapes(this.shapeTable, this._stateAt, x, y, z, id)
  }

  // Highest collision top under a centred player footprint, searching block
  // y-1 and block y. Returns the world Y, -Infinity for nothing, null if unknown.
  supportTop (x, y, z, cx = x + 0.5, cz = z + 0.5) {
    const minX = cx - HALF
    const maxX = cx + HALF
    const minZ = cz - HALF
    const maxZ = cz + HALF
    let top = -Infinity
    this.supportBy = null
    for (let by = y - 1; by <= y; by++) {
      const shapes = this.shapesAt(x, by, z)
      if (shapes === null) return null
      for (const s of shapes) {
        if (x + s[3] <= minX + EPS || x + s[0] >= maxX - EPS || z + s[5] <= minZ + EPS || z + s[2] >= maxZ - EPS) continue
        const t = by + s[4]
        if (t > top) {
          top = t
          this.supportBy = by
        }
      }
    }
    return top
  }

  // Does a player box with feet at footY, centred on (cx, cz), hit anything?
  // Only checks blocks in column (x, z) unless wide is set.
  bodyBlocked (x, z, footY, cx = x + 0.5, cz = z + 0.5, height = HEIGHT) {
    const minX = cx - HALF
    const maxX = cx + HALF
    const minZ = cz - HALF
    const maxZ = cz + HALF
    const minY = footY + EPS
    const maxY = footY + height
    const x0 = Math.floor(minX + EPS)
    const x1 = Math.floor(maxX - EPS)
    const z0 = Math.floor(minZ + EPS)
    const z1 = Math.floor(maxZ - EPS)
    for (let bx = x0; bx <= x1; bx++) {
      for (let bz = z0; bz <= z1; bz++) {
        for (let by = Math.floor(minY) - 1; by <= Math.floor(maxY - EPS); by++) {
          const shapes = this.shapesAt(bx, by, bz)
          if (shapes === null) return null
          for (const s of shapes) {
            if (bx + s[3] > minX && bx + s[0] < maxX &&
                by + s[4] > minY && by + s[1] < maxY &&
                bz + s[5] > minZ && bz + s[2] < maxZ) return true
          }
        }
      }
    }
    return false
  }

  // For reports: the first block box a player body (feet at footY, centred
  // on cx, cz) overlaps, as { x, y, z, name, box }, 'unknown', or null.
  bodyHit (cx, cz, footY, height = HEIGHT) {
    const minX = cx - HALF
    const maxX = cx + HALF
    const minZ = cz - HALF
    const maxZ = cz + HALF
    const minY = footY + EPS
    const maxY = footY + height
    for (let bx = Math.floor(minX + EPS); bx <= Math.floor(maxX - EPS); bx++) {
      for (let bz = Math.floor(minZ + EPS); bz <= Math.floor(maxZ - EPS); bz++) {
        for (let by = Math.floor(minY) - 1; by <= Math.floor(maxY - EPS); by++) {
          const shapes = this.shapesAt(bx, by, bz)
          if (shapes === null) return 'unknown'
          for (const s of shapes) {
            if (bx + s[3] > minX && bx + s[0] < maxX &&
                by + s[4] > minY && by + s[1] < maxY &&
                bz + s[5] > minZ && bz + s[2] < maxZ) {
              return { x: bx, y: by, z: bz, name: this.infoAt(bx, by, bz).name, box: s }
            }
          }
        }
      }
    }
    return null
  }

  // Liquid or hazard anywhere the body would be.
  bodyHazard (x, y, z) {
    let liquid = false
    let hazard = false
    for (let by = y; by <= y + 1; by++) {
      const info = this.infoAt(x, by, z)
      if (!info) continue
      if (info.liquid) liquid = true
      if (info.hazard) hazard = true
    }
    return { liquid, hazard }
  }

  // Cell analysis for feet in block (x, y, z). Cached until a nearby block changes.
  cell (x, y, z) {
    const k = this.key(x, y, z)
    let c = this.cells.get(k)
    if (c) return c
    c = this.analyse(x, y, z)
    this.cells.set(k, c)
    return c
  }

  analyse (x, y, z) {
    const feet = this.infoAt(x, y, z)
    const below = this.infoAt(x, y - 1, z)
    if (!feet || !below || !this.infoAt(x, y + 1, z) || !this.infoAt(x, y + 2, z)) {
      return { kind: 'unknown', x, y, z }
    }
    const { liquid, hazard } = this.bodyHazard(x, y, z)
    if (hazard) return { kind: 'hazard', x, y, z }
    if (liquid) return { kind: 'liquid', x, y, z }

    if (feet.climbable) {
      // Body inside the ladder block. Clearance ignores the ladder itself.
      const blocked = this.bodyBlockedIgnoring(x, z, y, (info) => info.climbable)
      if (blocked) return { kind: 'blocked', x, y, z }
      const top = this.supportTop(x, y, z)
      return { kind: 'ladder', x, y, z, H: top != null && top >= y && top < y + 1 ? top : y, below }
    }

    const top = this.supportTop(x, y, z)
    if (top === null) return { kind: 'unknown', x, y, z }
    if (top >= y + 1 - EPS) return { kind: 'solid', x, y, z }
    if (top < y) {
      const blocked = this.bodyBlocked(x, z, y)
      if (blocked === null) return { kind: 'unknown', x, y, z }
      return { kind: blocked ? 'blocked' : 'air', x, y, z }
    }
    const blocked = this.bodyBlocked(x, z, top)
    if (blocked === null) return { kind: 'unknown', x, y, z }
    if (blocked) return { kind: 'blocked', x, y, z }
    // Head room for a jump: about 1.25 above a standing head.
    const floor = this.infoAt(x, this.supportBy, z)
    const jumpRoom = !this.bodyBlocked(x, z, top, x + 0.5, z + 0.5, HEIGHT + 1.25)
    return {
      kind: 'stand',
      x,
      y,
      z,
      H: top,
      jumpRoom,
      awkward: !!floor?.awkward,
      fenceTop: !!floor?.fenceLike || floor?.dynamic === 'wall',
      partial: !!floor?.partial
    }
  }

  bodyBlockedIgnoring (x, z, footY, ignore) {
    for (let by = Math.floor(footY); by <= Math.floor(footY + HEIGHT); by++) {
      const info = this.infoAt(x, by, z)
      if (!info) return true
      if (ignore(info)) continue
      const shapes = this.shapesAt(x, by, z)
      for (const s of shapes) {
        if (x + s[3] > x + 0.5 - HALF && x + s[0] < x + 0.5 + HALF &&
            by + s[4] > footY + EPS && by + s[1] < footY + HEIGHT &&
            z + s[5] > z + 0.5 - HALF && z + s[2] < z + 0.5 + HALF) return true
      }
    }
    return false
  }

  // First standable cell at or below (x, y, z) within maxDepth, falling through
  // open air. { y, cell } or { blocked } or { unknown } or { liquid } or { tooDeep }.
  landing (x, y, z, maxDepth) {
    for (let d = 0; d <= maxDepth; d++) {
      const c = this.cell(x, y - d, z)
      if (c.kind === 'stand' || c.kind === 'ladder') return { y: y - d, cell: c, depth: d }
      if (c.kind === 'unknown') return { unknown: true }
      if (c.kind === 'liquid') return { liquid: true, y: y - d }
      if (c.kind === 'hazard') return { hazard: true }
      if (c.kind !== 'air') return { blocked: true }
      if (y - d < 0) return { tooDeep: true }
    }
    return { tooDeep: true }
  }

  // How many of the 4 sides drop away by more than a block, weighted by depth.
  edgeExposure (x, y, z, H) {
    let exposure = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx
      const nz = z + dz
      let found = false
      for (let ny = y + 1; ny >= y - 1; ny--) {
        const c = this.cell(nx, ny, nz)
        if (c.kind === 'stand' && c.H > H - 1.01) { found = true; break }
        if (c.kind === 'solid' || c.kind === 'blocked' || c.kind === 'unknown' || c.kind === 'ladder') { found = true; break }
      }
      if (found) continue
      const land = this.landing(nx, y - 1, nz, 8)
      const depth = land.y != null ? Math.max(0, H - (land.cell ? land.cell.H : land.y)) : 10
      exposure += depth >= 4 ? 1 : depth >= 2 ? 0.5 : 0.2
    }
    return exposure
  }

  // Count of the 8 neighbours whose body space is blocked at this height.
  tightness (x, y, z, H) {
    let blocked = 0
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue
        const b = this.bodyBlocked(x + dx, z + dz, H + 0.6, x + dx + 0.5, z + dz + 0.5, 1.2)
        if (b !== false) blocked++
      }
    }
    return blocked
  }

  invalidateAround (x, y, z) {
    this.version++
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -3; dy <= 2; dy++) this.cells.delete(this.key(x + dx, y + dy, z + dz))
      }
    }
  }

  invalidateAll () {
    this.version++
    this.cells.clear()
  }
}

module.exports = { Terrain, UNKNOWN, HALF, HEIGHT, buildTable }
