'use strict'

// Equivalence gate for performance work: runs 80 fixed courses (every kind x
// every ability variant x 2 seeds) and hashes each run's outcome, tick count,
// final position (exact doubles) and planner expansions. An optimization that
// is meant to be exact must not change the hash.
//
//   node scripts/fingerprint.js

const crypto = require('crypto')
const { makeCourse, VARIANTS, KINDS } = require('../test/harness/courses')
const { runScenario } = require('../test/harness/run')

const h = crypto.createHash('sha1')
const t0 = Date.now()
for (const kind of Object.keys(KINDS)) {
  for (const v of VARIANTS) {
    for (const seed of [900001, 900002]) {
      let pos = null
      const r = runScenario({ ...makeCourse(kind, seed, v), maxTicks: 3000, onTick (bot) { pos = bot.entity.position } })
      h.update(`${kind}${seed}${v.name}|${r.status}|${r.ticks}|${pos.x},${pos.y},${pos.z}|${r.nav.expansions}`)
    }
  }
}
console.log(h.digest('hex'), `${Date.now() - t0} ms`)
