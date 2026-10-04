'use strict'

// Large-scale deterministic simulation of the nav stack.
//
//   npm run simulate -- --runs 2000 --seed 1 --kinds all --workers 8
//   npm run simulate -- --replay parkour:12345:speed1 --trace
//
// Every run is a fresh seeded course, so any failure can be replayed exactly.

const os = require('os')
const fs = require('fs')
const path = require('path')
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')

const { KINDS, VARIANTS, makeCourse } = require('../test/harness/courses')
const { runScenario } = require('../test/harness/run')

function args () {
  const a = process.argv.slice(2)
  const get = (name, def) => {
    const i = a.indexOf('--' + name)
    if (i === -1) return def
    const v = a[i + 1]
    return v === undefined || v.startsWith('--') ? true : v
  }
  return {
    runs: Number(get('runs', 200)),
    seed: Number(get('seed', 1)),
    kinds: String(get('kinds', 'all')),
    variants: String(get('variants', 'all')),
    workers: Number(get('workers', Math.max(1, os.cpus().length - 1))),
    replay: get('replay', null),
    trace: !!get('trace', false),
    out: String(get('out', 'sim-report.json')),
    maxTicks: Number(get('max-ticks', 3000))
  }
}

function runOne ({ kind, seed, variant }, maxTicks, trace) {
  const v = VARIANTS.find(x => x.name === variant)
  const course = makeCourse(kind, seed, v)
  const res = runScenario({ ...course, maxTicks }, { trace })
  const dx = course.goal.x + 0.5 - course.start.x
  const dz = course.goal.z + 0.5 - course.start.z
  const vmax = 0.36 * (1 + 0.2 * (course.speed || 0))
  res.lowerBound = Math.hypot(dx, dz) / vmax
  return { kind, seed, variant, ...res }
}

function jobsFor (o) {
  const kinds = o.kinds === 'all' ? Object.keys(KINDS) : o.kinds.split(',')
  const variants = o.variants === 'all' ? VARIANTS.map(v => v.name) : o.variants.split(',')
  const jobs = []
  for (let i = 0; i < o.runs; i++) {
    jobs.push({
      kind: kinds[i % kinds.length],
      variant: variants[Math.floor(i / kinds.length) % variants.length],
      seed: o.seed * 100000 + i
    })
  }
  return jobs
}

const INVARIANTS = ['snaps', 'accelViolations', 'offGrid', 'constantTurnRuns', 'keyFlicker', 'sprintIntoWall', 'teleports']

function summarize (results) {
  const groups = new Map()
  for (const r of results) {
    for (const key of [r.kind, `${r.kind}/${r.variant}`, 'ALL']) {
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(r)
    }
  }
  const rows = []
  for (const [key, list] of groups) {
    const n = list.length
    const arrived = list.filter(r => r.status === 'arrived')
    // Only a course with no path from the very start is unsolvable; a NoPath
    // after the bot has moved is a movement failure.
    const unsolvable = (r) => r.status === 'failed' && r.reason === 'NoPath' && r.ticks <= 1
    const noPath = list.filter(unsolvable).length
    const sum = (f) => list.reduce((s, r) => s + f(r), 0)
    const avg = (f, l = list) => l.length ? l.reduce((s, r) => s + f(r), 0) / l.length : 0
    const inv = {}
    for (const k of INVARIANTS) inv[k] = sum(r => r.metrics[k])
    rows.push({
      group: key,
      runs: n,
      success: arrived.length / n,
      solvable: (n - noPath) ? arrived.length / (n - noPath) : 0,
      noPath,
      timeout: list.filter(r => r.status === 'timeout').length,
      otherFail: list.filter(r => r.status === 'failed' && !unsolvable(r)).length,
      ticksVsBound: avg(r => r.ticks / Math.max(1, r.lowerBound), arrived),
      replans: avg(r => Object.values(r.nav.replans).reduce((a, b) => a + b, 0)),
      fallbackTicks: avg(r => r.nav.fallbackTicks),
      falls: sum(r => r.metrics.falls),
      fallDamage: sum(r => r.metrics.fallDamage),
      predictionMisses: sum(r => r.nav.predictionMisses),
      maxYawDelta: Math.max(...list.map(r => r.metrics.maxYawDelta)),
      msPerTick: avg(r => r.msPerTick),
      invariants: inv
    })
  }
  rows.sort((a, b) => (a.group === 'ALL') - (b.group === 'ALL') || a.group.localeCompare(b.group))
  return rows
}

