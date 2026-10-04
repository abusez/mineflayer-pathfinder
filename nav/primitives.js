'use strict'

const { Vec3 } = require('vec3')
const { f32, emptyInput, yawToward } = require('./util')
const { newLiving } = require('./vanillaClient/player')

// Movement primitives between planner nodes. Geometry proposes a move; a
// physics rollout of a skilled-player execution decides if it is possible and
// what it costs. Executing it for real is the controller's job.

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1]
]

// (0 - 0.08) * 0.98 in float math, what the client holds while standing.
const RESTING_MOTION_Y = -0.0784000015258789

const SAFE_FALL = 3
const MAX_FALL = 8
// Chained jumps from a carry node: at most 60° off the landing velocity.
const CARRY_COS = 0.5
// ...and only jumps of 3+ blocks: shorter ones need no momentum, and the
// landing's stand twin already covers them.
const CARRY_MIN_DIST2 = 9
const UNKNOWN_CELL = { kind: 'unknown' }
const MAX_RUNUP = 3

// Ground sprint speed in blocks/tick, by Speed level. Used for cost estimates.
function sprintSpeed (speedLevel) {
  return 0.2806 * (1 + 0.2 * speedLevel)
}

function maxRise (jumpBoost) {
  // Jump apex: 1.2522 at base, about +0.6 per Jump Boost level.
  return 1.2522 + 0.62 * jumpBoost
}

class Primitives {
  constructor (bot, terrain, sim) {
    this.bot = bot
    this.terrain = terrain
    this.sim = sim
    this.memo = new Map()
    // Transposition table: moves out of a node, per terrain version and
    // abilities. Re-searches (replans, better-route checks) re-expand the
    // same nodes; the moves are a pure function of node + terrain + abilities.
    this.expandMemo = new Map()
    // Landing scans: (column, top, depth) -> highest standing cell or null.
    this.landingMemo = new Map()
    this.memoVersion = -1
    this.memoAbilities = ''
    this.stats = { rollouts: 0, memoHits: 0 }
  }

  refresh () {
    const a = this.sim.abilities()
    this.abilities = a
    const health = typeof this.bot.health === 'number' ? this.bot.health : 20
    const sig = a.speed + ':' + a.jumpBoost + ':' + health
    if (this.memoVersion !== this.terrain.version || this.memoAbilities !== sig) {
      this.memo.clear()
      this.expandMemo.clear()
      this.landingMemo.clear()
      this.memoVersion = this.terrain.version
      this.memoAbilities = sig
    }
    this.vSprint = sprintSpeed(a.speed)
    this.rise = maxRise(a.jumpBoost)
    this.maxGap = 4 + a.speed + (a.jumpBoost > 0 ? 1 : 0)
  }

  // Swept body check along a straight segment between two column centres.
  corridorClear (ax, az, bx, bz, footY, height) {
    const t = this.terrain
    const dx = bx - ax
    const dz = bz - az
    const len = Math.hypot(dx, dz)
    const steps = Math.max(1, Math.ceil(len / 0.25))
    for (let i = 0; i <= steps; i++) {
      const cx = ax + dx * i / steps
      const cz = az + dz * i / steps
      const blocked = t.bodyBlocked(Math.floor(cx), Math.floor(cz), footY, cx, cz, height)
      if (blocked !== false) return false
    }
    return true
  }

  // Moves out of any node, through the transposition table. Results that
  // touched unloaded chunks are not cached: a chunk loading changes them
  // without a terrain version bump.
  expandKey (node) {
    return node.state + '|' + node.x + ',' + node.y + ',' + node.z + '|' + node.H + (node.carry ? '|' + node.carry.key : '')
  }

  validateKey (node, target, mode) {
    return node.x + ',' + node.y + ',' + node.z + '|' + target.x + ',' + target.y + ',' + target.z + '|' + mode + (node.carry ? '|' + node.carry.key : '')
  }

  expand (node, out) {
    const key = this.expandKey(node)
    const hit = this.expandMemo.get(key)
    if (hit) {
      this.stats.expandHits = (this.stats.expandHits || 0) + 1
      // Jumps confirmed since this was cached must look exactly as a fresh
      // expansion would build them now (same cost expression, no lazy flag).
      for (let i = 0; i < hit.length; i++) {
        const m = hit[i]
        if (m.lazyGap && m.lazyGap.v.confidence != null) hit[i] = this.confirmedMove(m)
      }
      return hit
    }
    // A carry node (landed a jump, still moving) only chains further jumps;
    // its stand twin covers everything else.
    const moves = node.state === 'carry'
      ? this.gapMoves(node, out)
      : node.state === 'ladder'
        ? this.expandLadder(node, out)
        : node.state === 'water'
          ? this.expandWater(node, out)
          : this.expandStand(node, out)
    if (!out.frontier) this.expandMemo.set(key, moves)
    return moves
  }

