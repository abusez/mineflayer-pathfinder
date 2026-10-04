'use strict'

const { Movements } = require('mineflayer-pathfinder')
const Move = require('mineflayer-pathfinder/lib/move')
const Vec3 = require('vec3')

const HALF = 0.3
const HEIGHT = 1.8
const JUMP_RISE = 1.25
const CENTER = 0.15
const SAMPLES = 8

const CARDINALS = [
  { x: -1, z: 0 },
  { x: 1, z: 0 },
  { x: 0, z: -1 },
  { x: 0, z: 1 }
]

const DIAGONALS = [
  { x: -1, z: -1 },
  { x: -1, z: 1 },
  { x: 1, z: -1 },
  { x: 1, z: 1 }
]

const SIDE_GAPS = [
  [2, 1], [2, -1], [-2, 1], [-2, -1],
  [1, 2], [1, -2], [-1, 2], [-1, -2]
]

function cellKey (node) {
  const x = Number.isFinite(node.cellX) ? node.cellX : Math.floor(node.x)
  const y = Number.isFinite(node.cellY) ? node.cellY : Math.floor(node.y)
  const z = Number.isFinite(node.cellZ) ? node.cellZ : Math.floor(node.z)
  return x + ',' + y + ',' + z
}

function feetOf (pos) {
  return {
    x: Math.floor(pos.x),
    y: Math.floor(pos.y + 0.05),
    z: Math.floor(pos.z)
  }
}

