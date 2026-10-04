# mineflayer-nav

Physics-driven parkour pathfinding for [mineflayer](https://github.com/binmasterdotpro/mineflayer) on Minecraft 1.8.9.

Every move is checked against a bit-exact copy of the 1.8.9 client physics before the bot commits to it:
- exact 1.8.9 hitboxes for every block, including fences, walls, panes, stair corners, chests and doors
- parkour jumps at any angle, including long drops
- chained jumps that carry momentum
- vanilla 1.8.9 tick timing and movement packets
- a humanlike, deterministic mouse model

Requires Node.js 22 or newer.

## Install

```bash
npm install github:abusez/mineflayer-pathfinder
```

The repository is `mineflayer-pathfinder`, but the package is named `mineflayer-nav`, so it doesn't clash with the unrelated `mineflayer-pathfinder` on npm. Require it as `mineflayer-nav`.

The package installs its own mineflayer and protocol forks (binmasterdotpro, 1.8.9). Keep install scripts enabled: the `minecraft-data` fork builds its data files at install time. This package's own install step patches `prismarine-physics` with the 1.8.9 fixes, and it re-applies that patch when first required if install scripts were skipped. If your npm asks you to approve install scripts, approve `minecraft-data` and `mineflayer-nav`.

## Quick start

```js
const { createBot } = require('mineflayer-nav')

async function main () {
  const bot = await createBot({
    host: 'localhost',
    username: 'Bot' // offline-mode server; or refreshToken / accessToken
  })

  bot.once('nav:ready', async () => {
    try {
      await bot.nav.goto(100, 64, -20)
      bot.chat('made it')
    } catch (err) {
      console.log('no route:', err.name, err.message)
    }
  })
}

main()
```

`createBot` takes the usual mineflayer options, plus:

| option | |
|---|---|
| `host`, `port` | Port 25565 follows the server's SRV record, like the game client. |
| `version` | Default `'1.8.9'`. |
| `refreshToken` | Microsoft refresh token. Login goes refresh token → Xbox Live → XSTS → Minecraft. |
| `accessToken` | Minecraft access token. |
| `username` | Offline-mode name. Or pass your own `auth` option (for example `'microsoft'`) through to mineflayer. |
| `onSession(session)` | Called after login. Microsoft may rotate the refresh token; store `session.refreshToken`. |
| `nav` | `navPlugin` options (below), or `false` to skip the nav. |

It returns the mineflayer bot, with the vanilla 1.8.9 physics plugin installed instead of mineflayer's own.

## Use with your own bot

```js
const mineflayer = require('mineflayer')
const { vanillaPhysics, navPlugin } = require('mineflayer-nav')

const bot = mineflayer.createBot({
  host: 'localhost',
  username: 'Bot',
  version: '1.8.9',
  plugins: { physics: vanillaPhysics } // required: the nav predicts with this physics
})
bot.loadPlugin(navPlugin({ workers: 2 }))
```

`navPlugin(options)`:

| option | default | |
|---|---|---|
| `workers` | `2` | Planner worker threads. `0` plans on the main thread. |
| `debugServer` | `false` | `true` or `{ port }` streams the route to the navview client mod (default port 28765). |
| `log` | no-op | Receives debug server messages. |

## `bot.nav`

| | |
|---|---|
| `goto(x, y, z)` | Walk, jump and climb to the block. Returns a promise that resolves on arrival and rejects with a `NavError`: `NoPath`, `PathStopped`, `GoalChanged` or `Disconnected`. |
| `stop()` | Cancel the current goto. |
| `active`, `goal`, `route` | Current state. `route.waypoints` is the planned path. |
| `jumpTargets()` | Parkour jumps from where the bot stands: `{ start, jumps, rejected }`, each rejection with a reason. |
| `setRecalc(on)` | Allow or forbid searching for better routes while moving. |
| `terrain`, `sim`, `planner`, `stats` | Internals, for tools and debugging. |

Events on the bot: `nav:ready`, `nav:route`, `nav:search`, `nav:stage`, `nav:replan`, `nav:arrived`, `nav:failed`.

## Other exports

- `attachCommands(bot, { recordingsDir })`: the interactive terminal console the CLI uses.
- `startDebugServer(bot, { port, log })`, `buildSnapshot(bot)`: the route stream for the client mod.
- `installGrimTrace(bot, print)`: prints the last 30 ticks (position, velocity, facing, keys, controller plan) when Grim flags the bot.
- `createRecorder`, `replay`, `recordingStats`, `createNetTrace`: movement recordings and packet traces.
- `buildShapeTable(registry)`, `resolveShapes(table, stateAt, x, y, z)`: 1.8.9 collision boxes.
- `Terrain`, `createSim`, `createNav`, `WorkerPool`, `sessionFromRefreshToken`, `sessionFromAccessToken`, `resolveGameHost`.

## CLI

The package includes the terminal bot it grew out of:

```bash
npx mineflayer-nav --host localhost --username Bot
```

In a clone of this repository, `npm start` runs the same thing. Settings come from flags, or from a `.env` file in the working directory (see `.env.example`):

```
HOST=your.server.address
PORT=25565
VERSION=1.8.9
REFRESH_TOKEN=your-microsoft-refresh-token
JOIN_COMMANDS=/ac grim;/warp scaffold
```

Use `ACCESS_TOKEN` or `OFFLINE_USERNAME` instead of `REFRESH_TOKEN` if you prefer. `NAV_WORKERS` sets the planner threads, and `DEBUG_PORT` sets the client mod port (`0` turns it off).

After joining, type commands:

```
goto 100 64 -20
jumps
jumps 8 -22
hitbox 8 134 -23
scene save ladder
move left 5
jump
stop
sneak on
sprint off
say hello
record start
record stop parkour-run
quit
```

What each command does:
- `jumps` lists the parkour jumps from where the bot stands: landing block, gap, height change, technique and confidence, plus rejected candidates and why. `jumps <x> <z>` explains one landing column in full.
- `hitbox <x> <y> <z>` prints a block's 1.8.9 collision boxes.
- `scene save [name] [radius]` saves the nearby blocks to `recordings/scenes/`. `HarnessWorld.fromScene` in the test harness rebuilds that world, so live problems can be replayed offline.
- `record start` / `record stop` save movement and statistics to `recordings/`.

## navview client mod

`mod/` is a Forge 1.8.9 client mod. It connects to the bot's debug server on `127.0.0.1:28765` and draws the planned route in your game. Download the jar from the [latest release](https://github.com/abusez/mineflayer-pathfinder/releases/latest). Usage and build instructions are in [mod/README.md](mod/README.md). It isn't part of the npm package.

## How it works

Everything is built on the 1.8.9 physics simulator in the prismarine-physics fork. The bot predicts its own movement with the same code the physics plugin runs, so every decision is checked against the physics before it's made.

- **Planner** (`nav/planner.js`): A* over `(x, y, z, movementState)`. It picks *where* to go: walks, steps, jump-ups, drops, ladders and parkour jumps.
  - Jumps can land at any angle, within the reach the jump's air time allows. Longer drops reach further.
  - Fall damage is costed, not forbidden.
  - A landed jump keeps its exact touchdown state (position, velocity, sprint), so the next jump can use that momentum. Gaps that need a run-up you can only get from the jump before can still be planned.
  - It prefers open, safe and smooth routes, and treats an unloaded chunk as unknown, never as air.
- **Primitives** (`nav/primitives.js`): before the planner may use a jump, a physics rollout of a skilled execution has to land it. Small perturbations of that rollout give each jump a confidence score, which feeds into its cost.
- **Hitboxes** (`nav/shapes18.js`): the 1.8.9 collision box of every block state, transcribed from the 1.8.9 client source.
  - Neighbour-dependent blocks are resolved per position with the 1.8 rules: fences, walls, panes and iron bars, stair corners, double chests, and doors.
  - The planner, the rollout simulator and the live physics all read this one table, so they agree box for box.
- **Terrain** (`nav/blocks.js`): floor heights and clearance from those boxes.
- **Controller** (`nav/controller.js`): every tick it simulates about 20 candidate input plans and keeps the best. That one comparison produces jump timing, air strafing, landing corrections, braking, and moving sideways while the camera catches up. Keys stay pressed for at least 2 ticks, and sprint follows vanilla rules.
- **Rotation** (`nav/rotation.js`): a deterministic mouse model with reaction delay, minimum-jerk turns, consistent undershoot and correction, speed and acceleration caps, and the sensitivity GCD. It uses no random noise.
- **Smoother and recovery** (`nav/smoother.js`, `nav/recovery.js`): physics-checked node skipping, and replanning when the bot strays, falls or gets stuck.
- **Vanilla client** (`nav/vanillaClient/`): 1.8.9 tick timing and movement packets.
- **Physics fixes** (`nav/physicsFixes.js`, `scripts/patch-physics.js`): the 1.8 airborne-sprint timing fix, the 1.8 ladder fixes, and the hitbox hook.

## Development

```bash
npm install
npm test
npm run simulate -- --runs 400 --seed 1
npm run simulate -- --replay parkour:100154:jump2 --trace
```

- `npm test` runs the unit tests, the hitbox tests, and fixed-seed courses that must arrive with zero invariant violations.
- `simulate` generates seeded courses (open fields, hills, parkour, partial blocks, ladder towers, cliffs, mazes, mixed) with no effects, Speed I/II and Jump Boost I/II. It runs them in parallel and prints success rates and invariant counts. It writes `sim-report.json`, and any failure can be replayed exactly with `--replay`.
- `node scripts/bench.js` profiles the planner and controller.

The old pathfinder code is kept for reference in `legacy/`.

## License

MIT. See [LICENSE](LICENSE).
