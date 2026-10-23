import * as THREE from 'three';
import { CONFIG, FUEL_RADIUS, ShooterDef, ShooterKind, TurretShooterDef, DumperShooterDef } from './config';
import type { Robot } from './robot';
import type { HubInfo } from './field';

export interface Shot {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
}

/**
 * One implementation per shooter kind. A robot type in config picks a kind and
 * its parameters; adding a new robot type means a config entry, plus a new
 * implementation here only if it needs a new mechanism.
 */
export interface ShooterImpl<D extends ShooterDef> {
  /** Build the mechanism's visuals into the robot's group (robot-local, x forward). */
  buildVisual(def: D, robot: Robot): void;
  /** Called every physics step: move the mechanism, and return a shot if one could fire now. */
  aim(def: D, robot: Robot, dt: number, hub: HubInfo): Shot | null;
}

const g = () => CONFIG.physics.gravity;
const deg = THREE.MathUtils.degToRad;
const randn = () => (Math.random() + Math.random() + Math.random() - 1.5) / 0.75; // cheap ~N(0,1)
const hubTargetY = () => CONFIG.hub.height + FUEL_RADIUS;

/** Launch velocity that rises to `apex` and comes back down through targetY at horizontal distance d. */
function ballistic(d: number, y0: number, targetY: number, apex: number) {
  const vy = Math.sqrt(2 * g() * Math.max(1, apex - y0));
  const t = vy / g() + Math.sqrt((2 * Math.max(0.1, apex - targetY)) / g());
  return { vh: d / t, vy };
}

function applySpread(v: THREE.Vector3, yawDeg: number, speedPct: number) {
  v.applyAxisAngle(THREE.Object3D.DEFAULT_UP, deg(yawDeg) * randn());
  v.multiplyScalar(1 + (speedPct / 100) * randn());
}

const turret: ShooterImpl<TurretShooterDef> = {
  buildVisual(def, robot) {
    const H = robot.height;
    const pivot = new THREE.Group();
    pivot.position.set(def.pivotX, H - 3, 0);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(6, 7, 4, 16),
      new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.4, roughness: 0.5 }),
    );
    pivot.add(base);
    const hood = new THREE.Mesh(
      new THREE.BoxGeometry(12, 5, 8),
      new THREE.MeshStandardMaterial({ color: 0xb8bec7, metalness: 0.5, roughness: 0.4 }),
    );
    hood.position.set(4, 3, 0);
    hood.rotation.z = 0.45;
    pivot.add(hood);
    robot.group.add(pivot);
    robot.mechanism = pivot;
  },

  aim(def, robot, dt, hub) {
    const pos = robot.position;
    const pivotWorld = robot.localToWorld(def.pivotX, 0, 0);
    const dx = hub.x - pivotWorld.x, dz = hub.z - pivotWorld.z;
    const d = Math.hypot(dx, dz);

    // Slew the turret (robot-relative angle) toward the Hub.
    const worldYaw = Math.atan2(-dz, dx);
    const desired = wrapAngle(worldYaw - robot.yaw);
    const err = wrapAngle(desired - robot.turretYaw);
    robot.turretYaw = wrapAngle(robot.turretYaw + THREE.MathUtils.clamp(err, -def.slewRate * dt, def.slewRate * dt));
    if (robot.mechanism) robot.mechanism.rotation.y = robot.turretYaw;
    if (Math.abs(err) > deg(def.aimToleranceDeg)) return null;

    const y0 = pos.y + robot.height / 2 + def.exitAboveTop;
    const ty = hubTargetY();
    const { vh, vy } = ballistic(d, y0, ty, ty + def.apexAboveTarget);
    const shotYaw = robot.yaw + robot.turretYaw;
    // This is the ball's world velocity: the shooter already compensates for the
    // robot's motion, which is what makes shooting on the move work.
    const vel = new THREE.Vector3(Math.cos(shotYaw) * vh, vy, -Math.sin(shotYaw) * vh);
    if (vel.length() > def.maxLaunchSpeed) vel.setLength(def.maxLaunchSpeed);
    applySpread(vel, def.spreadYawDeg, def.spreadSpeedPct);
    return { pos: new THREE.Vector3(pivotWorld.x, y0, pivotWorld.z), vel };
  },
};

const dumper: ShooterImpl<DumperShooterDef> = {
  buildVisual(def, robot) {
    const H = robot.height;
    const metal = new THREE.MeshStandardMaterial({ color: 0xb8bec7, metalness: 0.5, roughness: 0.4 });
    // The lift group rises; the mast is stretched to meet it from the robot top.
    const lift = new THREE.Group();
    lift.position.set(def.exitX, H, 0);
    const chute = new THREE.Mesh(new THREE.BoxGeometry(8, 1.5, robot.width - 8), metal);
    chute.rotation.z = 0.5;
    lift.add(chute);
    const mastGeo = new THREE.BoxGeometry(2, 1, 2);
    mastGeo.translate(0, -0.5, 0);
    const mast = new THREE.Mesh(mastGeo, metal);
    mast.position.x = -3;
    lift.add(mast);
    robot.group.add(lift);
    robot.mechanism = lift;
  },

  aim(def, robot, dt, hub) {
    // Raise the lift while shoot is held, lower it otherwise.
    const rate = dt / def.liftTime;
    robot.mechanismState = THREE.MathUtils.clamp(robot.mechanismState + (robot.command.shoot ? rate : -rate), 0, 1);
    const rise = (def.releaseHeight - robot.height) * robot.mechanismState;
    if (robot.mechanism) {
      robot.mechanism.position.y = robot.height + rise;
      const mast = robot.mechanism.children[1];
      mast.scale.y = Math.max(0.01, rise);
    }
    if (robot.mechanismState < 1) return null;

    if (def.requireNearHub) {
      // Gap between the robot's bumper and the Hub's footprint (axis-aligned box).
      const p = robot.position, h = CONFIG.hub.size / 2;
      const gx = Math.max(0, Math.abs(p.x - hub.x) - h), gz = Math.max(0, Math.abs(p.z - hub.z) - h);
      const gap = Math.hypot(gx, gz) - robot.length / 2;
      if (gap > def.maxGapToHub) return null;
    }
    const exit = robot.localToWorld(def.exitX, def.releaseHeight - robot.position.y + FUEL_RADIUS, 0);
    const { vh, vy } = ballistic(def.landReach, exit.y, hubTargetY(), def.apexHeight);
    const f = robot.forward;
    const vel = new THREE.Vector3(f.x * vh, vy, f.z * vh);
    applySpread(vel, def.spreadYawDeg, def.spreadSpeedPct);
    // Released from a moving robot, the ball carries the robot's velocity too.
    vel.x += robot.velocity.x;
    vel.z += robot.velocity.z;
    return { pos: exit, vel };
  },
};

export const SHOOTERS: { [K in ShooterKind]: ShooterImpl<Extract<ShooterDef, { kind: K }>> } = { turret, dumper };

export function wrapAngle(a: number) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
