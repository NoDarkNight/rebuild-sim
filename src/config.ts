// Every dimension, count, speed, and timing value lives here.
// Units: inches, seconds, pounds, radians unless noted.
//
// Coordinate frame: Y is up. The field's long axis is X. Red's alliance wall
// is at -X, Blue's at +X, and the Center Line is x = 0. Z spans the width.

export type Alliance = 'red' | 'blue';
export type ShooterKind = 'turret' | 'dumper';

/** Fields every shooter has. Both kinds compute launch speed from distance, so they
 *  can score from anywhere in the Alliance Zone and ferry from outside it. */
interface ShooterBase {
  /** One ball per shot. */
  shotsPerSecond: number;
  /** Ball apex height above the Hub opening; higher arcs drop more steeply into the Hub. */
  apexAboveTarget: number;
  /** Fastest the shooter can launch; beyond this range shots fall short. */
  maxLaunchSpeed: number;
  /** Random per-ball error (roughly one standard deviation). */
  spreadYawDeg: number;
  spreadSpeedPct: number;
  /** Flywheel reaches full speed this long after shoot is pressed and coasts down over
   *  spinDownTime. Shots start at minFlywheel, a little slow, so the first few can fall short. */
  spinUpTime: number;
  spinDownTime: number;
  minFlywheel: number;
  /** Exit is spawned this far above the robot's top. */
  exitAboveTop: number;
  /** Length of the rear bay holding the shooter; the hopper fills the rest. */
  bayLength: number;
}

export interface TurretShooterDef extends ShooterBase {
  kind: 'turret';
  /** Max turret slew rate, rad/s. Shots only fire once aimed within aimToleranceDeg.
   *  The turret leads its shots for the robot's motion, so it can shoot on the move. */
  slewRate: number;
  aimToleranceDeg: number;
}

export interface DumperShooterDef extends ShooterBase {
  kind: 'dumper';
  /** The full-width roller shooter in the rear bay fires up and over the back,
   *  each ball from a random point along its width, as a continuous stream. */
  /** No turret: the robot turns its back toward the target (turn rate = gain x heading
   *  error) and streams once within the tolerance. Shots don't lead for robot motion. */
  alignGain: number;
  alignToleranceDeg: number;
  /** Fraction of the robot's own motion the shot corrects for (a turret does all of it). */
  moveLead: number;
  /** Intake and shooter share the hopper's feed path, so it can't intake while shooting. */
  intakeWhileShooting: boolean;
}

export type ShooterDef = TurretShooterDef | DumperShooterDef;

export interface RobotTypeDef {
  id: string;
  name: string;
  blurb: string;
  shooter: ShooterDef;
}

