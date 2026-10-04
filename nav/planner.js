'use strict'

const { Vec3 } = require('vec3')
const { emptyInput } = require('./util')
const { DIRS } = require('./primitives')

// A* over (x, y, z, movementState). It decides where to go: which cells, which
// gaps, which ladders. Velocity, exact direction and timing are left to the
// controller and the simulator.

const EDGE_FIELDS = ['H', 'state', 'kind', 'cost', 'dir', 'dist', 'jump', 'sprint', 'air', 'gap', 'runup', 'fall', 'confidence', 'margin', 'lazyGap', 'carry']

// carry: just landed a jump, still moving (node.carry holds the exact
// touchdown state); only chained jumps leave it. Paths report it as stand.
const STATES = ['stand', 'jumping', 'falling', 'ladder', 'water', 'carry']
const STATE_INDEX = Object.fromEntries(STATES.map((s, i) => [s, i]))

class Heap {
  constructor () {
    this.items = []
  }

  get size () {
    return this.items.length
  }

  push (node) {
    const a = this.items
    a.push(node)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].f <= node.f) break
      a[i] = a[p]
      a[i].heapIndex = i
      i = p
    }
    a[i] = node
    node.heapIndex = i
  }

  pop () {
    const a = this.items
    const top = a[0]
    const last = a.pop()
    if (a.length > 0) {
      a[0] = last
      this.down(0)
    }
    top.heapIndex = -1
    return top
  }

  update (node) {
    const a = this.items
    let i = node.heapIndex
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].f <= node.f) break
      a[i] = a[p]
      a[i].heapIndex = i
      i = p
    }
    a[i] = node
    node.heapIndex = i
  }

  down (i) {
    const a = this.items
    const node = a[i]
    const n = a.length
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let m = i
      let mf = node.f
      if (l < n && a[l].f < mf) { m = l; mf = a[l].f }
      if (r < n && a[r].f < mf) m = r
      if (m === i) break
      a[i] = a[m]
      a[i].heapIndex = i
      i = m
    }
    a[i] = node
    node.heapIndex = i
  }
}

class Planner {
  constructor (bot, terrain, sim, primitives) {
    this.bot = bot
    this.terrain = terrain
    this.sim = sim
    this.primitives = primitives
    // Extra cost on cells where following the route kept failing (set by
    // nav on stuck replans), so the next search looks elsewhere.
    this.penalties = new Map()
    this.weights = {
      edge: 1.2,
      tight: 0.12,
      lowCeiling: 0.3,
      fenceTop: 1.5,
      awkward: 2,
      partial: 0.15,
      turn: 0.35
    }
  }

