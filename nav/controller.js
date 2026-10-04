'use strict'

const { emptyInput, copyInput, sameInput, yawToward, CONTROLS } = require('./util')

// Predictive movement controller. Every tick it rolls a handful of candidate
// input plans through the simulator, each followed by the same tracking
// policy, and keeps the one with the best predicted outcome. Jump timing, air
// control, braking and moving sideways while the camera catches up all come
// out of that comparison.

const COMBOS = [
  { forward: true },
  { forward: true, left: true },
  { forward: true, right: true },
  { left: true },
  { right: true },
  { back: true },
  { back: true, left: true },
  { back: true, right: true }
]

// Each combo's normalised (strafe, forward), exactly as inputDirection computes them.
const COMBO_STRAFE = []
const COMBO_FORWARD = []
for (const c of COMBOS) {
  let strafe = (c.right ? 1 : 0) - (c.left ? 1 : 0)
  let forward = (c.forward ? 1 : 0) - (c.back ? 1 : 0)
  const len = Math.hypot(strafe, forward)
  strafe /= len
  forward /= len
  COMBO_STRAFE.push(strafe)
  COMBO_FORWARD.push(forward)
}

const COMMIT_TICKS = 3
const HORIZON = 16
const LONG_HORIZON = 26
const FAIL = -1000
// A predicted failure closer than this (ticks) switches to the fallback.
const IMMINENT_FAIL_TICKS = 8
const EYE = 1.62
const MIN_HOLD_TICKS = 2
// Ground slipperiness 0.6 * 0.91: a released body coasts about v * 1.2.
const COAST = 1.2
// Score cost of a jump, in blocks of progress. Sprint-jumping on flat ground
// gains ~0.05 blocks/tick, so hopping only wins when it clearly pays.
const JUMP_COST = 0.8
// Score cost per half-heart of fall damage taken in a rollout.
const DAMAGE_COST = 2
// How many ticks of current velocity count as future progress.
const MOMENTUM_TICKS = 3
// Weight of average progress over the rollout (rewards getting there sooner).
const PROGRESS_AVG_WEIGHT = 1
// Small preference for keeping the current keys. Smaller than one tick of
// progress, so it can never pin the bot in place.
const STABILITY_BONUS = 0.01

class Controller {
  constructor (bot, sim, terrain, rotation) {
    this.bot = bot
    this.sim = sim
    this.terrain = terrain
    this.rotation = rotation
    this.route = null
    this.cursor = 0
    // The keys really held, and when each last changed, kept by observe()
    // from the bot itself (nav also releases keys while it replans).
    this.applied = emptyInput()
    this.changedAt = Object.fromEntries(CONTROLS.map(k => [k, -100]))
    this.tickCount = 0
    this.stats = { rollouts: 0, fallbackTicks: 0 }
    this.lastPlan = null
  }

  setRoute (route, s) {
    this.route = route
    this.cursor = 1
    if (s) this.cursor = route.advance(s, 1)
  }

  canSprint (s) {
    const food = this.bot.food
    return (typeof food !== 'number' || food > 6) && !s.isInWater && !s.isInLava
  }

  onLadder (s) {
    const p = s.pos
    const info = this.terrain.infoAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    return !!info && info.climbable
  }

  // Yaw that faces the wall a ladder hangs on.
  ladderYaw (w) {
    const info = this.terrain.infoAt(w.x, w.y, w.z)
    if (!info || !info.climbable || !info.shapes.length) return null
    let sx = 0
    let sz = 0
    for (const s of info.shapes) {
      sx += (s[0] + s[3]) / 2
      sz += (s[2] + s[5]) / 2
    }
    sx = sx / info.shapes.length - 0.5
    sz = sz / info.shapes.length - 0.5
    if (sx * sx + sz * sz < 0.0025) return null
    return yawToward(sx, sz)
  }

