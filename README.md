# No Man's Land

A browser-based 3D match simulator for REBUILT, the 2026 FRC game. The name comes from the Neutral Zone in the middle of the field, which players call no man's land. You drive one robot: intake Fuel, shoot it into your Hub, and play through Auto, the Hub shifts, and End Game.

Built with Three.js, Rapier (`@dimforge/rapier3d-compat`), and Vite. The UI uses the Unbounded and Space Grotesk fonts from Google Fonts, with system fallbacks when offline.

```bash
npm install
npm run dev
```

## Deploying

Every push to `main` builds the game and publishes it to GitHub Pages at https://nodarknight.github.io/rebuild-sim/ (`.github/workflows/deploy.yml`). To deploy by hand, run the **Deploy to GitHub Pages** workflow from the Actions tab.

**One-time setup:** in the repo's Settings > Pages, set Source to **GitHub Actions**.

GitHub serves project sites under `/<repo>/`, so the workflow builds with `BASE_PATH=/rebuild-sim/` (read in `vite.config.ts`). Local builds use `/`. To try a Pages-style build locally:

```bash
BASE_PATH=/rebuild-sim/ npm run build && npx vite preview --base /rebuild-sim/
```

## Controls

| Action | Keyboard / mouse | Gamepad |
| --- | --- | --- |
| Move (toward the opponent is forward in the default view) | WASD | Left stick |
| Rotate | J / L | Right stick X |
| Intake (hold) | Shift | LT / LB / A |
| Shoot (hold) | Space / left mouse | RT / RB |
| Cycle camera (bird's-eye, chase, driver station, top down) | Tab | Y |
| Restart match | R | Start |
| Back to robot picker | Esc | Back |

The default bird's-eye camera sits high behind your robot, always facing the opponent's side, so driving is field-oriented. Any Hub, Trench, or alliance wall between the camera and your robot fades out while it's in the way.

## Online play

Up to six players (3v3); empty slots are parked robots.

1. One player clicks **Host a room** and shares the 5-letter room code.
2. Everyone else types the code and clicks **Join**.
3. In the lobby, each player picks a robot and an alliance, and the host clicks **Start match**.

Only the host can restart (R) or send everyone back to the lobby (Esc).

**How it works:**
- The host's browser runs the real match physics.
- Each joiner sends its driving commands 30 times a second.
- The host streams snapshots (about 2.4 KB each) 20 times a second. A snapshot carries the clock, scores, each robot's pose and mechanisms, and every Fuel ball.
- Joiners show the world 100 ms in the past, blending between snapshots so motion stays smooth.

Connections are peer-to-peer WebRTC (`peerjs`). The free PeerJS cloud service only introduces the players to each other; game data doesn't go through it. Tuning values live under `net` in `config.ts`.

**Limits for now:**
- Joiners feel their own inputs after a round trip plus the 100 ms smoothing delay. There's no client-side prediction yet.
- If the host leaves, the match ends.
- Some strict corporate or school networks block peer-to-peer connections, which would need a TURN relay server.

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
- `camera.ts`, `input.ts`, `hud.ts`: views, controls, and the overlay/menus (including the online lobby)
- `net/session.ts`: hosting and joining rooms, the lobby, and message routing (PeerJS)
- `net/protocol.ts`: binary snapshot and command formats, and the joiner-side interpolation buffer
- `textures.ts`: procedural canvas textures (carpet, floor lettering), so there are no image assets

### Adding a robot type

Add an entry to `CONFIG.robotTypes`. If it needs a new mechanism, add a shooter kind to the `ShooterDef` union in `config.ts` and an implementation to `SHOOTERS` in `shooters.ts`.

### Room to grow

- **AI robots:** robots are driven by a `DriveCommand` (`robot.ts`). The player's comes from input or the auto routine (`Game.playerCommand`). An AI controller would just produce commands for the parked robots.
- **Climbing, fouls, ranking points, human players:** these would hang off `Match` and `Game` and aren't modeled yet.

## Simplifications and rules as modeled

- **Hub scoring:** the Hub is a square box. A ball counts once its center is inside the walls and below the rim, and it can only get there through the top opening. It drops back out on the Neutral Zone side after `hub.exitDelay`.
- **Hub activity:** both Hubs are active in Auto and End Game and inactive during the Transition Shift (`match.transitionHubsActive`). They alternate during Shifts 1–4, starting from the Auto result. Fuel still counts for 3 s after a Hub turns inactive.
- **Where you can score:** only from inside your own Alliance Zone. Outside it, both robots ferry: they lob Fuel high (over the Hub's net) to a floor spot in your Alliance Zone (`ferry` in config). The HUD shows Score or Ferry.
- **Hub:** six clear panels form a solid hexagonal guide on top, so near-misses can bounce in. The top deck around the opening glows in the alliance color while the Hub is active. A truss and net on the Neutral Zone side block Fuel from entering from outside the Alliance Zone. Scored Fuel is seen dropping into the funnel before it's counted out.
- **Trench:** the post beside the Bump is a wedge that carries on the Bump's slope, and an AprilTag sign stands on top of the beam.
- **Shooting:** launch speed is computed from distance with random per-ball spread (about 90% from a standstill across the zone). Flywheels spin up for about half a second when you press Shoot, and the first balls leave a little slow.
- **Turret:** tracks the target with its turret and leads its shots for the robot's motion, so it can shoot on the move.
- **Dumper:** no turret. While Shoot is held it turns its back (the full-width flywheel) toward the target, then streams Fuel from random points along the flywheel. It doesn't lead its shots, so shooting on the move drifts.
- **Robot layout:** Fuel flows front to back. The over-the-bumper intake feeds the hopper (intaken balls are seen rolling up into it), and the hopper's floor belt carries Fuel to the shooter bay at the rear (`bayLength`). Following real REBUILT robots, the Turret is a turntable ring sunk into the frame with a compact shooter head, and the Dumper is a bank of full-width rollers on an arc between two side plates. Both stay within the robot's height.
- **Robot physics:** robots are free rigid bodies with most of their mass in a low ballast (`robot.ballastFraction`), so they pitch over the Bump without tipping. They fall faster than free Fuel (`robot.gravityScale`), lose speed while pitched on the Bump (`robot.slopeSpeedFactor`), and can't be thrown upward faster than `robot.maxRise`, so they roll over the Bump instead of launching. The chassis collider is frictionless (the robot rides on its wheels), and drive is traction-limited and only pushes while the wheels touch the ground, so collisions transfer momentum and defense works. A robot tipped past about 70° for `robot.selfRightAfter` seconds is set back on its wheels.
- **Robot size:** every robot is 22 in tall and fits under the Trench (`robot.height`).
- **Collider details:** the robot collider has a 3 in edge radius (`robot.borderRadius`); smaller radii snag on the Bump's base edge. The Trench bar's collider sits `trench.colliderSlop` above the visual bar, because Rapier's contact margin would otherwise stop a 22 in robot under the 22.25 in bar.
- **Hub height:** the opening is at 64 in, not the real 72 in (`hub.height`).
- **No air drag:** Fuel has no linear damping, because the Turret aims with drag-free ballistics. Angular damping brings rolling Fuel to a stop.
- **Auto:** you drive during Auto by default. Set `match.autoDriverControl` to false to run the built-in routine instead.
