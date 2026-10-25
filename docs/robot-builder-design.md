# Robot builder: design proposal

Status: **parked**. It's on hold while multiplayer gets built first. It was revised after the first review (Fuel weight, Dumper shoot-on-move, fewer knobs). Nothing here is built yet.

## Idea in one paragraph

Before a match, players design their own robot instead of picking Turret or Dumper. Each part choice is an engineering tradeoff with physical consequences, and the robot's on-field behavior is computed from the design, never assigned by hand. Two real FRC constraints keep the system balanced: a **weight limit** and the **frame perimeter**. The current Turret and Dumper become presets, and they should play almost exactly as they do now.

## Design principles

1. **Every stat comes from a cause the player can see.** Top speed comes from gearing. Accuracy at a high fire rate comes from flywheel power. Pushing force comes from mass and gearing. The builder shows those causes next to the number.
2. **Budgets bind.** A good default robot sits near the weight limit, so adding anything means giving something up.
3. **Several good answers.** A fast ferry bot, a slow heavy defender, and a tall hauler should all be viable, each strong in a different way.
4. **Few knobs, real consequences.** If a knob doesn't change how the match plays, it goes. The everyday controls are gearing, height, intake, shooter type and count, and hopper size. Feed rate, flywheel, power and hood sit in a collapsed "Advanced" section with sensible defaults.

## Constraints (the budget)

| Constraint | Value | Source |
| --- | --- | --- |
| Weight limit | 115 lb, not counting bumpers and battery | Real FRC rule |
| Bumpers + battery | +28 lb added to physical mass | Typical real values |
| Frame perimeter | 110 in, so width = 55 − length | Real FRC rule |
| Frame length | 24 to 31 in | Keeps the robot roughly square |
| Height | 20 to 30 in | ≤ 22 in fits under the Trench (22.25 in) |

A design over 115 lb can't start a match. The builder shows exactly how far over it is.

## Parts the player chooses

```ts
interface RobotDesign {
  name: string;
  frameLength: number;            // in, 24–31; width = 55 − length
  height: number;                 // in, 20–30
  gearing: 'L1' | 'L2' | 'L3';    // swerve ratio: torque <-> speed
  intakeWidth: number;            // in, 12 up to the frame's inner width
  hopperFill: number;             // 0.4–1: how much of the free space the hopper uses
  shooter:
    | { kind: 'turret'; count: 1 | 2 }
    | { kind: 'dumper'; lanes: 1 | 2 | 3 | 4 }
    | { kind: 'none' };           // pure defense
  feedRate: number;               // balls/s per turret or per dumper lane, 3–8
  flywheel: 'light' | 'medium' | 'heavy';
  power: 'standard' | 'high' | 'max';   // flywheel motors / ratio
  adjustableHood: boolean;
}
```

What each part means mechanically:

- **Gearing** uses the real swerve ratio names. L1 is torquey and slow, and L3 is fast but weak when the robot is heavy.
- **Frame length** trades length for width. A longer robot has a longer hopper; a wider one fits a wider intake and more dumper lanes.
- **Height** above 22 in adds hopper volume but loses the Trench.
- **Shooter:**
  - **Turret:** one or two, each with its own flywheel and aim. Each turret needs a rear bay 13 in long. Two turrets sit side by side in that bay with smaller rings.
  - **Dumper:** one fixed shooter across the back with 1–4 lanes, each about 5 in wide, on a shared hood. Its bay is 11 in. Max lanes = floor((width − 7) / 5).
  - **None:** a defender. No bay, so the hopper gets the space.
- **Flywheel mass** trades spin-up time against shot-to-shot consistency.
- **Power** (one or two motors per flywheel, and the gear ratio) sets top launch speed, which sets ferry reach and how well the shooter holds speed during sustained fire.
- **Adjustable hood** lets the shooter pick its arc, so it stays accurate at every distance. A fixed hood can only change speed, so it's precise only near its sweet spot.

## Derived stats and formulas