  // Where the camera should point for state s.
  aimRotation (s, cursor, currentYaw) {
    const route = this.route
    const wps = route.waypoints
    const n = wps.length
    const w = wps[Math.min(cursor, n - 1)]
    const p = s.pos
    if (w.state === 'ladder' || (this.onLadder(s) && (w.kind === 'climb' || w.kind === 'climbDown'))) {
      const yaw = this.ladderYaw(w.state === 'ladder' ? w : wps[cursor - 1] || w)
      if (yaw != null) return { yaw, pitch: w.H < p.y - 0.2 ? 35 : -20 }
    }
    let aim = route.aim(p, cursor)
    let dist = Math.hypot(aim.x - p.x, aim.z - p.z)
    // Close to (or over) the target: look along the next stretch instead, so
    // the camera never whips round to a point just behind the body.
    if (dist < 1 && cursor + 1 < n) {
      aim = route.aim(p, cursor + 1)
      dist = Math.hypot(aim.x - p.x, aim.z - p.z)
    }
    const dx = aim.x - p.x
    const dz = aim.z - p.z
    const yaw = dist < 0.6 ? currentYaw : yawToward(dx, dz)
    const pitch = Math.atan2(EYE - (aim.y - p.y), Math.max(2.5, dist)) * 180 / Math.PI
    return { yaw, pitch: Math.max(-30, Math.min(55, pitch)) }
  }

  // The tracking policy: keys that push toward the aim point with the camera
  // where it actually is, sprinting when legal, jumping at the last tick
  // before an edge or into a face that needs it.
  policy (s, yaw, cursor) {
    const route = this.route
    const wps = route.waypoints
    const n = wps.length
    const input = emptyInput()
    if (cursor >= n) return input
    const w = wps[cursor]
    const prev = wps[cursor - 1] || w
    const p = s.pos

    if (s.isInWater || s.isInLava) {
      const d = this.bestCombo(yaw, w.pos.x - p.x, w.pos.z - p.z)
      if (d) Object.assign(input, d)
      input.jump = true
      return input
    }

    const ladderEdge = w.state === 'ladder' || (this.onLadder(s) && (w.kind === 'climb' || w.kind === 'climbDown' || w.kind === 'ladderExit'))
    if (ladderEdge) {
      if (w.kind === 'climbDown' && w.H < p.y - 0.05) return input // let gravity slide down
      input.forward = true
      return input
    }

    const aim = route.aim(p, cursor)
    const dx = aim.x - p.x
    const dz = aim.z - p.z
    const dist = Math.hypot(dx, dz)
    const hs = Math.hypot(s.motion.x, s.motion.z)

    const last = cursor === n - 1
    if (last && s.onGround) {
      const toEnd = Math.hypot(w.pos.x - p.x, w.pos.z - p.z)
      if (toEnd < hs * COAST + 0.05) return input
    }

    if (dist > 0.05) {
      const combo = this.bestCombo(yaw, dx, dz)
      if (combo) Object.assign(input, combo)
    }

    if (!s.onGround) {
      // Landing control: let go when the current speed would carry past.
      if (w.kind === 'gap' || w.kind === 'jumpUp' || w.kind === 'drop' || last) {
        const toLand = Math.hypot(w.pos.x - p.x, w.pos.z - p.z)
        const tl = ticksToLand(s.pos.y, s.motion.y, w.H)
        if (tl != null && hs * tl * 0.9 > toLand + 0.25) {
          input.forward = false
          input.left = false
          input.right = false
          input.back = hs * tl * 0.6 > toLand + 0.8
        }
      }
      // Air technique the planner validated for this gap (walk-jumps that
      // let go or brake land short targets a sprint jump would overshoot).
      if (w.kind === 'gap' && w.air === 'release') {
        input.forward = input.left = input.right = input.back = false
      } else if (w.kind === 'gap' && w.air === 'brake') {
        input.forward = input.left = input.right = false
        input.back = true
      }
      input.sprint = input.forward && s.prevSprint && this.canSprint(s) && w.sprint !== false
      return input
    }

    // A gap validated as a walk-jump is approached without sprinting.
    const walkJump = w.kind === 'gap' && w.sprint === false
    input.sprint = !!input.forward && !s.isCollidedHorizontally && this.canSprint(s) && !walkJump

    const needsJump = w.kind === 'gap' || w.kind === 'jumpUp' || (w.H - p.y > 0.6 && w.state === 'stand')
    if (needsJump && s.jumpTicks === 0) {
      const fromTakeoff = Math.hypot(p.x - prev.pos.x, p.z - prev.pos.z)
      const nearTakeoff = w.kind !== 'gap' || fromTakeoff < 1.25 ||
        (Math.floor(p.x) === prev.x && Math.floor(p.z) === prev.z)
      if (nearTakeoff) {
        const probe = this.sim.clone(s)
        this.sim.step(probe, input, yaw)
        if (!probe.onGround || probe.isCollidedHorizontally) input.jump = true
      }
    }
    return input
  }

