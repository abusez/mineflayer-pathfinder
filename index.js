'use strict'

// Before anything loads prismarine-physics.
require('./lib/ensurePhysics')

// Physics-driven parkour navigation for mineflayer on Minecraft 1.8.9.
//
//   const { createBot } = require('mineflayer-pathfinder')
//   const bot = await createBot({ host: 'localhost', username: 'Bot' })
//   bot.once('nav:ready', async () => {
//     await bot.nav.goto(100, 64, -20)
//   })
//
// Requiring this module has no side effects. See README.md for the API.

const { createBot } = require('./lib/createBot')
const { navPlugin } = require('./lib/plugin')
const { resolveGameHost } = require('./lib/server')
const { sessionFromRefreshToken, sessionFromAccessToken } = require('./auth')
const { createNav, NavError } = require('./nav')
const { vanillaPhysics } = require('./nav/vanillaClient')
const { WorkerPool, defaultWorkerCount } = require('./nav/workers/pool')
const { startDebugServer, buildSnapshot, DEFAULT_PORT: DEBUG_PORT } = require('./nav/debugServer')
const { installGrimTrace, parseGrimFlag } = require('./nav/grimTrace')
const { createRecorder, replay, stats: recordingStats } = require('./nav/recorder')
const { createNetTrace } = require('./nav/netTrace')
const { buildShapeTable, resolveShapes } = require('./nav/shapes18')
const { Terrain } = require('./nav/blocks')
const { createSim } = require('./nav/sim')
const { attachCommands } = require('./commands')

module.exports = {
  // Start here
  createBot,
  navPlugin,

  // Building blocks
  createNav,
  NavError,
  vanillaPhysics,
  WorkerPool,
  defaultWorkerCount,

  // Login and connection
  sessionFromRefreshToken,
  sessionFromAccessToken,
  resolveGameHost,

  // Tools
  attachCommands,
  startDebugServer,
  buildSnapshot,
  DEBUG_PORT,
  installGrimTrace,
  parseGrimFlag,
  createRecorder,
  replay,
  recordingStats,
  createNetTrace,

  // 1.8.9 collision boxes, terrain analysis and the physics simulator
  buildShapeTable,
  resolveShapes,
  Terrain,
  createSim
}
