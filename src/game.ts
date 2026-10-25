import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG, FUEL_RADIUS, Alliance, RobotTypeDef } from './config';
import { buildField, Field, rotateForAlliance } from './field';
import { FuelSystem } from './fuel';
import { Robot, DriveCommand, idleCommand } from './robot';
import { Match } from './match';
import type { DriverInput } from './input';
import type { CameraRig } from './camera';

/** One of the six robot positions: Red 1-3 are slots 0-2, Blue 1-3 are slots 3-5. */
export interface SlotSetup {
  typeId: string;
  teamNumber: number;
  /** Player id of whoever drives it, or null for a parked robot. */
  driver: string | null;
  name?: string;
}

/** solo: this browser runs everything. host: runs physics for everyone, takes remote
 *  players' commands. client: never steps physics, only shows the host's snapshots. */
export type GameMode = 'solo' | 'host' | 'client';

export interface GameSetup {
  mode: GameMode;
  /** This browser's player id; the robot whose driver matches is driven from local input. */
  localId: string;
  slots: SlotSetup[];
}

export const SLOTS_PER_ALLIANCE = 3;
export const slotAlliance = (slot: number): Alliance => (slot < SLOTS_PER_ALLIANCE ? 'red' : 'blue');

const randomTeamNumber = () => 100 + Math.floor(Math.random() * 9800);

/** Solo match: you in slot 1 of your alliance, everyone else parked. */
export function soloSetup(typeId: string, alliance: Alliance): GameSetup {
  const types = CONFIG.robotTypes;
  const slots: SlotSetup[] = [];
  for (let i = 0; i < SLOTS_PER_ALLIANCE * 2; i++) {
    const mine = i === (alliance === 'red' ? 0 : SLOTS_PER_ALLIANCE);
    slots.push({ typeId: mine ? typeId : types[i % types.length].id, teamNumber: randomTeamNumber(), driver: mine ? 'local' : null });
  }
  return { mode: 'solo', localId: 'local', slots };
}

/** Fill every slot nobody claimed with a parked robot. */
export function parkedSlot(i: number): SlotSetup {
  const types = CONFIG.robotTypes;
  return { typeId: types[i % types.length].id, teamNumber: randomTeamNumber(), driver: null };
}

interface PendingExit {
  at: number;
  hub: Alliance;
}

/** One match: owns the physics world, scene contents, robots, Fuel, and clock. */
export class Game {
  readonly scene = new THREE.Scene();
  readonly world: RAPIER.World;
  readonly field: Field;
  readonly fuel: FuelSystem;
  /** Index = slot: Red 1-3, then Blue 1-3. */
  readonly robots: Robot[] = [];
  /** The robot this browser drives (or watches, if it drives none). */
  readonly player: Robot;
  readonly alliance: Alliance;
  readonly match = new Match();
  /** False for the idle field shown behind the menu. */
  readonly live: boolean;
  readonly mode: GameMode;

  private simTime = 0;
  private accumulator = 0;
  private exits: PendingExit[] = [];
  private input: DriverInput = { forward: 0, right: 0, turn: 0, intake: false, shoot: false };
  private remoteCommands = new Map<string, DriveCommand>();
  private drivers: (string | null)[] = [];

  constructor(readonly setup: GameSetup, live: boolean) {
    this.live = live;
    this.mode = setup.mode;
    const P = CONFIG.physics;
    this.world = new RAPIER.World({ x: 0, y: -P.gravity, z: 0 });
    this.world.timestep = P.timestep;
    this.world.lengthUnit = P.unitsPerMeter;
    this.world.numSolverIterations = P.solverIterations;

    this.setupScene();
    this.field = buildField(this.world, this.scene);
    this.fuel = new FuelSystem(this.world, this.scene, CONFIG.fuel.total);

    // Robots by slot. Parked robots (no driver) just sit there as obstacles.
    const types = CONFIG.robotTypes;
    const preload = this.preloadPerRobot();
    setup.slots.forEach((slot, i) => {
      const a = slotAlliance(i);
      const start = CONFIG.startSlots[i % SLOTS_PER_ALLIANCE];
      const p = rotateForAlliance(a, start.x, start.z);
      const type: RobotTypeDef = types.find((t) => t.id === slot.typeId) ?? types[0];
      this.robots.push(new Robot(this.world, this.scene, {
        alliance: a, type, teamNumber: slot.teamNumber, x: p.x, z: p.z, yaw: a === 'red' ? 0 : Math.PI, preload,
      }, slot.driver === null));
      this.drivers.push(slot.driver);
    });
    const mine = setup.slots.findIndex((sl) => sl.driver === setup.localId);
    this.player = this.robots[Math.max(0, mine)];
    this.alliance = this.player.alliance;
    this.layoutFuel(preload);
    this.fuel.syncMeshes(); // clients show this layout until the first snapshot lands
  }

