'use strict'

require('./ensurePhysics')

const crypto = require('crypto')
const mineflayer = require('mineflayer')
const { sessionFromAccessToken, sessionFromRefreshToken } = require('../auth')
const { vanillaPhysics } = require('../nav/vanillaClient')
const { navPlugin } = require('./plugin')
const { resolveGameHost } = require('./server')

// One call to a connected 1.8.9 bot with bot.nav:
//
//   const bot = await createBot({ host, refreshToken })
//   bot.once('nav:ready', () => bot.nav.goto(100, 64, -20))
//
// Login, pick one:
//   refreshToken  Microsoft refresh token (refresh -> Xbox Live -> XSTS -> Minecraft)
//   accessToken   Minecraft access token
//   username      offline-mode name (no auth), or pass your own `auth` option
//                 (e.g. 'microsoft') straight through to mineflayer
//
// Other options:
//   host, port (25565 follows the server's SRV record), version ('1.8.9')
//   nav: options for navPlugin ({ workers, debugServer, log }), or false
//   onSession(session): called after login, e.g. to store a rotated refresh token
//   ...anything else is passed to mineflayer.createBot
//
// The vanilla physics plugin replaces mineflayer's: 1.8.9 tick timing and
// movement packets, which the nav's predictions depend on.
async function createBot (options = {}) {
  const { host, port = 25565, version = '1.8.9', refreshToken, accessToken, nav = {}, onSession, ...rest } = options
  if (!host) throw new Error('createBot: host is required')
  if (refreshToken && accessToken) throw new Error('createBot: give refreshToken or accessToken, not both')

  let login = {}
  if (refreshToken || accessToken) {
    const session = refreshToken ? await sessionFromRefreshToken(refreshToken) : await sessionFromAccessToken(accessToken)
    if (onSession) onSession(session)
    login = {
      username: session.profile.username,
      auth: 'mojang',
      skipValidation: true,
      profilesFolder: false,
      session: {
        accessToken: session.accessToken,
        clientToken: crypto.randomUUID().replace(/-/g, ''),
        selectedProfile: { id: session.profile.uuid.replace(/-/g, ''), name: session.profile.username }
      }
    }
  } else if (!rest.username) {
    throw new Error('createBot: give refreshToken, accessToken, or username')
  }

  const game = await resolveGameHost(host, port)
  const bot = mineflayer.createBot({
    ...rest,
    ...login,
    host: game.host,
    port: game.port,
    version,
    plugins: { ...(rest.plugins || {}), physics: vanillaPhysics }
  })
  if (nav !== false) bot.loadPlugin(navPlugin(nav))
  return bot
}

module.exports = { createBot }
