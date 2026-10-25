import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG, FUEL_RADIUS, Alliance, RobotTypeDef } from './config';
import { SHOOTERS, wrapAngle } from './shooters';
import { beltTexture, textTexture } from './textures';
import type { FuelSystem } from './fuel';
import type { HubInfo } from './field';

export interface RobotSpec {
  alliance: Alliance;
  type: RobotTypeDef;
  x: number;
  z: number;
  yaw: number;
  preload: number;
  teamNumber: number;
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

/** score: can hit the Hub; ferry: lobs to own Alliance Zone; none: can't release. */
export type AimMode = 'score' | 'ferry' | 'none';

export const idleCommand = (): DriveCommand => ({ moveX: 0, moveZ: 0, turn: 0, intake: false, shoot: false });

/** Robot-local frame: x forward, y up, origin at the chassis center. */
export interface HopperLayout {
  /** Shooter bay at the rear, from bayBack to back. Balls ride the floor belt rearward into it. */
  bayBack: number;
  back: number;
  front: number;
  bottom: number;
  top: number;
  width: number;
}

const UP = new THREE.Vector3(0, 1, 0);

export class Robot {
  readonly alliance: Alliance;
  readonly type: RobotTypeDef;
  readonly height = CONFIG.robot.height;
  readonly length = CONFIG.robot.length;
  readonly width = CONFIG.robot.width;
  readonly teamNumber: number;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  /** Visual root for robot-local parts; its origin sits on the floor under the chassis center. */
  readonly group = new THREE.Group();
  readonly hopperLayout: HopperLayout;
  mechanism: THREE.Object3D | null = null;

  hopper: number;
  readonly capacity = CONFIG.robot.hopperCapacity;
  command: DriveCommand = idleCommand();
  turretYaw = 0;
  /** Shooter flywheel speed, 0..1 of full. */
  flywheel = 0;
  /** A shooter may ask the drive to hold this heading (overrides the turn input). */
  headingTarget: number | null = null;
  /** What a shot would do right now; shown on the HUD. */
  aimMode: AimMode = 'none';
  /** Fuel shot by this robot, for stats. */
  shotsFired = 0;
  grounded = true;

  // Cached per step.
  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  quaternion = new THREE.Quaternion();
  yaw = 0;
  /** Heading projected onto the floor (unit, y = 0). */
  forward = new THREE.Vector3(1, 0, 0);