  confirmedMove (m) {
    const { ticks, gap, damage, v } = m.lazyGap
    const confidence = v.confidence
    const cost = ticks + this.confidenceCost(ticks, confidence) + 3 + 2 * (gap - 1) + 0 + damage * 12
    return { ...m, cost, confidence, lazyGap: null }
  }

  // All moves out of a standing node. Each: { x, y, z, H, state, kind, cost, ... }.
  // Sets out.frontier when an unloaded chunk was in the way.
  expandStand (node, out) {
    const t = this.terrain
    const { x, y, z, H } = node
    const moves = []
    for (let i = 0; i < DIRS.length; i++) {
      const [dx, dz] = DIRS[i]
      const diagonal = dx !== 0 && dz !== 0
      const nx = x + dx
      const nz = z + dz
      const dist = diagonal ? Math.SQRT2 : 1

      // Neighbour at the same level, one up, or (jump boost) higher.
      let foundLevel = false
      for (let ny = y + Math.ceil(this.rise); ny >= y - 1; ny--) {
        const c = t.cell(nx, ny, nz)
        if (c.kind === 'unknown') { out.frontier = true; foundLevel = true; break }
        if (c.kind === 'stand') {
          const rise = c.H - H
          if (rise > this.rise) continue
          if (rise < -0.6) break
          foundLevel = true
          const move = this.walkOrJump(node, c, dx, dz, dist, rise, diagonal)
          if (move) moves.push(move)
          break
        }
        if (c.kind === 'ladder' && ny <= y + 1) {
          foundLevel = true
          if (!diagonal && this.corridorClear(x + 0.5, z + 0.5, nx + 0.5, nz + 0.5, Math.max(H, c.H), 1.8)) {
            moves.push({ x: nx, y: ny, z: nz, H: c.H, state: 'ladder', kind: 'ladderEnter', cost: 3 + Math.max(0, c.H - H) * 8.5, dir: i })
          }
          break
        }
        if (ny === y && c.kind !== 'air') { foundLevel = true; break }
      }

      // Nothing walkable at this level: drop down, or jump across.
      if (!foundLevel) {
        const drop = this.dropMove(node, nx, nz, dx, dz, dist, diagonal, out)
        if (drop) moves.push(drop)
      }
    }
    for (const g of this.gapMoves(node, out)) moves.push(g)
    return moves
  }

  walkOrJump (node, c, dx, dz, dist, rise, diagonal) {
    const { x, z, H } = node
    const ax = x + 0.5
    const az = z + 0.5
    const bx = c.x + 0.5
    const bz = c.z + 0.5
    const footY = Math.max(H, c.H)
    if (diagonal) {
      // Corner cutting: the swept body must clear both side columns.
      if (!this.corridorClear(ax, az, bx, bz, footY, 1.8)) return null
    } else if (!this.corridorClear(ax, az, bx, bz, footY, 1.8)) {
      return null
    }
    let cost = dist / this.vSprint
    if (rise <= 0.6) {
      cost += Math.abs(rise) * 0.5
      return { x: c.x, y: c.y, z: c.z, H: c.H, state: 'stand', kind: rise > 0.01 ? 'step' : 'walk', cost, dir: DIRS.findIndex(d => d[0] === dx && d[1] === dz), dist, confidence: 1 }
    }
    // Higher than a step: stairs may still be walkable, otherwise jump.
    const v = this.validate(node, c, 'up', dx, dz)
    if (!v.ok) return null
    cost = v.ticks + (v.jump ? 2 : 0)
    return {
      x: c.x,
      y: c.y,
      z: c.z,
      H: c.H,
      state: 'stand',
      kind: v.jump ? 'jumpUp' : 'step',
      cost,
      dir: DIRS.findIndex(d => d[0] === dx && d[1] === dz),
      dist,
      jump: v.jump,
      confidence: v.confidence
    }
  }

  dropMove (node, nx, nz, dx, dz, dist, diagonal, out) {
    const t = this.terrain
    const { x, y, z, H } = node
    const first = t.cell(nx, y, nz)
    if (first.kind === 'unknown') { out.frontier = true; return null }
    if (first.kind !== 'air') return null
    const land = t.landing(nx, y - 1, nz, MAX_FALL + 1)
    if (land.unknown) { out.frontier = true; return null }
    if (land.y == null || land.liquid || land.hazard) return null
    const c = land.cell
    const fall = H - c.H
    if (fall > MAX_FALL) return null
    if (!this.corridorClear(x + 0.5, z + 0.5, nx + 0.5, nz + 0.5, H, 1.8)) return null
    const health = typeof this.bot.health === 'number' ? this.bot.health : 20
    // EntityLivingBase.fall: damage = ceil(distance - 3 - jumpBoostLevel).
    const damage = Math.max(0, Math.ceil(fall - SAFE_FALL - this.abilities.jumpBoost))
    if (damage > 0 && damage >= health - 4) return null
    const fallTicks = 5 * Math.sqrt(Math.max(0, fall))
    const cost = dist / this.vSprint + fallTicks + damage * 12 + fall * 0.4
    return {
      x: nx,
      y: c.y,
      z: nz,
      H: c.H,
      state: c.kind === 'ladder' ? 'ladder' : 'stand',
      kind: 'drop',
      cost,
      dir: DIRS.findIndex(d => d[0] === dx && d[1] === dz),
      dist,
      fall,
      confidence: 1
    }
  }

