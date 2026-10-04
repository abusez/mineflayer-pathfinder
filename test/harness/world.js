'use strict'

const mcData = require('minecraft-data')('1.8.9')

// Just enough of a 1.8 chunk column for prismarine-physics' FastWorld:
// getColumnAt(pos) -> column.getBlockStateId(pos), world coordinates.
class Column {
  constructor () {
    this.sections = new Array(16).fill(null)
  }

  getBlockStateId (pos) {
    const y = pos.y
    if (y < 0 || y > 255) return 0
    const section = this.sections[y >> 4]
    if (!section) return 0
    return section[((y & 15) << 8) | ((pos.z & 15) << 4) | (pos.x & 15)]
  }

  setBlockStateId (x, y, z, stateId) {
    if (y < 0 || y > 255) return
    let section = this.sections[y >> 4]
    if (!section) {
      if (stateId === 0) return
      section = this.sections[y >> 4] = new Uint16Array(4096)
    }
    section[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = stateId
  }
}

function stateOf (name, meta = 0) {
  const block = mcData.blocksByName[name]
  if (!block) throw new Error(`Unknown block ${name}`)
  return (block.id << 4) | meta
}

class HarnessWorld {
  constructor () {
    this.columns = new Map()
    this.listeners = []
  }

  key (cx, cz) {
    return (cx + 2097152) * 4194304 + (cz + 2097152)
  }

  // Columns only exist once loaded. A missing column is an unloaded chunk.
  loadColumn (cx, cz) {
    const key = this.key(cx, cz)
    let column = this.columns.get(key)
    if (!column) {
      column = new Column()
      this.columns.set(key, column)
    }
    return column
  }

  unloadColumn (cx, cz) {
    this.columns.delete(this.key(cx, cz))
  }

  loadArea (x0, z0, x1, z1) {
    for (let cx = Math.floor(Math.min(x0, x1) / 16); cx <= Math.floor(Math.max(x0, x1) / 16); cx++) {
      for (let cz = Math.floor(Math.min(z0, z1) / 16); cz <= Math.floor(Math.max(z0, z1) / 16); cz++) {
        this.loadColumn(cx, cz)
      }
    }
  }

  getColumn (cx, cz) {
    return this.columns.get(this.key(cx, cz)) || null
  }

  getColumnAt (pos) {
    return this.columns.get(this.key(Math.floor(pos.x) >> 4, Math.floor(pos.z) >> 4)) || null
  }

  getStateId (x, y, z) {
    const column = this.columns.get(this.key(x >> 4, z >> 4))
    if (!column) return -1
    return column.getBlockStateId({ x, y, z })
  }

  set (x, y, z, name, meta = 0) {
    this.setState(x, y, z, name === 'air' ? 0 : stateOf(name, meta))
  }

  setState (x, y, z, stateId) {
    const column = this.loadColumn(x >> 4, z >> 4)
    const old = column.getBlockStateId({ x, y, z })
    column.setBlockStateId(x, y, z, stateId)
    if (old !== stateId) {
      for (const listener of this.listeners) listener(x, y, z, old, stateId)
    }
  }

  fill (x0, y0, z0, x1, y1, z1, name, meta = 0) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
          this.set(x, y, z, name, meta)
        }
      }
    }
  }

  onChange (listener) {
    this.listeners.push(listener)
  }

  // A world saved live by the "scene save" command: every chunk inside the
  // saved bounds is loaded, blocks are restored by raw state id.
  static fromScene (scene) {
    const w = new HarnessWorld()
    const { min, max } = scene.bounds
    w.loadArea(min[0], min[2], max[0], max[2])
    for (const [x, y, z, id] of scene.blocks) w.setState(x, y, z, id)
    return w
  }
}

module.exports = { HarnessWorld, stateOf, mcData }
