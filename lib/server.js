'use strict'

const dns = require('dns')
const net = require('net')

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

// The game client follows the Minecraft SRV record (_minecraft._tcp.<host>).
// Some resolvers (a local 127.0.0.1 DNS, for one) refuse SRV queries, so
// public resolvers are tried next. Returns { host, port } to connect to.
async function resolveGameHost (host, port = 25565) {
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

module.exports = { resolveGameHost }