function sameCell (a, b) {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

function isJumpKind (kind) {
  return kind === 'step' || kind === 'gap' || kind === 'drop'
}

class ParkourMovements extends Movements {
  block (x, y, z) {
    try {
      return this.bot.blockAt(new Vec3(x, y, z), false)
    } catch {
      return null
    }
  }

  isClimb (block) {
    return !!block && (block.name === 'ladder' || block.name === 'vine')
  }

  climbAt (x, y, z) {
    return this.isClimb(this.block(x, y, z))
  }

  isLiquid (block) {
    return !!block && this.liquids.has(block.type)
  }

  // True when the player box intersects a solid. Shapes that only reach the
  // feet are the floor being stood on. Missing chunks count as blocked while
  // planning and are ignored while rechecking a route already being walked.
  hitsBox (minX, minY, minZ, maxX, maxY, maxZ, feetY, allowClimb, missing) {
    const x0 = Math.floor(minX)
    const x1 = Math.floor(maxX - 1e-4)
    const y0 = Math.floor(minY)
    const y1 = Math.floor(maxY - 1e-4)
    const z0 = Math.floor(minZ)
    const z1 = Math.floor(maxZ - 1e-4)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const block = this.block(x, y, z)
          if (!block) {
            if (missing === 'block') return true
            continue
          }
          if (allowClimb && this.isClimb(block)) continue
          if (this.isLiquid(block)) return true
          if (!block.shapes || block.shapes.length === 0) continue
          for (const shape of block.shapes) {
            if (y + shape[4] <= feetY + 0.001) continue
            if (minX < x + shape[3] && maxX > x + shape[0] &&
              minY < y + shape[4] && maxY > y + shape[1] &&
              minZ < z + shape[5] && maxZ > z + shape[2]) return true
          }
        }
      }
    }
    return false
  }

  bodyClear (x, y, z, allowClimb = false, missing = 'block') {
    const px = x + 0.5
    const pz = z + 0.5
    return !this.hitsBox(px - HALF, y + 0.02, pz - HALF, px + HALF, y + HEIGHT, pz + HALF, y, allowClimb, missing)
  }

  // Ceiling room for a jump. The head peaks about 1.25 above a standing head.
  headroom (x, y, z, missing = 'block') {
    const px = x + 0.5
    const pz = z + 0.5
    return !this.hitsBox(
      px - HALF, y + 0.02, pz - HALF,
      px + HALF, y + JUMP_RISE + HEIGHT, pz + HALF,
      y, false, missing
    )
  }

  standable (x, y, z) {
    const below = this.block(x, y - 1, z)
    if (!below || this.isClimb(below) || this.isLiquid(below)) return false
    if (!below.shapes || below.shapes.length === 0) return false
    for (const shape of below.shapes) {
      const wide = (shape[3] - shape[0]) > 0.5 && (shape[5] - shape[2]) > 0.5
      if (wide && shape[4] >= 0.9) return true
    }
    return false
  }

  arcClear (from, to, rise, missing = 'block') {
    const x0 = from.x + 0.5
    const z0 = from.z + 0.5
    const x1 = to.x + 0.5
    const z1 = to.z + 0.5
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES
      const x = x0 + (x1 - x0) * t
      const z = z0 + (z1 - z0) * t
      const y = from.y + (to.y - from.y) * t + 4 * rise * t * (1 - t)
      if (this.hitsBox(x - HALF, y + 0.02, z - HALF, x + HALF, y + HEIGHT, z + HALF, y, false, missing)) return false
    }
    return true
  }

  arcFromPos (pos, to, rise, missing, allowClimb = false) {
    const x1 = to.x + 0.5
    const z1 = to.z + 0.5
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES
      const x = pos.x + (x1 - pos.x) * t
      const z = pos.z + (z1 - pos.z) * t
      const y = pos.y + (to.y - pos.y) * t + 4 * rise * t * (1 - t)
      if (this.hitsBox(x - HALF, y + 0.02, z - HALF, x + HALF, y + HEIGHT, z + HALF, y, allowClimb, missing)) return false
    }
    return true
  }

  makeMove (x, y, z, cost, kind, sprint) {
    const move = new Move(x, y, z, 0, cost, [], [], kind === 'gap')
    move.kind = kind
    move.sprint = !!sprint
    move.cellX = Math.floor(x)
    move.cellY = Math.floor(y)
    move.cellZ = Math.floor(z)
    return move
  }

  tryWalk (node, dx, dz, neighbors) {
    const x = node.x + dx
    const y = node.y
    const z = node.z + dz
    if (!this.standable(x, y, z) || !this.bodyClear(x, y, z)) return false
    if (!this.arcClear(node, { x, y, z }, 0)) return false
    neighbors.push(this.makeMove(x, y, z, 1, 'walk', false))
    return true
  }

  tryDiagonal (node, dx, dz, neighbors) {
    const x = node.x + dx
    const y = node.y
    const z = node.z + dz
    const sideX = node.x + dx
    const sideZ = node.z + dz
    // Both shoulders need a floor and an empty body. One open side is a corner clip.
    if (!this.standable(sideX, y, node.z) || !this.bodyClear(sideX, y, node.z)) return false
    if (!this.standable(node.x, y, sideZ) || !this.bodyClear(node.x, y, sideZ)) return false
    if (!this.standable(x, y, z) || !this.bodyClear(x, y, z)) return false
    if (!this.arcClear(node, { x, y, z }, 0)) return false
    neighbors.push(this.makeMove(x, y, z, Math.SQRT2, 'diagonal', false))
    return true
  }

  tryStep (node, dx, dz, neighbors) {
    const x = node.x + dx
    const y = node.y + 1
    const z = node.z + dz
    if (!this.standable(x, y, z) || !this.bodyClear(x, y, z)) return false
    if (!this.headroom(node.x, node.y, node.z)) return false
    if (dx !== 0 && dz !== 0) {
      if (!this.bodyClear(node.x + dx, node.y, node.z) || !this.bodyClear(node.x, node.y, node.z + dz)) return false
      if (!this.headroom(node.x + dx, node.y, node.z) || !this.headroom(node.x, node.y, node.z + dz)) return false
    }
    const diagonal = dx !== 0 && dz !== 0
    neighbors.push(this.makeMove(x, y, z, diagonal ? Math.SQRT2 + 1 : 2, 'step', false))
    return true
  }

  tryGap (node, dx, dz, neighbors) {
    const cheb = Math.max(Math.abs(dx), Math.abs(dz))
    const man = Math.abs(dx) + Math.abs(dz)
    if (cheb < 1 || (cheb === 1 && man === 1)) return false
    const sprint = cheb >= 3 || man >= 3
    const maxUp = cheb >= 4 ? 0 : 1
    for (let dy = maxUp; dy >= -this.maxDropDown; dy--) {
      const x = node.x + dx
      const y = node.y + dy
      const z = node.z + dz
      if (!this.standable(x, y, z) || !this.bodyClear(x, y, z)) continue
      const rise = dy < 0 && cheb <= 1 ? 0 : JUMP_RISE
      if (rise > 0 && !this.headroom(node.x, node.y, node.z)) continue
      if (!this.arcClear(node, { x, y, z }, rise)) continue
      const cost = 2 + cheb + (sprint ? 1 : 0) + Math.abs(dy)
      neighbors.push(this.makeMove(x, y, z, cost, 'gap', sprint))
      return true
    }
    return false
  }

  tryDrop (node, dx, dz, neighbors) {
    const x = node.x + dx
    const z = node.z + dz
    if (!this.bodyClear(x, node.y, z)) return
    for (let dy = 1; dy <= this.maxDropDown; dy++) {
      const y = node.y - dy
      if (!this.bodyClear(x, y, z)) return
      if (!this.standable(x, y, z)) continue
      neighbors.push(this.makeMove(x, y, z, 1 + dy * 0.5, 'drop', false))
      return
    }
  }

  tryEnterLadder (node, dx, dz, neighbors) {
    const x = node.x + dx
    const z = node.z + dz
    if (!this.standable(node.x, node.y, node.z)) return
    if (this.climbAt(x, node.y, z) && this.bodyClear(x, node.y, z, true)) {
      neighbors.push(this.makeMove(x, node.y, z, 2, 'ladder', false))
    }
    if (this.climbAt(x, node.y + 1, z) && this.bodyClear(x, node.y + 1, z, true) && this.headroom(node.x, node.y, node.z)) {
      neighbors.push(this.makeMove(x, node.y + 1, z, 2.5, 'ladder', false))
    }
  }

  addLadderHere (node, neighbors) {
    const x = node.x
    const y = node.y
    const z = node.z
    if (this.climbAt(x, y + 1, z) && this.bodyClear(x, y + 1, z, true)) {
      neighbors.push(this.makeMove(x, y + 1, z, 2, 'ladder', false))
    }
    if (this.climbAt(x, y - 1, z) && this.bodyClear(x, y - 1, z, true)) {
      neighbors.push(this.makeMove(x, y - 1, z, 2, 'ladder', false))
    }
    for (const dir of CARDINALS) {
      for (const dy of [0, 1]) {
        const nx = x + dir.x
        const ny = y + dy
        const nz = z + dir.z
        if (!this.standable(nx, ny, nz) || !this.bodyClear(nx, ny, nz)) continue
        if (dy === 1 && !this.headroom(x, y, z)) continue
        neighbors.push(this.makeMove(nx, ny, nz, dy === 0 ? 1 : 2, dy === 0 ? 'walk' : 'step', false))
      }
    }
  }

  getNeighbors (node) {
    const neighbors = []
    if (this.climbAt(node.x, node.y, node.z)) {
      this.addLadderHere(node, neighbors)
      return neighbors
    }
    for (const dir of CARDINALS) {
      this.tryWalk(node, dir.x, dir.z, neighbors)
      this.tryStep(node, dir.x, dir.z, neighbors)
      this.tryDrop(node, dir.x, dir.z, neighbors)
      this.tryEnterLadder(node, dir.x, dir.z, neighbors)
      for (const distance of [2, 3, 4]) {
        this.tryGap(node, dir.x * distance, dir.z * distance, neighbors)
      }
    }
    for (const dir of DIAGONALS) {
      if (!this.tryDiagonal(node, dir.x, dir.z, neighbors)) {
        this.tryGap(node, dir.x, dir.z, neighbors)
      }
      this.tryStep(node, dir.x, dir.z, neighbors)
    }
    for (const [dx, dz] of SIDE_GAPS) {
      this.tryGap(node, dx, dz, neighbors)
    }
    return neighbors
  }

  destinationOpen (node, missing) {
    const x = node.cellX
    const y = node.cellY
    const z = node.cellZ
    if (node.kind === 'ladder') return this.climbAt(x, y, z) && this.bodyClear(x, y, z, true, missing)
    return this.standable(x, y, z) && this.bodyClear(x, y, z, false, missing)
  }

  // The edge from where the bot is standing to this node, with the same body
  // and arc tests used to create it. Already standing on the node is open.
  edgeOpen (pos, node) {
    const to = {
      x: Number.isFinite(node.cellX) ? node.cellX : Math.floor(node.x),
      y: Number.isFinite(node.cellY) ? node.cellY : Math.floor(node.y),
      z: Number.isFinite(node.cellZ) ? node.cellZ : Math.floor(node.z)
    }
    const here = feetOf(pos)
    if (sameCell(here, to)) return true
    const kind = node.kind || 'walk'
    const target = { cellX: to.x, cellY: to.y, cellZ: to.z, kind }
    if (!this.destinationOpen(target, 'ignore')) return false
    // On the ground, test from the cell center. A body drifted a few
    // centimeters toward a wall still fits the move it was planned for.
    const origin = { x: here.x + 0.5, y: here.y, z: here.z + 0.5 }
    if (kind === 'ladder') return this.arcFromPos(origin, to, 0, 'ignore', true)
    if (!this.bot.entity.onGround) return this.arcFromPos(pos, to, 0, 'ignore')
    if (kind === 'step' || kind === 'gap') {
      if (!this.headroom(here.x, here.y, here.z, 'ignore')) return false
      return this.arcFromPos(origin, to, JUMP_RISE, 'ignore')
    }
    return this.arcFromPos(origin, to, 0, 'ignore')
  }

  arrived (bot, node, next, isLast) {
    const pos = bot.entity.position
    if (!pos || !Number.isFinite(node.cellX)) return false
    const here = feetOf(pos)
    const dx = node.cellX + 0.5 - pos.x
    const dz = node.cellZ + 0.5 - pos.z
    const centered = dx * dx + dz * dz <= CENTER * CENTER
    if (node.kind === 'ladder') {
      return here.x === node.cellX && here.z === node.cellZ && Math.abs(pos.y - node.cellY) < 0.35
    }
    if (!bot.entity.onGround) return false
    if (here.x !== node.cellX || here.y !== node.cellY || here.z !== node.cellZ) return false
    const jump = isJumpKind(node.kind)
    const nextJump = next && isJumpKind(next.kind)
    if (!jump || isLast || nextJump) return centered
    return true
  }

  routeAffected (oldBlock, newBlock, path) {
    if (!oldBlock || !newBlock || !path || path.length === 0) return false
    if (oldBlock.type === newBlock.type && oldBlock.metadata === newBlock.metadata && oldBlock.stateId === newBlock.stateId) return false
    const pos = this.bot.entity && this.bot.entity.position
    if (!pos) return false
    const points = [pos]
    for (const node of path) points.push(node)
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i]
      const toNode = points[i + 1]
      const to = {
        x: Number.isFinite(toNode.cellX) ? toNode.cellX : Math.floor(toNode.x),
        y: Number.isFinite(toNode.cellY) ? toNode.cellY : Math.floor(toNode.y),
        z: Number.isFinite(toNode.cellZ) ? toNode.cellZ : Math.floor(toNode.z)
      }
      const rise = toNode.kind === 'step' || toNode.kind === 'gap' ? JUMP_RISE : 0
      if (this.blockHitsSegment(from, to, oldBlock, rise) || this.blockHitsSegment(from, to, newBlock, rise)) return true
      if (this.isSupport(oldBlock, to) || this.isSupport(newBlock, to)) return true
    }
    return false
  }

  isSupport (block, cell) {
    if (!block.position) return false
    return block.position.x === cell.x && block.position.z === cell.z && block.position.y === cell.y - 1
  }

  blockHitsSegment (from, to, block, rise) {
    if (!block.position) return false
    const x1 = to.x + 0.5
    const z1 = to.z + 0.5
    const y1 = to.y
    const x0 = Number.isFinite(from.cellX) ? from.cellX + 0.5 : from.x
    const z0 = Number.isFinite(from.cellZ) ? from.cellZ + 0.5 : from.z
    const y0 = Number.isFinite(from.cellY) ? from.cellY : from.y
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES
      const x = x0 + (x1 - x0) * t
      const z = z0 + (z1 - z0) * t
      const y = y0 + (y1 - y0) * t + 4 * rise * t * (1 - t)
      if (this.playerHitsBlock(x, y, z, block)) return true
    }
    return false
  }

  playerHitsBlock (px, py, pz, block) {
    const bp = block.position
    if (!block.shapes || block.shapes.length === 0) return false
    const minX = px - HALF
    const maxX = px + HALF
    const minY = py + 0.02
    const maxY = py + HEIGHT
    const minZ = pz - HALF
    const maxZ = pz + HALF
    for (const shape of block.shapes) {
      if (bp.y + shape[4] <= py + 0.001) continue
      if (minX < bp.x + shape[3] && maxX > bp.x + shape[0] &&
        minY < bp.y + shape[4] && maxY > bp.y + shape[1] &&
        minZ < bp.z + shape[5] && maxZ > bp.z + shape[2]) return true
    }
    return false
  }
}

