'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const dns = require('dns')
const net = require('net')
const mineflayer = require('mineflayer')
const { sessionFromAccessToken, sessionFromRefreshToken } = require('./auth')
const { attachCommands } = require('./commands')
const { vanillaPhysics } = require('./nav/vanillaClient')
const { line: logLine } = require('./log')

loadDotEnv(path.join(__dirname, '.env'))

const host = arg('--host') || process.env.HOST
const port = Number(arg('--port') || process.env.PORT || 25565)
const version = arg('--version') || process.env.VERSION || '1.8.9'
const refreshToken = arg('--refresh-token') || process.env.REFRESH_TOKEN || ''
const accessToken = arg('--access-token') || process.env.ACCESS_TOKEN || ''

const COMMANDS = ['/ac grim', '/warp scaffold']
const COMMAND_DELAY_MS = 1500

async function main () {
  if (!host) {
    throw new Error('Set HOST (or --host) to the Minecraft server address')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a number from 1 to 65535')
  }
  if (refreshToken && accessToken) {
    throw new Error('Provide either a refresh token or an access token, not both')
  }
  if (!refreshToken && !accessToken) {
    throw new Error('Set REFRESH_TOKEN or ACCESS_TOKEN (see .env.example)')
  }

  const session = refreshToken
    ? await sessionFromRefreshToken(refreshToken)
    : await sessionFromAccessToken(accessToken)

  console.log(logLine('ok', `authenticated as ${session.profile.username}`))
  if (session.refreshToken && session.refreshToken !== refreshToken) {
    console.log(logLine('warn', 'Microsoft issued a new refresh token. Update REFRESH_TOKEN with this value:'))
    console.log(session.refreshToken)
  }

  const game = await resolveGameHost(host, port)
  if (game.host !== host || game.port !== port) {
    console.log(logLine('info', `server address ${game.host}:${game.port}`))
  }

  const bot = mineflayer.createBot({
    host: game.host,
    port: game.port,
    version,
    username: session.profile.username,
    auth: 'mojang',
    // Vanilla 1.8.9 tick timing and movement packets (replaces mineflayer's physics plugin).
    plugins: { physics: vanillaPhysics },
    skipValidation: true,
    profilesFolder: false,
    session: {
      accessToken: session.accessToken,
      clientToken: crypto.randomUUID().replace(/-/g, ''),
      selectedProfile: {
        id: session.profile.uuid.replace(/-/g, ''),
        name: session.profile.username
      }
    }
  })

  const commands = attachCommands(bot)
  let commandsSent = false

  bot.once('spawn', () => {
    if (commandsSent) return
    commandsSent = true
    commands.print(logLine('info', `spawned on ${game.host}:${game.port}, sending /ac grim then /warp scaffold`))
    sendCommands(bot, commands.print).then(() => {
      if (bot.entity) commands.markReady()
    }).catch(err => {
      commands.print(logLine('err', err.message || String(err)))
      bot.quit()
    })
  })

  bot.on('message', (message, position) => {
    // Position 2 is the action bar (above the hotbar). It is not chat.
    if (position === 'game_info') return
    const text = chatText(message)
    if (text) commands.print(logLine('chat', text))
  })

  bot.on('kicked', (reason) => {
    commands.print(logLine('err', 'kicked: ' + (typeof reason === 'string' ? reason : JSON.stringify(reason))))
  })

  bot.on('error', (err) => {
    commands.print(logLine('err', err.message || String(err)))
  })

  bot.on('end', (reason) => {
    commands.print(logLine('err', `disconnected${reason ? `: ${reason}` : ''}`))
    commands.close()
  })
}

function resolveSrv (host, servers) {
  return new Promise((resolve, reject) => {
    const resolver = new dns.Resolver()
    if (servers) resolver.setServers(servers)
    const lookup = servers ? resolver : dns
    lookup.resolveSrv('_minecraft._tcp.' + host, (err, addresses) => {
      if (err) reject(err)
      else resolve(addresses || [])
    })
  })
}

// The game client follows the Minecraft SRV record. This machine's resolver is
// 127.0.0.1 and it refuses those queries, so hypixel.net was opened as a
// website address and the connection timed out.
async function resolveGameHost (host, port) {
  if (port !== 25565 || net.isIP(host) !== 0) return { host, port }
  const attempts = [undefined, ['1.1.1.1', '1.0.0.1'], ['8.8.8.8', '8.8.4.4']]
  for (const servers of attempts) {
    try {
      const records = await resolveSrv(host, servers)
      if (records.length === 0) continue
      records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)
      return { host: records[0].name.replace(/\.$/, ''), port: records[0].port }
    } catch (err) {
      const code = err && err.code
      if (servers && (code === 'ENOTFOUND' || code === 'ENODATA')) return { host, port }
    }
  }
  return { host, port }
}

async function sendCommands (bot, print) {
  await sleep(COMMAND_DELAY_MS)
  for (const command of COMMANDS) {
    if (!bot.entity) return
    print(logLine('info', `> ${command}`))
    bot.chat(command)
    await sleep(COMMAND_DELAY_MS)
  }
}

function chatText (message) {
  const raw = message && typeof message.toAnsi === 'function' ? message.toAnsi() : String(message)
  const plain = raw.replace(/\u001b\[[0-9;]*m/g, '').trim()
  if (!plain) return ''
  return raw.replace(/\s+$/g, '') + '\u001b[0m'
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function arg (name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) return undefined
  return value
}

function loadDotEnv (file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

main().catch(err => {
  console.error(logLine('err', err.message || err))
  process.exitCode = 1
})