  private fireTimer = 0;
  private tippedFor = 0;
  private root = new THREE.Group();
  private hopperFill: THREE.Mesh;
  private hopperFillHeight: number;
  private beltTex: THREE.CanvasTexture;
  private intakeRoller: THREE.Mesh;
  private intakeMat: THREE.MeshStandardMaterial;
  private intakeZoneMat: THREE.MeshBasicMaterial;
  private marker: THREE.Mesh | null = null;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(private world: RAPIER.World, scene: THREE.Scene, spec: RobotSpec, private idle: boolean) {
    const R = CONFIG.robot;
    this.alliance = spec.alliance;
    this.type = spec.type;
    this.teamNumber = spec.teamNumber;
    this.hopper = Math.min(spec.preload, this.capacity);
    const H = this.height, L = this.length, W = this.width;

    // Free rigid body: it pitches and rolls over the Bump and takes real hits.
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spec.x, H / 2 + 0.05, spec.z)
      .setRotation(yawQuat(spec.yaw))
      .setAngularDamping(R.angularDamping)
      .setGravityScale(R.gravityScale)
      .setCanSleep(idle);
    if (idle) desc.setLinearDamping(R.idleLinearDamping).setAngularDamping(R.idleLinearDamping);
    this.body = world.createRigidBody(desc);
    const r = R.borderRadius;
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(L / 2 - r, H / 2 - r, W / 2 - r, r)
        .setMass(R.mass * (1 - R.ballastFraction))
        .setFriction(R.friction)
        // Rapier averages friction by default, which would still drag on the carpet.
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min),
      this.body,
    );
    // Low ballast (batteries, drivetrain) keeps the center of mass near the floor.
    // It sits inside the chassis shape, so it never touches anything on its own.
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(L / 2 - r - 1, 1, W / 2 - r - 1)
        .setTranslation(0, -H / 2 + R.ballastHeight, 0)
        .setMass(R.mass * R.ballastFraction)
        .setFriction(R.friction)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min),
      this.body,
    );

    // --- Visuals ---
    this.group.position.y = -H / 2;
    this.root.add(this.group);
    scene.add(this.root);

    const shadows = CONFIG.render.shadows;
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadows;
      this.group.add(m);
      return m;
    };
    const bh = R.bumperHeight, bt = 3.5;
    const allianceHex = spec.alliance === 'red' ? CONFIG.colors.red : CONFIG.colors.blue;
    const bumperMat = new THREE.MeshStandardMaterial({ color: allianceHex, roughness: 0.85 });
    add(new THREE.BoxGeometry(L, bh, bt), bumperMat, 0, bh / 2 + 1, W / 2 - bt / 2);
    add(new THREE.BoxGeometry(L, bh, bt), bumperMat, 0, bh / 2 + 1, -W / 2 + bt / 2);
    add(new THREE.BoxGeometry(bt, bh, W - 2 * bt), bumperMat, L / 2 - bt / 2, bh / 2 + 1, 0);
    add(new THREE.BoxGeometry(bt, bh, W - 2 * bt), bumperMat, -L / 2 + bt / 2, bh / 2 + 1, 0);
    // Team number on both side bumpers, like the real thing.
    const numMat = new THREE.MeshBasicMaterial({
      map: textTexture(String(spec.teamNumber), 256, 96), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2,
    });
    for (const sz of [-1, 1]) {
      const plate = add(new THREE.PlaneGeometry(L * 0.62, bh * 0.85), numMat, 0, bh / 2 + 1, sz * (W / 2 + 0.02));
      plate.rotation.y = sz > 0 ? 0 : Math.PI;
      plate.castShadow = false;
    }
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.35, roughness: 0.55 });
    add(new THREE.BoxGeometry(L - 2 * bt - 0.2, bh + 2, W - 2 * bt - 0.2), frameMat, 0, (bh + 2) / 2 + 0.5, 0);

    // Ball path, front to back: an over-the-bumper intake (as on most REBUILT robots)
    // feeds the hopper; a floor belt carries Fuel rearward into the shooter bay.
    // The front is the only side that collects.
    const I = R.intake;
    const bayBack = -L / 2 + bt + 0.5;
    const hop: HopperLayout = {
      bayBack, back: bayBack + spec.type.shooter.bayLength, front: L / 2 + I.reach, bottom: bh + 2.6, top: H - 0.4, width: W - 2 * bt - 1,
    };
    this.hopperLayout = hop;
    const hopLen = hop.front - hop.back, hopX = (hop.front + hop.back) / 2, hopH = hop.top - hop.bottom;
    // Dumpers in the references carry big smoked-polycarbonate hoppers; turrets, clear ones.
    const smoked = spec.type.shooter.kind === 'dumper';
    const polyMat = new THREE.MeshStandardMaterial({
      color: smoked ? 0x1a1c21 : 0xdfe8f5, transparent: true, opacity: smoked ? 0.5 : 0.2,
      roughness: 0.1, depthWrite: false, side: THREE.DoubleSide,
    });
    const shell = add(new THREE.BoxGeometry(hopLen, hopH, hop.width), polyMat, hopX, hop.bottom + hopH / 2, 0);
    shell.castShadow = false;
    // Aluminum edge rails outline the hopper, including the overhang.
    const railMat = new THREE.MeshStandardMaterial({ color: 0xc3cad3, metalness: 0.6, roughness: 0.35 });
    for (const sz of [-1, 1]) {
      add(new THREE.BoxGeometry(hopLen, 1, 1), railMat, hopX, hop.top, sz * hop.width / 2);
      for (const x of [hop.back, hop.front]) add(new THREE.BoxGeometry(1, hopH, 1), railMat, x, hop.bottom + hopH / 2, sz * hop.width / 2);
    }
    const fillGeo = new THREE.BoxGeometry(hopLen - 1.2, 1, hop.width - 1.2);
    fillGeo.translate(0, 0.5, 0); // grow upward from the hopper floor
    this.hopperFill = add(
      fillGeo,
      new THREE.MeshStandardMaterial({ color: CONFIG.colors.fuel, emissive: 0x2a2000, roughness: 0.75 }),
      hopX, hop.bottom + 0.1, 0,
    );
    this.hopperFillHeight = hopH - 0.6;
    this.beltTex = beltTexture();
    this.beltTex.repeat.set(hopLen / 8, 2);
    const belt = add(
      new THREE.PlaneGeometry(hopLen - 1, hop.width - 1),
      new THREE.MeshStandardMaterial({ map: this.beltTex, roughness: 0.9 }),
      hopX, hop.bottom + 0.05, 0,
    );
    belt.rotation.x = -Math.PI / 2;
    belt.castShadow = false;

    // Intake mouth under the overhang: side plates, a ramp up to the hopper floor, and the roller.
    const rollerX = hop.front - 2.5, rollerY = 2.6;
    for (const sz of [-1, 1]) {
      const plate = add(new THREE.BoxGeometry(I.reach + 1, hop.bottom - 1, 0.6), polyMat,
        L / 2 + (I.reach + 1) / 2 - 0.5, 1 + (hop.bottom - 1) / 2, sz * (hop.width / 2 - 0.3));
      plate.castShadow = false;
    }
    const rampRun = rollerX - (L / 2 - 1), rampRise = hop.bottom - rollerY;
    const ramp = add(
      new THREE.BoxGeometry(Math.hypot(rampRun, rampRise), 0.6, hop.width - 1.5),
      new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.7 }),
      (rollerX + L / 2 - 1) / 2, (rollerY + hop.bottom) / 2, 0,
    );
    ramp.rotation.z = -Math.atan2(rampRise, rampRun);
    this.intakeMat = new THREE.MeshStandardMaterial({ color: 0x5f6670, emissive: 0x000000, roughness: 0.5 });
    this.intakeRoller = add(new THREE.CylinderGeometry(2, 2, hop.width - 1.5, 12), this.intakeMat, rollerX, rollerY, 0);
    this.intakeRoller.rotation.x = Math.PI / 2;
    this.intakeZoneMat = new THREE.MeshBasicMaterial({
      color: CONFIG.colors.gold, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
    });
    const zone = add(new THREE.PlaneGeometry(I.reach + 2, I.width), this.intakeZoneMat, L / 2 + (I.reach + 2) / 2, 0.4, 0);
    zone.rotation.x = -Math.PI / 2;
    zone.castShadow = false;

    // A small gold marker floats over the human's robot.
    if (!idle) {
      this.marker = new THREE.Mesh(
        new THREE.ConeGeometry(3.2, 6, 4),
        new THREE.MeshBasicMaterial({ color: CONFIG.colors.gold }),
      );
      this.marker.rotation.x = Math.PI; // point down
      scene.add(this.marker);
    }

    SHOOTERS[spec.type.shooter.kind].buildVisual(spec.type.shooter as never, this);
    this.readState();
    this.syncVisual(0);
  }

  /** Intake runs while held, unless the hopper is full or the design can't intake while shooting. */
  get intaking() {
    const def = this.type.shooter;
    const blocked = def.kind === 'dumper' && !def.intakeWhileShooting && this.command.shoot;
    return this.command.intake && !blocked && this.hopper < this.capacity;
  }

  /** Client: take pose and mechanism state from a host snapshot instead of physics. */
  applyNetState(pos: THREE.Vector3, quat: THREE.Quaternion, s: {
    turretYaw: number; flywheel: number; hopper: number; intake: boolean; shoot: boolean; aimMode: AimMode; shotsFired: number;
  }) {
    this.body.setTranslation(pos, false);
    this.body.setRotation(quat, false);
    this.turretYaw = s.turretYaw;
    this.flywheel = s.flywheel;
    this.hopper = s.hopper;
    this.command = { ...this.command, intake: s.intake, shoot: s.shoot };
    this.aimMode = s.aimMode;
    this.shotsFired = s.shotsFired;
    this.readState();
    // Mechanisms the host animates while aiming.
    if (!this.mechanism) return;
    if (this.type.shooter.kind === 'turret') this.mechanism.rotation.y = this.turretYaw;
    else for (const c of this.mechanism.children) c.rotation.y += 0.6 * this.flywheel;
  }

  /** Refresh cached pose from the physics body. */
  readState() {
    const t = this.body.translation(), q = this.body.rotation(), v = this.body.linvel();
    this.position.set(t.x, t.y, t.z);
    this.velocity.set(v.x, v.y, v.z);
    this.quaternion.set(q.x, q.y, q.z, q.w);
    const f = this.forward.set(1, 0, 0).applyQuaternion(this.quaternion);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(1, 0, 0);
    f.normalize();
    this.yaw = Math.atan2(-f.z, f.x);
  }

  /** Robot-local point (origin at chassis center) to world, using the full 3D pose. */
  localToWorld(lx: number, ly: number, lz: number) {
    return new THREE.Vector3(lx, ly, lz).applyQuaternion(this.quaternion).add(this.position);
  }

  /** Is anything (floor, Bump, Fuel) just under the chassis? Drive only grips when it is. */
  private probeGround() {
    const p = this.body.translation();
    this.ray.origin = { x: p.x, y: p.y, z: p.z };
    const hit = this.world.castRay(this.ray, this.height / 2 + CONFIG.robot.groundProbe, true,
      undefined, undefined, undefined, this.body);
    return hit !== null;
  }

  /** Traction-limited holonomic drive. Called before each physics step. */
  applyDrive(dt: number) {
    if (this.idle) return;
    const R = CONFIG.robot, c = this.command;
    this.grounded = this.probeGround();
    this.selfRight(dt);
    // A 125 lb robot cresting the Bump shouldn't be thrown into the air.
    const lv = this.body.linvel();
    if (lv.y > R.maxRise) this.body.setLinvel({ x: lv.x, y: R.maxRise, z: lv.z }, true);
    if (!this.grounded) return;

    let mx = c.moveX, mz = c.moveZ;
    const mag = Math.hypot(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; }
    // Climbing or cresting the Bump costs power: while the chassis is pitched or
    // rolled, top speed drops, so the robot rolls over instead of launching.
    const q = this.body.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    const speed = upY < Math.cos(THREE.MathUtils.degToRad(R.slopeTiltDeg)) ? R.maxSpeed * R.slopeSpeedFactor : R.maxSpeed;
    // Equivalent to a force capped at mass * maxAccel: being hit still moves us,
    // and we can only claw back at the traction limit.
    const v = this.body.linvel();
    let dvx = mx * speed - v.x, dvz = mz * speed - v.z;
    const dv = Math.hypot(dvx, dvz), maxDv = R.maxAccel * dt;
    if (dv > maxDv) { dvx *= maxDv / dv; dvz *= maxDv / dv; }
    this.body.setLinvel({ x: v.x + dvx, y: v.y, z: v.z + dvz }, true);

    // Yaw rate control about world up; pitch and roll stay physical.
    let turn = c.turn;
    if (this.headingTarget !== null) {
      const def = this.type.shooter;
      const gain = def.kind === 'dumper' ? def.alignGain : 3;
      turn = THREE.MathUtils.clamp(gain * wrapAngle(this.headingTarget - this.yaw), -1, 1);
    }
    const w = this.body.angvel();
    const dw = THREE.MathUtils.clamp(turn * R.maxOmega - w.y, -R.maxAlpha * dt, R.maxAlpha * dt);
    this.body.setAngvel({ x: w.x, y: w.y + dw, z: w.z }, true);
  }

  /** If the robot stays tipped past ~70 degrees, set it back on its wheels. */
  private selfRight(dt: number) {
    const q = this.body.rotation();
    const upY = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w)).dot(UP);
    this.tippedFor = upY < 0.35 ? this.tippedFor + dt : 0;
    if (this.tippedFor < CONFIG.robot.selfRightAfter) return;
    const p = this.body.translation();
    this.body.setRotation(yawQuat(this.yaw), true);
    this.body.setTranslation({ x: p.x, y: this.height / 2 + 4, z: p.z }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.tippedFor = 0;
  }

  /** Intake and shooting. Called after each physics step. */
  update(dt: number, fuel: FuelSystem, ownHub: HubInfo) {
    this.readState();
    if (this.intaking) this.runIntake(fuel);

    const def = this.type.shooter;
    const shots = SHOOTERS[def.kind].aim(def as never, this, dt, ownHub);
    const interval = 1 / def.shotsPerSecond;
    if (this.command.shoot && this.hopper > 0) {
      this.fireTimer += dt;
      if (this.fireTimer >= interval) {
        if (shots) {
          for (const s of shots) {
            if (this.hopper <= 0) break;
            if (fuel.spawn(s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z) >= 0) { this.hopper--; this.shotsFired++; }
          }
          this.fireTimer -= interval;
        } else {
          this.fireTimer = interval; // ready to fire the moment we can
        }
      }
    } else {
      this.fireTimer = Math.min(this.fireTimer + dt, interval);
    }
  }

  private runIntake(fuel: FuelSystem) {
    const I = CONFIG.robot.intake;
    const fx = this.forward.x, fz = this.forward.z;
    const px = this.position.x, pz = this.position.z, bottom = this.position.y - this.height / 2;
    const xMin = this.length / 2 - FUEL_RADIUS, xMax = this.length / 2 + I.reach + FUEL_RADIUS;
    const halfW = I.width / 2;
    for (let i = 0; i < fuel.count; i++) {
      if (!fuel.active[i]) continue;
      const p = fuel.bodies[i].translation();
      const dx = p.x - px, dz = p.z - pz;
      if (Math.abs(dx) > 50 || Math.abs(dz) > 50) continue;
      const lx = dx * fx + dz * fz; // along heading
      const lz = dx * -fz + dz * fx; // across, to the right
      if (lx < xMin || lx > xMax || Math.abs(lz) > halfW || p.y - bottom > I.height) continue;
      // Roll it to the roller, then up the ramp into the hopper, following the robot.
      const hop = this.hopperLayout, half = this.height / 2;
      fuel.capture(i, (u, start) => {
        const mouth = this.localToWorld(hop.front - 2.5, 3 + FUEL_RADIUS - half, lz);
        if (u < 0.35) return start.clone().lerp(mouth, u / 0.35);
        const inside = this.localToWorld((hop.front + hop.back) / 2, hop.bottom + FUEL_RADIUS + 1 - half, lz * 0.6);
        return mouth.lerp(inside, (u - 0.35) / 0.65);
      }, CONFIG.robot.intake.captureTime);
      if (++this.hopper >= this.capacity) break;
    }
  }

  /** The floating marker helps find your robot from far cameras; the follow cam doesn't need it. */
  setMarkerVisible(on: boolean) {
    if (this.marker) this.marker.visible = on;
  }

  /** Copy physics pose to visuals. */
  syncVisual(time: number) {
    const t = this.body.translation(), q = this.body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(q.x, q.y, q.z, q.w);
    const frac = this.hopper / this.capacity;
    this.hopperFill.visible = frac > 0;
    this.hopperFill.scale.y = Math.max(0.001, frac * this.hopperFillHeight);
    const running = this.intaking;
    this.intakeMat.color.setHex(running ? CONFIG.colors.gold : 0x5f6670);
    this.intakeZoneMat.opacity = running ? 0.35 : 0;
    if (running) this.intakeRoller.rotation.y = time * 25;
    // Belt runs rearward (toward the shooter) while intaking or shooting.
    if (running || this.command.shoot) this.beltTex.offset.x = (time * 1.5) % 1;
    if (this.marker) {
      this.marker.position.set(t.x, t.y + this.height / 2 + 16 + Math.sin(time * 3) * 1.5, t.z);
      this.marker.rotation.y = time * 1.5;
    }
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.root);
    if (this.marker) scene.remove(this.marker);
    const disposeMesh = (o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
    };
    this.root.traverse(disposeMesh);
    if (this.marker) disposeMesh(this.marker);
  }
}

export function yawQuat(yaw: number) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}