All constants go in `config.ts` under a new `builder` section. The numbers below are first guesses, chosen so the two presets land near today's tuning.

### Weight

| Part | Weight (lb) |
| --- | --- |
| Base: drivetrain 24 + frame/belly pan 18 + electronics 10 | 52 |
| Height above 20 in | 0.5 per inch |
| Hopper | 6 + 0.12 × capacity |
| Intake | 6 + 0.3 × width |
| Turret (turntable, indexer, flywheel, hood frame) | 22 each |
| Dumper | 8 + 7 per lane |
| Flywheel mass, per flywheel (a dumper has one per lane) | light 0, medium 1.5, heavy 3 |
| Power, per flywheel | standard 0, high 2, max 2.5 |
| Adjustable hood | 3 per turret, 4 for a dumper |
| Ballast (automatic) | fills any unused weight up to 115 lb, as real teams do; not a player control |

Because ballast tops every legal design up to 115 lb, every robot's physical mass is 115 + 28 = 143 lb (bumpers and battery), plus **about 0.48 lb per ball in the hopper**. Real Fuel is 0.45–0.5 lb, so 50 Fuel adds about 24 lb. A full hopper makes the robot noticeably heavier: harder to push, slower to accelerate. The weight limit is checked with the hopper empty. The parts' weight is what you spend; ballast just fills the rest.

### Hopper capacity

Usable volume is the hopper's floor area times its height:

```
interiorLength = frameLength − 7            (inside the bumpers)
hopperLength   = (interiorLength − bayLength) + 7     (+7 in over-the-bumper overhang)
hopperWidth    = width − 8
hopperHeight   = height − 7.5               (above the belly pan and bumpers)
capacity       = floor(hopperFill × hopperLength × hopperWidth × hopperHeight / 100)
```

The divisor of 100 in³ per ball is a gameplay constant. Real hoppers flare out above the frame after the match starts, and this stands in for that. It's calibrated so today's Turret holds about 40 balls and today's Dumper about 46.

### Driving

| Stat | Formula | Notes |
| --- | --- | --- |
| Top speed | free speed × 0.85: L1 13, L2 15.5, L3 18 ft/s, which is 133 / 158 / 184 in/s | Today: 170 |
| Acceleration | min(μg, F_gear / m × g) with μ = 1.0 and F_gear = L1 180, L2 150, L3 120 lbf | Traction-limited when light, motor-limited when heavy. Today: 360 in/s² |
| Pushing force (defense) | min(F_gear, μ × m) lbf | Shown in the builder. In the sim it emerges from mass plus the acceleration cap |
| Turn rate | 0.55 × top speed / half-diagonal | A square L2 robot gets 4.5 rad/s, same as today |
| Trench | height ≤ 22 | Badge in the builder |

Gearing becomes a real choice:
- A light L3 robot accelerates at the traction limit and is fastest.
- A loaded L3 hauler (about 175 lb) drops to about 0.7 g.
- An L1 defender has the most pushing force in the game but the lowest top speed.

### Shooting

| Stat | Formula |
| --- | --- |
| Fire rate | feedRate × (turret count or dumper lanes) |
| Max launch speed | standard 360, high 420, max 470 in/s |
| Spin-up time | light 0.25 s, medium 0.45 s, heavy 0.75 s, × 1.4 at max power (taller ratio) |
| Shot-to-shot speed variation | each ball briefly drops the flywheel by light 8%, medium 4%, heavy 2%; random error is about half of that |
| Speed sag under sustained fire | sag = 0.006 × feedRate / powerFactor (standard 1, high 1.6, max 1.8); the control loop removes 70% of it, and the rest makes shots land short |
| Aim error | turret 1.5°; dumper 2.5° (the whole robot aims) |
| Fixed-hood penalty | +1% speed error for every 40 in away from its sweet spot (130 in) |
| Shoot-on-move | turret with adjustable hood: full lead; turret with fixed hood: aim leads, but range doesn't adjust; dumper: leads about 95% of the robot's motion, and its whole body has to turn to aim (slightly worse) |
| Intake while shooting | turret: yes; dumper: **no**, because its intake and shooter share the hopper's feed path. This is the dumper's real weakness in REBUILT |

