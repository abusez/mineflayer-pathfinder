'use strict'

const { Vec3 } = require('vec3')
const { HarnessWorld } = require('./world')
const { mulberry32 } = require('../../nav/util')

// Seeded course generators. Each returns { world, start, goal, yaw, kind }.
// Courses are built to be passable by a skilled player, but generators are
// allowed to be wrong: a planner "noPath" is reported separately from a
// movement failure.

const FLOOR_Y = 63

function rngFor (seed) {
  const r = mulberry32(seed)
  return {
    next: r,
    int (a, b) { return a + Math.floor(r() * (b - a + 1)) },
    pick (list) { return list[Math.floor(r() * list.length)] },
    chance (p) { return r() < p }
  }
}

function base (size = 80) {
  const w = new HarnessWorld()
  w.loadArea(-24, -24, size + 24, size + 24)
  return w
}

function open (rng) {
  const w = base()
  w.fill(0, FLOOR_Y, 0, 64, FLOOR_Y, 64, 'grass')
  for (let i = 0; i < 40; i++) {
    const x = rng.int(4, 60)
    const z = rng.int(4, 60)
    const t = rng.int(0, 3)
    if (t === 0) w.fill(x, 64, z, x, 64 + rng.int(1, 3), z, 'stone') // pillar
    else if (t === 1) w.fill(x, 64, z, x + rng.int(0, 6), 64 + rng.int(0, 2), z, 'cobblestone') // wall
    else if (t === 2) w.fill(x, 64, z, x, 64 + rng.int(0, 2), z + rng.int(0, 6), 'cobblestone')
    else w.fill(x, FLOOR_Y - 1, z, x + rng.int(0, 2), FLOOR_Y, z + rng.int(0, 2), 'air') // pit
  }
  const start = { x: rng.int(1, 6), z: rng.int(1, 6) }
  const goal = { x: rng.int(45, 62), z: rng.int(45, 62) }
  clearColumn(w, start.x, start.z)
  clearColumn(w, goal.x, goal.z)
  return finish(w, start, goal, 64, 64, rng)
}

function hills (rng) {
  const w = base()
  const waves = []
  for (let i = 0; i < 4; i++) {
    waves.push({ a: rng.next() * 3 + 1, fx: rng.next() * 0.15 + 0.03, fz: rng.next() * 0.15 + 0.03, p: rng.next() * 6.28 })
  }
  const height = (x, z) => {
    let h = 0
    for (const v of waves) h += v.a * Math.sin(x * v.fx + v.p) * Math.cos(z * v.fz + v.p * 0.7)
    return FLOOR_Y + Math.round(h)
  }
  for (let x = 0; x <= 64; x++) {
    for (let z = 0; z <= 64; z++) {
      const h = height(x, z)
      w.fill(x, 50, z, x, h - 1, z, 'dirt')
      w.set(x, h, z, 'grass')
    }
  }
  const start = { x: rng.int(2, 8), z: rng.int(2, 8) }
  const goal = { x: rng.int(50, 62), z: rng.int(50, 62) }
  return finish(w, start, goal, height(start.x, start.z) + 1, height(goal.x, goal.z) + 1, rng)
}

// Platforms in a line with gaps, steps up and down, sideways offsets.
function parkour (rng, abilities = {}) {
  const w = base()
  const speed = abilities.speed || 0
  const jb = abilities.jumpBoost || 0
  let x = 0
  let z = 32
  let y = FLOOR_Y
  w.fill(x - 2, y, z - 1, x + 2, y, z + 1, 'stone')
  const start = { x, z }
  const platforms = [{ x0: x - 2, x1: x + 2, z0: z - 1, z1: z + 1, y }]
  x += 2
  let runup = 3
  const jumps = rng.int(6, 11)
  for (let i = 0; i < jumps; i++) {
    let dy = rng.pick([0, 0, 0, 1, -1, -1])
    // Jump Boost I peaks around 1.8 blocks, so +2 needs Jump Boost II.
    if (jb > 1 && rng.chance(0.3)) dy = 2
    // What a skilled player can clear: 4 flat needs a 3 block run-up, one
    // down adds reach, Speed adds about a block going down.
    let maxGap = dy > 1 ? 1 : dy === 1 ? 2 : runup >= 3 ? 4 : 3
    if (dy < 0 && speed > 1 && runup >= 3) maxGap += 1
    const gap = rng.int(1, maxGap)
    const side = gap <= 2 && rng.chance(0.3) ? rng.pick([-1, 1]) : 0
    const len = rng.int(1, 4)
    const width = rng.int(0, 1)
    x += gap + 1
    z += side
    y += dy
    w.fill(x, y, z - width, x + len - 1, y, z + width, rng.pick(['stone', 'quartz_block', 'wool']))
    platforms.push({ x0: x, x1: x + len - 1, z0: z - width, z1: z + width, y, gap, dy, side })
    clearAbove(w, x, y, z - width, x + len - 1, z + width)
    runup = len - 1 // the takeoff is the last block, not part of the run-up
    x += len - 1
  }
  // Goal platform
  w.fill(x + 1, y, z - 1, x + 3, y, z + 1, 'stone')
  clearAbove(w, x + 1, y, z - 1, x + 3, z + 1)
  const goal = { x: x + 2, z }
  platforms.push({ x0: x + 1, x1: x + 3, z0: z - 1, z1: z + 1, y })
  return { world: w, start: new Vec3(start.x + 0.5, FLOOR_Y + 1, start.z + 0.5), goal: { x: goal.x, y: y + 1, z: goal.z }, yaw: -90, platforms }
}

