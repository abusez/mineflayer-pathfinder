'use strict'

// Reapplies the 1.8.9 fixes to the prismarine-physics fork after every npm
// install: two ladder fixes, and the hook that lets nav/world.js supply the
// 1.8.9 neighbour-dependent collision boxes. They used to be hand edits inside
// node_modules and were lost on reinstall. Each patch is skipped when its
// marker is already present.
//
// Runs as the package's postinstall, and again from index.js when the library
// is first required (newer npm versions skip install scripts that the user
// has not approved).

const fs = require('fs')
const path = require('path')

const PATCHES = [
  {
    name: 'ladder climb motionY',
    marker: 'EntityLivingBase sets motionY = 0.2D after the move',
    find: '        motion.y = physics.ladderClimbSpeed // climb ladder\n',
    replace:
      '        // EntityLivingBase sets motionY = 0.2D after the move. 0.15 is only the\n' +
      '        // pre-move fall clamp above. Gravity and air drag then leave 0.1176.\n' +
      '        motion.y = 0.2\n'
  },
  {
    name: '1.8 ladder boxes (table)',
    marker: 'const LADDER_18 = {',
    find: '    for (const stateId in mcData.blocksByStateId) {\n      const block = mcData.blocksByStateId[stateId]\n',
    replace:
      '    // 1.8 BlockLadder uses 0.125; minecraft-data ships the later 0.1875 boxes.\n' +
      '    // New arrays so doors and trapdoors that share shape ids 27-30 stay thick.\n' +
      '    const LADDER_18 = {\n' +
      '      27: [[0, 0, 0.875, 1, 1, 1]], // NORTH\n' +
      '      28: [[0, 0, 0, 0.125, 1, 1]], // EAST\n' +
      '      29: [[0, 0, 0, 1, 1, 0.125]], // SOUTH\n' +
      '      30: [[0.875, 0, 0, 1, 1, 1]] // WEST\n' +
      '    }\n\n' +
      '    for (const stateId in mcData.blocksByStateId) {\n      const block = mcData.blocksByStateId[stateId]\n'
  },
  {
    name: '1.8 ladder boxes (lookup)',
    marker: "block.name === 'ladder' && shapesId instanceof Array",
    find: '        blockShapes = shapes.shapes[shapesId[stateId - minStateId]]\n      }\n      if (!blockShapes) {\n',
    replace:
      '        blockShapes = shapes.shapes[shapesId[stateId - minStateId]]\n      }\n' +
      "      if (block.name === 'ladder' && shapesId instanceof Array) {\n" +
      '        blockShapes = LADDER_18[shapesId[stateId - minStateId]] || blockShapes\n' +
      '      }\n      if (!blockShapes) {\n'
  },
  {
    name: '1.8.9 neighbour-dependent boxes (nav/shapes18.js)',
    marker: 'if (world.resolveShapes) {',
    find: '            let shapes = block.shapes\n            if (wallIds.has(block.type)) {\n',
    replace:
      '            let shapes = block.shapes\n' +
      '            // Worlds from nav/world.js resolve fences, walls, panes, stairs,\n' +
      '            // chests and doors with the 1.8.9 rules (nav/shapes18.js).\n' +
      '            if (world.resolveShapes) {\n' +
      '              shapes = world.resolveShapes(block)\n' +
      '            } else if (wallIds.has(block.type)) {\n'
  }
]

// Applies every missing patch. Returns { applied: [names], failed: [names] }.
function applyPatches ({ log = console.log } = {}) {
  const file = path.join(path.dirname(require.resolve('prismarine-physics/package.json')), 'index.js')
  let source = fs.readFileSync(file, 'utf8')
  const applied = []
  const failed = []
  for (const patch of PATCHES) {
    if (source.includes(patch.marker)) continue
    if (!source.includes(patch.find)) {
      failed.push(patch.name)
      log(`patch-physics: could not apply "${patch.name}" (source changed upstream)`)
      continue
    }
    source = source.replace(patch.find, patch.replace)
    applied.push(patch.name)
    log(`patch-physics: applied "${patch.name}"`)
  }
  if (applied.length) fs.writeFileSync(file, source)
  return { applied, failed }
}

// True when every patch is already in place (no file writes).
function isPatched () {
  const file = path.join(path.dirname(require.resolve('prismarine-physics/package.json')), 'index.js')
  const source = fs.readFileSync(file, 'utf8')
  return PATCHES.every(patch => source.includes(patch.marker))
}

module.exports = { applyPatches, isPatched }

if (require.main === module) {
  if (applyPatches().failed.length) process.exitCode = 1
}