  // Vanilla rules the client enforces on itself: sprint needs forward, food
  // and no horizontal collision (EntityPlayerSP stops it on collision).
  legalize (input, s) {
    if (input.sprint && (!input.forward || input.back || input.sneak || s.isCollidedHorizontally || !this.canSprint(s))) input.sprint = false
    return input
  }

  // Jumps the route asks for are free; only optional hops cost score.
  routeNeedsJump (s, cursor) {
    const wps = this.route.waypoints
    for (let k = cursor; k < Math.min(wps.length, cursor + 2); k++) {
      const w = wps[k]
      if (w.kind === 'gap' || w.kind === 'jumpUp' || w.H - s.pos.y > 0.6) return true
    }
    return false
  }

  bestCombo (yaw, dx, dz) {
    const len = Math.hypot(dx, dz)
    if (len < 1e-6) return null
    const ux = dx / len
    const uz = dz / len
    let best = null
    let bestDot = 0.2
    // inputDirection's math, with the yaw's sin/cos computed once for all
    // eight combos (same expressions, so identical results).
    const rad = yaw * Math.PI / 180
    const sin = Math.sin(rad)
    const cos = Math.cos(rad)
    for (let i = 0; i < COMBOS.length; i++) {
      const strafe = COMBO_STRAFE[i]
      const forward = COMBO_FORWARD[i]
      const dot = (strafe * cos - forward * sin) * ux + (forward * cos + strafe * sin) * uz
      if (dot > bestDot + 1e-9) {
        bestDot = dot
        best = COMBOS[i]
      }
    }
    return best
  }

  // Roll one candidate out. The candidate fixes the keys for its first few
  // ticks; after that the tracking policy drives.
  rollout (s0, rot0, cursor0, cand, horizon) {
    this.stats.rollouts++
    const route = this.route
    const n = route.size
    const s = this.sim.clone(s0)
    const r = rot0.clone()
    let cursor = cursor0
    let collisions = 0
    let jumps = 0
    let hurt = 0
    let fallTop = s0.pos.y
    let progressSum = 0
    let first = null
    let firstLook = null
    let predicted = null
    let completed = false
    let finishedAt = horizon
    let failedAt = -1
    for (let t = 0; t < horizon; t++) {
      const target = this.aimRotation(s, cursor, r.yaw)
      r.setTarget(target.yaw, target.pitch)
      const look = r.next()
      let input
      // Air plans hold their keys until touchdown, the way a player commits
      // to an air strafe; jump plans do the same after takeoff.
      const holding = cand.untilLanding ? (t === 0 || !s.onGround) && t < horizon : t < cand.commit
      if (holding) {
        input = copyInput(cand.keys)
        if (cand.sprint === 'policy') {
          input.sprint = !!input.forward && (s.onGround ? !s.isCollidedHorizontally : s.prevSprint) && this.canSprint(s)
        }
        input.jump = !!cand.jump && t === 0
        if (cand.untilLanding && t > 0 && input.forward && cand.sprint === 'policy') {
          input.sprint = s.prevSprint && this.canSprint(s)
        }
      } else {
        input = this.policy(s, look.yaw, cursor)
      }
      this.legalize(input, s)
      if (t === 0) {
        first = input
        firstLook = look
      }
      if (input.jump && s.onGround && s.jumpTicks === 0 && !this.routeNeedsJump(s, cursor)) jumps++
      const wasAirborne = !s.onGround
      if (s.onGround) fallTop = s.pos.y
      else if (s.pos.y > fallTop) fallTop = s.pos.y
      const segment = route.waypoints[Math.min(cursor, n - 1)]
      this.sim.step(s, input, look.yaw, look.pitch)
      if (wasAirborne && s.onGround) {
        // Damage the route planned for (a deliberate drop) is not held against
        // a candidate, or every way of taking the drop would lose to waiting.
        const damage = Math.ceil(fallTop - s.pos.y - 3 - s.jumpBoost)
        if (damage > 0 && segment.kind !== 'drop') hurt += damage
        fallTop = s.pos.y
      }
      if (cand.trace) cand.trace.push({ x: s.pos.x, y: s.pos.y, z: s.pos.z, yaw: look.yaw, keys: input, cursor })
      if (t === 0) predicted = { x: s.pos.x, y: s.pos.y, z: s.pos.z }
      cursor = route.advance(s, cursor)
      if (wasAirborne && s.onGround && !route.landingOk(s, cursor)) { failedAt = t; break }
      progressSum += route.progress(s.pos, cursor)
      if (cursor >= n) {
        completed = true
        finishedAt = t
        break
      }
      const w = route.waypoints[cursor]
      const floor = route.floorNear(cursor)
      if (w.state !== 'ladder' && !this.onLadder(s)) {
        if (s.pos.y < floor - 1.2 || (s.onGround && s.pos.y < floor - 0.55)) { failedAt = t; break }
        if (s.isCollidedHorizontally) collisions++
      }
      if ((s.isInWater || s.isInLava) && w.state !== 'water') { failedAt = t; break }
    }
    let score
    if (failedAt >= 0) {
      score = FAIL + failedAt
    } else {
      const hs = Math.hypot(s.motion.x, s.motion.z)
      const ran = completed ? finishedAt + 1 : horizon
      // Final progress plus the average along the way: getting there sooner
      // wins even when every candidate ends up at the same waypoint.
      score = route.progress(s.pos, cursor) + PROGRESS_AVG_WEIGHT * progressSum / ran -
        0.4 * route.deviation(s.pos, cursor) - 0.04 * collisions - JUMP_COST * jumps - DAMAGE_COST * hurt
      // Terminal value: momentum along the route is progress still to come.
      const dir = route.direction(cursor)
      // Only on the ground: speed mid-air is not banked until it lands, and
      // crediting it made waiting (still flying at the horizon) beat landing.
      if (dir && s.onGround) score += MOMENTUM_TICKS * (s.motion.x * dir.x + s.motion.z * dir.z)
      // Finishing early is worth the ground it would otherwise still cover.
      if (completed) score += 30 + (horizon - finishedAt) * 0.3 - 3 * hs
    }
    return { score, input: first, look: firstLook, predicted, cursor }
  }