// Slabs, stairs, snow, fences, walls, trapdoors, carpets.
function partial (rng) {
  const w = base()
  w.fill(0, FLOOR_Y, 0, 64, FLOOR_Y, 64, 'stone')
  for (let i = 0; i < 70; i++) {
    const x = rng.int(3, 60)
    const z = rng.int(3, 60)
    const t = rng.int(0, 8)
    if (t === 0) w.fill(x, 64, z, x + rng.int(0, 3), 64, z + rng.int(0, 3), 'stone_slab', 0)
    else if (t === 1) {
      // slab staircase up onto a block
      w.set(x, 64, z, 'stone_slab', 0)
      w.fill(x + 1, 64, z, x + 3, 64, z + 2, 'stone')
      w.fill(x + 1, 65, z, x + 1, 65, z + 2, 'stone_slab', 0)
    } else if (t === 2) w.fill(x, 64, z, x, 64, z + rng.int(0, 3), 'oak_stairs', rng.int(0, 3))
    else if (t === 3) w.fill(x, 64, z, x + rng.int(0, 2), 64, z + rng.int(0, 2), 'snow_layer', rng.int(0, 7))
    else if (t === 4) w.fill(x, 64, z, x + rng.int(0, 5), 64, z, 'fence')
    else if (t === 5) w.fill(x, 64, z, x, 64, z + rng.int(0, 5), 'cobblestone_wall')
    else if (t === 6) w.fill(x, 64, z, x + rng.int(0, 2), 64, z + rng.int(0, 2), 'trapdoor', 0)
    else if (t === 7) w.fill(x, 64, z, x + rng.int(0, 3), 64, z + rng.int(0, 3), 'carpet', rng.int(0, 15))
    else w.fill(x, 64, z, x + 2, 64, z + 2, 'soul_sand')
  }
  const start = { x: rng.int(1, 4), z: rng.int(1, 4) }
  const goal = { x: rng.int(48, 62), z: rng.int(48, 62) }
  clearColumn(w, start.x, start.z)
  clearColumn(w, goal.x, goal.z)
  return finish(w, start, goal, 64, 64, rng)
}

// A tower with ladders up the side; goal on the roof.
function ladders (rng) {
  const w = base()
  w.fill(0, FLOOR_Y, 0, 40, FLOOR_Y, 40, 'stone')
  const h = rng.int(4, 10)
  const tx = rng.int(15, 22)
  const tz = rng.int(15, 22)
  w.fill(tx, 64, tz, tx + 4, 63 + h, tz + 4, 'stone')
  // Ladder on a random face, attached to the tower.
  const face = rng.int(0, 3)
  const along = rng.int(1, 3)
  let lx, lz, meta
  if (face === 0) { lx = tx - 1; lz = tz + along; meta = 4 } // west face, ladder faces west, on east wall
  else if (face === 1) { lx = tx + 5; lz = tz + along; meta = 5 }
  else if (face === 2) { lx = tx + along; lz = tz - 1; meta = 2 }
  else { lx = tx + along; lz = tz + 5; meta = 3 }
  w.fill(lx, 64, lz, lx, 63 + h, lz, 'ladder', meta)
  const start = { x: rng.int(1, 6), z: rng.int(1, 6) }
  return finish(w, start, { x: tx + 2, z: tz + 2 }, 64, 64 + h, rng)
}

// Terraces stepping down by 1-6 blocks; some too deep to drop safely.
function cliffs (rng) {
  const w = base()
  let y = 72
  let x = 0
  w.fill(0, 50, 20, 8, y, 30, 'stone')
  x = 9
  while (x < 60 && y > 54) {
    const drop = rng.pick([1, 1, 2, 2, 3, 3, 4, 5, 6])
    const len = rng.int(3, 8)
    y -= drop
    w.fill(x, 50, 20, x + len - 1, y, 30, 'stone')
    // occasional staircase route on the side
    if (drop > 3) {
      for (let k = 1; k < drop; k++) w.set(x - 1, y + drop - k, 30 - k, 'stone')
    }
    x += len
  }
  w.fill(x, 50, 20, x + 4, y, 30, 'stone')
  return finish(w, { x: 3, z: 25 }, { x: x + 2, z: rng.int(21, 29) }, 73, y + 1, rng)
}

