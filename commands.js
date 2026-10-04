'use strict'

const readline = require('readline')
const { Vec3 } = require('vec3')
const { createNav } = require('./nav')
const { WorkerPool } = require('./nav/workers/pool')
const { installGrimTrace } = require('./nav/grimTrace')
const { createRecorder, stats } = require('./nav/recorder')
const { createNetTrace } = require('./nav/netTrace')
const fs = require('fs')
const path = require('path')
const { line: logLine, paint } = require('./log')

const MOVE_CONTROLS = {
  forward: 'forward',
  back: 'back',
  backward: 'back',
  left: 'left',
  right: 'right'
}

const MAX_BLOCKS = 1000
const STUCK_TICKS = 6
// Player box from MCP Entity (width 0.6, height 1.8). The extra step reaches
// a face the collision resolver is already touching.
const PLAYER_HALF = 0.3
const PLAYER_HEIGHT = 1.8
const STALL_PROBE = 0.08
// A climb makes no horizontal progress. Allow a short pause at the top to
// step off, but don't wait this long against an ordinary wall.
const CLIMB_STUCK_TICKS = 25
const MAX_COORD = 30000000

// Interactive terminal console for a bot: goto, jumps, hitbox, record, ...
// options.recordingsDir: where record/scene files go (default ./recordings
// in the working directory).
function attachCommands (bot, options = {}) {
  const recordingsDir = options.recordingsDir || path.join(process.cwd(), 'recordings')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
  })

  let generation = 0
  let queue = Promise.resolve()
  let ready = false
  let recorder = null
  let netTrace = null

  function print (line) {
    readline.cursorTo(process.stdout, 0)
    readline.clearLine(process.stdout, 0)
    console.log(line)
    if (ready) rl.prompt(true)
  }

  function stopMovement () {
    generation++
    if (bot.nav) bot.nav.stop()
    if (bot.entity) bot.clearControlStates()
    queue = Promise.resolve()
  }

  function enqueue (task) {
    const gen = generation
    queue = queue.then(async () => {
      if (gen !== generation || !bot.entity) return
      await task(gen)
    }).catch(err => {
      print(logLine('err', err.message || String(err)))
    })
    return queue
  }

  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) {
      rl.prompt()
      return
    }
    if (!ready || !bot.entity) {
      print(logLine('warn', 'still joining. Wait until the prompt says the bot is ready.'))
      return
    }
    handle(text)
    rl.prompt()
  })

  let closed = false

  rl.on('close', () => {
    stopMovement()
    if (!closed && bot.entity) bot.quit()
  })

  function handle (text) {
    const parts = text.split(/\s+/)
    const name = parts[0].toLowerCase()

    if (name === 'help') {
      print(helpText())
      return
    }

    if (name === 'stop') {
      stopMovement()
      print(logLine('warn', 'stopped'))
      return
    }

    if (name === 'quit' || name === 'exit') {
      stopMovement()
      bot.quit()
      return
    }

    if (name === 'jump') {
      enqueue(() => pulseControl('jump'))
      return
    }

    if (name === 'recalc') {
      if (!bot.nav) {
        print(logLine('warn', 'navigation is not ready yet'))
        return
      }
      const state = parseToggle(parts[1], bot.nav.recalc)
      if (state == null) {
        print('Usage: recalc on|off')
        return
      }
      bot.nav.setRecalc(state)
      print(logLine('info', state ? 'recalculation on' : 'recalculation off'))
      return
    }

    if (name === 'sneak' || name === 'sprint') {
      const state = parseToggle(parts[1], bot.getControlState(name))
      if (state == null) {
        print(`Usage: ${name} on|off`)
        return
      }
      bot.setControlState(name, state)
      print(`${name} ${state ? 'on' : 'off'}`)
      return
    }

    if (name === 'say' || name === 'chat') {
      const message = text.slice(parts[0].length).trim()
      if (!message) {
        print('Usage: say <message>')
        return
      }
      bot.chat(message)
      return
    }

    if (name === 'jumps') {
      const { start, jumps, rejected } = bot.nav.jumpTargets()
      if (!start) {
        print('Not standing on a walkable block.')
        return
      }
      print(`Standing on ${start.x} ${start.y} ${start.z} (floor ${start.H.toFixed(3)}).`)
      if (!jumps.length) print('No jumps from here.')
      else print(`${jumps.length} jump${jumps.length === 1 ? '' : 's'}:`)
      for (const j of jumps.slice(0, 15)) {
        const up = j.H - start.H
        const how = j.verified ? `${j.sprint ? 'sprint' : 'walk'}${j.air && j.air !== 'forward' ? '/' + j.air : ''} conf ${(j.confidence * 100).toFixed(0)}%` : 'UNVERIFIED (physics could not land it)'
        print(`  ${j.x} ${j.y} ${j.z}  gap ${j.gap}  ${up > 0.01 ? '+' : ''}${up.toFixed(2)}  ${how}`)
      }
      // "jumps <x> <z>": every reason for one landing column, in full.
      const fx = Number(parts[1])
      const fz = Number(parts[2])
      if (parts.length >= 3 && isCoord(fx) && isCoord(fz)) {
        const mine = rejected.filter(r => r.x === Math.floor(fx) && r.z === Math.floor(fz))
        if (!mine.length) print(`No candidate lands on column ${Math.floor(fx)},${Math.floor(fz)} (not in the jump offset set, or it's a plain walk/step).`)
        for (const r of mine) print(`  ${describeRejection(r)}`)
        return
      }
      const reasons = rejected.filter(r => r.reason !== 'physics could not land it' && !r.routine)
      if (reasons.length) {
        print(`Rejected: ${reasons.slice(0, 10).map(describeRejection).join('; ')}`)
      }
      print('("jumps <x> <z>" explains one landing column in full.)')
      return
    }

    if (name === 'hitbox') {
      const [hx, hy, hz] = parts.slice(1, 4).map(Number)
      if (![hx, hy, hz].every(isCoord)) {
        print('Usage: hitbox <x> <y> <z>')
        return
      }
      const x = Math.floor(hx)
      const y = Math.floor(hy)
      const z = Math.floor(hz)
      const t = bot.nav.terrain
      t.columns?.clear()
      const info = t.infoAt(x, y, z)
      if (!info) {
        print('That chunk is not loaded.')
        return
      }
      const shapes = t.shapesAt(x, y, z)
      print(`${x} ${y} ${z}: ${info.name} (state ${t.stateAt(x, y, z)}), ${shapes.length ? shapes.length + ' box' + (shapes.length === 1 ? '' : 'es') : 'no collision'}`)
      for (const s of shapes) print(`  [${s.map(v => +v.toFixed(4)).join(', ')}]`)
      print(`  cell above: ${t.cell(x, y + 1, z).kind}`)
      return
    }

    if (name === 'scene') {
      if ((parts[1] || '').toLowerCase() !== 'save') {
        print('Usage: scene save [name] [radius]')
        return
      }
      const radius = Math.min(32, Math.max(1, Number(parts[3]) || 12))
      const file = saveScene(parts[2] || 'scene-' + Date.now(), radius)
      print(`Saved blocks within ${radius} of the bot to ${file}`)
      return
    }

    if (name === 'nettrace') {
      const action = (parts[1] || '').toLowerCase()
      if (action === 'start') { netTrace.start(); print('Tracing movement packets.'); return }
      if (action === 'stop') {
        const r = netTrace.stop(parts[2] || 'trace-' + Date.now())
        print(`Saved ${r.records.length} packets to ${r.file}`)
        return
      }
      print('Usage: nettrace start | nettrace stop [name]')
      return
    }

    if (name === 'record') {
      const action = (parts[1] || '').toLowerCase()
      if (!recorder) recorder = createRecorder(bot)
      if (action === 'start') {
        recorder.start()
        print('Recording movement. "record stop [name]" saves it.')
        return
      }
      if (action === 'stop') {
        if (!recorder.recording) {
          print('Not recording.')
          return
        }
        const dir = recordingsDir
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `${(parts[2] || 'rec-' + Date.now()).replace(/[^\w.-]/g, '_')}.json`)
        const rec = recorder.save(file)
        print(`Saved ${rec.ticks.length} ticks to ${file}`)
        print(JSON.stringify(stats(rec)))
        return
      }
      print('Usage: record start | record stop [name]')
      return
    }

    if (name === 'move') {
      const direction = MOVE_CONTROLS[(parts[1] || '').toLowerCase()]
      const blocks = Number(parts[2])
      if (!direction || !Number.isFinite(blocks) || blocks <= 0 || blocks > MAX_BLOCKS) {
        print('Usage: move <forward|back|left|right> <blocks>')
        return
      }
      enqueue((gen) => move(direction, blocks, gen))
      return
    }

    if (name === 'goto') {
      const coords = parts.slice(1, 4).map(Number)
      if (coords.length !== 3 || coords.some(coord => !isCoord(coord))) {
        print('Usage: goto <x> <y> <z>')
        return
      }
      const [x, y, z] = coords.map(Math.floor)
      enqueue((gen) => goTo(x, y, z, gen))
      return
    }

    print(logLine('warn', `unknown command "${name}". Type help.`))
  }

  function goTo (x, y, z, gen) {
    const started = Date.now()
    const before = snapStats()
    return bot.nav.goto(x, y, z).then(() => {
      if (gen !== generation) return
      const sec = ((Date.now() - started) / 1000).toFixed(1)
      print(logLine('ok', `arrived at ${x} ${y} ${z} in ${sec}s${statSuffix(before)}`))
    }).catch(err => {
      if (gen !== generation || err.name === 'PathStopped' || err.name === 'GoalChanged') return
      if (err.name === 'NoPath') throw new Error(`No path to ${x} ${y} ${z}`)
      if (err.name === 'Stuck') throw new Error(`Gave up on ${x} ${y} ${z}: ${err.message}`)
      throw err
    })
  }

  async function pulseControl (control) {
    bot.setControlState(control, true)
    await onceTick()
    bot.setControlState(control, false)
  }

  function move (direction, blocks, gen) {
    const { control, x: dirX, z: dirZ } = movementAxes(direction)
    const start = bot.entity.position.clone()
    bot.setControlState(control, true)
    print(logLine('nav', `moving ${direction} ${blocks} block${blocks === 1 ? '' : 's'}`))

    return new Promise((resolve) => {
      let stuck = 0
      let previous = 0
      let bestY = start.y
      let forcedMoves = 0
      const onForcedMove = () => { forcedMoves++ }

      const finish = (message) => {
        bot.removeListener('physicsTick', onTick)
        bot.removeListener('forcedMove', onForcedMove)
        if (bot.entity) bot.setControlState(control, false)
        if (message) print(message)
        resolve()
      }

      const onTick = () => {
        if (gen !== generation || !bot.entity) {
          finish()
          return
        }
        const pos = bot.entity.position
        const traveled = (pos.x - start.x) * dirX + (pos.z - start.z) * dirZ
        if (traveled >= blocks) {
          finish(`Moved ${direction} ${traveled.toFixed(2)} blocks.`)
          return
        }
        // Climbing a ladder barely moves x/z, so the horizontal stall used to
        // release forward after a few ticks and the bot slid back down.
        const climbing = onClimbable()
        const rose = pos.y > bestY + 0.01
        if (rose) bestY = pos.y
        if (traveled > previous + 0.001 || rose) stuck = 0
        else stuck++
        previous = traveled
        if (stuck >= (climbing ? CLIMB_STUCK_TICKS : STUCK_TICKS)) {
          finish(`Stopped ${direction} after ${traveled.toFixed(2)} blocks. ${stallReason(dirX, dirZ, forcedMoves)}`)
        }
      }

      bot.on('forcedMove', onForcedMove)
      bot.on('physicsTick', onTick)
    })
  }

  // The block whose shape meets the player box, nudged along the move.
  function stallReason (dirX, dirZ, forcedMoves) {
    const hit = blockInFront(dirX, dirZ)
    if (hit) {
      const { block, shape } = hit
      const half = slabHalf(block.name, shape)
      return `Hit ${block.name}${half} at ${block.position.x} ${block.position.y} ${block.position.z}.`
    }
    if (forcedMoves > 0) return 'Server moved you back.'
    return 'No block in front.'
  }

  function blockInFront (dirX, dirZ) {
    const pos = bot.entity.position
    const minX = pos.x - PLAYER_HALF + Math.min(0, dirX * STALL_PROBE)
    const maxX = pos.x + PLAYER_HALF + Math.max(0, dirX * STALL_PROBE)
    const minY = pos.y
    const maxY = pos.y + PLAYER_HEIGHT
    const minZ = pos.z - PLAYER_HALF + Math.min(0, dirZ * STALL_PROBE)
    const maxZ = pos.z + PLAYER_HALF + Math.max(0, dirZ * STALL_PROBE)

    let best = null
    let bestDist = Infinity
    for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
      for (let z = Math.floor(minZ); z <= Math.floor(maxZ); z++) {
        for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
          let block = null
          try {
            block = bot.blockAt(new Vec3(x, y, z))
          } catch {
            block = null
          }
          const shape = block && hitShape(block, x, y, z, minX, minY, minZ, maxX, maxY, maxZ)
          if (!shape) continue
          const dist = (x + 0.5 - pos.x) * dirX + (z + 0.5 - pos.z) * dirZ
          if (dist <= 0 || dist >= bestDist) continue
          bestDist = dist
          best = { block, shape }
        }
      }
    }
    return best
  }

  function movementAxes (direction) {
    const yaw = Number(bot.entity.yawDegrees) * Math.PI / 180
    if (!Number.isFinite(yaw)) {
      throw new Error('Bot has no facing direction yet')
    }
    const sin = Math.sin(yaw)
    const cos = Math.cos(yaw)
    const forward = { x: -sin, z: cos }
    const left = { x: cos, z: sin }
    const desired = direction === 'forward'
      ? forward
      : direction === 'back'
        ? { x: -forward.x, z: -forward.z }
        : direction === 'left'
          ? left
          : { x: -left.x, z: -left.z }

    let control = 'forward'
    let best = -Infinity
    for (const candidate of ['forward', 'back', 'left', 'right']) {
      const physics = physicsDirection(candidate, sin, cos)
      const dot = physics.x * desired.x + physics.z * desired.z
      if (dot > best) {
        best = dot
        control = candidate
      }
    }

    return { control, x: desired.x, z: desired.z }
  }

  // Same strafe/forward mix as prismarine-physics moveFlying.
  function physicsDirection (control, sin, cos) {
    const strafe = control === 'right' ? 1 : control === 'left' ? -1 : 0
    const forward = control === 'forward' ? 1 : control === 'back' ? -1 : 0
    return {
      x: strafe * cos - forward * sin,
      z: forward * cos + strafe * sin
    }
  }

  // Raw state ids around the bot, for rebuilding the exact world in the test
  // harness (HarnessWorld.fromScene).
  function saveScene (sceneName, radius) {
    const t = bot.nav.terrain
    t.columns?.clear()
    const p = bot.entity.position
    const cx = Math.floor(p.x)
    const cy = Math.floor(p.y)
    const cz = Math.floor(p.z)
    const blocks = []
    const names = {}
    for (let y = Math.max(0, cy - radius); y <= Math.min(255, cy + radius); y++) {
      for (let z = cz - radius; z <= cz + radius; z++) {
        for (let x = cx - radius; x <= cx + radius; x++) {
          const id = t.stateAt(x, y, z)
          if (id > 0) {
            blocks.push([x, y, z, id])
            names[id] = t.table[id]?.name || 'unknown'
          }
        }
      }
    }
    const e = bot.entity
    const scene = {
      version: bot.version,
      bot: {
        position: [p.x, p.y, p.z],
        velocity: [e.velocity.x, e.velocity.y, e.velocity.z],
        yaw: Number(e.yawDegrees),
        pitch: Number(e.pitchDegrees),
        onGround: e.onGround,
        effects: Object.values(e.effects || {}).map(f => ({ id: f.id, amplifier: f.amplifier }))
      },
      bounds: { min: [cx - radius, Math.max(0, cy - radius), cz - radius], max: [cx + radius, Math.min(255, cy + radius), cz + radius] },
      names,
      blocks
    }
    const dir = path.join(recordingsDir, 'scenes')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${sceneName.replace(/[^\w.-]/g, '_')}.json`)
    fs.writeFileSync(file, JSON.stringify(scene))
    return file
  }

  function onClimbable () {
    const pos = bot.entity.position
    for (const dy of [0, 0.5, 1]) {
      let block = null
      try {
        block = bot.blockAt(pos.offset(0, dy, 0))
      } catch {
        block = null
      }
      if (block && (block.name === 'ladder' || block.name === 'vine')) return true
    }
    return false
  }

  function onceTick () {
    return new Promise((resolve) => bot.once('physicsTick', resolve))
  }

  function markReady () {
    if (!bot.nav) {
      // Path searches run in worker threads so they never stall movement.
      // NAV_WORKERS sets how many (default 2, 0 = plan on the main thread).
      const workers = process.env.NAV_WORKERS === undefined ? 2 : Number(process.env.NAV_WORKERS)
      const pool = workers > 0 ? new WorkerPool({ size: workers }) : undefined
      createNav(bot, { pool })
      if (pool) bot.once('end', () => pool.destroy())
    }
    installGrimTrace(bot, print)
    netTrace = createNetTrace(bot)
    bot.on('nav:stage', (ev) => {
      const text = formatStage(ev)
      if (text) print(text)
    })

    ready = true
    print(logLine('ok', 'ready. Examples: move left 5, goto 0 64 0'))
    print(helpText())
    rl.prompt()
  }

  function snapStats () {
    const s = bot.nav.stats
    return {
      fallbackTicks: s.fallbackTicks,
      predictionMisses: s.predictionMisses,
      replans: { ...s.replans }
    }
  }

  function statSuffix (before) {
    const s = bot.nav.stats
    const parts = []
    const reasons = []
    for (const key of Object.keys(s.replans)) {
      const n = s.replans[key] - (before.replans[key] || 0)
      if (n > 0) reasons.push(n > 1 ? `${key} x${n}` : key)
    }
    if (reasons.length) parts.push('replans ' + reasons.join(', '))
    const fb = s.fallbackTicks - before.fallbackTicks
    if (fb) parts.push(`${fb} fallback tick${fb === 1 ? '' : 's'}`)
    const miss = s.predictionMisses - before.predictionMisses
    if (miss) parts.push(`${miss} prediction miss${miss === 1 ? '' : 'es'}`)
    return parts.length ? ', ' + parts.join(', ') : ''
  }

  function close () {
    if (closed) return
    closed = true
    ready = false
    stopMovement()
    rl.close()
  }

  return { print, markReady, close }
}

function slabHalf (name, shape) {
  if (!name || !name.includes('slab') || name.startsWith('double_')) return ''
  return shape[1] >= 0.5 ? ' upper' : ' bottom'
}

function hitShape (block, x, y, z, minX, minY, minZ, maxX, maxY, maxZ) {
  if (!block.shapes) return null
  for (const shape of block.shapes) {
    const sx0 = x + shape[0]
    const sy0 = y + shape[1]
    const sz0 = z + shape[2]
    const sx1 = x + shape[3]
    const sy1 = y + shape[4]
    const sz1 = z + shape[5]
    if (sx1 > minX && sx0 < maxX && sy1 > minY && sy0 < maxY && sz1 > minZ && sz0 < maxZ) return shape
  }
  return null
}

function describeRejection (r) {
  let text = `${r.x ?? ''}${r.y != null ? ' ' + r.y : ''}${r.z != null ? ' ' + r.z : ''} ${r.reason}`
  if (r.hit === 'unknown') text += ' (by an unloaded chunk)'
  else if (r.hit) text += ` (by ${r.hit.name} at ${r.hit.x} ${r.hit.y} ${r.hit.z}, box [${r.hit.box.map(v => +v.toFixed(4)).join(', ')}])`
  if (r.cells) text += ` [${r.cells}]`
  return text
}

function isCoord (value) {
  return Number.isFinite(value) && Math.abs(value) <= MAX_COORD
}

function parseToggle (word, current) {
  if (!word) return !current
  const value = word.toLowerCase()
  if (value === 'on' || value === 'true') return true
  if (value === 'off' || value === 'false') return false
  return null
}

function helpText () {
  return [
    'Commands:',
    '  move <forward|back|left|right> <blocks>',
    '  goto <x> <y> <z>',
    '  recalc [on|off]   (look for a better route while already walking)',
    '  jump',
    '  stop',
    '  sneak [on|off]',
    '  sprint [on|off]',
    '  jumps [x z]   (parkour jumps from here; with x z, why that column is or is not a jump)',
    '  hitbox <x> <y> <z>   (collision boxes of one block)',
    '  scene save [name] [radius]   (save nearby blocks for offline replay)',
    '  say <message>',
    '  record start | record stop [name]',
    '  quit',
    'Path overlay: Nav View mod on this machine, 127.0.0.1:28765'
  ].join('\n')
}

function dur (ms) {
  if (ms == null || !Number.isFinite(ms)) return '?'
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's'
  if (ms >= 10) return Math.round(ms) + 'ms'
  return ms.toFixed(1) + 'ms'
}

function xyz (p) {
  if (!p) return '?'
  return `${Number(p.x).toFixed(1)} ${Number(p.y).toFixed(1)} ${Number(p.z).toFixed(1)}`
}

function cell (p) {
  if (!p) return '?'
  return `${p.x} ${p.y} ${p.z}`
}

function statusWord (status) {
  const color = {
    found: 'green',
    ok: 'green',
    partial: 'yellow',
    uncertain: 'yellow',
    waiting: 'yellow',
    fallback: 'yellow',
    risky: 'yellow',
    stale: 'yellow',
    noPath: 'red',
    noStart: 'red',
    stuck: 'red',
    fallen: 'red',
    forced: 'red',
    prediction: 'yellow',
    offRoute: 'yellow',
    liquid: 'red',
    blocks: 'yellow'
  }[status] || 'white'
  return paint(color, status || '?')
}

function timingPhrase (ev) {
  const wall = dur(ev.wall)
  if (ev.compute == null || !Number.isFinite(ev.compute) || Math.abs(ev.wall - ev.compute) < 8) return wall
  return `${wall} wall, ${dur(ev.compute)} ${ev.worker ? 'worker' : 'computing'}`
}

function formatStage (ev) {
  switch (ev.stage) {
    case 'start':
      return logLine('nav', `planning ${paint('bold', ev.dist.toFixed(1) + ' blocks')} to ${cell(ev.goal)} from ${xyz(ev.from)}`)
    case 'search': {
      const kinds = (ev.kinds || []).map(([k, n]) => `${n} ${k}`).join(', ')
      const cost = Number.isFinite(ev.cost) ? `, cost ${Math.round(ev.cost)}` : ''
      const wps = ev.waypoints ? `, ${ev.waypoints} waypoints` : ''
      return logLine('nav', `search ${statusWord(ev.status)} in ${timingPhrase(ev)}, ${ev.nodes || 0} nodes${wps}${cost}${kinds ? ' (' + kinds + ')' : ''}`)
    }
    case 'smooth':
      return logLine('nav', `smoothed ${ev.before} -> ${ev.after} waypoints in ${dur(ev.ms)}`)
    case 'route':
      return logLine('nav', `following ${statusWord(ev.status)} route, ${ev.waypoints} waypoints, ${ev.length.toFixed(1)} blocks`)
    case 'continue':
      return logLine('nav', `end of ${statusWord(ev.status)} section, planning the next stretch`)
    case 'chunks':
      return logLine('warn', `path hits unloaded chunks, retrying in ${ev.ticks} ticks`)
    case 'stale':
      return logLine('warn', `discarded ${ev.count} search${ev.count === 1 ? '' : 'es'} because the world changed, searching again`)
    case 'better':
      return logLine('nav', `better route, cost ${ev.cost.toFixed(0)} vs ${ev.remaining.toFixed(0)} left, ${ev.waypoints} waypoints, ${dur(ev.ms)}`)
    case 'replan': {
      const where = ev.pos ? ` at ${xyz(ev.pos)}` : ''
      const wp = ev.size ? `, waypoint ${Math.min(ev.cursor, ev.size - 1)}/${ev.size}${ev.kind ? ' ' + ev.kind : ''}` : ''
      const pen = ev.penalty ? `, penalty ${ev.penalty}` : ''
      return logLine('warn', `replanning (${statusWord(ev.reason)})${where}${wp}${pen}`)
    }
    case 'status': {
      const where = ev.pos ? ` at ${xyz(ev.pos)}` : ''
      const wp = ev.size ? `, waypoint ${Math.min(ev.cursor, ev.size - 1)}/${ev.size}${ev.kind ? ' ' + ev.kind : ''}` : ''
      const plan = ev.plan ? `, plan ${ev.plan}` : ''
      if (ev.status === 'ok' && ev.prev && ev.prev !== 'waiting') {
        return logLine('nav', `recovered from ${statusWord(ev.prev)}${where}${wp}${plan}`)
      }
      if (ev.status === 'ok') return logLine('nav', `moving${where}${wp}${plan}`)
      if (ev.status === 'waiting') return logLine('nav', `waiting for a path${where}`)
      return logLine('warn', `${statusWord(ev.status)}${where}${wp}${plan}`)
    }
    case 'progress': {
      let mid
      if (ev.mode === 'move') {
        mid = `waypoint ${Math.min(ev.cursor, ev.size)}/${ev.size}${ev.kind ? ' ' + ev.kind : ''}`
      } else if (ev.mode === 'planning') {
        mid = `planning ${dur(ev.searchingFor)}`
      } else {
        mid = 'waiting for chunks'
      }
      const plan = ev.mode === 'move' && ev.plan ? `, plan ${ev.plan}` : ''
      const ctrl = ev.mode === 'move' && ev.controlMs != null ? `, control ${dur(ev.controlMs)}` : ''
      const extra = ev.mode === 'move' && ev.searching ? `, search ${dur(ev.searchingFor)}` : ''
      return logLine('nav', `${xyz(ev.pos)} | ${mid} | ${ev.left.toFixed(1)} blocks left${plan}${ctrl}${extra}`)
    }
    default:
      return null
  }
}

module.exports = { attachCommands }
