'use strict'

const f32 = Math.fround

// net.minecraft.util.Timer (MCP 1.8.9), ported field for field.
//
//   sysClock()  ~ Minecraft.getSystemTime()   (LWJGL Sys.getTime() in ms)
//   hrClockMs() ~ System.nanoTime() / 1000000L
//
// Minecraft.runGameLoop calls updateTimer() once per frame, then runTick()
// elapsedTicks times. Clocks are injectable for deterministic tests.
class VanillaTimer {
  constructor (tps = 20, { sysClock = () => Date.now(), hrClockMs = () => Math.floor(performance.now()), runningSince = null } = {}) {
    this.sysClock = sysClock
    this.hrClockMs = hrClockMs
    this.ticksPerSecond = f32(tps)
    this.elapsedTicks = 0
    this.renderPartialTicks = f32(0)
    this.timerSpeed = f32(1)
    this.elapsedPartialTicks = f32(0)
    this.timeSyncAdjustment = 1.0
    this.counter = 0
    this.lastSyncSysClock = Math.trunc(this.sysClock())
    this.lastSyncHRClock = Math.trunc(this.hrClockMs())
    // Vanilla's lastHRTime starts at 0.0 and the timer is created at game
    // start, long before a server is joined. A bot creates its timer at
    // login, so start as a client that has already been running: otherwise
    // the first frame would see a huge delta and run 10 ticks at once.
    this.lastHRTime = runningSince != null ? runningSince : this.hrClockMs() / 1000
    // Diagnostics only (not vanilla state): ticks before the cap last frame.
    this.uncappedTicks = 0
  }

  updateTimer () {
    const i = Math.trunc(this.sysClock())
    const j = i - this.lastSyncSysClock
    const k = Math.trunc(this.hrClockMs())
    const d0 = k / 1000.0

    if (j <= 1000 && j >= 0) {
      this.counter += j

      if (this.counter > 1000) {
        const l = k - this.lastSyncHRClock
        const d1 = this.counter / l
        this.timeSyncAdjustment += (d1 - this.timeSyncAdjustment) * 0.20000000298023224
        this.lastSyncHRClock = k
        this.counter = 0
      }

      if (this.counter < 0) {
        this.lastSyncHRClock = k
      }
    } else {
      this.lastHRTime = d0
    }

    this.lastSyncSysClock = i
    let d2 = (d0 - this.lastHRTime) * this.timeSyncAdjustment
    this.lastHRTime = d0
    d2 = Math.min(1.0, Math.max(0.0, d2)) // MathHelper.clamp_double(d2, 0.0D, 1.0D)
    this.elapsedPartialTicks = f32(this.elapsedPartialTicks + d2 * this.timerSpeed * this.ticksPerSecond)
    this.elapsedTicks = Math.trunc(this.elapsedPartialTicks)
    this.elapsedPartialTicks = f32(this.elapsedPartialTicks - this.elapsedTicks)
    this.uncappedTicks = this.elapsedTicks

    if (this.elapsedTicks > 10) {
      this.elapsedTicks = 10
    }

    this.renderPartialTicks = this.elapsedPartialTicks
  }
}

module.exports = { VanillaTimer }
