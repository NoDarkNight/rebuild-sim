// Every dimension, count, speed, and timing value lives here.
// Units: inches, seconds, pounds, radians unless noted.
//
// Coordinate frame: Y is up. The field's long axis is X. Red's alliance wall
// is at -X, Blue's at +X, and the Center Line is x = 0. Z spans the width.

export type Alliance = 'red' | 'blue';
export type ShooterKind = 'turret' | 'dumper';

export interface TurretShooterDef {
  kind: 'turret';
  ballsPerSecond: number;
  /** Ball apex height above the Hub opening; higher arcs drop more steeply into the Hub. */
  apexAboveTarget: number;
  /** Fastest the shooter can launch; beyond this range shots fall short. */
  maxLaunchSpeed: number;
  /** Random aim error, one standard-ish deviation. */
  spreadYawDeg: number;
  spreadSpeedPct: number;
  /** Turret pivot, robot-local (x forward). Exit is spawned this far above the robot top. */
  pivotX: number;
  exitAboveTop: number;
  /** Max turret slew rate, rad/s. Shots only fire once aimed within aimToleranceDeg. */
  slewRate: number;
  aimToleranceDeg: number;
}

export interface DumperShooterDef {
  kind: 'dumper';
  ballsPerSecond: number;
  /** Fixed, robot-relative trajectory: ball apex height (absolute) and how far
   *  forward of the exit it falls back through the Hub opening height. */
  apexHeight: number;
  landReach: number;
  spreadYawDeg: number;
  spreadSpeedPct: number;
  /** Exit point, robot-local x (forward). A lift raises it to releaseHeight
   *  (above the floor) over liftTime while shoot is held; it only releases fully raised. */
  exitX: number;
  releaseHeight: number;
  liftTime: number;
  /** Only releases when the bumper is within this gap of the alliance's own Hub. */
  requireNearHub: boolean;
  maxGapToHub: number;
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
  },

  hub: {
    size: 47, // square footprint
    height: 72, // top opening height
    wallThickness: 4,
    /** Center of the Hub measured from its alliance wall. */
    centerFromWall: 182.11,
    /** Scored Fuel reappears this long after entering. */
    exitDelay: 0.6,
    exitHeight: 6,
    exitSpeedMin: 50,
    exitSpeedMax: 110,
    exitSpreadZ: 16,
  },

  bump: {
    width: 73, // along Z, flanking each side of the Hub
    depth: 44.4, // along X, the driving direction
    height: 6.513,
    topDepth: 12,
  },

  trench: {
    clearance: 22.25,
    openingWidth: 50.34,
    depth: 47, // along X
    barThickness: 12,
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
    linearDamping: 0.25,
    angularDamping: 0.8,
    ccd: true,
    preloadPerRobot: 8,
    /** Loose Fuel in the Neutral Zone: a jittered grid centered on the field. */
    neutralSpacing: 7.5,
    neutralJitter: 0.7,
    neutralWidth: 206, // along Z
    sphereSegments: 12,
  },

  robot: {
    length: 27.5,
    width: 27.5,
    mass: 125,
    heights: { short: 22, tall: 30 } as const,
    bumperHeight: 5,
    borderRadius: 1,
    friction: 0.2,
    maxSpeed: 170, // ~14 ft/s
    maxAccel: 360,
    maxOmega: 4.5,
    maxAlpha: 18,
    hopperCapacity: 50,
    intake: { reach: 7, width: 24, height: 10 },
    /** Partners and opponents are parked; heavy damping makes them feel braked. */
    idleLinearDamping: 6,
  },

  robotTypes: [
    {
      id: 'turret',
      name: 'Turret',
      blurb: 'Auto-aims at your Hub. Shoot while moving from anywhere in range.',
      shooter: {
        kind: 'turret',
        ballsPerSecond: 6,
        apexAboveTarget: 40,
        maxLaunchSpeed: 420,
        spreadYawDeg: 1.6,
        spreadSpeedPct: 2.5,
        pivotX: 5,
        exitAboveTop: 4,
        slewRate: 8,
        aimToleranceDeg: 6,
      },
    },
    {
      id: 'dumper',
      name: 'Dumper',
      blurb: 'No aiming. Drive up against your Hub and dump Fuel in fast.',
      shooter: {
        kind: 'dumper',
        ballsPerSecond: 14,
        apexHeight: 92,
        landReach: 26,
        spreadYawDeg: 4,
        spreadSpeedPct: 4,
        exitX: 9,
        releaseHeight: 80,
        liftTime: 0.35,
        requireNearHub: true,
        maxGapToHub: 24,
      },
    },
  ] as RobotTypeDef[],

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
    /** Auto routine for the human's robot: drive forward, then (optionally) shoot the preload. */
    autoDriveTime: 1.0,
    autoDriveSpeed: 80,
    autoShootPreload: true,
  },

  camera: {
    fov: 55,
    follow: { distance: 120, height: 75, lookAhead: 30, smoothing: 6 },
    driverStation: { behindWall: 60, height: 135, lookAtX: -20 }, // lookAtX is for Red; mirrored for Blue
    topDown: { margin: 1.08 },
  },

  render: {
    shadows: true,
    maxPixelRatio: 1.5,
  },

  input: {
    gamepadDeadzone: 0.12,
  },

  colors: {
    red: 0xd8262e,
    blue: 0x1f5fd6,
    fuel: 0xf6d21c,
    carpet: 0x5b5f66,
    neutral: 0x8a8f99,
    hubInactive: 0x2a2d33,
  },
};

export const FUEL_RADIUS = CONFIG.fuel.diameter / 2;
