'use strict'

// Watches the real movement against what the controller predicted and decides
// when the route can no longer be trusted. It never moves the bot itself: it
// asks for a replan, and the controller and mouse model do the correcting.

const PREDICTION_TOLERANCE = 0.05
const PREDICTION_REPLAN = 0.3
const STUCK_TICKS = 30
const OFF_ROUTE = 2.0
const FALLBACK_REPLAN_TICKS = 8
const BETTER_ROUTE_EVERY = 60
const MAX_FRUITLESS_REPLANS = 4

class Recovery {
  constructor () {
    this.reset()
  }

  reset () {
    this.predicted = null
    this.bestProgress = -Infinity
    this.lastProgressTick = 0
    this.fallbackRun = 0
    this.mismatches = 0
    this.fruitlessReplans = 0
    this.replanProgress = -Infinity
    this.lastBetterCheck = 0
    this.counts = { prediction: 0, stuck: 0, offRoute: 0, fallen: 0, liquid: 0, blocks: 0, fallback: 0, forced: 0, better: 0 }
  }

  routeChanged (tick) {
    this.bestProgress = -Infinity
    this.lastProgressTick = tick
    this.fallbackRun = 0
    this.lastBetterCheck = tick
  }

  // Called after the physics tick with the state the server will see.
  check ({ tick, state, route, cursor, status }) {
    if (this.predicted) {
      const p = this.predicted
      const err = Math.hypot(state.pos.x - p.x, state.pos.y - p.y, state.pos.z - p.z)
      if (err > PREDICTION_TOLERANCE) this.mismatches++
      if (err > PREDICTION_REPLAN) return this.replan('prediction')
    }
    if (!route) return null

    const progress = route.progress(state.pos, cursor) + cursor * 0.01
    if (progress > this.bestProgress + 0.1) {
      this.bestProgress = progress
      this.lastProgressTick = tick
    } else if (tick - this.lastProgressTick > STUCK_TICKS) {
      return this.replan('stuck')
    }

    if (cursor < route.size) {
      const w = route.waypoints[cursor]
      if (w.state === 'stand' && state.onGround && route.deviation(state.pos, cursor) > OFF_ROUTE) return this.replan('offRoute')
      if (state.pos.y < route.floorNear(cursor) - 2 && state.onGround) return this.replan('fallen')
      if ((state.isInWater || state.isInLava) && w.state !== 'water') return this.replan('liquid')
    }

    if (status === 'fallback') {
      if (++this.fallbackRun > FALLBACK_REPLAN_TICKS) return this.replan('fallback')
    } else {
      this.fallbackRun = 0
    }
    return null
  }

  wantsBetterRouteCheck (tick) {
    if (tick - this.lastBetterCheck < BETTER_ROUTE_EVERY) return false
    this.lastBetterCheck = tick
    return true
  }

  replan (reason) {
    this.counts[reason] = (this.counts[reason] || 0) + 1
    if (this.bestProgress <= this.replanProgress + 0.5) this.fruitlessReplans++
    else this.fruitlessReplans = 0
    this.replanProgress = this.bestProgress
    return reason
  }

  givingUp () {
    return this.fruitlessReplans >= MAX_FRUITLESS_REPLANS
  }
}

module.exports = { Recovery, PREDICTION_TOLERANCE }
