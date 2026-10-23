import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG, FUEL_RADIUS, Alliance, RobotTypeDef } from './config';
import { buildField, Field, rotateForAlliance } from './field';
import { FuelSystem } from './fuel';
import { Robot, DriveCommand, idleCommand } from './robot';
import { Match, other } from './match';
import type { DriverInput } from './input';
import type { CameraRig } from './camera';

export interface GameSetup {
  typeId: string;
  height: number;
  alliance: Alliance;
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
  readonly robots: Robot[] = [];
  readonly player: Robot;
  readonly match = new Match();
  /** False for the idle field shown behind the menu. */
  readonly live: boolean;

  private simTime = 0;
  private accumulator = 0;
  private exits: PendingExit[] = [];
  private input: DriverInput = { forward: 0, right: 0, turn: 0, intake: false, shoot: false };

  constructor(readonly setup: GameSetup, live: boolean) {
    this.live = live;
    const P = CONFIG.physics;
    this.world = new RAPIER.World({ x: 0, y: -P.gravity, z: 0 });
    this.world.timestep = P.timestep;
    this.world.lengthUnit = P.unitsPerMeter;
    this.world.numSolverIterations = P.solverIterations;

    this.setupScene();
    this.field = buildField(this.world, this.scene);
    this.fuel = new FuelSystem(this.world, this.scene, CONFIG.fuel.total);

    // Robots: the human takes slot 0 on their alliance; everyone else is parked.
    const types = CONFIG.robotTypes;
    const chosen = types.find((t) => t.id === setup.typeId) ?? types[0];
    const preload = this.preloadPerRobot();
    let player: Robot | null = null;
    let n = 0;
    for (const a of [setup.alliance, other(setup.alliance)]) {
      CONFIG.startSlots.forEach((slot, i) => {
        const human = a === setup.alliance && i === 0;
        const p = rotateForAlliance(a, slot.x, slot.z);
        const type: RobotTypeDef = human ? chosen : types[n % types.length];
        const height = human ? setup.height : n % 2 ? CONFIG.robot.heights.short : CONFIG.robot.heights.tall;
        const robot = new Robot(this.world, this.scene, {
          alliance: a, type, height, x: p.x, z: p.z, yaw: a === 'red' ? 0 : Math.PI, preload,
        }, !human);
        this.robots.push(robot);
        if (human) player = robot;
        n++;
      });
    }
    this.player = player!;
    this.layoutFuel(preload);
  }

  private preloadPerRobot() {
    const F = CONFIG.fuel;
    const robots = CONFIG.startSlots.length * 2;
    const available = F.total - CONFIG.depot.fuelCount * 2;
    return Math.max(0, Math.min(F.preloadPerRobot, Math.floor(available / robots)));
  }

  private setupScene() {
    this.scene.background = new THREE.Color(0x14171c);
    this.scene.fog = new THREE.Fog(0x14171c, 900, 1800);
    this.scene.add(new THREE.HemisphereLight(0xdde6f0, 0x3a3530, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
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

  /** Advance by a frame's worth of time using fixed physics steps. */
  advance(frameDt: number, rig: CameraRig) {
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

    this.player.command = this.playerCommand(rig);
    for (const r of this.robots) r.applyDrive(dt);
    this.world.step();
    for (const r of this.robots) r.update(dt, this.fuel, this.field.hubs[r.alliance]);
    this.checkHubs();
    this.processExits();
  }

  private playerCommand(rig: CameraRig): DriveCommand {
    const m = this.match;
    if (!this.live || m.isOver) return idleCommand();
    const M = CONFIG.match;
    if (m.isAuto) {
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
          fuel.despawn(i);
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