function steerTo (bot, node) {
  const pos = bot.entity.position
  const here = feetOf(pos)
  const onIt = here.x === node.cellX && here.y === node.cellY && here.z === node.cellZ
  const aimX = onIt ? node.cellX + 0.5 : node.x
  const aimZ = onIt ? node.cellZ + 0.5 : node.z
  const dx = aimX - pos.x
  const dz = aimZ - pos.z
  if (dx * dx + dz * dz > 1e-6) bot.look(Math.atan2(-dx, -dz), 0)
  const centering = onIt && isJumpKind(node.kind)
  const jumping = (node.kind === 'step' || node.kind === 'gap') && !centering && bot.entity.onGround
  const sprinting = node.kind === 'gap' && node.sprint && !centering
  bot.setControlState('forward', true)
  bot.setControlState('back', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('jump', node.kind === 'ladder' ? false : jumping)
  bot.setControlState('sprint', node.kind === 'ladder' ? false : sprinting)
  bot.setControlState('sneak', false)
}

function follow (bot, movements, node, path) {
  const pos = bot.entity.position
  if (!pos) return { reached: false, reset: false }
  if (!movements.edgeOpen(pos, node)) {
    bot.clearControlStates()
    bot.jumpQueued = false
    return { reset: true }
  }
  const next = path.length > 1 ? path[1] : null
  if (movements.arrived(bot, node, next, path.length === 1)) return { reached: true }
  steerTo(bot, node)
  return { reached: false, reset: false }
}

function attachFollower (bot, movements) {
  const visited = new Set()
  bot.pathfinder.visitedCells = visited
  bot.pathfinder.currentNode = null
  bot.pathfinder.hold = false
  bot.pathfinder.noteReached = (node) => {
    if (node) visited.add(cellKey(node))
  }
  bot.pathfinder.reachedNode = (node, next) => movements.arrived(bot, node, next, !next)
  bot.pathfinder.follow = (node, path) => follow(bot, movements, node, path)
  bot.pathfinder.routeAffected = (oldBlock, newBlock, path) => movements.routeAffected(oldBlock, newBlock, path)
  bot.on('goal_updated', () => {
    visited.clear()
    bot.pathfinder.hold = false
  })
  // A fresh search starts from the current feet. Visits from the previous
  // route must not skip a block the new route needs to walk back through.
  bot.on('path_reset', () => visited.clear())
}

module.exports = {
  ParkourMovements,
  attachFollower,
  cellKey
}
