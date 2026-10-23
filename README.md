# rebuild-sim

A browser-based 3D match simulator for REBUILT, the 2026 FRC game. You drive one robot: intake Fuel, shoot it into your Hub, and play through Auto, the Hub shifts, and End Game.

Built with Three.js, Rapier (`@dimforge/rapier3d-compat`), and Vite.

```bash
npm install
npm run dev
```

## Controls

| Action | Keyboard / mouse | Gamepad |
| --- | --- | --- |
| Move (camera-relative) | WASD | Left stick |
| Rotate | Q / E | Right stick X |
| Intake (hold) | Space | LT / LB / A |
| Shoot (hold) | Left Shift / left mouse | RT / RB |
| Cycle camera (follow, driver station, top down) | Tab | Y |
| Restart match | R | Start |
| Back to robot picker | Esc | Back |

## Tuning

All dimensions, counts, speeds, and timings live in `src/config.ts`, in inches and seconds. If the frame rate drops, lower `fuel.total` first, then turn off `render.shadows`.

`window.sim` in the devtools console exposes the live `game`, `CONFIG`, `renderer`, `camera`, and `rig`.

## Layout

- `config.ts`: every tunable value, plus the robot type definitions
- `field.ts`: carpet, walls, Hubs, Bumps, Trenches, and Depots (visuals and colliders)
- `fuel.ts`: a fixed pool of Fuel bodies drawn with one `InstancedMesh`. Fuel is conserved. A ball is either on the field or "stored" (in a hopper, or falling through a Hub).
- `robot.ts`: chassis, accel-limited holonomic drive, intake zone, and hopper
- `shooters.ts`: one implementation per shooter kind (`turret`, `dumper`)
- `match.ts`: the period timeline, Hub active/inactive logic, the 3 s scoring grace, and scores
- `game.ts`: one match. It owns the physics world and runs the fixed-step loop, Hub scoring, and Fuel exits.
- `camera.ts`, `input.ts`, `hud.ts`: views, controls, and the overlay/menus

### Adding a robot type

Add an entry to `CONFIG.robotTypes`. If it needs a new mechanism, add a shooter kind to the `ShooterDef` union in `config.ts` and an implementation to `SHOOTERS` in `shooters.ts`.

### Room to grow

- **AI robots:** robots are driven by a `DriveCommand` (`robot.ts`). The player's comes from input or the auto routine (`Game.playerCommand`). An AI controller would just produce commands for the parked robots.
- **Climbing, fouls, ranking points, human players:** these would hang off `Match` and `Game` and aren't modeled yet.

## Simplifications

- The Hub is a square box. A ball counts once its center is inside the walls and below the rim, and it can only get there through the top opening. It drops back out on the Neutral Zone side after `hub.exitDelay`.
- The Dumper raises a lift above the rim while Shoot is held. It only releases when it's near your own Hub (`requireNearHub` / `maxGapToHub`).
- The Trench bar's collider sits `trench.colliderSlop` (0.75 in) above the visual bar, because Rapier's contact margin would otherwise stop a 22 in robot under the 22.25 in bar.
- Auto drives the robot forward, then shoots its preload (`match.autoShootPreload`). The Dumper is out of range in Auto, so it scores nothing there.
