# Nav system status (2026-10-03)

mineflayer-pathfinder has been replaced by the physics-driven stack in `nav/`. See README "How `goto` works". The old code is in `legacy/`.

## Checkpoint results

`npm run simulate -- --runs 400 --seed 1`:

| kind | runs | arrived | arrived (solvable) | unsolvable courses | movement failures | ticks / lower bound | replans/run | invariant hits |
|---|---|---|---|---|---|---|---|---|
| cliffs | 50 | 94.0% | 100% | 3 | 0 | 1.56 | 0.04 | none |
| hills | 50 | 100% | 100% | 0 | 0 | 1.46 | 0.04 | keyFlicker 9 |
| ladders | 50 | 100% | 100% | 0 | 0 | 2.41 | 0.06 | keyFlicker 4 |
| maze | 50 | 100% | 100% | 0 | 0 | 4.80 | 0.00 | none |
| mixed | 50 | 100% | 100% | 0 | 0 | 1.36 | 0.00 | keyFlicker 11 |
| open | 50 | 100% | 100% | 0 | 0 | 1.24 | 0.02 | keyFlicker 2 |
| parkour | 50 | 98.0% | 100% | 1 | 0 | 1.31 | 0.06 | keyFlicker 8 |
| partial | 50 | 100% | 100% | 0 | 0 | 1.25 | 0.00 | keyFlicker 2 |
| **all** | 400 | 99.0% | **100%** | 4 | 0 | 1.93 | 0.03 | keyFlicker 36 |

- Zero teleports, rotation snaps, off-GCD rotations, sprinting into walls, timeouts and constant-rate turns. Max yaw change was 21.8°/tick.
- "Unsolvable" means the planner found no path at tick 0. Those are generator courses that really are impossible, such as cliff drops that are too deep.
- An earlier 2,000-run batch on a different seed (7) reached 99.9% on solvable courses, with 2 failures.
- `npm test` passes all 77 tests: unit tests, the hitbox tests, plus fixed-seed courses that require zero invariant violations.
- The simulator matches the live physics tick bit for bit, including Speed and Jump Boost (`test/sim.test.js`).

## Parkour (legacy finder)

Jump candidates now come from the legacy finder's set (`legacy/parkour.js`): straight 2-5 blocks, diagonal 1x1 when the diagonal walk is blocked, 2+1 and 3+1 side gaps, and longer side reaches with Speed. They're gated by its parabolic arc test, using the real jump apex. Every candidate is still checked with a physics rollout, which picks sprint or walk, and immediate, late or no release in the air. Planning uses only jumps the physics can land. `jumps` lists unverified jumps and rejected candidates with the reason.

`npm run simulate -- --runs 500 --seed 11 --kinds parkour`: **499/500 arrived** (base, Speed I/II and Jump Boost I/II at 100 each). The one failure is `parkour:1100141:speed1`, a mid-run NoPath. The 400-run all-terrain check still reaches 100% of solvable courses.

## Performance (measured with `node scripts/bench.js`, 8 courses)

| | before | after |
|---|---|---|
| total time | 10.4 s | 4.1 s (2.5x) |
| one physics tick | 2.42 us | 1.39 us |
| physics ticks simulated | 3.14 M | 1.84 M |
| main-thread p99 per tick | 18.5 ms | 3.1 ms |

What did it:
- **Per-tick block cache** (`nav/world.js`): a direct-mapped array in front of a map. It returns the same block objects without hashing or reallocating.
- **Look-ahead reuse in jump validation:** the edge-test probe state becomes the next state when the bot doesn't jump.
- **Lazy jump confidence:** only 1.7% of validated jumps are ever taken, so the 5 perturbation trials run when A* reaches the edge. Unconfirmed jumps wait in the queue as deferred relaxations at a lower-bound cost, so every route still competes on true costs.
- **Transposition table** for node expansions (`Primitives.expand`): 58% of expansions repeated across replans.
- **Trig hoisted** out of the controller's key choice.

Exactness: every change except lazy confidence leaves `scripts/fingerprint.js` (80 runs, exact positions) unchanged. Lazy confidence changes tie order only; the 400-run statistics are identical to eager evaluation.

**Workers** (`nav/workers/`): whole A* searches run in a worker thread over a SharedArrayBuffer copy of the world. Live mode only; tests stay on the main thread. On real-time paced runs the main thread's mean per-tick time fell from 2.9 to 1.1 ms (hills) and from 1.8 to 1.0 ms (mixed), and the bot waited fewer ticks for a plan. The default is 2 workers; `NAV_WORKERS=0` disables them.