  // Parkour jumps, using the legacy finder's candidate set (legacy/parkour.js):
  // straight 2-4 blocks, diagonal 1x1 when the diagonal walk is blocked, the
  // 2+1 side gaps, plus longer reaches when Speed or Jump Boost allow. A
  // candidate needs a standing cell, a clear parabolic arc, and something
  // to jump over. The physics rollout then picks the technique and the
  // confidence; jumps it cannot land stay available as "unverified" at a
  // high cost instead of being silently dropped.
  gapMoves (node, out, report = null) {
    const t = this.terrain
    const { x, y, z, H } = node
    const moves = []
    const start = t.cell(x, y, z)
    if (!start.jumpRoom) {
      if (report) report.push({ reason: 'no head room for a jump here' })
      return moves
    }
    // With momentum (a carry node), only jumps roughly along the velocity.
    const carry = node.carry
    const vx = carry ? carry.state.motion.x : 0
    const vz = carry ? carry.state.motion.z : 0
    const speed = Math.hypot(vx, vz)
    for (const [dx, dz, need] of this.gapOffsets()) {
      if (carry && (dx * dx + dz * dz < CARRY_MIN_DIST2 || (dx * vx + dz * vz) < CARRY_COS * speed * Math.hypot(dx, dz))) continue
      const move = this.tryGap(node, dx, dz, out, report, need)
      // Planning only takes jumps the physics can land; the rest are listed
      // in the report for inspection.
      if (!move || !(move.verified || report)) continue
      moves.push(move)
      // The same landing, still moving: chained jumps start from here.
      if (move.verified && move.end && !report) moves.push(this.carryMove(move))
    }
    return moves
  }

  // The twin of a landed jump that keeps its exact touchdown state (position,
  // velocity, sprint), so the next jump can use the momentum.
  carryMove (move) {
    const e = move.end
    const q = (v, k) => Math.round(v * k)
    const key = q(e.pos.x - move.x, 16) + ',' + q(e.pos.z - move.z, 16) + ',' +
      q(e.motion.x, 100) + ',' + q(e.motion.z, 100) + ',' + (e.living.sprinting ? 1 : 0)
    return { ...move, state: 'carry', carry: { state: e, key }, end: null }
  }

  // Ticks in the air for a jump that lands `drop` blocks lower (1.8 jump
  // velocity, gravity and drag).
  airTicks (drop) {
    let vy = 0.42 + 0.1 * this.abilities.jumpBoost
    let y = 0
    let t = 0
    while (t < 200) {
      y += vy
      vy = (vy - 0.08) * 0.98
      t++
      if (vy < 0 && y <= -drop) return t
    }
    return t
  }

  // Furthest landing (column centre to centre) worth simulating for a jump
  // that drops `drop` blocks: the flat reach, scaled by the extra air time.
  reachFor (drop) {
    return (this.maxGap + 1.15) * this.airTicks(Math.max(0, drop)) / this.airTicks(0)
  }

