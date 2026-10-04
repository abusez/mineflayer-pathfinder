'use strict'

// Nav performance benchmark. Wraps the pipeline stages (no code changes) and
// reports inclusive time, call counts, physics ticks, block lookups, clones,
// GC and the worst per-tick main-thread time over a fixed set of courses.
//
//   node scripts/bench.js [--kinds all] [--seeds 2] [--json out.json]

const { PerformanceObserver, performance } = require('perf_hooks')

// Count every physics tick, before anything captures Physics.
const pp = require('prismarine-physics')
const PhysicsOrig = pp.Physics
let simTicks = 0
let simMs = 0
pp.Physics = function (...a) {
  const ph = PhysicsOrig(...a)
  const sim = ph.simulatePlayer
  ph.simulatePlayer = (s, w) => { simTicks++; const t = performance.now(); try { return sim(s, w) } finally { simMs += performance.now() - t } }
  return ph
}
const { makeCourse, VARIANTS, KINDS } = require('../test/harness/courses')
const { runScenario } = require('../test/harness/run')
const { Planner } = require('../nav/planner')
const { Primitives } = require('../nav/primitives')
const { Controller } = require('../nav/controller')
const { Smoother } = require('../nav/smoother')
const { NavWorld, ColumnCache } = require('../nav/world')
const { Terrain } = require('../nav/blocks')
const player = require('../nav/vanillaClient/player')

const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf('--' + n); return i === -1 ? d : args[i + 1] }
const kinds = arg('kinds', 'all') === 'all' ? Object.keys(KINDS) : arg('kinds').split(',')
const seeds = Number(arg('seeds', 2))

const stats = new Map()
let depth = new Map()
function stat (name) {
  let s = stats.get(name)
  if (!s) stats.set(name, s = { calls: 0, ms: 0, max: 0 })
  return s
}
// Inclusive timing; re-entrant calls to the same stage are not double counted.
function wrap (obj, method, name) {
  const orig = obj[method]
  obj[method] = function (...a) {
    const s = stat(name)
    s.calls++
    if (depth.get(name)) return orig.apply(this, a)
    depth.set(name, 1)
    const t0 = performance.now()
    try { return orig.apply(this, a) } finally {
      const dt = performance.now() - t0
      s.ms += dt
      if (dt > s.max) s.max = dt
      depth.set(name, 0)
    }
  }
}
function count (obj, method, name) {
  const orig = obj[method]
  obj[method] = function (...a) { stat(name).calls++; return orig.apply(this, a) }
}

wrap(Planner.prototype, 'search', 'planner.search(setup)')
const origSearch = Planner.prototype.search
Planner.prototype.search = function (...a) {
  const s = origSearch.apply(this, a)
  const step = s.step
  s.step = (...b) => {
    const st = stat('planner.step')
    st.calls++
    const t0 = performance.now()
    try { return step(...b) } finally { const dt = performance.now() - t0; st.ms += dt; if (dt > st.max) st.max = dt }
  }
  return s
}
wrap(Primitives.prototype, 'expandStand', 'primitives.expandStand')
wrap(Primitives.prototype, 'gapMoves', 'primitives.gapMoves')
wrap(Primitives.prototype, 'validate', 'primitives.validate(physics)')
count(Primitives.prototype, 'rollout', 'primitives.rollout')
wrap(Controller.prototype, 'tick', 'controller.tick')
count(Controller.prototype, 'rollout', 'controller.rollout')
wrap(Smoother.prototype, 'smooth', 'smoother.smooth')
let memoHits = 0
const P = require('../nav/primitives').Primitives.prototype
const origValidate = P.validate
P.validate = function (node, target, mode, ...rest) {
  const key = node.x + ',' + node.y + ',' + node.z + '|' + target.x + ',' + target.y + ',' + target.z + '|' + mode
  if (this.memo.has(key)) memoHits++
  return origValidate.call(this, node, target, mode, ...rest)
}
count(NavWorld.prototype, 'getBlock', 'world.getBlock')
count(ColumnCache.prototype, 'get', 'columns.get')
count(Terrain.prototype, 'cell', 'terrain.cell')
count(Terrain.prototype, 'analyse', 'terrain.analyse(miss)')

let gcMs = 0
let gcCount = 0
new PerformanceObserver(list => { for (const e of list.getEntries()) { gcMs += e.duration; gcCount++ } }).observe({ type: 'gc', buffered: false })

const tickTimes = []
const t0 = performance.now()
const heap0 = process.memoryUsage().heapUsed
let ticks = 0
let runs = 0
for (const kind of kinds) {
  for (let i = 0; i < seeds; i++) {
    const course = makeCourse(kind, 500001 + i, VARIANTS[0])
    let last = 0
    runScenario({
      ...course,
      maxTicks: 3000,
      onTick () {
        const now = performance.now()
        if (last) tickTimes.push(now - last)
        last = now
      }
    })
    runs++
  }
}
const total = performance.now() - t0
ticks = tickTimes.length + runs

const rows = [...stats.entries()].map(([name, s]) => ({ name, ...s }))
rows.sort((a, b) => b.ms - a.ms)
tickTimes.sort((a, b) => a - b)
const pct = (p) => tickTimes[Math.min(tickTimes.length - 1, Math.floor(tickTimes.length * p))]

console.log(`${runs} runs, ${ticks} ticks, ${total.toFixed(0)} ms wall`)
console.log(`main-thread time per tick: p50 ${pct(0.5).toFixed(2)} ms, p99 ${pct(0.99).toFixed(2)} ms, max ${pct(1).toFixed(1)} ms`)
console.log(`physics: ${simTicks} ticks simulated, ${simMs.toFixed(0)} ms (${(simMs / total * 100).toFixed(1)}% of wall), ${(simTicks / (simMs / 1000)).toFixed(0)} ticks/s while simulating (${(simMs / simTicks * 1000).toFixed(2)} us each)`)
console.log(`block lookups: ${(stat('world.getBlock').calls / simTicks).toFixed(1)} getBlock per physics tick; validate memo hits ${memoHits} of ${stat('primitives.validate(physics)').calls}; ${(stat('primitives.rollout').calls / Math.max(1, stat('primitives.validate(physics)').calls - memoHits)).toFixed(1)} rollouts per fresh validation`)
console.log(`GC: ${gcCount} collections, ${gcMs.toFixed(0)} ms (${(gcMs / total * 100).toFixed(1)}% of wall); heap delta ${((process.memoryUsage().heapUsed - heap0) / 1e6).toFixed(1)} MB`)
console.log('')
console.log('stage'.padEnd(30) + 'calls'.padStart(11) + '   incl ms'.padStart(12) + '   % wall' + '   max ms' + '   us/call')
for (const r of rows) {
  const per = r.ms ? (r.ms / r.calls * 1000).toFixed(1) : ''
  console.log(r.name.padEnd(30) + String(r.calls).padStart(11) + (r.ms ? r.ms.toFixed(0) : '-').padStart(12) + (r.ms ? (r.ms / total * 100).toFixed(1) + '%' : '').padStart(9) + (r.ms ? r.max.toFixed(1) : '').padStart(9) + per.padStart(10))
}
if (arg('json')) require('fs').writeFileSync(arg('json'), JSON.stringify({ total, ticks, tick: { p50: pct(0.5), p99: pct(0.99), max: pct(1) }, gcMs, rows }, null, 1))
