'use strict'

const MAX_REJECTED_JUMP_TICKS = 10
const JUMP_ALIGN_DEG = 5
const JUMP_LOG_TICKS = 6
const RECORD_TICKS = 30
const FLAG_INTERVAL_MS = 1000
// Same rules as a client-side S08 flag detector: 500ms between alerts, a 2s
// quiet period after a world join, and no alert when the packet moves you
// more than 3 blocks horizontally (pearls, cages, server transfers).
const FLAG_ALERT_COOLDOWN_MS = 500
const FLAG_JOIN_GRACE_MS = 2000
const FLAG_TELEPORT_DISTANCE_SQ = 9

const PLAYER_HALF_WIDTH = 0.3
const PLAYER_HEIGHT = 1.8
const FULL_CUBE_SHAPE = [[0, 0, 0, 1, 1, 1]]
const RECORDED_PACKETS = new Set(['position', 'position_look', 'look', 'flying', 'entity_action'])

const AIR_ACCEL = Math.fround(0.02)
const AIR_ACCEL_SPRINT = Math.fround(AIR_ACCEL + AIR_ACCEL * 0.3)
// prismarine computes f32(x + x * 0.3), so this value makes its sprint branch
// produce the plain AIR_ACCEL that a non-sprinting tick would have used.
const AIR_ACCEL_UNSPRINT = AIR_ACCEL / 1.3

function configureMovements (movements, bot) {
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowSprinting = true
  movements.allowParkour = true
  movements.scafoldingBlocks = []
  // Pathfinder starts with ladders climbable. Keep that, and keep them out of
  // the avoid set below: a ladder is a partial cube, and marking it avoided
  // makes the cell unsafe so routes never enter it.
  movements.climbables.clear()
  const ladder = bot.registry.blocksByName.ladder
  const vine = bot.registry.blocksByName.vine
  if (ladder) movements.climbables.add(ladder.id)
  if (vine) movements.climbables.add(vine.id)
  // A ladder's collision reaches y=1, so pathfinder treats the cell above it as
  // a floor and routes to the block center. Only a thin strip is solid, and the
  // bot orbits that lip. Fences are not floors; climbables still climb.
  if (ladder) movements.fences.add(ladder.id)
  if (vine) movements.fences.add(vine.id)

  const Block = require('prismarine-block')(bot.registry)
  for (const info of bot.registry.blocksArray) {
    if (info.name === 'air' || info.name === 'cave_air' || info.name === 'void_air') continue
    if (info.name === 'ladder' || info.name === 'vine') continue
    const block = Block.fromStateId(info.minStateId, 0)
    if (isFullCube(block)) continue
    if (!block.shapes || block.shapes.length === 0) continue
    movements.fences.add(info.id)
    movements.blocksToAvoid.add(info.id)
  }
}

