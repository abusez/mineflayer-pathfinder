'use strict'

const os = require('os')
const path = require('path')
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads')

// Fixed pool of planner workers. The main thread never waits on it: it posts
// jobs and polls finished results synchronously with receiveMessageOnPort,
// which also works inside a tight loop with no event-loop turns.
//
// Default size leaves headroom for the main thread (live movement tick,
// network) and the OS: about half the logical cores, at most 8.
function defaultWorkerCount () {
  const cpus = os.cpus().length
  return Math.max(1, Math.min(8, Math.floor(cpus / 2) - 1))
}

class WorkerPool {
  constructor ({ size = defaultWorkerCount(), version = '1.8.9' } = {}) {
    this.size = size
    this.workers = []
    this.nextId = 1
    this.simPose = null
    for (let i = 0; i < size; i++) {
      const worker = new Worker(path.join(__dirname, 'planWorker.js'), { workerData: { version } })
      const { port1, port2 } = new MessageChannel()
      worker.postMessage({ type: 'init', port: port2 }, [port2])
      worker.unref()
      port1.unref()
      worker.on('message', (msg) => {
        if (msg && msg.type === 'sim' && msg.pose) this.simPose = { ...msg.pose, at: Date.now() }
      })
      this.workers.push({ worker, port: port1, busy: 0 })
    }
    this.rr = 0
  }

  // Send world column changes (shared sections) to every worker.
  broadcastColumns (columns) {
    if (!columns.length) return
    const msg = { type: 'columns', mirror: columns[0].mirror, columns: columns.map(c => ({ cx: c.cx, cz: c.cz, sections: c.sections })) }
    for (const w of this.workers) w.worker.postMessage(msg)
  }

  // Least-busy worker; returns false if every worker already has `maxQueue` jobs.
  submit (msg, maxQueue = 2) {
    let best = null
    for (let i = 0; i < this.workers.length; i++) {
      const w = this.workers[(this.rr + i) % this.workers.length]
      if (w.busy < maxQueue && (!best || w.busy < best.busy)) best = w
    }
    if (!best) return false
    this.rr = (this.rr + 1) % this.workers.length
    best.busy++
    best.worker.postMessage({ ...msg, id: this.nextId++ })
    return true
  }

  // Every finished job, without blocking.
  poll () {
    const out = []
    for (const w of this.workers) {
      for (;;) {
        const m = receiveMessageOnPort(w.port)
        if (!m) break
        w.busy--
        out.push(m.message)
      }
    }
    return out
  }

  get idle () {
    return this.workers.reduce((n, w) => n + (w.busy === 0 ? 1 : 0), 0)
  }

  destroy () {
    for (const w of this.workers) w.worker.terminate()
    this.workers = []
  }
}

module.exports = { WorkerPool, defaultWorkerCount }
