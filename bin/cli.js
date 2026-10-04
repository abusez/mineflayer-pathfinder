#!/usr/bin/env node
'use strict'

// Command-line bot: joins a server, then reads commands from the terminal
// (goto, jumps, hitbox, record, ...). Settings come from flags or a .env file
// in the working directory:
//
//   HOST, PORT, VERSION, REFRESH_TOKEN, ACCESS_TOKEN or OFFLINE_USERNAME (offline-mode servers),
//   JOIN_COMMANDS   chat commands sent after spawning, separated by ";"
//   NAV_WORKERS     planner worker threads (default 2, 0 = main thread)
//   DEBUG_PORT      port for the navview client mod (default 28765, 0 = off)

const fs = require('fs')
const path = require('path')
const { createBot } = require('../lib/createBot')
const { attachCommands } = require('../commands')
const { line: logLine } = require('../log')

loadDotEnv(path.join(process.cwd(), '.env'))

const host = arg('--host') || process.env.HOST
const port = Number(arg('--port') || process.env.PORT || 25565)
const version = arg('--version') || process.env.VERSION || '1.8.9'
const refreshToken = arg('--refresh-token') || process.env.REFRESH_TOKEN || ''
const accessToken = arg('--access-token') || process.env.ACCESS_TOKEN || ''
const username = arg('--username') || process.env.OFFLINE_USERNAME || ''
const joinCommands = (arg('--commands') || process.env.JOIN_COMMANDS || '').split(';').map(s => s.trim()).filter(Boolean)
const workers = Number(process.env.NAV_WORKERS ?? 2)
const debugPort = Number(process.env.DEBUG_PORT ?? 28765)

const COMMAND_DELAY_MS = 1500

async function main () {
  if (!host) throw new Error('Set HOST (or --host) to the Minecraft server address')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a number from 1 to 65535')
  if (refreshToken && accessToken) throw new Error('Provide either a refresh token or an access token, not both')
  if (!refreshToken && !accessToken && !username) throw new Error('Set REFRESH_TOKEN, ACCESS_TOKEN or OFFLINE_USERNAME (see .env.example)')

  const bot = await createBot({
    host,
    port,
    version,
    ...(refreshToken ? { refreshToken } : accessToken ? { accessToken } : { username, auth: 'offline' }),
    onSession (session) {
      console.log(logLine('ok', `authenticated as ${session.profile.username}`))
      if (session.refreshToken && session.refreshToken !== refreshToken) {
        console.log(logLine('warn', 'Microsoft issued a new refresh token. Update REFRESH_TOKEN with this value:'))
        console.log(session.refreshToken)
      }
    },
    nav: {
      workers,
      debugServer: debugPort > 0 ? { port: debugPort } : false,
      log: (msg) => commands.print(logLine('info', msg))
    }
  })

  const commands = attachCommands(bot)

  bot.once('spawn', () => {
    commands.print(logLine('info', `spawned on ${bot._client.socket?.remoteAddress || host}`))
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

async function sendCommands (bot, print) {
  if (!joinCommands.length) return
  await sleep(COMMAND_DELAY_MS)
  for (const command of joinCommands) {
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