function installMovementGuards (bot, print) {
  // 1.8 ladders are 0.125 thick. The bundled shapes are the later 0.1875 box,
  // which is shared with doors, so a jump into one stops 0.0625 blocks early.
  useVanilla18LadderBoxes(bot)
  logFastWorldLadder(bot)
  installFlagDetector(bot, print)

  let desiredYaw = null
  const lastFlagAt = new Map()
  let rejectedJumpTicks = 0
  let jumpLogTicks = 0

  // One entry per tick, holding the state the sim consumed, the packets that
  // went out, and what the blocks did to the motion. A Simulation flag arrives
  // a few ticks after the cause, so keep a second and a half of it.
  const record = []
  let current = null
  let tickId = 0

  const look = bot.look.bind(bot)
  const setControlState = bot.setControlState.bind(bot)
  let sprintTicks = 0

  bot.look = (yaw, pitch, force) => {
    if (typeof yaw === 'number' && Number.isFinite(yaw)) desiredYaw = yaw
    return look(yaw, pitch, force)
  }

  // pathfinder's fullStop() zeroes horizontal velocity and teleports up to half
  // a block to the block center. Vanilla can do neither in one tick, so Grim
  // reads it as a Simulation offset. clearControlStates is its first statement,
  // so this captures the real physics result an instant before it is overwritten.
  let stopSnapshot = null
  const clearControlStates = bot.clearControlStates.bind(bot)
  bot.clearControlStates = () => {
    if (bot.entity) {
      const { position, velocity } = bot.entity
      stopSnapshot = { x: position.x, z: position.z, vx: velocity.x, vz: velocity.z }
    }
    return clearControlStates()
  }

  // updatePosition() runs between the sim and the physicsTick event, so these
  // are the only thing Grim ever saw. Reading bot.entity afterwards instead
  // would pick up the look interpolation that runs before our own listener.
  const write = bot._client.write.bind(bot._client)
  bot._client.write = (name, params) => {
    if (current && RECORDED_PACKETS.has(name)) current.packets.push(packetSummary(name, params))
    return write(name, params)
  }

  let keysThisTick = 'none'
  let prevSprintApplicable = false

  bot.on('physicsTickBegin', () => {
    if (!bot.entity) return

    // Restoring here rather than at the call site: fullStop mutates after
    // clearControlStates returns, and this always runs before the next position
    // packet, so the snapped values never reach the server either way.
    if (stopSnapshot) {
      const { position, velocity } = bot.entity
      // #region agent log
      if (position.x !== stopSnapshot.x || position.z !== stopSnapshot.z || velocity.x !== stopSnapshot.vx || velocity.z !== stopSnapshot.vz) {
        dbgTick('G', 'undid pathfinder fullStop', {
          snappedX: +position.x.toFixed(4),
          snappedZ: +position.z.toFixed(4),
          realX: +stopSnapshot.x.toFixed(4),
          realZ: +stopSnapshot.z.toFixed(4),
          realVx: +stopSnapshot.vx.toFixed(4),
          realVz: +stopSnapshot.vz.toFixed(4)
        })
      }
      // #endregion
      position.x = stopSnapshot.x
      position.z = stopSnapshot.z
      velocity.x = stopSnapshot.vx
      velocity.z = stopSnapshot.vz
      stopSnapshot = null
    }

    // The turn toward a new node happens after the sim, so a jump was leaving
    // the ground still facing the previous node and landing in the block.
    // Snapping here, before simulatePlayer, makes the jump boost and the
    // position packet share the heading pathfinder already asked for.
    const lookErr = lookError()
    if (bot.entity.onGround && bot.getControlState('jump') && desiredYaw != null && lookErr != null && lookErr > JUMP_ALIGN_DEG) {
      look(desiredYaw, 0, true)
    }

    keysThisTick = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
      .filter(key => bot.getControlState(key))
      .join('+') || 'none'

    // 1.8 assigns jumpMovementFactor at the end of the tick, after the move, so
    // airborne acceleration runs on last tick's sprint. Grim checks it that way
    // (lastSprintingForSpeed) but prismarine applies it on the current tick, so
    // every mid-air sprint toggle desyncs by 0.006 until we shift it back.
    const forward = (bot.getControlState('forward') ? 1 : 0) - (bot.getControlState('back') ? 1 : 0)
    const applicable = forward > 0 && !bot.getControlState('sneak') &&
      !bot.entity.isInWater && !bot.entity.isInLava
    const sprinting = applicable && bot.getControlState('sprint')
    const prevSprinting = prevSprintApplicable
    if (sprinting === prevSprinting) bot.physics.airborneAcceleration = AIR_ACCEL
    else bot.physics.airborneAcceleration = sprinting ? AIR_ACCEL_UNSPRINT : AIR_ACCEL_SPRINT
    prevSprintApplicable = sprinting

    // #region agent log
    if (sprinting !== prevSprinting) {
      dbgTick('F', 'airborne sprint accel shifted', {
        onGround: bot.entity.onGround,
        sprinting,
        prevSprinting,
        accel: bot.physics.airborneAcceleration,
        vx: +bot.entity.velocity.x.toFixed(4),
        vz: +bot.entity.velocity.z.toFixed(4)
      })
    }
    // #endregion

    current = {
      tick: ++tickId,
      t: Date.now(),
      pre: {
        pos: vec(bot.entity.position),
        vel: vec(bot.entity.velocity),
        yaw: bot.entity.yaw,
        pitch: bot.entity.pitch,
        yawDeg: Number(bot.entity.yawDegrees),
        pitchDeg: Number(bot.entity.pitchDegrees),
        desiredYaw,
        lookErr: lookError(),
        keys: keysThisTick,
        control: controlSnapshot(),
        jumpQueued: !!bot.jumpQueued,
        onGround: bot.entity.onGround,
        colH: bot.entity.isCollidedHorizontally,
        colV: bot.entity.isCollidedVertically,
        inWater: bot.entity.isInWater,
        inLava: bot.entity.isInLava,
        food: bot.food,
        effects: effectSummary(),
        airAccel: bot.physics.airborneAcceleration,
        sprintApplicable: sprinting,
        prevSprintApplicable: prevSprinting
      },
      packets: [],
      blocks: sampleBlocks()
    }
  })

  bot.on('physicsTick', () => {
    if (!bot.entity) return
    capturePost()
    // Pathfinder drops forward when the next node is straight up the ladder,
    // and without that collision the climb stops. Steering runs after it.
    if (bot.pathfinder?.hold) {
      setControlState('forward', false)
      setControlState('back', false)
      setControlState('left', false)
      setControlState('right', false)
      setControlState('jump', false)
      setControlState('sprint', false)
      setControlState('sneak', false)
      bot.jumpQueued = false
    } else if (bot.pathfinder?.goal && !steerLadderClimb(setControlState)) {
      reconcilePathInputs(setControlState)
    }
    commitTick()
    // #region agent log
    const feet = blockAt(bot.entity.position)
    const under = blockAt(bot.entity.position.offset(0, -1, 0))
    if (bot.entity.onGround && under && under.name === 'ladder' && !isClimbableBlock(feet)) {
      dbg('H', 'standing on ladder top', {
        x: +bot.entity.position.x.toFixed(3),
        y: +bot.entity.position.y.toFixed(3),
        z: +bot.entity.position.z.toFixed(3),
        keys: keysThisTick
      })
    }
    // #endregion
  })

  bot.on('message', (message) => {
    const text = message.toString()
    const flag = parseGrimFlag(text)
    if (!flag) return
    // Timer-packet check. It fires while standing still and says nothing about movement.
    if (flag.check === 'TransactionOrder') return

    // No throttle on Simulation: the offsets arrive as a decaying series and
    // dropping the tail loses the shape that identifies the cause. Only the
    // terminal is thinned out, since 30 lines per flag in a chain is unreadable.
    if (flag.check === 'Simulation') {
      const now = Date.now()
      const previous = lastFlagAt.get('Simulation') || 0
      if (now - previous < FLAG_INTERVAL_MS) print(formatFlag(flag, []))
      else print(formatFlag(flag, record))
      lastFlagAt.set('Simulation', now)
      // #region agent log
      dbgTick('E', 'grim simulation flag', {
        check: flag.check,
        vl: flag.vl,
        detail: flag.detail,
        ticks: record.slice()
      })
      // #endregion
      return
    }

    const now = Date.now()
    const previous = lastFlagAt.get(flag.check) || 0
    if (now - previous < FLAG_INTERVAL_MS) return
    lastFlagAt.set(flag.check, now)
    print(formatFlag(flag, record))
    const latest = record[record.length - 1]
    // #region agent log
    dbg('D', 'grim flag', {
      check: flag.check,
      detail: flag.detail,
      vl: flag.vl,
      keys: latest?.pre.keys,
      colH: latest?.pre.colH,
      onGround: latest?.pre.onGround,
      lookErr: latest?.pre.lookErr,
      yaw: latest?.pre.yawDeg
    })
    // #endregion
  })

  function reconcilePathInputs (setControl) {
    const forward = bot.getControlState('forward')
    const back = bot.getControlState('back')
    const wantsJump = bot.getControlState('jump')
    const wantsSprint = bot.getControlState('sprint')
    const wasSprinting = sprintTicks > 0
    const sneak = shouldSneak(wantsJump)
    const stepping = stepCollision() && !!bot.pathfinder?.goal

    if (sneak && !stepping) {
      setControl('sneak', true)
      setControl('sprint', false)
      cancelJump(setControl)
      sprintTicks = 0
      return
    }
    if (bot.getControlState('sneak')) {
      // #region agent log
      if (stepping) logStep('C', 'sneak forced off for step', { y: +bot.entity.position.y.toFixed(3) })
      // #endregion
      setControl('sneak', false)
    }
    if (stepping && !bodyOnLadder()) {
      setControl('forward', true)
      setControl('back', false)
      setControl('jump', true)
      setControl('sprint', false)
      sprintTicks = 0
      // #region agent log
      logStep('B', 'step jump injected', { y: +bot.entity.position.y.toFixed(3), colH: bot.entity.isCollidedHorizontally })
      // #endregion
    }

    const hardStop = !forward || back || blockedSprint() || hungry()
    let sprint = false
    if (!hardStop && wantsSprint && canSprint(wasSprinting)) {
      sprint = true
      sprintTicks++
    } else {
      sprintTicks = 0
    }
    setControl('sprint', sprint)

    const jumpOk = !wantsJump || jumpAllowed()
    if (wantsJump && !jumpOk) {
      // Pathfinder holds jump for the whole arc, so airborne ticks are not a
      // stall and must not creep the counter toward the escape hatch.
      if (bot.entity.onGround) rejectedJumpTicks++
      cancelJump(setControl)
    } else {
      rejectedJumpTicks = 0
    }
    const colH = bot.entity.isCollidedHorizontally
    const sneaking = bot.getControlState('sneak')
    if (current) {
      // What pathfinder asked for versus what we let through, for the tick
      // these controls will actually drive.
      current.decision = {
        wantsJump,
        wantsSprint,
        jumpOk,
        rejectedJumpTicks,
        sneak: sneaking,
        sprint: bot.getControlState('sprint'),
        jump: bot.getControlState('jump'),
        forward: bot.getControlState('forward'),
        wall: wallAhead(),
        edge: edgeNearby()
      }
    }
    // #region agent log
    if (wantsJump || !bot.entity.onGround) jumpLogTicks = JUMP_LOG_TICKS
    else if (jumpLogTicks > 0) jumpLogTicks--
    if (jumpLogTicks > 0) {
      dbgTick(!jumpOk ? 'B' : sneaking ? 'C' : 'D', 'path input decision', {
        sneak: sneaking,
        sprint: bot.getControlState('sprint'),
        jump: bot.getControlState('jump'),
        forward: bot.getControlState('forward'),
        wantsJump,
        wantsSprint,
        jumpOk,
        rejectedJumpTicks,
        colH,
        onGround: bot.entity.onGround,
        edge: edgeNearby(),
        wall: wallAhead(),
        lookErr: lookError(),
        y: +bot.entity.position.y.toFixed(3),
        vy: +bot.entity.velocity.y.toFixed(3)
      })
    }
    // #endregion
  }

  function cancelJump (setControl) {
    setControl('jump', false)
    // setControlState('jump', true) latches jumpQueued, and physics jumps on that
    // even after the key is released. A rejected jump was still simulated.
    bot.jumpQueued = false
  }

  function canSprint (wasSprinting) {
    if (!bot.getControlState('forward') || bot.getControlState('back')) return false
    if (blockedSprint() || hungry()) return false
    // Vanilla keeps sprinting through a jump; dropping it mid-arc makes
    // pathfinder's sprint jumps fall short of the gap it planned for.
    if (wasSprinting && !bot.entity.onGround) return true
    return bot.entity.onGround && !bot.entity.isCollidedHorizontally
  }

  function blockedSprint () {
    return bot.entity.isInWater || bot.entity.isInLava || bot.entity.isCollidedHorizontally || wallAhead()
  }

  function hungry () {
    return typeof bot.food === 'number' && bot.food <= 6
  }

  function jumpAllowed () {
    if (!bot.entity.onGround) return false
    // A gate that never opens is a freeze, so let a long-rejected jump through.
    if (rejectedJumpTicks >= MAX_REJECTED_JUMP_TICKS) return true
    // A 1-block step is a feet collision with air at the head. Jumping there is
    // the normal way up. Refusing it left the bot pressed into the wool.
    if (stepCollision()) return true
    // Only a full block at head height is worth refusing. Pathfinder turns at
    // 60 deg/tick, so gating on look direction stalled a jump at every step.
    if (bot.entity.isCollidedHorizontally) return false
    return true
  }

  function stepCollision () {
    return bot.entity.onGround && bot.entity.isCollidedHorizontally && !wallAhead()
  }

  function shouldSneak (wantsJump) {
    if (!bot.entity.onGround || wantsJump) return false
    if (bot.entity.isInWater || bot.entity.isInLava) return false
    // A 1-block face and a ladder climb are jumps, not edges to cling to.
    if (stepCollision() || isClimbableBlock(blockAt(bot.entity.position))) return false
    const node = bot.pathfinder?.currentNode
    if (node && (node.kind === 'drop' || node.kind === 'gap' || node.kind === 'step')) return false
    const goal = bot.pathfinder?.goal
    if (goal && Number.isFinite(goal.y) && goal.y > bot.entity.position.y + 0.25) return false
    return edgeNearby()
  }

  // Forward only. Side probes made every 1-wide bridge look like an edge, and
  // a block one step up is support even though the floor under it is air.
  function edgeNearby () {
    const yaw = Number(bot.entity.yawDegrees) * Math.PI / 180
    if (!Number.isFinite(yaw)) return false
    const fx = -Math.sin(yaw)
    const fz = Math.cos(yaw)
    const x = fx * 0.32
    const z = fz * 0.32
    return !solidOffset(x, -0.6, z) && !solidOffset(x, 0.4, z)
  }

  function solidOffset (x, y, z) {
    try {
      const block = bot.blockAt(bot.entity.position.offset(x, y, z))
      return !!block && block.boundingBox === 'block'
    } catch {
      return true
    }
  }

  const lastStepLog = { B: 0, C: 0 }
  function logStep (hypothesisId, message, data) {
    const now = Date.now()
    if (now - lastStepLog[hypothesisId] < 200) return
    lastStepLog[hypothesisId] = now
    // #region agent log
    fetch('http://127.0.0.1:7566/ingest/74c5088e-cc36-4991-a223-3e69704f73d8',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'cbcc58'},body:JSON.stringify({sessionId:'cbcc58',runId:'post-fix-14',hypothesisId,location:'movement.js:reconcilePathInputs',message,data,timestamp:now})}).catch(()=>{});
    // #endregion
  }

  function wallAhead () {
    const yaw = Number(bot.entity.yawDegrees) * Math.PI / 180
    if (!Number.isFinite(yaw)) return false
    const fx = -Math.sin(yaw)
    const fz = Math.cos(yaw)
    try {
      const head = bot.blockAt(bot.entity.position.offset(fx * 0.45, 1.1, fz * 0.45))
      return !!head && head.boundingBox === 'block' && isFullCube(head)
    } catch {
      return false
    }
  }

  // 1.8 climbs only while collided with the ladder, so face its solid side and
  // hold forward. Jump is not a 1.8 climb input, and sprint into the face
  // trips SprintE the tick after the collision.
  function steerLadderClimb (setControl) {
    const block = ladderToClimb()
    if (!block) return false
    const yaw = ladderPushYaw(block)
    if (yaw == null) return false
    desiredYaw = yaw
    look(yaw, 0, true)
    const node = bot.pathfinder.currentNode
    const feetY = Math.floor(bot.entity.position.y + 0.05)
    const cellY = Number.isFinite(node.cellY) ? node.cellY : Math.floor(node.y)
    // A small rise used to look like the node was below the body, so forward
    // released and the jump fell back down. Descend only when the rung itself
    // is under the feet. 1.8 climbs by holding into the face, never by jumping.
    const goingDown = cellY < feetY
    setControl('forward', !goingDown)
    setControl('back', false)
    setControl('left', false)
    setControl('right', false)
    setControl('jump', false)
    setControl('sprint', false)
    setControl('sneak', false)
    bot.jumpQueued = false
    return true
  }

  function bodyOnLadder () {
    const pos = bot.entity.position
    for (const dy of [0, 0.4, 1]) {
      if (isClimbableBlock(blockAt(pos.offset(0, dy, 0)))) return true
    }
    return false
  }

  function ladderToClimb () {
    const node = bot.pathfinder?.currentNode
    if (!node || node.kind !== 'ladder') return null
    const pos = bot.entity.position
    const here = blockAt(pos)
    if (isClimbableBlock(here)) return here
    for (const dy of [0.4, 1]) {
      const above = blockAt(pos.offset(0, dy, 0))
      if (isClimbableBlock(above)) return above
    }
    const cellY = Number.isFinite(node.cellY) ? node.cellY : Math.floor(node.y)
    const cellX = Number.isFinite(node.cellX) ? node.cellX : Math.floor(node.x)
    const cellZ = Number.isFinite(node.cellZ) ? node.cellZ : Math.floor(node.z)
    const cell = blockAt(pos.offset(cellX - pos.x, cellY - pos.y, cellZ - pos.z))
    if (isClimbableBlock(cell)) return cell
    return null
  }

  function blockAt (pos) {
    try {
      return bot.blockAt(pos)
    } catch {
      return null
    }
  }

  function lookError () {
    if (desiredYaw == null || !Number.isFinite(bot.entity.yaw)) return null
    return +(angleDiff(bot.entity.yaw, desiredYaw) * 180 / Math.PI).toFixed(3)
  }

  function controlSnapshot () {
    const out = {}
    for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
      out[key] = bot.getControlState(key)
    }
    return out
  }

  function effectSummary () {
    const effects = bot.entity.effects
    if (!effects) return []
    return Object.values(effects)
      .filter(Boolean)
      .map(e => ({ id: e.id, amplifier: e.amplifier, duration: e.duration }))
  }

  // 3 wide, 3 deep and 4 tall around the feet block covers everything a 0.6 by
  // 1.8 hitbox can touch, plus the floor below and the block it might step onto.
  function sampleBlocks () {
    const base = bot.entity.position.floored()
    const list = []
    for (let dy = -1; dy <= 2; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          let block = null
          try {
            block = bot.blockAt(base.offset(dx, dy, dz))
          } catch {
            block = null
          }
          if (!block) {
            list.push({ dx, dy, dz, name: 'unloaded' })
            continue
          }
          if (block.boundingBox === 'empty') continue
          // Shapes are the bulk of the record and almost every block is a plain
          // cube, so only carry them when they say something.
          if (isFullCube(block)) list.push({ dx, dy, dz, name: block.name, full: true })
          else list.push({ dx, dy, dz, name: block.name, bb: block.boundingBox, shapes: block.shapes })
        }
      }
    }
    return { base: { x: base.x, y: base.y, z: base.z }, list }
  }

  function capturePost () {
    if (!current) return
    const pre = current.pre
    const delta = {
      x: bot.entity.position.x - pre.pos.x,
      y: bot.entity.position.y - pre.pos.y,
      z: bot.entity.position.z - pre.pos.z
    }
    current.post = {
      pos: vec(bot.entity.position),
      vel: vec(bot.entity.velocity),
      onGround: bot.entity.onGround,
      colH: bot.entity.isCollidedHorizontally,
      colV: bot.entity.isCollidedVertically
    }
    current.delta = delta
    // #region agent log
    if (pre.keys === 'none' && Math.hypot(delta.x, delta.z) > 0.05 && Math.hypot(pre.vel.x, pre.vel.z) < 0.02) {
      dbg('B', 'idle position jump', {
        dx: +delta.x.toFixed(4),
        dz: +delta.z.toFixed(4),
        x: +bot.entity.position.x.toFixed(4),
        z: +bot.entity.position.z.toFixed(4),
        pk: current.packets.map(p => p.name + (p.x !== undefined ? '@' + p.x.toFixed(3) + ',' + p.z.toFixed(3) : '')).join(',')
      })
    }
    const ladderTouch = (current.blocks?.list || []).filter(b => b.name === 'ladder')
    if (ladderTouch.length && pre.vel.y < -0.2 && !String(pre.keys).includes('forward')) {
      dbg('C', 'falling past ladder without forward', {
        y: +pre.pos.y.toFixed(3),
        vy: +pre.vel.y.toFixed(4),
        keys: pre.keys,
        shapes: ladderTouch.map(b => b.dx + ',' + b.dy + ',' + b.dz + ':' + (b.shapes ? b.shapes[0][0] : '?')).join(' ')
      })
    }
    // #endregion
    current.interaction = {
      // prismarine clamps each axis separately as it moves, zeroing that
      // component, so a killed velocity is exactly the block taking the motion.
      clampedX: pre.vel.x !== 0 && current.post.vel.x === 0,
      clampedY: pre.vel.y !== 0 && current.post.vel.y === 0,
      clampedZ: pre.vel.z !== 0 && current.post.vel.z === 0,
      stepped: delta.y > 0 && pre.vel.y <= 0 && current.post.onGround,
      touching: touchingBlocks(pre.pos, delta)
    }
  }

  function commitTick () {
    if (!current) return
    record.push(current)
    if (record.length > RECORD_TICKS) record.shift()
    current = null
  }

  // Which sampled boxes the hitbox swept through this tick. This is the set
  // prismarine resolved against, so it is what to compare Grim's view to.
  function touchingBlocks (from, delta) {
    if (!current) return []
    const base = current.blocks.base
    const eps = 1e-7
    const minX = Math.min(from.x, from.x + delta.x) - PLAYER_HALF_WIDTH - eps
    const maxX = Math.max(from.x, from.x + delta.x) + PLAYER_HALF_WIDTH + eps
    const minY = Math.min(from.y, from.y + delta.y) - eps
    const maxY = Math.max(from.y, from.y + delta.y) + PLAYER_HEIGHT + eps
    const minZ = Math.min(from.z, from.z + delta.z) - PLAYER_HALF_WIDTH - eps
    const maxZ = Math.max(from.z, from.z + delta.z) + PLAYER_HALF_WIDTH + eps

    const hits = []
    for (const entry of current.blocks.list) {
      const shapes = entry.full ? FULL_CUBE_SHAPE : entry.shapes
      if (!shapes) continue
      const ox = base.x + entry.dx
      const oy = base.y + entry.dy
      const oz = base.z + entry.dz
      for (const shape of shapes) {
        if (ox + shape[3] > minX && ox + shape[0] < maxX &&
            oy + shape[4] > minY && oy + shape[1] < maxY &&
            oz + shape[5] > minZ && oz + shape[2] < maxZ) {
          hits.push({ dx: entry.dx, dy: entry.dy, dz: entry.dz, name: entry.name })
          break
        }
      }
    }
    return hits
  }
}