  candidates (s) {
    const list = [{ name: 'policy', commit: 0 }]
    // Warm start: last tick's plan, one tick further along, is always on the
    // table, so following through on a committed key press stays possible.
    const prev = this.prevPlan
    if (prev && prev.commit > 1 && !prev.untilLanding && this.tickCount === prev.tick) {
      list.push({ name: 'carry', commit: prev.commit - 1, keys: { ...prev.keys }, sprint: prev.sprint })
    }
    const sprintOk = this.canSprint(s)
    if (!s.onGround) {
      // In the air: hold one strafe until landing, or briefly then adapt.
      for (const keys of COMBOS) {
        const sprint = keys.forward ? 'policy' : undefined
        list.push({ name: 'air', untilLanding: true, keys: { ...keys }, sprint })
        list.push({ name: 'airTap', commit: MIN_HOLD_TICKS, keys: { ...keys }, sprint })
      }
      list.push({ name: 'airIdle', untilLanding: true, keys: {} })
      list.push({ name: 'airTapIdle', commit: MIN_HOLD_TICKS, keys: {} })
      return list
    }
    for (const keys of COMBOS) {
      if (keys.forward && sprintOk) {
        list.push({ name: 'keys+sprint', commit: COMMIT_TICKS, keys: { ...keys, sprint: true } })
      }
      list.push({ name: 'keys', commit: COMMIT_TICKS, keys: { ...keys } })
    }
    list.push({ name: 'idle', commit: COMMIT_TICKS, keys: {} })
    if (s.jumpTicks === 0) {
      for (const keys of [{ forward: true }, { forward: true, left: true }, { forward: true, right: true }]) {
        // Jump now, then either let the policy steer the air or hold the keys.
        list.push({ name: 'jump', commit: MIN_HOLD_TICKS, keys, sprint: 'policy', jump: true })
        list.push({ name: 'jumpHold', untilLanding: true, keys, sprint: 'policy', jump: true })
      }
    }
    return list
  }

  horizonFor (cursor) {
    const wps = this.route.waypoints
    for (let k = cursor; k < Math.min(wps.length, cursor + 3); k++) {
      const kind = wps[k].kind
      if (kind === 'gap' || kind === 'drop' || kind === 'jumpUp') return LONG_HORIZON
    }
    return HORIZON
  }

