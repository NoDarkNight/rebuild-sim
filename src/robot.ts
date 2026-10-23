import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG, FUEL_RADIUS, Alliance, RobotTypeDef } from './config';
import { SHOOTERS } from './shooters';
import type { FuelSystem } from './fuel';
import type { HubInfo } from './field';

export interface RobotSpec {
  alliance: Alliance;
  type: RobotTypeDef;
  height: number;
  x: number;
  z: number;
  yaw: number;
  preload: number;
}

/** What a controller (human, auto routine, future AI) asks the robot to do. */
export interface DriveCommand {
  /** Field-frame translation, each component -1..1 of max speed. */
  moveX: number;
  moveZ: number;
  /** -1..1 of max rotation rate; positive is counter-clockwise from above. */
  turn: number;
  intake: boolean;
  shoot: boolean;
}

export const idleCommand = (): DriveCommand => ({ moveX: 0, moveZ: 0, turn: 0, intake: false, shoot: false });

export class Robot {
  readonly alliance: Alliance;
  readonly type: RobotTypeDef;
  readonly height: number;
  readonly length = CONFIG.robot.length;
  readonly width = CONFIG.robot.width;
  readonly body: RAPIER.RigidBody;
  readonly group = new THREE.Group();
  mechanism: THREE.Object3D | null = null;

  hopper: number;
  readonly capacity = CONFIG.robot.hopperCapacity;
  command: DriveCommand = idleCommand();
  turretYaw = 0;
  /** Shooter-specific 0..1 state, e.g. the Dumper's lift extension. */
  mechanismState = 0;
  /** Fuel shot by this robot, for stats. */
  shotsFired = 0;

  // Cached per step.
  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  yaw = 0;
  forward = new THREE.Vector3(1, 0, 0);

  private fireTimer = 0;
  private root: THREE.Group;
  private hopperFill: THREE.Mesh;
  private hopperFillHeight: number;
  private intakeRoller: THREE.Mesh;
  private intakeMat: THREE.MeshStandardMaterial;

