'use strict'

const { Vec3 } = require('vec3')

// The followed form of a planner path: waypoints with arc lengths, progress
// tests, and the aim point used for steering.

// Edges that need a specific execution and can't be smoothed over.
const ANCHORS = new Set(['gap', 'jumpUp', 'drop', 'ladderEnter', 'climb', 'climbDown', 'ladderExit', 'swim', 'swimExit'])

const LOOK_AHEAD = 3
const TAKEOFF_LEAD = 0.6

class Route {
  constructor (path, { goal, uncertain = false } = {}) {
    this.waypoints = path.map((p, i) => ({
      ...p,
      index: i,
      pos: p.pos || new Vec3(p.x + 0.5, p.H, p.z + 0.5),
      anchor: ANCHORS.has(p.kind)
    }))
    this.goal = goal
    this.uncertain = uncertain
    this.cum = [0]
    for (let i = 1; i < this.waypoints.length; i++) {
      const a = this.waypoints[i - 1].pos
      const b = this.waypoints[i].pos
      this.cum.push(this.cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z) + Math.abs(b.y - a.y) * 0.5)
    }
    this.length = this.cum[this.cum.length - 1]
  }

  get size () {
    return this.waypoints.length
  }

  // Next edge is one the controller must execute precisely.
  anchorAfter (i) {
    const next = this.waypoints[i + 1]
    return !!next && next.anchor
  }

  // Is waypoint i reached by a body in state s?
  reached (s, i) {
    const w = this.waypoints[i]
    const p = s.pos
    const last = i === this.waypoints.length - 1
    if (w.state === 'ladder') {
      if (Math.floor(p.x) !== w.x || Math.floor(p.z) !== w.z) return false
      return Math.abs(p.y - w.H) < 0.4 || (w.kind === 'climb' && p.y > w.H)
    }
    if (w.state === 'water') {
      return Math.floor(p.x) === w.x && Math.floor(p.z) === w.z && Math.abs(p.y - w.y) < 1
    }
    const dx = p.x - w.pos.x
    const dz = p.z - w.pos.z
    const dy = p.y - w.H
    if (last) return s.onGround && Math.floor(p.x) === w.x && Math.floor(p.z) === w.z && Math.abs(dy) < 0.05
    if (s.onGround && Math.abs(dy) < 0.05 && Math.abs(dx) < 0.8 && Math.abs(dz) < 0.8) return true
    // Landings must really be landed on, but anywhere on the landing area
    // near the target will do.
    if (w.kind === 'gap' || w.kind === 'jumpUp' || w.kind === 'drop') {
      if (!s.onGround || Math.abs(dy) >= 0.05 || Math.hypot(dx, dz) >= 1.5) return false
      // ...and on the far side of the gap, not on the takeoff edge.
      const a = this.waypoints[i - 1]
      if (!a || w.kind === 'drop') return true
      const sx = w.pos.x - a.pos.x
      const sz = w.pos.z - a.pos.z
      return (p.x - a.pos.x) * sx + (p.z - a.pos.z) * sz >= 0.5 * (sx * sx + sz * sz)
    }
    if (Math.abs(dy) > 0.6) return false
    const next = this.waypoints[i + 1]
    if (next.anchor) {
      // A takeoff counts once we are over its block.
      return Math.floor(p.x) === w.x && Math.floor(p.z) === w.z
    }
    const dist = Math.hypot(dx, dz)
    if (dist < 0.5) return true
    if (dist > 1.1) return false
    const nx = next.pos.x - w.pos.x
    const nz = next.pos.z - w.pos.z
    return dx * nx + dz * nz >= 0
  }

  // Move the cursor past every waypoint already reached, including skips
  // (standing on a later waypoint's block).
  advance (s, cursor) {
    const n = this.waypoints.length
    while (cursor < n && this.reached(s, cursor)) cursor++
    if (cursor < n && s.onGround) {
      for (let k = cursor + 1; k < Math.min(n, cursor + 5); k++) {
        const w = this.waypoints[k]
        if (w.state !== 'stand') break
        if (Math.floor(s.pos.x) === w.x && Math.floor(s.pos.z) === w.z && Math.abs(s.pos.y - w.H) < 0.05) {
          cursor = k + 1
          while (cursor < n && this.reached(s, cursor)) cursor++
          break
        }
      }
    }
    return cursor
  }

  // Arc-length progress of a position given the cursor.
  progress (p, cursor) {
    const n = this.waypoints.length
    if (cursor >= n) return this.length + 1
    if (cursor === 0) return 0
    const a = this.waypoints[cursor - 1].pos
    const b = this.waypoints[cursor].pos
    const sx = b.x - a.x
    const sz = b.z - a.z
    const sy = b.y - a.y
    const len2 = sx * sx + sz * sz
    let t
    if (len2 < 1e-6) t = Math.max(0, Math.min(1, sy !== 0 ? (p.y - a.y) / sy : 0))
    else t = Math.max(0, Math.min(1, ((p.x - a.x) * sx + (p.z - a.z) * sz) / len2))
    // Coming down onto a lower waypoint is progress too, or every way of
    // walking off a ledge would score the same.
    if (sy < -0.6) t = Math.max(t, Math.min(1, (a.y - p.y) / -sy) * 0.95)
    return this.cum[cursor - 1] + t * (this.cum[cursor] - this.cum[cursor - 1])
  }

  // After coming down from the air: did the body land somewhere the route
  // expects? Precise edges must be landed on (or not left at all).
  landingOk (s, cursor) {
    const n = this.waypoints.length
    if (cursor >= n) return true
    const w = this.waypoints[cursor]
    const a = cursor > 0 ? this.waypoints[cursor - 1] : w
    if (w.state !== 'stand' || a.state !== 'stand') return true
    const p = s.pos
    const sx = w.pos.x - a.pos.x
    const sz = w.pos.z - a.pos.z
    const len2 = sx * sx + sz * sz
    const t = len2 > 1e-6 ? ((p.x - a.pos.x) * sx + (p.z - a.pos.z) * sz) / len2 : 0
    const dev = this.deviation(p, cursor)
    // Coming down off a ledge onto lower ground near the target is fine even
    // if momentum carried the body a little past the planned cell.
    if (w.kind === 'drop' && p.y < a.H - 0.4 && p.y > w.H - 1.1 && Math.hypot(p.x - w.pos.x, p.z - w.pos.z) < 2.5) return true
    if (w.kind === 'gap' || w.kind === 'jumpUp' || w.kind === 'drop') {
      // Not reached, so the only acceptable place is back on the approach
      // side of the takeoff (a hop before the edge).
      return Math.abs(p.y - a.H) < 0.6 && dev < 1 && t < 0.35
    }
    // Walk segments: smoothing guarantees floor between the end heights.
    const lo = Math.min(a.H, w.H) - 0.65
    const hi = Math.max(a.H, w.H) + 0.65
    return p.y > lo && p.y < hi && dev < 1.5 && t > -0.5
  }

  // Unit horizontal direction of the segment ending at the cursor.
  direction (cursor) {
    const n = this.waypoints.length
    const b = this.waypoints[Math.min(cursor, n - 1)].pos
    const a = cursor > 0 ? this.waypoints[Math.min(cursor, n - 1) - 1].pos : b
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz)
    return len < 1e-6 ? null : { x: dx / len, z: dz / len }
  }

  // Horizontal distance from the current segment's line.
  deviation (p, cursor) {
    const n = this.waypoints.length
    const b = this.waypoints[Math.min(cursor, n - 1)].pos
    const a = cursor > 0 ? this.waypoints[cursor - 1].pos : b
    const sx = b.x - a.x
    const sz = b.z - a.z
    const len2 = sx * sx + sz * sz
    if (len2 < 1e-6) return Math.hypot(p.x - b.x, p.z - b.z)
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * sx + (p.z - a.z) * sz) / len2))
    return Math.hypot(p.x - (a.x + sx * t), p.z - (a.z + sz * t))
  }

  // Lowest floor the body may be at around the cursor without having fallen.
  floorNear (cursor) {
    const n = this.waypoints.length
    const w = this.waypoints[Math.min(cursor, n - 1)]
    const prev = cursor > 0 ? this.waypoints[cursor - 1] : w
    return Math.min(w.H, prev.H)
  }

  // Steering point: pure pursuit along walk segments, never past a takeoff by
  // more than a short lead, and straight at the target for precise edges.
  aim (p, cursor) {
    const wps = this.waypoints
    const n = wps.length
    if (cursor >= n) return wps[n - 1].pos
    const w = wps[cursor]
    if (cursor === 0 || w.anchor || cursor === n - 1) return w.pos
    const a = wps[cursor - 1].pos
    // Project onto the current segment, then walk forward LOOK_AHEAD.
    const sx = w.pos.x - a.x
    const sz = w.pos.z - a.z
    const len = Math.hypot(sx, sz)
    let t = len > 1e-6 ? Math.max(0, Math.min(1, ((p.x - a.x) * sx + (p.z - a.z) * sz) / (len * len))) : 1
    let remaining = LOOK_AHEAD
    let k = cursor
    let fromX = a.x + sx * t
    let fromZ = a.z + sz * t
    for (;;) {
      const to = wps[k].pos
      const seg = Math.hypot(to.x - fromX, to.z - fromZ)
      if (seg >= remaining) {
        const f = remaining / seg
        return new Vec3(fromX + (to.x - fromX) * f, to.y, fromZ + (to.z - fromZ) * f)
      }
      remaining -= seg
      if (k + 1 >= n) return to
      // Look past gentle bends only. Cutting a sharp corner can go through
      // the wall it turns around.
      if (sharpTurn(fromX, fromZ, to, wps[k + 1].pos)) return to
      if (wps[k + 1].anchor) {
        // Line up with the precise edge: a short lead past the takeoff centre.
        const nx = wps[k + 1].pos.x - to.x
        const nz = wps[k + 1].pos.z - to.z
        const nl = Math.hypot(nx, nz) || 1
        const lead = Math.min(remaining, TAKEOFF_LEAD)
        return new Vec3(to.x + nx / nl * lead, to.y, to.z + nz / nl * lead)
      }
      fromX = to.x
      fromZ = to.z
      k++
      t = 0
    }
  }

  // Planner cost still ahead, interpolated along the current segment.
  remainingCost (cursor, p) {
    const n = this.waypoints.length
    if (cursor >= n) return 0
    const last = this.waypoints[n - 1].g
    if (cursor === 0) return last - this.waypoints[0].g
    const a = this.waypoints[cursor - 1]
    const b = this.waypoints[cursor]
    let t = 0
    if (p) {
      const sx = b.pos.x - a.pos.x
      const sz = b.pos.z - a.pos.z
      const len2 = sx * sx + sz * sz
      if (len2 > 1e-6) t = Math.max(0, Math.min(1, ((p.x - a.pos.x) * sx + (p.z - a.pos.z) * sz) / len2))
    }
    return last - (a.g + (b.g - a.g) * t)
  }
}

function sharpTurn (fromX, fromZ, corner, next) {
  const ax = corner.x - fromX
  const az = corner.z - fromZ
  const bx = next.x - corner.x
  const bz = next.z - corner.z
  const la = Math.hypot(ax, az)
  const lb = Math.hypot(bx, bz)
  if (la < 1e-6 || lb < 1e-6) return false
  return (ax * bx + az * bz) / (la * lb) < Math.cos(Math.PI / 4)
}

module.exports = { Route, ANCHORS }
