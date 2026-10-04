# navview

A Forge 1.8.9 client mod that draws the bot's planned route in your game: the path, its jumps and drops, and the goal. Run it in your own client next to the bot to see what the bot is about to do.

It isn't part of the npm package.

## Install

Download `navview-1.0.0.jar` from the [latest release](https://github.com/abusez/mineflayer-pathfinder/releases/latest) and put it in `.minecraft/mods` of a Forge 1.8.9 install.

## Use

The mod connects to the bot's debug server on `127.0.0.1:28765`. It only connects to the local machine.

- The CLI (`npm start` / `npx mineflayer-nav`) starts the debug server by default. `DEBUG_PORT` changes the port, and `0` turns it off.
- In your own code: `navPlugin({ debugServer: true })`, or `{ debugServer: { port } }`.

In game:

| | |
|---|---|
| `V` | Toggle the overlay (rebindable in Controls). |
| `/navview` | Status: on or off, connected or not, node count. |
| `/navview on`, `/navview off` | Show or hide the overlay. |
| `/navview reconnect` | Reconnect to the debug server. |

The port is in `config/navview.cfg`.

## Build

You need Java 8 and Gradle 4.10.3 (ForgeGradle 2.1).

```bash
cd mod
gradle build
```

The jar is written to `build/libs/navview-1.0.0.jar`.

## Releases

Pushing a tag like `v0.2.0` runs `.github/workflows/mod-release.yml`, which builds the jar and attaches it to a GitHub Release for that tag. The workflow can also be run by hand from the Actions tab, which just uploads the jar as a build artifact.
