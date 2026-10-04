'use strict'

// The nav needs the 1.8.9 fixes in prismarine-physics (ladders, and the hook
// for the 1.8.9 collision boxes). They are applied by the postinstall script,
// but newer npm versions skip install scripts the user has not approved, so
// check once on load and apply them before prismarine-physics is first
// required. Must be required before anything that loads prismarine-physics.

const { applyPatches, isPatched } = require('../scripts/patch-physics')

if (!isPatched()) {
  try {
    const { failed } = applyPatches({ log: () => {} })
    if (failed.length) {
      process.emitWarning(`could not patch prismarine-physics (${failed.join(', ')}); ladder and hitbox behaviour will not match 1.8.9`, 'MineflayerNavWarning')
    }
  } catch (err) {
    process.emitWarning(`could not patch prismarine-physics: ${err.message}. Run "node node_modules/mineflayer-nav/scripts/patch-physics.js" once.`, 'MineflayerNavWarning')
  }
}