  private preloadPerRobot() {
    const F = CONFIG.fuel;
    const robots = CONFIG.startSlots.length * 2;
    const available = F.total - CONFIG.depot.fuelCount * 2;
    return Math.max(0, Math.min(F.preloadPerRobot, Math.floor(available / robots)));
  }

  private setupScene() {
    this.scene.background = new THREE.Color(0x161a21);
    this.scene.fog = new THREE.Fog(0x161a21, 900, 1900);
    this.scene.add(new THREE.HemisphereLight(0xdde6f0, 0x3a3530, 0.5));
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.7);
    sun.position.set(-150, 500, 220);
    if (CONFIG.render.shadows) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      const sc = sun.shadow.camera;
      sc.left = -360; sc.right = 360; sc.top = 200; sc.bottom = -200; sc.near = 100; sc.far = 1000;
      sun.shadow.bias = -0.0005;
    }
    this.scene.add(sun);
  }

  /** Depots, then the Neutral Zone gets everything not preloaded. */
  private layoutFuel(preload: number) {
    const F = CONFIG.fuel, D = CONFIG.depot, y = FUEL_RADIUS + 0.05;
    const d = CONFIG.fuel.diameter + 0.4;

    for (const a of ['red', 'blue'] as Alliance[]) {
      const depot = this.field.depots[a];
      const cols = Math.max(1, Math.floor((D.width - 2) / d));
      const rows = Math.ceil(D.fuelCount / cols);
      for (let i = 0; i < D.fuelCount; i++) {
        const c = i % cols, r = Math.floor(i / cols);
        this.fuel.spawn(depot.x + (r - (rows - 1) / 2) * d, y, depot.z + (c - (cols - 1) / 2) * d, 0, 0, 0, true);
      }
    }

    const neutral = F.total - D.fuelCount * 2 - preload * this.robots.length;
    const s = F.neutralSpacing;
    const cols = Math.floor(F.neutralWidth / s) + 1;
    const rows = Math.ceil(neutral / cols);
    for (let i = 0; i < neutral; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      const j = () => (Math.random() * 2 - 1) * F.neutralJitter;
      this.fuel.spawn((r - (rows - 1) / 2) * s + j(), y, (c - (cols - 1) / 2) * s + j(), 0, 0, 0, true);
    }
  }

  setInput(input: DriverInput) {
    this.input = input;
  }

  /** Host: the latest command from a remote player. */
  setRemoteCommand(playerId: string, cmd: DriveCommand) {
    this.remoteCommands.set(playerId, cmd);
  }

  /** Advance by a frame's worth of time using fixed physics steps. Clients don't simulate;
   *  their state arrives in snapshots, so this only keeps visuals ticking. */
  advance(frameDt: number, rig: CameraRig) {
    if (this.mode === 'client') {
      this.simTime += frameDt;
      for (const r of this.robots) r.syncVisual(this.simTime);
      return;
    }
    const P = CONFIG.physics;
    this.accumulator = Math.min(this.accumulator + frameDt, P.timestep * P.maxSubSteps);
    while (this.accumulator >= P.timestep) {
      this.step(P.timestep, rig);
      this.accumulator -= P.timestep;
    }
    this.fuel.syncMeshes();
    for (const r of this.robots) r.syncVisual(this.simTime);
  }

  private step(dt: number, rig: CameraRig) {
    this.simTime += dt;
    if (this.live && !this.match.isFinal) this.match.update(dt);

    const local = this.localCommand(rig);
    this.robots.forEach((r, i) => {
      const d = this.drivers[i];
      if (d === null) return;
      r.command = d === this.setup.localId ? local : this.gate(this.remoteCommands.get(d) ?? idleCommand());
    });
    for (const r of this.robots) r.applyDrive(dt);
    this.world.step();
    for (const r of this.robots) r.update(dt, this.fuel, this.field.hubs[r.alliance]);
    this.checkHubs();
    this.fuel.update(dt);
    this.processExits();
  }

  /** Robots don't move before the match or after the final buzzer. */
  private gate(cmd: DriveCommand): DriveCommand {
    return !this.live || this.match.isOver ? idleCommand() : cmd;
  }

  /** What this browser's driver is asking for, in field coordinates. Clients send it to the host. */
  localCommand(rig: CameraRig): DriveCommand {
    const m = this.match;
    if (!this.live || m.isOver) return idleCommand();
    const M = CONFIG.match;
    if (m.isAuto && !M.autoDriverControl) {
      // Simple auto: drive straight forward, then shoot the preload.
      const cmd = idleCommand();
      if (m.time < M.autoDriveTime) {
        const f = this.player.forward, k = M.autoDriveSpeed / CONFIG.robot.maxSpeed;
        cmd.moveX = f.x * k;
        cmd.moveZ = f.z * k;
      } else {
        cmd.shoot = M.autoShootPreload;
      }
      return cmd;
    }
    const i = this.input, f = rig.driveForward;
    // right = forward x up
    return {
      moveX: f.x * i.forward - f.z * i.right,
      moveZ: f.z * i.forward + f.x * i.right,
      turn: i.turn,
      intake: i.intake,
      shoot: i.shoot,
    };
  }

  /** A ball whose center is inside a Hub's walls, below the rim, fell through the top opening. */
  private checkHubs() {
    const fuel = this.fuel, H = CONFIG.hub;
    const hubs = [this.field.hubs.red, this.field.hubs.blue];
    for (let i = 0; i < fuel.count; i++) {
      if (!fuel.active[i]) continue;
      const b = fuel.bodies[i];
      if (b.isSleeping()) continue;
      const p = b.translation();
      if (p.y > H.height) continue;
      for (const hub of hubs) {
        if (Math.abs(p.x - hub.x) < hub.interiorHalf && Math.abs(p.z - hub.z) < hub.interiorHalf) {
          // Let it be seen dropping down into the Hub's funnel before it vanishes.
          const sink = new THREE.Vector3(hub.x, H.height - 26, hub.z);
          fuel.capture(i, (u, start) => start.clone().lerp(sink, u), H.sinkTime);
          if (this.live) this.match.recordScore(hub.alliance);
          this.exits.push({ at: this.simTime + H.exitDelay, hub: hub.alliance });
          break;
        }
      }
    }
  }

  private processExits() {
    const H = CONFIG.hub;
    while (this.exits.length && this.exits[0].at <= this.simTime) {
      const e = this.exits.shift()!;
      const hub = this.field.hubs[e.hub];
      const speed = H.exitSpeedMin + Math.random() * (H.exitSpeedMax - H.exitSpeedMin);
      const x = hub.x + hub.exitDir * (H.size / 2 + FUEL_RADIUS + 1);
      const z = hub.z + (Math.random() * 2 - 1) * H.exitSpreadZ;
      this.fuel.spawn(x, H.exitHeight, z, hub.exitDir * speed, 0, (Math.random() - 0.5) * 30);
    }
  }

  /** Elapsed simulation time (seconds since this Game was built). */
  get time() {
    return this.simTime;
  }
  set time(t: number) {
    this.simTime = t;
  }

  /** Hub rings glow when active. */
  updateHubVisuals() {
    for (const a of ['red', 'blue'] as Alliance[]) {
      const hub = this.field.hubs[a];
      const active = !this.live || this.match.hubActive(a);
      const base = a === 'red' ? CONFIG.colors.red : CONFIG.colors.blue;
      hub.ringMaterial.color.setHex(active ? base : CONFIG.colors.hubInactive);
      hub.ringMaterial.emissive.setHex(active ? base : 0x000000);
      hub.ringMaterial.emissiveIntensity = active ? 0.9 + 0.3 * Math.sin(this.simTime * 6) : 0;
    }
  }

  dispose() {
    for (const r of this.robots) r.dispose(this.scene);
    this.fuel.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[];
        (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
      }
    });
    this.world.free();
  }
}