Rejected by measurement:
- **Speculative node-level expansion in workers:** slower (2.0 s vs 1.6 s), because 78% of results arrived after the main thread had already done the work.
- **GPU / WASM:** the physics is branchy per-tick JavaScript with chunk lookups, and each rollout is sequential with small batches. Moving it would mean rewriting the physics, and batches are too small to pay for dispatch.

## Hitboxes (2026-10-03)

`nav/shapes18.js` is now the single 1.8.9 collision table for the planner (`Terrain.shapesAt`), the rollout simulator (`NavWorld`) and the live physics (`ShapeWorld`, through a `getSurroundingBBs` hook added by `scripts/patch-physics.js`). It was checked against the 1.8.9 client source (MCP 9.19).
- Static boxes already matched 1.8 for every simple block checked: farmland is a full block, lily pads are 1/64 tall, ladders are 1/8 slabs, plus hopper, cauldron, anvil, cocoa, skulls, trapdoors, gates and so on. The one fix was the piston head arm, which stays inside the head block in 1.8.
- New 1.8 neighbour rules:
  - Fences join same-material fences, gates and opaque full cubes. They never join pumpkins, melons or barriers, and nether brick and wooden fences don't join each other.
  - Walls are one box, 0.3125–0.6875 wide on a straight run, and also join gates and full cubes.
  - Panes and iron bars use the `BlockPane` rule (they join any full block, glass, or another pane).
  - Stairs use the 1.8 corner logic.
  - Double chests extend toward the joined chest.
  - Doors combine both halves.
  - The physics' snow rule from a later version (8 layers with snow above counts as a full block) is gone. In 1.8 that's 0.875.
- `test/shapes.test.js` covers each family and checks that all three worlds resolve the same boxes. The 80-run fingerprint is unchanged, and the 400-run seed-1 batch matches the pre-change run exactly (99.3% arrived, 100% of solvable, keyFlicker 51, accelViolations 1). The generated courses don't contain the affected neighbour cases.

## Known issues

- **Ladder beside a diagonal jump (open):** live, red at 7 133 -23 → green at 8 134 -22 (diagonal 1×1, +1) disappears from `jumps` once a ladder is placed on green, with no rejection reason. I couldn't reproduce it offline at those coordinates with any ladder position or facing. Next step: `jumps 8 -22` and `scene save ladder` on the live setup, then replay it with `HarnessWorld.fromScene`.

- **Key flicker:** about 0.09 events per run. A direction key is re-pressed within 2 ticks, only when every compliant plan was predicted to fail, as a safety override.
- **Stuck handling:** nav no longer gives up. When it is stuck, it makes the failing spot more expensive and replans, so each retry tries a different route. The two seed-7 parkour cases that used to give up (`parkour:701858:speed2`, `parkour:701970:speed1`) now arrive. Because nothing gives up, a truly unreachable spot now keeps retrying until you type `stop`.
- **Drops:** fixed a live bug where the bot froze at ledges. Landing a little past the planned cell counted as a failure, and the fallback then sneaked at the edge so the bot could never step off.
- **Fall damage:** cliffs courses take planned damage drops when no safe route exists. The damage cost in the planner (12 per HP) may need tuning.
- **Maze speed:** routes take about 5x the straight-line lower bound. That's expected for mazes, but turning at sharp corners is slow.
- **Not yet tested live** against Grim. The airborne-sprint timing fix and the ladder fixes come from the legacy debugging and still need confirming there.
- `node_modules` had been corrupted and was reinstalled. The 1.8 ladder patches to prismarine-physics are now reapplied by the `postinstall` script (`scripts/patch-physics.js`).

## Next steps

1. Live Grim testing on localhost parkour courses: `npm start`, then `goto`, watching the `[grim]` traces.
2. Fix the precision diagonal-jump approach: line up the run-up with the jump direction before takeoff.
3. Tune the cost weights (fall damage, edges, jump cost) from simulation and live results.
4. Step 8, movement recording and replay: `nav/recorder.js` and the `record` command exist and pass a replay-exactness test, but no human comparison has been done yet. Deferred.
5. Network latency simulation (future).
6. Delete `legacy/` once live testing passes.