function vec (v) {
  return { x: v.x, y: v.y, z: v.z }
}

function packetSummary (name, params) {
  const out = { name }
  if (!params) return out
  for (const key of ['x', 'y', 'z', 'yaw', 'pitch', 'onGround', 'actionId']) {
    const value = params[key]
    if (value === undefined) continue
    out[key] = typeof value === 'boolean' ? value : Number(value)
  }
  return out
}

function useVanilla18LadderBoxes (bot) {
  // registry.version is the comparison object (it has "<" and ">"), not the
  // "1.8.9" string. Reading it first made String() return "[object Object]"
  // and the rewrite never ran, so every ladder stayed 0.1875 thick.
  const version = String(bot.version || bot.registry?.version?.minecraftVersion || '')
  // #region agent log
  fetch('http://127.0.0.1:7566/ingest/74c5088e-cc36-4991-a223-3e69704f73d8',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'cbcc58'},body:JSON.stringify({sessionId:'cbcc58',runId:'post-fix-12',hypothesisId:'A',location:'movement.js:useVanilla18LadderBoxes',message:'ladder box version',data:{version,botVersion:bot.version||null,registryMinecraftVersion:bot.registry?.version?.minecraftVersion||null,registryType:typeof bot.registry?.version},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (!version.startsWith('1.8')) return
  const ladder = bot.registry.blocksByName.ladder
  const table = bot.registry.blockCollisionShapes
  const ids = table?.blocks?.ladder
  if (!ladder || !Array.isArray(ids)) return

  // Same facings as the shared 0.1875 boxes, pulled back to vanilla's 0.125.
  const corrected = {
    27: [[0, 0, 0.875, 1, 1, 1]],
    28: [[0, 0, 0, 0.125, 1, 1]],
    29: [[0, 0, 0, 1, 1, 0.125]],
    30: [[0.875, 0, 0, 1, 1, 1]]
  }
  const boxes = new Map()
  for (const id of ids) {
    if (corrected[id] && !boxes.has(id)) boxes.set(id, corrected[id])
  }
  if (ladder.stateShapes) {
    for (let meta = 0; meta < ids.length; meta++) {
      const box = boxes.get(ids[meta])
      if (box) ladder.stateShapes[meta] = box
    }
  }
  if (ladder.variations) {
    for (const variation of ladder.variations) {
      const box = boxes.get(ids[variation.metadata])
      if (box) variation.shapes = box
    }
  }
  const first = boxes.get(ids[0])
  if (first) ladder.shapes = first

  // bot.world is the sync view. Loaded chunks, and the cached blocks that
  // still point at the old 0.1875 arrays, live on the async world.
  const columns = bot.world?.async?.columns || bot.world?.columns
  let patched = 0
  let columnsSeen = 0
  if (columns) {
    for (const column of Object.values(columns)) {
      columnsSeen++
      const cache = column?.blockCache
      if (!cache) continue
      for (const block of Object.values(cache)) {
        if (!block || block.name !== 'ladder') continue
        const box = boxes.get(ids[block.metadata])
        if (!box) continue
        block.shapes = box
        patched++
      }
    }
  }
  // #region agent log
  fetch('http://127.0.0.1:7566/ingest/74c5088e-cc36-4991-a223-3e69704f73d8',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'cbcc58'},body:JSON.stringify({sessionId:'cbcc58',runId:'post-fix-11',hypothesisId:'A',location:'movement.js:useVanilla18LadderBoxes',message:'ladder box patch',data:{version,columnsSeen,patched,hasAsync:!!bot.world?.async?.columns,sample:boxes.get(30)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
}

// Physics collides through FastWorld, not bot.blockAt. This records the box
// that table actually hands the sim for a nearby ladder.
function logFastWorldLadder (bot) {
  let sample = null
  let at = null
  try {
    const { FastWorld } = require('prismarine-physics')
    const world = new FastWorld(bot)
    const ladder = bot.registry.blocksByName.ladder
    const hits = ladder && bot.findBlocks({ matching: ladder.id, maxDistance: 32, count: 1 })
    const pos = hits && hits[0]
    if (pos) {
      at = { x: pos.x, y: pos.y, z: pos.z }
      const block = world.getBlock(pos)
      sample = block ? block.shapes : null
    } else {
      const columns = bot.world?.async?.columns
      if (columns) {
        for (const column of Object.values(columns)) {
          const cache = column?.blockCache
          if (!cache) continue
          for (const cached of Object.values(cache)) {
            if (!cached || cached.name !== 'ladder' || !cached.position) continue
            at = { x: cached.position.x, y: cached.position.y, z: cached.position.z }
            const block = world.getBlock(cached.position)
            sample = block ? block.shapes : null
            break
          }
          if (sample) break
        }
      }
    }
  } catch (err) {
    sample = err && err.message
  }
  // #region agent log
  fetch('http://127.0.0.1:7566/ingest/74c5088e-cc36-4991-a223-3e69704f73d8',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'cbcc58'},body:JSON.stringify({sessionId:'cbcc58',runId:'post-fix-13',hypothesisId:'A',location:'movement.js:logFastWorldLadder',message:'fastworld ladder shape',data:{sample,at},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
}

function isClimbableBlock (block) {
  return !!block && (block.name === 'ladder' || block.name === 'vine')
}

// Direction to press so the body stays collided with the ladder's thin face.
// mineflayer yaw faces (dx, dz) via atan2(-dx, -dz).
function ladderPushYaw (block) {
  if (!block.shapes || block.shapes.length === 0) return null
  let sx = 0
  let sz = 0
  for (const shape of block.shapes) {
    sx += (shape[0] + shape[3]) / 2
    sz += (shape[2] + shape[5]) / 2
  }
  sx /= block.shapes.length
  sz /= block.shapes.length
  const dx = sx - 0.5
  const dz = sz - 0.5
  if (dx * dx + dz * dz < 0.0025) return null
  return Math.atan2(-dx, -dz)
}

function isFullCube (block) {
  if (!block || block.boundingBox !== 'block' || !block.shapes || block.shapes.length !== 1) return false
  const [x0, y0, z0, x1, y1, z1] = block.shapes[0]
  const eps = 1e-4
  return Math.abs(x0) < eps && Math.abs(y0) < eps && Math.abs(z0) < eps &&
    Math.abs(x1 - 1) < eps && Math.abs(y1 - 1) < eps && Math.abs(z1 - 1) < eps
}

function installFlagDetector (bot, print) {
  let currentCooldown = Date.now() + FLAG_JOIN_GRACE_MS

  const armJoinGrace = () => {
    currentCooldown = Date.now() + FLAG_JOIN_GRACE_MS
  }
  bot.on('login', armJoinGrace)
  bot.on('respawn', armJoinGrace)

  // Before the physics plugin applies the packet, so the distance is measured
  // from where the bot actually was.
  bot._client.prependListener('position', (packet) => {
    if (!bot.entity) return
    const now = Date.now()
    if (wasTeleported(bot.entity.position, packet)) return
    if (now - currentCooldown < FLAG_ALERT_COOLDOWN_MS) return
    currentCooldown = now
    print('Flag detected!')
    process.stdout.write('\u0007')
  })
}

function wasTeleported (position, packet) {
  const bitflags = typeof packet.flags === 'object'
  const flagX = bitflags ? packet.flags.x : (packet.flags & 1) !== 0
  const flagZ = bitflags ? packet.flags.z : (packet.flags & 4) !== 0
  const newX = (flagX ? position.x : 0) + packet.x
  const newZ = (flagZ ? position.z : 0) + packet.z
  const dx = newX - position.x
  const dz = newZ - position.z
  return dx * dx + dz * dz > FLAG_TELEPORT_DISTANCE_SQ
}

function parseGrimFlag (text) {
  const match = text.match(/\[GrimAC\].*failed\s+([A-Za-z0-9_]+)(?:\s*\(vl:([0-9.]+)\))?(?::\s*(.*))?/)
  if (!match) return null
  return { check: match[1], vl: match[2] || '', detail: (match[3] || '').trim() }
}

function formatFlag (flag, record) {
  const detail = flag.detail ? ` ${flag.detail}` : ''
  const lines = [`[grim] ${flag.check} vl=${flag.vl}${detail}`]
  record.forEach((entry, index) => {
    const age = record.length - 1 - index
    const pre = entry.pre
    const post = entry.post
    const delta = entry.delta
    const hit = entry.interaction
    const parts = [
      `  t-${String(age).padStart(2)}`,
      `pos=${num(pre.pos.x)},${num(pre.pos.y)},${num(pre.pos.z)}`,
      `vel=${num(pre.vel.x)},${num(pre.vel.y)},${num(pre.vel.z)}`,
      delta ? `d=${num(delta.x)},${num(delta.y)},${num(delta.z)}` : 'd=?',
      `g=${pre.onGround ? 1 : 0}${post ? '>' + (post.onGround ? 1 : 0) : ''}`,
      `cH=${pre.colH ? 1 : 0}${post ? '>' + (post.colH ? 1 : 0) : ''}`,
      `yaw=${Number.isFinite(pre.yawDeg) ? pre.yawDeg.toFixed(1) : '?'}`,
      `keys=${pre.keys}`,
      `air=${pre.airAccel.toFixed(6)}`
    ]
    if (pre.lookErr != null) parts.push(`lookErr=${pre.lookErr.toFixed(1)}`)
    if (hit) {
      const clamp = `${hit.clampedX ? 'X' : ''}${hit.clampedY ? 'Y' : ''}${hit.clampedZ ? 'Z' : ''}`
      if (clamp) parts.push(`clamped=${clamp}`)
      if (hit.stepped) parts.push('stepped')
      if (hit.touching.length) {
        parts.push(`touch=${hit.touching.map(b => `${b.name}@${b.dx},${b.dy},${b.dz}`).join(' ')}`)
      }
    }
    if (entry.packets.length) {
      parts.push(`pk=${entry.packets.map(p => p.actionId !== undefined ? `${p.name}:${p.actionId}` : p.name).join(',')}`)
    }
    lines.push(parts.join(' '))
  })
  return lines.join('\n')
}

function num (value) {
  return Number.isFinite(value) ? value.toFixed(4) : '?'
}

const debugLastAt = {}
function dbg (hypothesisId, message, data) {
  const now = Date.now()
  if (now - (debugLastAt[hypothesisId] || 0) < 200) return
  debugLastAt[hypothesisId] = now
  dbgTick(hypothesisId, message, data)
}

// Unthrottled: jump decisions only make sense tick by tick.
function dbgTick (hypothesisId, message, data) {
  const now = Date.now()
  // #region agent log
  fetch('http://127.0.0.1:7566/ingest/74c5088e-cc36-4991-a223-3e69704f73d8',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'cbcc58'},body:JSON.stringify({sessionId:'cbcc58',runId:'post-fix-10',hypothesisId,location:'movement.js',message,data,timestamp:now})}).catch(()=>{});
  // #endregion
}

function angleDiff (a, b) {
  let delta = a - b
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return Math.abs(delta)
}

module.exports = { configureMovements, installMovementGuards }
