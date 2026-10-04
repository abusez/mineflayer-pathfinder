'use strict'

require('./ensurePhysics')

const { createNav } = require('../nav')
const { WorkerPool } = require('../nav/workers/pool')
const { startDebugServer } = require('../nav/debugServer')

// Mineflayer plugin: adds bot.nav (goto, stop, jumpTargets, ...) once the bot
// has spawned. The bot must run the vanilla 1.8.9 physics plugin
// (plugins: { physics: vanillaPhysics }); createBot does that for you.
//
// options.workers: planner worker threads (default 2, 0 = plan on the main
//   thread). Searches in workers never stall the movement tick.
// options.debugServer: false, true, or { port } to stream the route to the
//   navview client mod (default false).
// options.log: function for debug server messages.
// Emits 'nav:ready' (nav) on the bot when bot.nav exists.
function navPlugin (options = {}) {
  const opts = { workers: 2, debugServer: false, log: () => {}, ...options }
  return function inject (bot) {
    function setup () {
      if (bot.nav) return
      if (!bot.vanilla) {
        bot.emit('error', new Error('navPlugin needs the vanilla 1.8.9 physics plugin: createBot({ plugins: { physics: vanillaPhysics } })'))
        return
      }
      const pool = opts.workers > 0 ? new WorkerPool({ size: opts.workers, version: bot.version }) : undefined
      createNav(bot, { ...opts.nav, pool })
      if (pool) bot.once('end', () => pool.destroy())
      // Closes itself when the bot disconnects.
      if (opts.debugServer) {
        startDebugServer(bot, { ...(typeof opts.debugServer === 'object' ? opts.debugServer : {}), log: opts.log })
      }
      bot.emit('nav:ready', bot.nav)
    }
    if (bot.entity) setup()
    else bot.once('spawn', setup)
  }
}

module.exports = { navPlugin }