  // Called every physics tick with the keys actually held.
  observe (input, tick) {
    this.tickCount = tick
    for (const k of CONTROLS) {
      if (!!input[k] !== !!this.applied[k]) this.changedAt[k] = tick
    }
    this.applied = copyInput(input)
  }

  // A direction key that changed too recently to change again. tickCount is
  // last tick's number while candidates for this tick are being chosen.
  holdViolation (input) {
    const now = this.tickCount + 1
    for (const k of ['forward', 'back', 'left', 'right']) {
      if (!!input[k] !== !!this.applied[k] && now - this.changedAt[k] < MIN_HOLD_TICKS) return true
    }
    return false
  }

  // One real tick. Returns the input and rotation to apply, plus status.
  tick (s) {
    const route = this.route
    this.cursor = route.advance(s, this.cursor)
    if (this.cursor >= route.size) {
      return { status: 'complete', input: emptyInput(), look: this.rotation.next(), predicted: null }
    }

    const horizon = this.horizonFor(this.cursor)
    // Key hold time is a hard rule: a candidate that flicks a direction key
    // too soon is only used when every compliant candidate would fail.
    let best = null
    let bestAny = null
    for (const cand of this.candidates(s)) {
      const res = this.rollout(s, this.rotation, this.cursor, cand, horizon)
      if (res.score > FAIL / 2) {
        const moving = res.input.forward || res.input.back || res.input.left || res.input.right
        if (sameInput(res.input, this.applied) && moving) res.score += STABILITY_BONUS
      }
      const entry = { ...res, cand }
      if (!bestAny || entry.score > bestAny.score) bestAny = entry
      if (this.holdViolation(res.input)) continue
      if (!best || entry.score > best.score) best = entry
    }
    // Fall back on a key flick only for safety: when every compliant plan
    // fails, or fails clearly sooner than the best plan overall.
    if (!best || (best.score <= FAIL / 2 && bestAny.score > best.score + 3)) best = bestAny

    let status = 'ok'
    let input = best.input
    // Only an imminent failure calls for the conservative fallback. A problem
    // late in the horizon is re-examined as the horizon slides forward.
    const failsAt = best.score <= FAIL / 2 ? best.score - FAIL : Infinity
    if (failsAt < IMMINENT_FAIL_TICKS) {
      status = 'fallback'
      this.stats.fallbackTicks++
      input = this.legalize(this.fallback(s), s)
    } else if (failsAt !== Infinity) {
      status = 'risky'
    }

    // The real rotation follows exactly what the rollouts assumed.
    const target = this.aimRotation(s, this.cursor, this.rotation.yaw)
    this.rotation.setTarget(target.yaw, target.pitch)
    const look = this.rotation.next()
    if (status === 'fallback') best.predicted = null

    this.lastPlan = { cand: best.cand.name, score: best.score }
    // tickCount is last tick's number until observe() runs for this one.
    this.prevPlan = status === 'fallback' ? null : { ...best.cand, tick: this.tickCount + 1 }
    return { status, input, look, predicted: best.predicted }
  }

  // Conservative: no sprint, no jump, sneak at edges, walk toward the next
  // waypoint. In the air nothing new can help, so keep the keys as they are.
  fallback (s) {
    if (!s.onGround) return copyInput({ ...this.applied, jump: false })
    const route = this.route
    const w = route.waypoints[Math.min(this.cursor, route.size - 1)]
    const input = emptyInput()
    const combo = this.bestCombo(this.rotation.yaw, w.pos.x - s.pos.x, w.pos.z - s.pos.z)
    if (combo) Object.assign(input, combo)
    if (s.onGround) {
      const probe = this.sim.clone(s)
      this.sim.step(probe, input, this.rotation.yaw)
      // Sneak at edges, except when the route means to step off this one.
      if (!probe.onGround && w.kind !== 'drop') input.sneak = true
    }
    return input
  }
}

// Ticks until a body at y with vertical motion vy comes down to height h.
function ticksToLand (y, vy, h) {
  let t = 0
  let py = y
  let v = vy
  while (t < 60) {
    py += v
    v = (v - 0.08) * 0.98
    t++
    if (v < 0 && py <= h) return t
  }
  return null
}

module.exports = { Controller }
