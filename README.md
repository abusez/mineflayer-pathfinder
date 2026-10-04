# mineflayer test

Joins a Minecraft server with [binmasterdotpro/mineflayer](https://github.com/binmasterdotpro/mineflayer) (1.8.9) and sends `/ac grim`, then `/warp scaffold`.

Login accepts either a Microsoft refresh token or a Minecraft access token, using the same chain as [ravioli-a/refresh-token-authentication](https://github.com/ravioli-a/refresh-token-authentication): refresh token → Xbox Live → XSTS → Minecraft access token → profile.

Requires Node.js 22 or newer.

## Setup

```powershell
npm install
copy .env.example .env
```

Edit `.env`:

```
HOST=your.server.address
PORT=25565
VERSION=1.8.9
REFRESH_TOKEN=your-microsoft-refresh-token
```

Or set `ACCESS_TOKEN` to a Minecraft access token instead of `REFRESH_TOKEN`. Provide only one of them.

## Run

```powershell
npm start
```

After it joins and sends `/ac grim` and `/warp scaffold`, type commands in the terminal:

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

`goto` uses the navigation stack in `nav/`. `jumps` lists the parkour jumps the bot can make from where it stands: landing block, gap size, height change, technique (sprint or walk, and what it does in the air) and confidence. It also lists jumps the physics can't land, and candidates it rejected with the reason (arc blocked, too high, fall too far). `jumps <x> <z>` explains one landing column in full, including routine rejections and, for "arc blocked", the block and box the arc hit. `hitbox <x> <y> <z>` prints a block's 1.8.9 collision boxes. `scene save [name] [radius]` writes the block states around the bot to `recordings/scenes/`, and `HarnessWorld.fromScene` in the test harness rebuilds that world exactly, so a live problem can be replayed offline. `move`, `jump`, `sneak` and `sprint` press keys directly. `stop` cancels the current command. Grim flags print a trace of the last 30 ticks: position, velocity, facing, keys and which controller plan was active.

## How `goto` works

Everything is built on the 1.8.9 physics simulator in the prismarine-physics fork. The bot predicts its own movement with the same code the physics plugin runs, so every decision is checked against the physics before it is made.

- **Planner** (`nav/planner.js`): A* over `(x, y, z, movementState)`. It picks *where* to go: walks, steps, jump-ups, drops, ladders, and parkour jumps at any angle. Jumps go up, across, or down onto lower platforms, and over pits and shallow trenches whenever that's cheaper than walking through. It prefers open, safe and smooth routes, and treats an unloaded chunk as unknown, never as air. The search stays alive and can hand back the next section past the commit frontier before the whole path exists. The search frontier is the furthest node explored.
- **Horizon** (`nav/horizon.js`): commits one section at a time. A section is simulated from the predicted end state of the section before it (position, velocity, facing, ground, sprint, jump), paused if the tick budget runs out, and appended only when that rollout lands. The bot walks the locked prefix while the next section is validated. Physics failures are remembered for that entry state, not as a permanent cost on the cell.
- **Primitives** (`nav/primitives.js`): before the planner may use a jump, a physics rollout of a skilled execution has to land it. Small perturbations of that rollout give each jump a confidence score, which feeds into its cost.
- **Hitboxes** (`nav/shapes18.js`): the 1.8.9 collision box of every block state, transcribed from the 1.8.9 client source. Neighbour-dependent blocks are resolved per position with the 1.8 rules: fences (join same-material fences, gates and opaque full cubes), walls (one box, thinner on a straight run), panes and iron bars, stair corners, double chests, and doors (facing and open from the lower half, hinge from the upper). The planner, the rollout simulator and the live physics all read this one table (the physics through a hook that `scripts/patch-physics.js` adds), so they agree box for box.
- **Terrain** (`nav/blocks.js`): floor heights and clearance from those boxes, including slabs, stairs, snow, fences, walls, trapdoors and ladders.
- **Controller** (`nav/controller.js`): every tick it simulates about 20 candidate input plans and keeps the best. That one comparison produces jump timing, air strafing, landing corrections, braking, and moving sideways while the camera catches up. Keys stay pressed for at least 2 ticks. Sprint follows vanilla rules. It also reads the committed prediction buffer so it can sprint, brake, and start a turn before it reaches the next gap. The section rollout uses the same policy on a frozen copy of the section, not the live buffer.
- **Rotation** (`nav/rotation.js`): a deterministic mouse model with reaction delay, minimum-jerk turns, consistent undershoot and correction, speed and acceleration caps, and the sensitivity GCD. It uses no random noise.
- **Smoother and recovery** (`nav/smoother.js`, `nav/recovery.js`): physics-checked node skipping inside a new section, and replanning when the bot strays, falls, or gets stuck. A block change invalidates predictions whose swept body hits that block, and only that future is resimulated. A small miss against the prediction buffer does not drop the route.
- **Physics fixes** (`nav/physicsFixes.js`, `scripts/patch-physics.js`): the 1.8 airborne-sprint timing fix, the 1.8 ladder fixes, and the hitbox hook. The `node_modules` patches are reapplied on every `npm install`.

The old pathfinder code is kept for reference in `legacy/` until the new system passes live testing.

## Simulation

```powershell
npm test
npm run simulate -- --runs 2000 --seed 1
npm run simulate -- --replay parkour:100154:jump2 --trace
```

`npm test` runs the unit tests plus fixed-seed courses that must complete with zero invariant violations. `simulate` generates seeded courses (open fields, hills, parkour, partial blocks, ladder towers, cliffs, mazes, mixed) with no effects, Speed I/II and Jump Boost I/II. It runs them in parallel worker threads and prints success rates and invariant counts. It writes `sim-report.json`, and every failure can be replayed exactly with `--replay`.

`record start` / `record stop` save the bot's movement to `recordings/`, along with movement statistics such as turn speeds, key hold times and jump rate. These are for comparing against human recordings in the same format (see `nav/recorder.js`).

Flags override the env file:

```powershell
node index.js --host your.server.address --port 25565 --refresh-token YOUR_TOKEN
node index.js --host your.server.address --access-token YOUR_MC_ACCESS_TOKEN
```