export const CONFIG = {
  physics: {
    gravity: 386.09, // in/s^2
    timestep: 1 / 60,
    maxSubSteps: 4,
    solverIterations: 4,
    unitsPerMeter: 39.37, // tells Rapier our length unit so its tolerances scale correctly
  },

  field: {
    length: 651.2,
    width: 317.7,
    wallHeight: 20,
    wallThickness: 4,
    allianceWallHeight: 78,
    /** Alliance wall to the Alliance Zone line. */
    allianceZoneDepth: 158.6,
    lineWidth: 2,
    railHeight: 3, // aluminum cap along the top of the side walls
  },

  hub: {
    size: 47, // square footprint
    height: 64, // top opening height (the real Hub is 72; lowered for feel)
    wallThickness: 4,
    /** Center of the Hub measured from its alliance wall. */
    centerFromWall: 182.11,
    /** Scored Fuel drops out of sight into the Hub over sinkTime, and reappears at the exit after exitDelay. */
    sinkTime: 0.3,
    exitDelay: 0.6,
    exitHeight: 6,
    exitSpeedMin: 50,
    exitSpeedMax: 110,
    exitSpreadZ: 16,
    /** White top band carrying the AprilTags. */
    capHeight: 14,
    /** Six clear panels form a hexagonal funnel on top: inradius at the base, height, outward tilt. */
    guide: { inradius: 20.5, height: 10, tiltDeg: 22, thickness: 0.5 },
    /** Truss and net on the Neutral Zone side stop Fuel from entering from outside the Alliance Zone. */
    netHeight: 130,
  },

  bump: {
    width: 73, // along Z, flanking each side of the Hub
    depth: 44.4, // along X, the driving direction
    height: 6.513,
    topDepth: 12,
    friction: 0.4,
  },

  trench: {
    clearance: 22.25,
    openingWidth: 50.34,
    depth: 10, // along X: a beam, not a tunnel
    barThickness: 7,
    postWidth: 8,
    /** Rapier treats shapes within a few tenths of an inch as touching, which would
     *  block a 22 in robot under a 22.25 in bar; only the bar's collider is raised by this. */
    colliderSlop: 0.75,
  },

  depot: {
    width: 42, // along Z
    depth: 27, // along X, out from the alliance wall
    centerZ: -110, // Red's depot; Blue's is rotated 180 degrees
    rimHeight: 1.125,
    fuelCount: 24,
  },

  fuel: {
    /** Real matches have 504; lower this if frame rate drops. */
    total: 300,
    diameter: 5.91,
    mass: 0.5,
    restitution: 0.55,
    friction: 0.9,
    /** Keep linear damping at 0: it acts as drag in flight and makes long shots fall
     *  short of the shooter's drag-free aim. Angular damping stops rolling balls instead. */
    linearDamping: 0,
    angularDamping: 1.5,
    ccd: true,
    preloadPerRobot: 8,
    /** Loose Fuel in the Neutral Zone: a tightly packed grid centered on the field. */
    neutralSpacing: 6.1,
    neutralJitter: 0.05,
    neutralWidth: 206, // along Z
    sphereSegments: 12,
  },

  robot: {
    length: 27.5,
    width: 27.5,
    mass: 125,
    /** Every robot fits under the Trench for now. */
    height: 22,
    /** Most of the mass sits in a low ballast so the robot rocks over the Bump without tipping. */
    ballastFraction: 0.75,
    ballastHeight: 3,
    bumperHeight: 5,
    /** Rounded like padded bumpers. Small radii snag on the Bump's base edge and pin the robot. */
    borderRadius: 3,
    /** The chassis rides on its wheels, not its frame: no carpet friction (it would eat
     *  turning torque). Drive braking and traction come from the drive model instead. */
    friction: 0,
    maxSpeed: 170, // ~14 ft/s
    /** Traction limit. Drive only pushes when wheels touch the ground, so collisions
     *  transfer momentum and a heavier hit can shove a robot off its line. */
    maxAccel: 360,
    groundProbe: 2.5,
    angularDamping: 2,
    /** If tipped past ~70 degrees for this long, the robot is set back on its wheels. */
    selfRightAfter: 1.2,
    /** Robots fall faster than free Fuel, and can't be thrown upward faster than maxRise,
     *  so they roll over the Bump instead of launching off it. */
    gravityScale: 2.2,
    maxRise: 30,
    slopeTiltDeg: 6,
    slopeSpeedFactor: 0.5,
    maxOmega: 4.5,
    maxAlpha: 18,
    hopperCapacity: 50,
    /** captureTime: how long an intaken ball takes to travel up into the hopper (visual). */
    intake: { reach: 7, width: 24, height: 10, captureTime: 0.3 },
    /** Partners and opponents are parked; damping stands in for locked wheels. */
    idleLinearDamping: 3,
  },

  robotTypes: [
    {
      id: 'turret',
      name: 'Turret',
      blurb: 'Tracks the target and shoots on the move. Scores anywhere in your zone, ferries from midfield.',
      shooter: {
        kind: 'turret',
        shotsPerSecond: 6,
        apexAboveTarget: 40,
        maxLaunchSpeed: 430,
        spreadYawDeg: 3,
        spreadSpeedPct: 5.5,
        spinUpTime: 0.45,
        spinDownTime: 1.5,
        minFlywheel: 0.75,
        exitAboveTop: 6,
        bayLength: 13,
        slewRate: 8,
        aimToleranceDeg: 1.5,
      },
    },
    {
      id: 'dumper',
      name: 'Dumper',
      blurb: 'Full-width rollers stream Fuel fast. Turns to aim; can’t intake while shooting.',
      shooter: {
        kind: 'dumper',
        shotsPerSecond: 13,
        apexAboveTarget: 40,
        maxLaunchSpeed: 430,
        spreadYawDeg: 4,
        spreadSpeedPct: 6,
        spinUpTime: 0.6,
        spinDownTime: 1.5,
        minFlywheel: 0.75,
        exitAboveTop: 3,
        bayLength: 11,
        alignGain: 5,
        alignToleranceDeg: 2,
        moveLead: 0.95,
        intakeWhileShooting: false,
      },
    },
  ] as RobotTypeDef[],

  /** Outside its Alliance Zone a robot can't score; it ferries Fuel to a floor spot this
   *  far from its alliance wall, arcing high enough to clear the Hub's net. */
  ferry: { depthFromWall: 90, sideMargin: 40, apexHeight: 160 },

  /** Starting slots, Red side. Blue's are the same rotated 180 degrees.
   *  Slot 0 is the human-driven robot when it's on that alliance. */
  startSlots: [
    { x: -275, z: -50 },
    { x: -275, z: 10 },
    { x: -275, z: 70 },
  ],

  match: {
    auto: 20,
    transition: 10,
    shiftLength: 25,
    shiftCount: 4,
    endGame: 30,
    scoringGrace: 3,
    /** Whether Hubs score during the Transition Shift. */
    transitionHubsActive: false,
    /** If true, the human drives during Auto. Otherwise this routine runs:
     *  drive forward, then (optionally) shoot the preload. */
    autoDriverControl: true,
    autoDriveTime: 1.0,
    autoDriveSpeed: 80,
    autoShootPreload: true,
  },

  camera: {
    fov: 55,
    /** Default: high behind the robot, always facing the opponent's side (field-oriented driving). */
    birdseye: { height: 230, back: 165, lookAhead: 45, smoothing: 5 },
    /** Chase cam locked behind the robot's heading. smoothing > 0 lets the heading lag instead. */
    follow: { distance: 92, height: 92, lookAhead: 55, lookHeight: 16, smoothing: 0 },
    /** Structures between the camera and the robot fade to this opacity. */
    occlusion: { opacity: 0.18, speed: 10 },
    driverStation: { behindWall: 60, height: 135, lookAtX: -20 }, // lookAtX is for Red; mirrored for Blue
    topDown: { margin: 1.08 },
  },

  render: {
    shadows: true,
    maxPixelRatio: 1.5,
    exposure: 0.95,
    environmentIntensity: 0.3,
  },

  input: {
    gamepadDeadzone: 0.12,
  },

  /** Online play (host runs physics, joiners show snapshots). */
  net: {
    snapshotRate: 20, // per second, host -> each joiner
    commandRate: 30, // per second, joiner -> host
    /** Joiners show the world this far in the past, blending between snapshots. */
    interpDelay: 0.1,
    /** Skip a snapshot for a joiner whose channel has this much unsent data. */
    maxBufferedBytes: 64 * 1024,
    codeLength: 5,
  },

  colors: {
    red: 0xd8262e,
    blue: 0x1f5fd6,
    fuel: 0xf6d21c,
    hubInactive: 0x2a2d33,
    /** UI and highlight accent. */
    gold: 0xffb21e,
  },
};

export const FUEL_RADIUS = CONFIG.fuel.diameter / 2;