  constructor(world: RAPIER.World, scene: THREE.Scene, spec: RobotSpec, private idle: boolean) {
    const R = CONFIG.robot;
    this.alliance = spec.alliance;
    this.type = spec.type;
    this.height = spec.height;
    this.hopper = Math.min(spec.preload, this.capacity);

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spec.x, spec.height / 2 + 0.05, spec.z)
      .setRotation(yawQuat(spec.yaw))
      .enabledRotations(false, true, false)
      .setCanSleep(idle);
    if (idle) desc.setLinearDamping(R.idleLinearDamping).setAngularDamping(R.idleLinearDamping);
    this.body = world.createRigidBody(desc);
    const r = R.borderRadius;
    world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(this.length / 2 - r, spec.height / 2 - r, this.width / 2 - r, r)
        .setMass(R.mass)
        .setFriction(R.friction),
      this.body,
    );

    // --- Visuals (robot-local: x forward, origin at chassis center) ---
    this.group.position.y = -spec.height / 2;
    const root = new THREE.Group();
    root.add(this.group);
    scene.add(root);
    this.root = root;

    const shadows = CONFIG.render.shadows;
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadows;
      this.group.add(m);
      return m;
    };
    const L = this.length, W = this.width, bh = R.bumperHeight, bt = 3.5;
    const bumperMat = new THREE.MeshStandardMaterial({
      color: spec.alliance === 'red' ? CONFIG.colors.red : CONFIG.colors.blue, roughness: 0.85,
    });
    add(new THREE.BoxGeometry(L, bh, bt), bumperMat, 0, bh / 2 + 1, W / 2 - bt / 2);
    add(new THREE.BoxGeometry(L, bh, bt), bumperMat, 0, bh / 2 + 1, -W / 2 + bt / 2);
    add(new THREE.BoxGeometry(bt, bh, W - 2 * bt), bumperMat, L / 2 - bt / 2, bh / 2 + 1, 0);
    add(new THREE.BoxGeometry(bt, bh, W - 2 * bt), bumperMat, -L / 2 + bt / 2, bh / 2 + 1, 0);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x30343b, metalness: 0.3, roughness: 0.6 });
    add(new THREE.BoxGeometry(L - 2 * bt, bh + 2, W - 2 * bt), frameMat, 0, (bh + 2) / 2 + 0.5, 0);
    // Corner uprights so height reads clearly (22 vs 30 in).
    const postGeo = new THREE.BoxGeometry(1.5, spec.height - bh - 2, 1.5);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      add(postGeo, frameMat, sx * (L / 2 - bt - 1), bh + 2 + (spec.height - bh - 2) / 2, sz * (W / 2 - bt - 1));
    }

    // Hopper: translucent box; its yellow fill height is hopper / capacity.
    const hopLen = L - 2 * bt - 2;
    const hopX = 0;
    const hopW = W - 2 * bt - 2;
    const hopBottom = bh + 2.5;
    const hopH = spec.height - hopBottom - 0.5;
    const shell = add(
      new THREE.BoxGeometry(hopLen, hopH, hopW),
      new THREE.MeshStandardMaterial({ color: 0xdfe8f5, transparent: true, opacity: 0.22, roughness: 0.1, depthWrite: false }),
      hopX, hopBottom + hopH / 2, 0,
    );
    shell.castShadow = false;
    const fillGeo = new THREE.BoxGeometry(hopLen - 1, 1, hopW - 1);
    fillGeo.translate(0, 0.5, 0); // grow upward from the hopper floor
    this.hopperFill = add(
      fillGeo,
      new THREE.MeshStandardMaterial({ color: CONFIG.colors.fuel, emissive: 0x3a2f00, roughness: 0.8 }),
      hopX, hopBottom, 0,
    );
    this.hopperFillHeight = hopH - 0.5;

    // Intake roller across the front.
    this.intakeMat = new THREE.MeshStandardMaterial({ color: 0x555b63, roughness: 0.5 });
    this.intakeRoller = add(new THREE.CylinderGeometry(1.6, 1.6, R.intake.width, 12), this.intakeMat, L / 2 + 2.5, 3, 0);
    this.intakeRoller.rotation.x = Math.PI / 2;

    SHOOTERS[spec.type.shooter.kind].buildVisual(spec.type.shooter as never, this);
    this.readState();
    this.syncVisual(0);
  }

  /** Refresh cached pose from the physics body. */
  readState() {
    const t = this.body.translation(), q = this.body.rotation(), v = this.body.linvel();
    this.position.set(t.x, t.y, t.z);
    this.velocity.set(v.x, v.y, v.z);
    this.yaw = 2 * Math.atan2(q.y, q.w);
    this.forward.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  localToWorld(lx: number, ly: number, lz: number) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return new THREE.Vector3(
      this.position.x + lx * c + lz * s,
      this.position.y + ly,
      this.position.z - lx * s + lz * c,
    );
  }

  /** Accel-limited, arcade-style holonomic drive. Called before each physics step. */
  applyDrive(dt: number) {
    if (this.idle) return;
    const R = CONFIG.robot, c = this.command;
    let mx = c.moveX, mz = c.moveZ;
    const mag = Math.hypot(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; }
    const v = this.body.linvel();
    let dvx = mx * R.maxSpeed - v.x, dvz = mz * R.maxSpeed - v.z;
    const dv = Math.hypot(dvx, dvz), maxDv = R.maxAccel * dt;
    if (dv > maxDv) { dvx *= maxDv / dv; dvz *= maxDv / dv; }
    this.body.setLinvel({ x: v.x + dvx, y: v.y, z: v.z + dvz }, true);

    const w = this.body.angvel().y;
    const dw = THREE.MathUtils.clamp(c.turn * R.maxOmega - w, -R.maxAlpha * dt, R.maxAlpha * dt);
    this.body.setAngvel({ x: 0, y: w + dw, z: 0 }, true);
  }

  /** Intake and shooting. Called after each physics step. */
  update(dt: number, fuel: FuelSystem, ownHub: HubInfo) {
    this.readState();
    if (this.command.intake && this.hopper < this.capacity) this.runIntake(fuel);

    const def = this.type.shooter;
    const shot = SHOOTERS[def.kind].aim(def as never, this, dt, ownHub);
    if (this.command.shoot && this.hopper > 0) {
      this.fireTimer += dt;
      const interval = 1 / def.ballsPerSecond;
      if (this.fireTimer >= interval) {
        if (shot) {
          const i = fuel.spawn(shot.pos.x, shot.pos.y, shot.pos.z, shot.vel.x, shot.vel.y, shot.vel.z);
          if (i >= 0) { this.hopper--; this.shotsFired++; }
          this.fireTimer -= interval;
        } else {
          this.fireTimer = interval; // ready to fire the moment we can
        }
      }
    } else {
      this.fireTimer = Math.min(this.fireTimer + dt, 1 / def.ballsPerSecond);
    }
  }

  private runIntake(fuel: FuelSystem) {
    const I = CONFIG.robot.intake;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const px = this.position.x, pz = this.position.z, bottom = this.position.y - this.height / 2;
    const xMin = this.length / 2 - FUEL_RADIUS, xMax = this.length / 2 + I.reach + FUEL_RADIUS;
    const halfW = I.width / 2;
    for (let i = 0; i < fuel.count; i++) {
      if (!fuel.active[i]) continue;
      const p = fuel.bodies[i].translation();
      const dx = p.x - px, dz = p.z - pz;
      if (Math.abs(dx) > 50 || Math.abs(dz) > 50) continue;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (lx < xMin || lx > xMax || Math.abs(lz) > halfW || p.y - bottom > I.height) continue;
      fuel.despawn(i);
      if (++this.hopper >= this.capacity) break;
    }
  }

  /** Copy physics pose to visuals. */
  syncVisual(time: number) {
    const t = this.body.translation(), q = this.body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(q.x, q.y, q.z, q.w);
    const frac = this.hopper / this.capacity;
    this.hopperFill.visible = frac > 0;
    this.hopperFill.scale.y = Math.max(0.001, frac * this.hopperFillHeight);
    const running = this.command.intake && this.hopper < this.capacity;
    this.intakeMat.color.setHex(running ? 0x3ddc84 : 0x555b63);
    if (running) this.intakeRoller.rotation.y = time * 25;
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    });
  }
}

export function yawQuat(yaw: number) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}