// Randomised DFS maze, 1-wide corridors, 3-high walls.
function maze (rng) {
  const w = base()
  const cells = 12
  const size = cells * 2 + 1
  w.fill(0, FLOOR_Y, 0, size, FLOOR_Y, size, 'stone')
  w.fill(0, 64, 0, size - 1, 66, size - 1, 'cobblestone')
  const seen = new Set()
  const stack = [[0, 0]]
  seen.add('0,0')
  w.fill(1, 64, 1, 1, 66, 1, 'air')
  while (stack.length) {
    const [cx, cz] = stack[stack.length - 1]
    const options = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dz]) => [cx + dx, cz + dz, dx, dz])
      .filter(([nx, nz]) => nx >= 0 && nz >= 0 && nx < cells && nz < cells && !seen.has(nx + ',' + nz))
    if (!options.length) { stack.pop(); continue }
    const [nx, nz, dx, dz] = rng.pick(options)
    seen.add(nx + ',' + nz)
    w.fill(1 + cx * 2 + dx, 64, 1 + cz * 2 + dz, 1 + cx * 2 + dx, 66, 1 + cz * 2 + dz, 'air')
    w.fill(1 + nx * 2, 64, 1 + nz * 2, 1 + nx * 2, 66, 1 + nz * 2, 'air')
    stack.push([nx, nz])
  }
  // A few shortcuts so there is more than one route.
  for (let i = 0; i < 8; i++) {
    const x = 1 + rng.int(0, cells - 1) * 2 + 1
    const z = 1 + rng.int(0, cells - 1) * 2
    if (x < size - 1) w.fill(x, 64, z, x, 66, z, 'air')
  }
  const end = 1 + (cells - 1) * 2
  return { world: w, start: new Vec3(1.5, 64, 1.5), goal: { x: end, y: 64, z: end }, yaw: 0 }
}

// Hills with a parkour bridge onto a plateau.
function mixed (rng, abilities) {
  const w = base()
  for (let x = 0; x <= 30; x++) {
    for (let z = 20; z <= 44; z++) {
      const h = FLOOR_Y + Math.round(1.5 * Math.sin(x * 0.3 + z * 0.2))
      w.fill(x, 55, z, x, h, z, 'dirt')
    }
  }
  let x = 31
  let y = FLOOR_Y + 1
  for (let i = 0; i < 5; i++) {
    const gap = rng.int(1, 3)
    x += gap
    const len = rng.int(1, 3)
    w.fill(x, y, 31, x + len - 1, y, 33, 'stone')
    x += len
    if (rng.chance(0.4)) y += 1
  }
  w.fill(x + 1, 55, 25, x + 12, y, 40, 'stone')
  w.fill(x + 6, y + 1, 30, x + 6, y + 2, 36, 'cobblestone')
  const h0 = FLOOR_Y + Math.round(1.5 * Math.sin(2 * 0.3 + 32 * 0.2))
  return { world: w, start: new Vec3(2.5, h0 + 1, 32.5), goal: { x: x + 10, y: y + 1, z: rng.int(27, 38) }, yaw: -90 }
}

function clearColumn (w, x, z) {
  w.fill(x, 64, z, x, 70, z, 'air')
  w.set(x, FLOOR_Y, z, 'stone')
}

function clearAbove (w, x0, y, z0, x1, z1) {
  w.fill(x0, y + 1, z0, x1, y + 4, z1, 'air')
}

function finish (w, start, goal, startY, goalY, rng) {
  return {
    world: w,
    start: new Vec3(start.x + 0.5, startY, start.z + 0.5),
    goal: { x: goal.x, y: goalY, z: goal.z },
    yaw: rng.int(-180, 179)
  }
}

const KINDS = { open, hills, parkour, partial, ladders, cliffs, maze, mixed }

const VARIANTS = [
  { name: 'base', speed: 0, jumpBoost: 0 },
  { name: 'speed1', speed: 1, jumpBoost: 0 },
  { name: 'speed2', speed: 2, jumpBoost: 0 },
  { name: 'jump1', speed: 0, jumpBoost: 1 },
  { name: 'jump2', speed: 0, jumpBoost: 2 }
]

function makeCourse (kind, seed, variant) {
  const rng = rngFor(seed)
  const course = KINDS[kind](rng, variant)
  return { ...course, kind, seed, variant: variant.name, speed: variant.speed, jumpBoost: variant.jumpBoost }
}

module.exports = { KINDS, VARIANTS, makeCourse }