The sag formula is deliberately physical. Heavier flywheels hold speed per ball but recover just as slowly. So the average sag during sustained fire depends on **power** and **fire rate**, not on flywheel mass. Flywheel mass instead buys consistency (less shot-to-shot variation) at the cost of spin-up time.

**Precision** in the builder is the expected hit rate. It's computed with a quick Monte Carlo when the design changes: 300 simulated shots at the Hub opening from 150 in, with the design's spread and sag. It's a rough guide; the real match uses full physics.

### Ferry reach

A ferry shot has to arc over the Hub's net, which needs an apex of 160 in. Given that apex, the maximum ferry distance is:

```
vy = sqrt(2g × (160 − exitHeight))
vh = sqrt(maxLaunch² − vy²)
reach = vh × (vy/g + sqrt(2 × 160 / g))
```

That gives four classes, shown on a small field diagram:

| Class | Reach | Typical power |
| --- | --- | --- |
| None | < 170 in, or no shooter | — |
| Near No Man's Land (the near half of the Neutral Zone) | 170–400 in | standard (about 280 in) |
| All of No Man's Land | 400–530 in | high (about 470 in) |
| Full field (even from the opponent's Alliance Zone) | ≥ 530 in | max (about 600 in) |

Scoring from anywhere in your own Alliance Zone needs only about 200 in, so every shooter can score from the whole zone.

### Intake

- Capture width = intakeWidth.
- Throughput = 0.5 balls/s per inch of width, so a 20 in intake takes 10 balls/s. Today it's unlimited. With a cap, a wide intake actually matters when sweeping the packed Fuel in the middle.

## Presets (sanity check of the numbers)

All on a 27.5 in square frame unless noted.

| Preset | Key choices | Parts weight | Capacity | Notes |
| --- | --- | --- | --- | --- |
| **Turret** (today's) | L2, 22 in, 1 turret, medium flywheel, high power, adjustable hood, 19.5 in intake | 104 lb | 40 | Shoots on the move; ferries from all of No Man's Land |
| **Dumper** (today's) | L2, 22 in, 4 lanes × 3.5/s, light flywheels, standard, fixed hood | 112 lb | 46 | 14 balls/s; ferries only from the near half of No Man's Land |
| **Twin turret** | L2, 22 in, 2 turrets, light, standard, fixed hood, 40% hopper, 13 in intake | 114.8 lb | 16 | High rate on the move, but a small hopper and a narrow intake, right at the limit |
| **Hauler** | L2, 30 in, 3 lanes, light, standard, fixed hood | 113 lb | 72 | Huge hopper, uses the Bump, sluggish when full (about 175 lb loaded) |
| **Defender** | L1, 20 in, no shooter, 50% hopper | 115 lb (mostly ballast) | 33 | 143 lbf pushing force, the most of any preset (L1 torque at full weight); can still carry Fuel |
| **Ferry** | L3, 22 in, 1 turret, heavy, max power, adjustable hood, 70% hopper, 14 in intake | 103 lb | 28 | Ferries from anywhere, top speed 184 in/s |

Each preset is within 115 lb and has a clear weakness. Adding a second turret to the default Turret puts it at about 133 lb, so the player must give up hopper, intake, or hood to fit it. That's the core decision the budget creates.

## UI

A new **Garage** screen replaces the robot picker. The flow is Menu, then Garage, then Match; R restarts with the same design.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  GARAGE                                  [Turret][Dumper][Hauler][Defender][Ferry] presets
├───────────────────────────────┬──────────────────────────────────────────┤
│                               │  DRIVETRAIN   Gearing  (L1)(L2)(L3)       │
│     live 3D preview           │               Frame length ──●── 27.5 in  │
│     (slowly rotating;         │  BODY         Height ────●──── 22 in  ✓ Trench
│      drag to orbit)           │               Hopper fill ────●── 100%     │
│                               │               Intake width ──●─ 19.5 in    │
│                               │  ▸ Advanced: feed rate, flywheel, power, hood │
│                               │  SHOOTER      (Turret ×1)(Turret ×2)(Dumper)(None)
│                               │               Lanes / feed rate / flywheel  │
│                               │               Power (Std)(High)(Max)       │
│                               │               [✓] Adjustable hood          │
├───────────────────────────────┴──────────────────────────────────────────┤
│ WEIGHT  ███████████████████░░░ 104 / 115 lb    CAPACITY 40   TRENCH ✓     │
│ Speed 158 in/s · Accel 1.0 g · Push 143 lbf · Turn 4.5 rad/s             │
│ Fire 6/s · Spin-up 0.45 s · Precision ~88% · Shoot-on-move: full         │
│ Ferry: [mini field: zones shaded where it can ferry/score from]          │
│                                            [Alliance: Red|Blue] [Start →] │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Live feedback:** changing any control rebuilds the preview robot and the stats immediately. Stats that got better flash gold, and stats that got worse flash red.
- **Hover:** each stat explains where it comes from, for example "Push 143 lbf = min(L2 force 150, mass 143 × μ)".
- **Weight bar:** turns red over 115 lb, and Start is disabled with "Over by 18 lb: try a lighter flywheel or a smaller hopper".
- **Saving:** designs save to the browser (localStorage) by name. A "Copy code" button gives a short text code for sharing a design. Both are optional for v1.
- **Other robots:** parked partners and opponents use random presets, so you see other designs on the field.

The look reuses the current golden dark theme and components (glass cards, segmented controls, gold primary button).

## How it maps onto the code

- **New `design.ts`:** the `RobotDesign` type, presets, and a pure `deriveStats(design) → RobotStats`. No three.js or physics, so it's easy to unit test.
- **`config.ts`:** a `builder` section holds every constant above. The per-type `robotTypes` and most of `robot` become presets and derived values.
- **`robot.ts`:** takes `RobotStats` instead of `RobotTypeDef` plus global constants: mass, speed, acceleration, turn rate, capacity, frame size, height, intake width and throughput. Hopper load adds mass at runtime.
- **`shooters.ts`:** turret count (independent aim per turret) and dumper lanes come from stats. Flywheel sag and variation replace the current fixed spin-up model.
- **Model building:** already mostly parametric. It extends to frame length and width, height, intake width, two turrets, and lane count. It runs both in the Garage preview and on the field.
- **New `garage.ts`:** the Garage UI and preview renderer (its own small scene, rendered with the main renderer into a second canvas).

**Suggested build order:**
1. `design.ts` and its stats, with the two current robots as presets that reproduce today's behavior.
2. Wire the stats into the robot and shooters.
3. Parametric models.
4. The Garage UI.
5. More presets and saving.

Each step is playable on its own.

## Out of scope for v1

- **Electrical load / brownouts:** too many motors running at once sags the drive.
- **Swerve module choice beyond gearing**, and different wheel treads.
- **Per-part reliability** (breakdowns).
- **Climbing mechanisms:** climbing isn't in the sim yet.

## Questions for you

1. **Weight rule:** use the real rule (115 lb, not counting bumpers and battery) as proposed, or one simpler total-mass cap?
2. **No shooter:** should a shooterless defender be allowed?
3. **Hopper load:** should carried Fuel (about 0.48 lb each) add mass, making full robots slower and harder to push? It's realistic, but it's a noticeable feel change.
7. **Automatic ballast:** filling unused weight up to 115 lb keeps the player from managing ballast, but it means every robot weighs the same and pushing power comes from gearing alone. Is that the right simplification?
4. **Limits:** at most two turrets and four dumper lanes. Too few, or too many?
5. **Ferry classes:** do the four tiers match how ferrying works in REBUILT as you see it?
6. **Saving and sharing:** in v1, or later?
