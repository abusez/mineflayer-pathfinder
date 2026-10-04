'use strict'

const { emptyInput, yawToward } = require('./util')
const { ANCHORS } = require('./route')

// Node skipping: replace runs of walk waypoints with the longest straight
// segments that the terrain allows and a physics rollout confirms.

const MAX_SKIP = 10
const SAMPLE = 0.2

class Smoother {
  constructor (bot, terrain, sim, primitives) {
    this.bot = bot
    this.terrain = terrain
    this.sim = sim
    this.primitives = primitives
    this.stats = { checks: 0, accepted: 0 }
  }

  smooth (path) {
    if (path.length <= 2) return path
    const out = [path[0]]
    let i = 0
    while (i < path.length - 1) {
      let j = i + 1
      const limit = Math.min(path.length - 1, i + MAX_SKIP)
      for (let k = limit; k > i + 1; k--) {
        if (!this.walkOnly(path, i, k)) continue
        this.stats.checks++
        if (this.straightWalkable(path[i], path[k]) && this.simConfirms(path[i], path[k])) {
          this.stats.accepted++
          j = k
          break
        }
      }
      out.push(path[j])
      i = j
    }
    return out
  }

  walkOnly (path, i, k) {
    for (let m = i + 1; m <= k; m++) {
      if (ANCHORS.has(path[m].kind) || path[m].state !== 'stand') return false
    }
    return path[i].state === 'stand'
  }

  // Every point on the straight line has floor within step height of the last.
  straightWalkable (a, b) {
    const t = this.terrain
    const ax = a.x + 0.5
    const az = a.z + 0.5
    const bx = b.x + 0.5
    const bz = b.z + 0.5
    const lo = Math.min(a.H, b.H) - 0.01
    const hi = Math.max(a.H, b.H) + 0.01
    const len = Math.hypot(bx - ax, bz - az)
    const steps = Math.max(1, Math.ceil(len / SAMPLE))
    let prevH = a.H
    for (let s = 0; s <= steps; s++) {
      const cx = ax + (bx - ax) * s / steps
      const cz = az + (bz - az) * s / steps
      const fx = Math.floor(cx)
      const fz = Math.floor(cz)
      let H = null
      for (let y = Math.floor(hi); y >= Math.floor(lo) - 1; y--) {
        const c = t.cell(fx, y, fz)
        if (c.kind === 'stand' && c.H >= lo && c.H <= hi) { H = c.H; break }
      }
      if (H == null || Math.abs(H - prevH) > 0.6) return false
      // The cell's own penalty marks edges; a straight line hugging a drop is
      // only worth it when the original path did the same.
      if (t.bodyBlocked(fx, fz, H, cx, cz) !== false) return false
      prevH = H
    }
    return true
  }

  // From rest at a, walk straight at b: must arrive without dropping.
  simConfirms (a, b) {
    const sim = this.sim
    this.primitives.refresh()
    const s = this.primitives.freshState(a.x + 0.5, a.H, a.z + 0.5)
    const tx = b.x + 0.5
    const tz = b.z + 0.5
    const yaw = yawToward(tx - s.pos.x, tz - s.pos.z)
    const input = emptyInput()
    input.forward = true
    input.sprint = this.primitives.canSprint()
    const lo = Math.min(a.H, b.H) - 0.3
    const len = Math.hypot(tx - a.x - 0.5, tz - a.z - 0.5) || 1
    let stuck = 0
    for (let t = 0; t < 80; t++) {
      const before = s.pos.clone()
      sim.step(s, input, yaw)
      if (s.isCollidedHorizontally) input.sprint = false
      if (s.pos.y < lo) return false
      if (s.onGround && Math.hypot(s.pos.x - tx, s.pos.z - tz) < 0.4) return Math.abs(s.pos.y - b.H) < 0.05
      if (Math.hypot(s.pos.x - before.x, s.pos.z - before.z) < 0.01) {
        if (++stuck > 3) return false
      } else stuck = 0
      // Overshot the line end.
      if (((s.pos.x - tx) * (tx - a.x - 0.5) + (s.pos.z - tz) * (tz - a.z - 0.5)) / len > 0.5) return false
    }
    return false
  }
}

module.exports = { Smoother }