  // Where the search starts, from the bot's real state. Airborne starts are
  // simulated to their landing so a replan mid-jump is still consistent.
  startNode () {
    const t = this.terrain
    const e = this.bot.entity
    const pos = e.position
    let state = 'stand'
    let g = 0
    let at = pos
    if (e.isInWater || e.isInLava) {
      state = 'water'
    } else {
      const feet = t.infoAt(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
      if (feet && feet.climbable) state = 'ladder'
      else if (!e.onGround) {
        state = e.velocity.y > 0 ? 'jumping' : 'falling'
        const s = this.sim.fromBot()
        const input = emptyInput()
        for (let i = 0; i < 80 && !s.onGround && !s.isInWater; i++) {
          this.sim.step(s, input, null)
          g++
          if (t.infoAt(Math.floor(s.pos.x), Math.floor(s.pos.y), Math.floor(s.pos.z))?.climbable) break
        }
        at = s.pos
      }
    }
    const cell = this.cellUnder(at, state)
    if (!cell) return null
    return {
      x: cell.x,
      y: cell.y,
      z: cell.z,
      H: cell.H ?? cell.y,
      state: cell.kind === 'ladder' ? 'ladder' : cell.kind === 'liquid' ? 'water' : 'stand',
      startState: state,
      g,
      kind: 'start'
    }
  }

  // The cell the body is really on: the feet column, or a neighbour whose edge
  // is holding the player up.
  cellUnder (pos, state) {
    const t = this.terrain
    const fx = Math.floor(pos.x)
    const fz = Math.floor(pos.z)
    const fy = Math.floor(pos.y + 1e-3)
    const own = t.cell(fx, fy, fz)
    if (state === 'water' && own.kind === 'liquid') return own
    if (own.kind === 'stand' || own.kind === 'ladder') return own
    let best = null
    let bestD = Infinity
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const y of [fy, fy - 1, fy + 1]) {
          const c = t.cell(fx + dx, y, fz + dz)
          if (c.kind !== 'stand' && c.kind !== 'ladder' && !(state === 'water' && c.kind === 'liquid')) continue
          const d = Math.hypot(fx + dx + 0.5 - pos.x, fz + dz + 0.5 - pos.z) + Math.abs((c.H ?? y) - pos.y)
          if (d < bestD) { bestD = d; best = c }
        }
      }
    }
    return bestD < 2 ? best : null
  }

  nodePenalty (cell) {
    if (cell.penalty != null) return cell.penalty
    const w = this.weights
    const t = this.terrain
    let p = 0
    if (cell.kind === 'stand') {
      p += w.edge * t.edgeExposure(cell.x, cell.y, cell.z, cell.H)
      p += w.tight * t.tightness(cell.x, cell.y, cell.z, cell.H)
      if (!cell.jumpRoom) p += w.lowCeiling
      if (cell.fenceTop) p += w.fenceTop
      if (cell.awkward) p += w.awkward
      if (cell.partial) p += w.partial
    }
    cell.penalty = p
    return p
  }

  // Time-sliced search. step(budget) expands up to `budget` nodes; budgets are
  // counted in expansions, not ms, so simulated runs stay deterministic.
  search (goal, { maxNodes = 80000 } = {}) {
    const planner = this
    const t = this.terrain
    this.primitives.refresh()
    const vh = this.primitives.vSprint * 1.35
    const start = this.startNode()
    const maps = STATES.map(() => new Map())
    const open = new Heap()
    let expanded = 0
    let done = null
    let best = null
    let bestFrontier = null

    const h = (n) => Math.hypot(goal.x + 0.5 - (n.x + 0.5), goal.z + 0.5 - (n.z + 0.5)) / vh + Math.max(0, goal.y - n.y) * 1.5
    const isGoal = (n) => n.x === goal.x && n.y === goal.y && n.z === goal.z

    if (!start) {
      done = { status: 'noStart', path: null }
    } else {
      start.f = start.g + h(start)
      start.h = h(start)
      start.parent = null
      maps[STATE_INDEX[start.state]].set(nodeKey(start), start)
      open.push(start)
      best = start
    }

    function finish (status, node, extra = {}) {
      done = { status, path: node ? reconstruct(node) : null, expanded, ...extra }
      return done
    }

    // Carry nodes are distinct per touchdown state.
    function nodeKey (m) {
      const k = t.key(m.x, m.y, m.z)
      return m.carry ? k + '|' + m.carry.key : k
    }

    // Standard A* relaxation of node -> m at path cost g.
    function relax (node, m, g) {
      const map = maps[STATE_INDEX[m.state]]
      const key = nodeKey(m)
      let succ = map.get(key)
      if (succ) {
        if (succ.closed || g >= succ.g) return
        for (const field of EDGE_FIELDS) succ[field] = m[field]
        succ.g = g
        succ.f = g + succ.h
        succ.parent = node
        if (succ.heapIndex >= 0) open.update(succ)
        else open.push(succ)
      } else {
        succ = { ...m, g, parent: node, closed: false }
        succ.h = h(succ)
        succ.f = g + succ.h
        map.set(key, succ)
        open.push(succ)
        if (succ.h < best.h) best = succ
      }
    }

    // budget: max expansions. deadline (performance.now() ms, live only):
    // checked before every expansion so a slice can't stall the client tick.
    function step (budget, deadline = Infinity) {
      if (done) return done
      let n = 0
      while (open.size > 0 && n < budget) {
        if (n > 0 && deadline !== Infinity && performance.now() >= deadline) break
        const node = open.pop()
        // Lazy edge evaluation. An unconfirmed jump waits in the queue as a
        // deferred relaxation at its lower-bound cost (full confidence). When
        // it comes up, confirm it; if it costs more, requeue it at the true
        // cost. Only confirmed costs ever reach the node table, so every
        // route to a node competes exactly as in eager A*.
        if (node.proposal) {
          if (!node.confirmed) {
            const lg = node.move.lazyGap
            const confidence = planner.primitives.confirmGap(lg.from, lg.target, lg.v)
            const extra = planner.primitives.confidenceCost(lg.ticks, confidence)
            node.move = { ...node.move, confidence, cost: node.move.cost + extra, lazyGap: null }
            node.confirmed = true
            if (extra > 0) {
              node.g += extra
              node.f += extra
              open.push(node)
              continue
            }
          }
          relax(node.parent, node.move, node.g)
          continue
        }
        node.closed = true
        n++
        expanded++
        if (isGoal(node)) return finish('found', node)
        if (expanded >= maxNodes) {
          return finish('partial', best !== start ? best : null)
        }
        const out = { frontier: false }
        const moves = planner.primitives.expand(node, out)
        if (out.frontier) {
          node.frontier = true
          if (!bestFrontier || node.h < bestFrontier.h || (node.h === bestFrontier.h && node.g < bestFrontier.g)) bestFrontier = node
        }
        for (const m of moves) {
          const key = t.key(m.x, m.y, m.z)
          const cell = t.cell(m.x, m.y, m.z)
          let cost = m.cost + planner.nodePenalty(cell) + (planner.penalties.get(key) || 0)
          if (node.dir != null && m.dir != null && m.dir !== node.dir) {
            cost += planner.weights.turn * turnAngle(node.dir, m.dir) / 45
          }
          const g = node.g + cost
          if (m.lazyGap) {
            const existing = maps[STATE_INDEX[m.state]].get(nodeKey(m))
            if (existing && (existing.closed || g >= existing.g)) continue
            // f uses the target's heuristic, exactly as the node itself would.
            open.push({ proposal: true, confirmed: false, parent: node, move: m, g, f: g + h(m) })
            continue
          }
          relax(node, m, g)
        }
      }
      if (open.size === 0) {
        if (bestFrontier && bestFrontier !== start) return finish('uncertain', bestFrontier)
        if (bestFrontier === start) return finish('waitChunks', null)
        return finish('noPath', null, { best: best && best !== start ? reconstruct(best) : null })
      }
      return null
    }

    function reconstruct (node) {
      const path = []
      for (let n = node; n; n = n.parent) {
        path.push({
          x: n.x,
          y: n.y,
          z: n.z,
          H: n.H,
          state: n.state === 'carry' ? 'stand' : n.state,
          carry: n.state === 'carry',
          kind: n.kind,
          dir: n.dir,
          jump: !!n.jump,
          sprint: n.sprint,
          air: n.air,
          gap: n.gap || 0,
          runup: n.runup || 0,
          fall: n.fall || 0,
          confidence: n.confidence ?? 1,
          g: n.g,
          pos: new Vec3(n.x + 0.5, n.H, n.z + 0.5)
        })
      }
      return path.reverse()
    }

    return {
      start,
      step,
      get done () { return done },
      get expanded () { return expanded }
    }
  }

  // Convenience for tests: run to completion.
  plan (goal, opts) {
    const s = this.search(goal, opts)
    let r = s.done
    while (!r) r = s.step(5000)
    return r
  }
}

function turnAngle (a, b) {
  const va = DIRS[a]
  const vb = DIRS[b]
  const aa = Math.atan2(va[1], va[0])
  const ab = Math.atan2(vb[1], vb[0])
  let d = Math.abs(aa - ab) * 180 / Math.PI
  if (d > 180) d = 360 - d
  return d
}

module.exports = { Planner, STATES }