function printTable (rows, { detailed = false } = {}) {
  const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%'
  const head = 'group'.padEnd(18) + 'runs'.padStart(6) + '  ok(all)  ok(solv) noPath  tmo  fail  t/bound replans  fb/run falls dmg  maxYaw  ms/t  invariants'
  console.log(head)
  console.log('-'.repeat(head.length + 20))
  for (const r of rows) {
    if (!detailed && r.group.includes('/')) continue
    const inv = Object.entries(r.invariants).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'
    console.log(
      r.group.padEnd(18) + String(r.runs).padStart(6) +
      pct(r.success).padStart(9) + pct(r.solvable).padStart(10) +
      String(r.noPath).padStart(7) + String(r.timeout).padStart(5) + String(r.otherFail).padStart(6) +
      r.ticksVsBound.toFixed(2).padStart(9) + r.replans.toFixed(2).padStart(8) + r.fallbackTicks.toFixed(1).padStart(8) +
      String(r.falls).padStart(6) + String(r.fallDamage).padStart(4) +
      r.maxYawDelta.toFixed(1).padStart(8) + r.msPerTick.toFixed(2).padStart(6) + '  ' + inv
    )
  }
}

async function main () {
  const o = args()
  if (o.replay) {
    const [kind, seed, variant = 'base'] = String(o.replay).split(':')
    const r = runOne({ kind, seed: Number(seed), variant }, o.maxTicks, o.trace)
    const trace = r.trace
    delete r.trace
    console.log(JSON.stringify(r, null, 2))
    if (trace) console.log(trace.join('\n'))
    return
  }

  const jobs = jobsFor(o)
  const workers = Math.max(1, Math.min(o.workers, jobs.length))
  const started = Date.now()
  const results = []
  let done = 0
  await Promise.all(Array.from({ length: workers }, (_, w) => new Promise((resolve, reject) => {
    const mine = jobs.filter((_, i) => i % workers === w)
    const worker = new Worker(__filename, { workerData: { jobs: mine, maxTicks: o.maxTicks } })
    worker.on('message', (r) => {
      results.push(r)
      done++
      if (done % 50 === 0 || done === jobs.length) {
        process.stderr.write(`\r${done}/${jobs.length} runs  ${((Date.now() - started) / 1000).toFixed(0)}s`)
      }
    })
    worker.on('error', reject)
    worker.on('exit', resolve)
  })))
  process.stderr.write('\n')

  results.sort((a, b) => a.seed - b.seed)
  const rows = summarize(results)
  printTable(rows, { detailed: o.runs >= 200 })
  const failures = results
    .filter(r => r.status !== 'arrived' || INVARIANTS.some(k => r.metrics[k] > 0))
    .map(r => ({
      replay: `${r.kind}:${r.seed}:${r.variant}`,
      status: r.status,
      reason: r.reason,
      ticks: r.ticks,
      replans: r.nav.replans,
      invariants: Object.fromEntries(INVARIANTS.filter(k => r.metrics[k] > 0).map(k => [k, r.metrics[k]]))
    }))
  const report = { options: o, seconds: (Date.now() - started) / 1000, summary: rows, failures }
  fs.writeFileSync(path.resolve(o.out), JSON.stringify(report, null, 2))
  console.log(`\n${results.length} runs in ${report.seconds.toFixed(1)}s, ${failures.length} with failures or invariant hits. Report: ${o.out}`)
  console.log('Replay one with: npm run simulate -- --replay <kind:seed:variant> --trace')
}

if (isMainThread) {
  main().catch(err => {
    console.error(err)
    process.exitCode = 1
  })
} else {
  for (const job of workerData.jobs) {
    let r
    try {
      r = runOne(job, workerData.maxTicks, false)
    } catch (err) {
      r = { ...job, status: 'failed', reason: 'Crash:' + (err && err.message), ticks: 0, lowerBound: 1, msPerTick: 0, metrics: Object.fromEntries(INVARIANTS.concat(['falls', 'fallDamage', 'maxYawDelta']).map(k => [k, 0])), nav: { replans: {}, fallbackTicks: 0, predictionMisses: 0 } }
    }
    parentPort.postMessage(r)
  }
}
