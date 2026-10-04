'use strict'

// Read-only copy of the loaded world for planner workers.
//
// Each non-empty 16x16x16 section is copied once into a SharedArrayBuffer
// (4096 u16 state ids, the 1.8 index layout x + 16*(z + 16*y)) and handed to
// every worker by reference: no per-job copying. Block updates write into the
// shared section in place and bump `epoch`; worker results carry the epoch
// they were computed against and are dropped if it has moved on, so a result
// never mixes two versions of the world.

const SECTION_U16 = 4096
let nextMirrorId = 1

class WorldMirror {
  constructor (bot) {
    this.bot = bot
    this.columns = new Map() // key -> { cx, cz, source, sections: (Uint16Array|null)[] }
    // Several mirrors (one per nav) can share a pool; results must never
    // cross between them, so every mirror has its own identity.
    this.id = nextMirrorId++
    this.epoch = 1
    this.pending = [] // column messages not yet sent to workers
  }

  key (cx, cz) {
    return (cx + 2097152) * 4194304 + (cz + 2097152)
  }

  column (cx, cz) {
    const world = this.bot.world
    if (world.getColumn) return world.getColumn(cx, cz)
    return world.getColumnAt({ x: cx * 16, y: 0, z: cz * 16 })
  }

  // Mirror every loaded column within `radius` chunks of (x, z); forget
  // columns that unloaded. Returns true if anything changed.
  sync (x, z, radius = 6) {
    const ccx = Math.floor(x) >> 4
    const ccz = Math.floor(z) >> 4
    let changed = false
    const seen = new Set()
    for (let cx = ccx - radius; cx <= ccx + radius; cx++) {
      for (let cz = ccz - radius; cz <= ccz + radius; cz++) {
        const key = this.key(cx, cz)
        const col = this.column(cx, cz)
        if (!col) continue
        seen.add(key)
        const have = this.columns.get(key)
        if (have && have.source === col) continue
        const sections = copySections(col)
        this.columns.set(key, { cx, cz, source: col, sections })
        this.pending.push({ cx, cz, sections, mirror: this.id })
        changed = true
      }
    }
    for (const [key, c] of this.columns) {
      if (seen.has(key)) continue
      // Out of range or unloaded: workers must see it as unknown.
      if (this.column(c.cx, c.cz) === c.source && Math.max(Math.abs(c.cx - ccx), Math.abs(c.cz - ccz)) <= radius + 2) continue
      this.columns.delete(key)
      this.pending.push({ cx: c.cx, cz: c.cz, sections: null, mirror: this.id })
      changed = true
    }
    if (changed) this.epoch++
    return changed
  }

  // A block changed in the live world.
  setBlock (x, y, z, stateId) {
    this.epoch++
    const c = this.columns.get(this.key(x >> 4, z >> 4))
    if (!c || y < 0 || y > 255) return
    let section = c.sections[y >> 4]
    if (!section) {
      if (!stateId) return
      section = c.sections[y >> 4] = new Uint16Array(new SharedArrayBuffer(SECTION_U16 * 2))
      this.pending.push({ cx: c.cx, cz: c.cz, sections: c.sections, mirror: this.id })
    }
    section[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = stateId
  }

  takePending () {
    const p = this.pending
    this.pending = []
    return p
  }
}

// Section arrays of a prismarine-chunk 1.8 column (Buffer data) or a harness
// column (Uint16Array sections), copied into shared memory. All-air sections
// stay null.
function copySections (col) {
  const out = new Array(16).fill(null)
  const sections = col.sections || []
  for (let i = 0; i < 16; i++) {
    const s = sections[i]
    if (!s) continue
    let src
    if (s instanceof Uint16Array) src = s
    else if (s.data && s.data.buffer) src = new Uint16Array(s.data.buffer, s.data.byteOffset, SECTION_U16)
    else continue
    let empty = true
    for (let k = 0; k < SECTION_U16; k++) if (src[k] !== 0) { empty = false; break }
    if (empty) continue
    const dst = new Uint16Array(new SharedArrayBuffer(SECTION_U16 * 2))
    dst.set(src)
    out[i] = dst
  }
  return out
}

// Worker side: the column interface Terrain and NavWorld read through.
class MirrorColumn {
  constructor (sections) {
    this.sections = sections
  }

  getBlockStateId (pos) {
    const y = pos.y
    if (y < 0 || y > 255) return 0
    const s = this.sections[y >> 4]
    if (!s) return 0
    return s[((y & 15) << 8) | ((pos.z & 15) << 4) | (pos.x & 15)]
  }
}

module.exports = { WorldMirror, MirrorColumn }