  // Every landing column within jump reach, at any angle, nearest first, as
  // [dx, dz, need]. Columns past the flat reach are only reachable with a
  // drop of at least `need` blocks. The physics rollout decides which jumps
  // can really be landed.
  gapOffsets () {
    const sig = this.maxGap + ':' + this.abilities.jumpBoost
    if (this._offsetsSig === sig) return this._offsets
    const flat = this.reachFor(0)
    const reach = this.reachFor(MAX_FALL)
    const R = Math.ceil(reach)
    const list = []
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const d = Math.hypot(dx, dz)
        // Neighbours are walks/steps, except the 1x1 diagonal (tryGap
        // keeps it only when the diagonal walk is blocked).
        if (d < 1.4 || d > reach) continue
        let need = 0
        if (d > flat) while (need < MAX_FALL && this.reachFor(need) < d) need++
        list.push([dx, dz, need])
      }
    }
    list.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]) || p[0] - q[0] || p[1] - q[1])
    this._offsetsSig = sig
    this._offsets = list
    return list
  }

  tryGap (node, dx, dz, out, report, need = 0) {
    const t = this.terrain
    const { x, y, z, H } = node
    const nx = x + dx
    const nz = z + dz
    const note = (reason, extra = {}) => {
      if (report) report.push({ x: nx, z: nz, reason, ...extra })
      return null
    }
    const diagonal1 = Math.abs(dx) === 1 && Math.abs(dz) === 1
    const dist = Math.hypot(dx, dz)
    const ux = dx / dist
    const uz = dz / dist

    // Landing: highest standing cell from +rise (or the drop this distance
    // needs) down to the fall limit.
    const top = need > 0 ? Math.min(y + Math.ceil(this.rise), Math.floor(y - need) + 1) : y + Math.ceil(this.rise)
    const c = this.landingIn(nx, nz, top, y - MAX_FALL)
    if (c === UNKNOWN_CELL) { out.frontier = true; return note('chunk not loaded') }
    if (!c) {
      return report ? note('nothing to land on', { routine: true, cells: this.describeColumn(nx, nz, top, Math.max(top - 6, y - MAX_FALL)) }) : null
    }
    const rise = c.H - H
    if (rise > this.rise - 0.2) return note('too high', { y: c.y })
    if (dist > this.reachFor(H - c.H)) return note('too far for the drop', { y: c.y, routine: true })
    // EntityLivingBase.fall: damage = ceil(distance - 3 - jumpBoostLevel).
    // Damage is costed, like a plain drop, while it leaves 4 HP to spare.
    const fall = H + 1.25 - c.H
    const damage = Math.max(0, Math.ceil(fall - SAFE_FALL - this.abilities.jumpBoost))
    const health = typeof this.bot.health === 'number' ? this.bot.health : 20
    if (H - c.H > MAX_FALL || (damage > 0 && damage >= health - 4)) return note('fall too far', { y: c.y })

    // Take off at the edge: the next column toward the jump is not floor at
    // this level (otherwise a step closer gives the same jump, shorter).
    if (!diagonal1 && this.walkableAt(Math.floor(x + 0.5 + ux * 0.8), y, Math.floor(z + 0.5 + uz * 0.8), H)) return note('not at the takeoff edge', { y: c.y, routine: true })
    // Land on the near edge: the column just before the landing is not floor
    // at the landing height (otherwise a shorter jump reaches it).
    const bx = Math.floor(nx + 0.5 - ux * 0.8)
    const bz = Math.floor(nz + 0.5 - uz * 0.8)
    if (!diagonal1 && !(bx === x && bz === z) && this.walkableAt(bx, c.y, bz, c.H)) return note('a shorter jump lands there', { y: c.y, routine: true })

    // Parkour only: something on the line has to be jumped over. A plain
    // walk (same level, every column floored) is not a parkour jump.
    if (diagonal1) {
      if (this.diagonalWalkable(x, y, z, dx, dz, H)) return note('walkable, no jump needed', { y: c.y, routine: true })
    } else if (!this.needsJump(x, z, nx, nz, ux, uz, y, H, c.H, dist)) {
      return note('walkable, no jump needed', { y: c.y, routine: true })
    }

    // Never jump over a stepping stone: floor on the line near either end's
    // height means the jump should land there first.
    if (!diagonal1 && this.floorOnLine(x, z, nx, nz, ux, uz, y, H, c.H, dist)) return note('a stepping stone is in the way', { y: c.y, routine: true })
    // The body along the real jump curve (Jump Boost raises the apex).
    if (!this.arcClear(x, z, H, nx, nz, c.H)) {
      return note('arc blocked', { y: c.y, hit: report ? this.arcHit(x, z, H, nx, nz, c.H) : null })
    }
    const v = this.validate(node, c, 'gap', ux, uz)
    const verified = v.ok
    // Inspection (report) wants real numbers now; planning confirms lazily.
    if (verified && report) this.confirmGap(node, c, v)
    const lazy = verified && v.confidence == null
    // Unconfirmed: cost at full confidence, a lower bound of the real cost.
    const confidence = verified ? (lazy ? 1 : v.confidence) : 0
    const ticks = verified ? v.ticks : Math.ceil(dist / this.vSprint) + 8
    const gap = Math.max(1, Math.round(dist - 1))
    const cost = ticks + this.confidenceCost(ticks, confidence) + 3 + 2 * (gap - 1) +
      (verified ? 0 : 60) + damage * 12
    if (report) report.push({ x: nx, y: c.y, z: nz, reason: verified ? 'ok' : 'physics could not land it', gap, rise, confidence })
    return {
      x: nx,
      y: c.y,
      z: nz,
      H: c.H,
      state: 'stand',
      kind: 'gap',
      cost,
      dir: nearestDir(ux, uz),
      dist,
      gap,
      jump: true,
      sprint: verified ? v.sprint : dist > 2.5,
      air: verified ? v.air : 'forward',
      runup: verified ? v.runup : 0,
      confidence,
      verified,
      margin: v.margin,
      end: verified ? v.end : null,
      lazyGap: lazy ? { from: { x: node.x, y: node.y, z: node.z, H: node.H }, target: c, v, ticks, gap, damage } : null
    }
  }

  // Highest standing cell in a column from top down to bottom, null, or
  // UNKNOWN_CELL (an unloaded chunk came first). Unknown results are not
  // cached: a chunk loading changes them without a terrain version bump.
  landingIn (x, z, top, bottom) {
    const key = this.terrain.key(x, top, z) * 16 + (top - bottom)
    const hit = this.landingMemo.get(key)
    if (hit !== undefined) return hit
    const t = this.terrain
    let found = null
    for (let ny = top; ny >= bottom; ny--) {
      const k = t.cell(x, ny, z)
      if (k.kind === 'unknown') return UNKNOWN_CELL
      if (k.kind === 'stand') { found = k; break }
    }
    this.landingMemo.set(key, found)
    return found
  }

  walkableAt (x, y, z, H) {
    for (const cy of [y, y - 1, y + 1]) {
      const c = this.terrain.cell(x, cy, z)
      if (c.kind === 'stand' && Math.abs(c.H - H) <= 0.6) return true
    }
    return false
  }

  // The 1x1 diagonal is a walk when both shoulders and the corner are open.
  diagonalWalkable (x, y, z, dx, dz, H) {
    const t = this.terrain
    for (const [cx, cz] of [[x + dx, z], [x, z + dz], [x + dx, z + dz]]) {
      const c = t.cell(cx, y, cz)
      if (c.kind !== 'stand' || Math.abs(c.H - H) > 0.6) return false
    }
    return this.corridorClear(x + 0.5, z + 0.5, x + dx + 0.5, z + dz + 0.5, H, 1.8)
  }

  floorOnLine (x, z, nx, nz, ux, uz, y, H, HB, len) {
    const t = this.terrain
    const lo = Math.min(H, HB) - 0.6
    const hi = Math.max(H, HB) + 0.6
    for (let d = 0.5; d < len - 0.3; d += 0.5) {
      const cx = Math.floor(x + 0.5 + ux * d)
      const cz = Math.floor(z + 0.5 + uz * d)
      if ((cx === x && cz === z) || (cx === nx && cz === nz)) continue
      for (const cy of [y + 1, y, y - 1]) {
        const c = t.cell(cx, cy, cz)
        if (c.kind === 'stand' && c.H >= lo && c.H <= hi) return true
      }
    }
    return false
  }

  // Some column on the line is not walkable at the takeoff level (a gap, a
  // pit, or a step too high to walk).
  needsJump (x, z, nx, nz, ux, uz, y, H, HB, len) {
    const t = this.terrain
    let prevH = H
    for (let d = 0.5; d < len - 0.3; d += 0.5) {
      const cx = Math.floor(x + 0.5 + ux * d)
      const cz = Math.floor(z + 0.5 + uz * d)
      if ((cx === x && cz === z) || (cx === nx && cz === nz)) continue
      let floor = null
      for (const cy of [y + 1, y, y - 1]) {
        const c = t.cell(cx, cy, cz)
        if (c.kind === 'stand') { floor = c.H; break }
      }
      if (floor == null || Math.abs(floor - prevH) > 0.6) return true
      prevH = floor
    }
    return Math.abs(HB - prevH) > 0.6
  }

  // Height above takeoff, per tick, of a 1.8 jump that comes down `drop`
  // blocks lower (negative: higher). The last entry is the landing height.
  jumpProfile (drop) {
    const key = drop + ':' + this.abilities.jumpBoost
    this._profiles = this._profiles || new Map()
    let prof = this._profiles.get(key)
    if (prof) return prof
    prof = [0]
    let vy = 0.42 + 0.1 * this.abilities.jumpBoost
    let y = 0
    for (let t = 0; t < 200; t++) {
      y += vy
      vy = (vy - 0.08) * 0.98
      if (vy < 0 && y <= -drop) break
      prof.push(y)
    }
    prof.push(-drop)
    this._profiles.set(key, prof)
    return prof
  }

  // Arc test: the body swept along the real jump height curve (rise to the
  // apex, then fall), moving at a steady pace from takeoff centre to landing
  // centre. Returns the first box hit ('unknown' in an unloaded chunk), or
  // null when clear.
  arcSweep (x, z, H, nx, nz, HB, wantHit) {
    const t = this.terrain
    const x0 = x + 0.5
    const z0 = z + 0.5
    const x1 = nx + 0.5
    const z1 = nz + 0.5
    const prof = this.jumpProfile(H - HB)
    const T = prof.length - 1
    const sub = 3
    for (let i = 0; i <= T * sub; i++) {
      const k = Math.floor(i / sub)
      const r = i / sub - k
      const dy = k < T ? prof[k] + (prof[k + 1] - prof[k]) * r : prof[T]
      const f = i / (T * sub)
      const px = x0 + (x1 - x0) * f
      const pz = z0 + (z1 - z0) * f
      const py = H + dy
      if (wantHit) {
        const hit = t.bodyHit(px, pz, py)
        if (hit) return hit
      } else if (t.bodyBlocked(Math.floor(px), Math.floor(pz), py, px, pz) !== false) {
        return true
      }
    }
    return null
  }

  arcClear (x, z, H, nx, nz, HB) {
    return !this.arcSweep(x, z, H, nx, nz, HB, false)
  }

  // For reports: the first block box the arc sweep hits.
  arcHit (x, z, H, nx, nz, HB) {
    return this.arcSweep(x, z, H, nx, nz, HB, true)
  }

  // For reports: block names in a column from y0 down to y1, with cell kinds.
  describeColumn (x, z, y0, y1) {
    const t = this.terrain
    const out = []
    for (let y = y0; y >= y1; y--) {
      const info = t.infoAt(x, y, z)
      out.push(`${y}:${info ? info.name : '?'}/${t.cell(x, y, z).kind}`)
    }
    return out.join(' ')
  }

  // Every parkour jump from a standing cell, for inspection. With report,
  // also lists rejected candidates and why.
  jumpTargets (node, report = null) {
    this.refresh()
    return this.gapMoves(node, { frontier: false }, report)
  }

  // Ladder node: climb, descend, or step off onto a neighbour.
  expandLadder (node, out) {
    const t = this.terrain
    const { x, y, z } = node
    const moves = []
    const up = t.cell(x, y + 1, z)
    if (up.kind === 'unknown') out.frontier = true
    if (up.kind === 'ladder') moves.push({ x, y: y + 1, z, H: y + 1, state: 'ladder', kind: 'climb', cost: 8.5, confidence: 1 })
    const down = t.cell(x, y - 1, z)
    if (down.kind === 'unknown') out.frontier = true
    if (down.kind === 'ladder') moves.push({ x, y: y - 1, z, H: y - 1, state: 'ladder', kind: 'climbDown', cost: 6.7, confidence: 1 })
    else if (down.kind === 'stand') moves.push({ x, y: y - 1, z, H: down.H, state: 'stand', kind: 'climbDown', cost: 6.7, confidence: 1 })
    for (let i = 0; i < 4; i++) {
      const [dx, dz] = DIRS[i]
      for (const ny of [y + 1, y]) {
        const c = t.cell(x + dx, ny, z + dz)
        if (c.kind === 'unknown') { out.frontier = true; continue }
        if (c.kind !== 'stand') continue
        if (c.H - (node.H ?? y) > 1.01) continue
        if (!this.corridorClear(x + 0.5, z + 0.5, c.x + 0.5, c.z + 0.5, Math.max(c.H, y), 1.8)) continue
        moves.push({ x: c.x, y: c.y, z: c.z, H: c.H, state: 'stand', kind: 'ladderExit', cost: 4 + (ny > y ? 8.5 : 0), dir: i, dist: 1, confidence: 1 })
        break
      }
    }
    // A standing cell in the same column above the ladder top.
    const above = t.cell(x, y + 1, z)
    if (above.kind === 'stand') moves.push({ x, y: y + 1, z, H: above.H, state: 'stand', kind: 'climb', cost: 8.5, confidence: 1 })
    return moves
  }

  // Swimming: only used when the bot is already in a liquid.
  expandWater (node, out) {
    const t = this.terrain
    const { x, y, z } = node
    const moves = []
    for (let i = 0; i < 4; i++) {
      const [dx, dz] = DIRS[i]
      for (let ny = y + 1; ny >= y - 1; ny--) {
        const c = t.cell(x + dx, ny, z + dz)
        if (c.kind === 'unknown') { out.frontier = true; continue }
        if (c.kind === 'liquid') { moves.push({ x: c.x, y: ny, z: c.z, H: ny, state: 'water', kind: 'swim', cost: 12, dir: i, dist: 1, confidence: 1 }); break }
        if (c.kind === 'stand' && c.H - y <= 1.3) { moves.push({ x: c.x, y: c.y, z: c.z, H: c.H, state: 'stand', kind: 'swimExit', cost: 10, dir: i, dist: 1, confidence: 1 }); break }
      }
    }
    const up = t.cell(x, y + 1, z)
    if (up.kind === 'liquid') moves.push({ x, y: y + 1, z, H: y + 1, state: 'water', kind: 'swim', cost: 8, confidence: 1 })
    if (up.kind === 'stand') moves.push({ x, y: y + 1, z, H: up.H, state: 'stand', kind: 'swimExit', cost: 8, confidence: 1 })
    return moves
  }

  // --- physics validation --------------------------------------------------

  // Straight run-up behind the takeoff along the jump direction (ux, uz).
  runupLength (node, ux, uz) {
    const t = this.terrain
    let r = 0
    for (let k = 1; k <= MAX_RUNUP; k++) {
      const px = node.x + 0.5 - ux * k
      const pz = node.z + 0.5 - uz * k
      const c = t.cell(Math.floor(px), node.y, Math.floor(pz))
      if (c.kind !== 'stand' || Math.abs(c.H - node.H) > 0.01) break
      if (!this.corridorClear(px, pz, node.x + 0.5, node.z + 0.5, node.H, 1.8)) break
      r = k
    }
    return r
  }

  validate (node, target, mode, dx, dz, d = 1) {
    const key = this.validateKey(node, target, mode)
    const hit = this.memo.get(key)
    if (hit) {
      this.stats.memoHits++
      return hit
    }
    const result = mode === 'up' ? this.validateUp(node, target, dx, dz) : this.validateGap(node, target, dx, dz)
    this.memo.set(key, result)
    return result
  }

  validateUp (node, target, dx, dz) {
    // Stairs and similar: does plain walking get there?
    const walk = this.rollout(node, target, { jumpMode: 'never', sprint: false, runup: 0, maxTicks: 30 })
    if (walk.ok) return { ok: true, jump: false, ticks: walk.ticks, confidence: 1 }
    const jump = this.rollout(node, target, { jumpMode: 'edge', sprint: false, runup: 0 })
    if (!jump.ok) return { ok: false }
    let passed = 0
    const trials = [{ yawOffset: 4 }, { yawOffset: -4 }, { lateral: 0.15 }, { lateral: -0.15 }]
    for (const trial of trials) {
      if (this.rollout(node, target, { jumpMode: 'edge', sprint: false, runup: 0, ...trial }).ok) passed++
    }
    return { ok: true, jump: true, ticks: jump.ticks, confidence: 0.5 + 0.5 * passed / trials.length }
  }

  // A skilled player can sprint-jump, walk-jump, or let go of the keys in the
  // air to land short. Try the fast way first and keep the first that lands.
  validateGap (node, target, dx, dz) {
    const runup = node.carry ? 0 : this.runupLength(node, dx, dz)
    // Still moving from the last jump: take off at once, or run to the edge.
    const start = node.carry ? node.carry.state : null
    const modes = start ? [
      { sprint: true, jumpMode: 'now', start },
      { sprint: true, jumpMode: 'edge', start },
      { sprint: true, jumpMode: 'now', air: 'release', releaseAfter: 6, start }
    ] : [
      { sprint: true, runup, air: 'forward' },
      { sprint: true, runup, air: 'release' },
      // Late release: high arcs (Jump Boost) carry too far on full sprint.
      { sprint: true, runup, air: 'release', releaseAfter: 6 },
      { sprint: true, runup, air: 'release', releaseAfter: 10 },
      { sprint: false, runup: 0, air: 'forward' },
      { sprint: false, runup: 0, air: 'release' },
      { sprint: false, runup: 0, air: 'brake' }
    ]
    for (const mode of modes) {
      const base = this.rollout(node, target, { jumpMode: 'edge', ...mode })
      if (!base.ok) continue
      // Confidence (the perturbation trials) is filled in lazily by
      // confirmGap: most validated jumps are never taken by A*.
      return {
        ok: true,
        jump: true,
        sprint: mode.sprint,
        // A late release is the controller's own overshoot control, not an
        // immediate let-go.
        air: mode.releaseAfter ? 'late' : mode.air,
        runup: mode.runup,
        ticks: base.airTicks + 1,
        margin: base.margin,
        end: base.end,
        confidence: null,
        mode
      }
    }
    return { ok: false }
  }

  // The perturbation trials for a validated jump: how many small execution
  // errors it tolerates. Cached on the (memoised) validation result.
  confirmGap (node, target, v) {
    if (v.confidence != null) return v.confidence
    const trials = [
      { yawOffset: 3 },
      { yawOffset: -3 },
      { lateral: 0.12 },
      { lateral: -0.12 },
      { jumpEarly: 1 }
    ]
    let passed = 0
    for (const trial of trials) {
      if (this.rollout(node, target, { jumpMode: 'edge', ...v.mode, ...trial }).ok) passed++
    }
    v.confidence = passed / trials.length
    return v.confidence
  }

  // The part of a jump's cost that depends on confidence.
  confidenceCost (ticks, confidence) {
    return ticks * 3 * (1 - confidence) + (confidence < 0.6 ? 40 : 0)
  }

  // Scripted skilled execution from node centre (minus run-up) to target.
  // jumpMode: 'edge' (last tick with ground under it), 'now' (first ground
  // tick, for chaining off a landing) or 'never'. start: continue from this
  // simulator state (a landing with momentum) instead of standing at the
  // node centre.
  rollout (node, target, { jumpMode, sprint, runup = 0, air = 'forward', releaseAfter = 0, yawOffset = 0, lateral = 0, jumpEarly = 0, maxTicks = 60, start = null }) {
    this.stats.rollouts++
    const sim = this.sim
    const ax = node.x + 0.5
    const az = node.z + 0.5
    const tx = target.x + 0.5
    const tz = target.z + 0.5
    const len = Math.hypot(tx - ax, tz - az)
    const ux = (tx - ax) / len
    const uz = (tz - az) / len
    let s
    if (start) {
      s = sim.clone(start)
      s.pos.x -= uz * lateral
      s.pos.z += ux * lateral
    } else {
      s = this.freshState(ax - ux * runup - uz * lateral, node.H, az - uz * runup + ux * lateral)
    }
    const input = emptyInput()
    input.forward = true
    input.sprint = sprint && this.canSprint()
    const yaw = yawToward(tx - s.pos.x, tz - s.pos.z) + yawOffset
    let ticks = 0
    let jumped = false
    let airTicks = 0
    const lowest = Math.min(node.H, target.H) - 1.5

    // No-jump look-ahead states for the edge test. Inputs don't change before
    // the jump, so when the bot doesn't jump, the first look-ahead state IS
    // the next state: reuse it instead of simulating that tick twice.
    const ahead = []
    while (ticks < maxTicks) {
      let jumpNow = false
      let reused = null
      if (jumpMode === 'now' && !jumped && s.onGround && ticks >= jumpEarly) {
        jumpNow = true
      } else if (jumpMode === 'edge' && !jumped && s.onGround) {
        // Jump on the last tick that still has ground under it, or into a face.
        while (ahead.length <= jumpEarly) {
          const from = ahead.length ? ahead[ahead.length - 1] : s
          if (ahead.length && (!from.onGround || from.isCollidedHorizontally)) break
          ahead.push(sim.step(sim.clone(from), input, yaw))
        }
        for (const p of ahead) {
          if (!p.onGround || p.isCollidedHorizontally) { jumpNow = true; break }
        }
        if (!jumpNow) reused = ahead.shift()
        else ahead.length = 0
      }
      if (jumpNow) {
        input.jump = true
        jumped = true
      }
      if (reused) s = reused
      else sim.step(s, input, yaw)
      input.jump = false
      if (jumped && air !== 'forward' && airTicks >= releaseAfter) {
        input.forward = false
        input.sprint = false
        input.back = air === 'brake'
      }
      ticks++
      if (jumped) airTicks++
      if (s.onGround && this.landedOn(s, target)) {
        // How far past the target's near edge the centre came down.
        const along = (s.pos.x - (tx - ux * 0.5)) * ux + (s.pos.z - (tz - uz * 0.5)) * uz
        return { ok: true, ticks, airTicks, margin: along, end: sim.clone(s) }
      }
      // Came down somewhere else after the jump.
      if (s.onGround && jumped && airTicks > 1) return { ok: false }
      if (s.pos.y < lowest) return { ok: false }
    }
    return { ok: false }
  }

  landedOn (s, target) {
    if (Math.abs(s.pos.y - target.H) > 0.001) return false
    const x = s.pos.x
    const z = s.pos.z
    // Supported when the 0.6 wide box overlaps the target column...
    if (x > target.x - 0.3 && x < target.x + 1.3 && z > target.z - 0.3 && z < target.z + 1.3) return true
    // ...or lands further along the same platform, close to the target.
    // Same limit the controller uses to count a landing as reached.
    if (Math.hypot(x - target.x - 0.5, z - target.z - 0.5) >= 1.5) return false
    const c = this.terrain.cell(Math.floor(x), target.y, Math.floor(z))
    return c.kind === 'stand' && Math.abs(c.H - target.H) < 0.001
  }

  canSprint () {
    return typeof this.bot.food !== 'number' || this.bot.food > 6
  }

  freshState (x, y, z) {
    const e = this.bot.entity
    return {
      pos: new Vec3(x, y, z),
      // A player at rest on the ground still carries one tick of gravity.
      motion: new Vec3(0, RESTING_MOTION_Y, 0),
      onGround: true,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: true,
      jumpTicks: 0,
      jumpQueued: false,
      fireworkRocketDuration: 0,
      attributes: e.attributes,
      yawDegrees: f32(0),
      pitchDegrees: f32(0),
      control: emptyInput(),
      jumpBoost: this.abilities.jumpBoost,
      depthStrider: 0,
      living: newLiving(),
      prevSprint: false
    }
  }
}

function nearestDir (ux, uz) {
  let best = 0
  let bestDot = -Infinity
  for (let i = 0; i < DIRS.length; i++) {
    const [dx, dz] = DIRS[i]
    const l = Math.hypot(dx, dz)
    const d = (dx * ux + dz * uz) / l
    if (d > bestDot) { bestDot = d; best = i }
  }
  return best
}

module.exports = { Primitives, DIRS, sprintSpeed, maxRise }
