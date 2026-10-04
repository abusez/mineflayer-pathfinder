'use strict'

const { Vec3 } = require('vec3')
const { buildShapeTable, resolveShapes } = require('./shapes18')

// Chunk column lookups dominate rollout cost (prismarine-world keys columns
// by string). Nav reads the same few columns thousands of times a tick, so
// cache them per tick. Columns only load or unload between ticks.
class ColumnCache {
  constructor (bot) {
    this.bot = bot
    this.cache = new Map()
    // Resolved block objects, same lifetime as the column cache. Physics asks
    // for ~30 blocks per tick and mostly the same ones as the tick before.
    this.blocks = new Map()
    // Direct-mapped front cache for blocks (16x16x16 slots, tag-checked).
    // Physics reads a small neighbourhood each tick; this avoids hashing.
    // `gen` invalidates every slot at once on clear().
    this.gen = 1
    this.slotGen = new Uint32Array(4096)
    this.slotX = new Int32Array(4096)
    this.slotY = new Int32Array(4096)
    this.slotZ = new Int32Array(4096)
    this.slotBlock = new Array(4096).fill(null)
    this.pos = new Vec3(0, 0, 0)
    this.lastCx = NaN
    this.lastCz = NaN
    this.lastColumn = null
  }

  clear () {
    this.cache.clear()
    this.blocks.clear()
    this.gen++
    this.lastCx = NaN
    this.lastCz = NaN
    this.lastColumn = null
  }

  get (cx, cz) {
    if (cx === this.lastCx && cz === this.lastCz) return this.lastColumn
    const key = (cx + 2097152) * 4194304 + (cz + 2097152)
    let column = this.cache.get(key)
    if (column !== undefined) {
      this.lastCx = cx
      this.lastCz = cz
      this.lastColumn = column
      return column
    }
    const world = this.bot.world
    if (world.getColumn) column = world.getColumn(cx, cz)
    else {
      this.pos.set(cx * 16, 0, cz * 16)
      column = world.getColumnAt(this.pos)
    }
    column = column || null
    this.cache.set(key, column)
    this.lastCx = cx
    this.lastCz = cz
    this.lastColumn = column
    return column
  }
}

// Block data for every state id: FastWorld's fields (type, boundingBox,
// _properties) with the 1.8.9 boxes from nav/shapes18.js.
function blockData (registry) {
  return buildShapeTable(registry).states
}

// A drop-in for FastWorld that reads columns through the cache.
class NavWorld {
  constructor (bot, columns) {
    this.columns = columns
    this.shapeTable = buildShapeTable(bot.registry)
    this.table = this.shapeTable.states
    this.pos = new Vec3(0, 0, 0)
    this._stateAt = (x, y, z) => this.stateAt(x, y, z)
  }

  stateAt (x, y, z) {
    const column = this.columns.get(x >> 4, z >> 4)
    if (!column) return -1
    if (y < 0 || y > 255) return 0
    this.pos.set(x, y, z)
    const id = column.getBlockStateId(this.pos)
    return id === undefined ? -1 : id
  }

  // Called by the patched prismarine-physics getSurroundingBBs. Neighbour-
  // dependent boxes are kept on the (per-position, cached) block object.
  resolveShapes (block) {
    if (!block.family) return block.shapes
    if (block.resolved) return block.resolved
    const p = block.position
    block.resolved = resolveShapes(this.shapeTable, this._stateAt, p.x, p.y, p.z)
    return block.resolved
  }

  getBlock (pos) {
    const x = Math.floor(pos.x)
    const y = Math.floor(pos.y)
    const z = Math.floor(pos.z)
    // Same block object for the same position until the cache is cleared.
    // prismarine-physics only reads blocks (shapes, type, position).
    if (x > -1048576 && x < 1048576 && z > -1048576 && z < 1048576 && y > -256 && y < 256) {
      const c = this.columns
      const slot = ((x & 15) << 8) | ((y & 15) << 4) | (z & 15)
      if (c.slotGen[slot] === c.gen && c.slotX[slot] === x && c.slotY[slot] === y && c.slotZ[slot] === z) return c.slotBlock[slot]
      const key = ((x + 1048576) * 2097152 + (z + 1048576)) * 512 + (y + 256)
      const blocks = c.blocks
      let block = blocks.get(key)
      if (block === undefined) {
        block = this.read(x, y, z)
        blocks.set(key, block)
      }
      c.slotGen[slot] = c.gen
      c.slotX[slot] = x
      c.slotY[slot] = y
      c.slotZ[slot] = z
      c.slotBlock[slot] = block
      return block
    }
    return this.read(x, y, z)
  }

  read (x, y, z) {
    const column = this.columns.get(x >> 4, z >> 4)
    if (!column) return null
    this.pos.set(x, y, z)
    const stateId = column.getBlockStateId(this.pos)
    if (stateId === undefined) return null
    const data = this.table[stateId]
    if (!data) throw new Error(`No block data for state ID ${stateId}`)
    return { ...data, position: new Vec3(x, y, z) }
  }
}

// A drop-in for FastWorld over bot.world (no caching), with the same 1.8.9
// boxes as NavWorld. The live physics and the test harness use it.
class ShapeWorld {
  constructor (bot) {
    this.bot = bot
    this.shapeTable = buildShapeTable(bot.registry)
    this.table = this.shapeTable.states
    this.pos = new Vec3(0, 0, 0)
    this._stateAt = (x, y, z) => this.stateAt(x, y, z)
  }

  stateAt (x, y, z) {
    this.pos.set(x, y, z)
    const column = this.bot.world.getColumnAt(this.pos)
    if (!column) return -1
    if (y < 0 || y > 255) return 0
    const id = column.getBlockStateId(this.pos)
    return id === undefined ? -1 : id
  }

  getBlock (pos) {
    const x = Math.floor(pos.x)
    const y = Math.floor(pos.y)
    const z = Math.floor(pos.z)
    const stateId = this.stateAt(x, y, z)
    if (stateId < 0) return null
    const data = this.table[stateId]
    if (!data) throw new Error(`No block data for state ID ${stateId}`)
    return { ...data, position: new Vec3(x, y, z) }
  }

  resolveShapes (block) {
    if (!block.family) return block.shapes
    const p = block.position
    return resolveShapes(this.shapeTable, this._stateAt, p.x, p.y, p.z)
  }
}

module.exports = { ColumnCache, NavWorld, ShapeWorld, blockData }
