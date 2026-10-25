import * as THREE from 'three';
import { CONFIG, FUEL_RADIUS, ShooterDef, ShooterKind, TurretShooterDef, DumperShooterDef } from './config';
import type { Robot, AimMode } from './robot';
import { allianceSign, inAllianceZone, type HubInfo } from './field';

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
  /** Build the mechanism's visuals into the robot's group (robot-local, x forward, y from the floor). */
  buildVisual(def: D, robot: Robot): void;
  /** Called every physics step: move the mechanism, and return the balls one
   *  shot would release right now, or null. */
  aim(def: D, robot: Robot, dt: number, hub: HubInfo): Shot[] | null;
}

const g = () => CONFIG.physics.gravity;
const deg = THREE.MathUtils.degToRad;
const randn = () => (Math.random() + Math.random() + Math.random() - 1.5) / 0.75; // cheap ~N(0,1)

interface Target {
  x: number;
  z: number;
  y: number;
  apex: number;
  mode: AimMode;
}

/** Score from inside our own Alliance Zone; anywhere else, ferry to a floor spot in it. */
function pickTarget(def: ShooterDef, robot: Robot, hub: HubInfo): Target {
  if (inAllianceZone(robot.alliance, robot.position.x)) {
    const y = CONFIG.hub.height + FUEL_RADIUS;
    return { x: hub.x, z: hub.z, y, apex: y + def.apexAboveTarget, mode: 'score' };
  }
  const Fe = CONFIG.ferry, F = CONFIG.field;
  return {
    x: allianceSign(robot.alliance) * (F.length / 2 - Fe.depthFromWall),
    z: THREE.MathUtils.clamp(robot.position.z, -F.width / 2 + Fe.sideMargin, F.width / 2 - Fe.sideMargin),
    y: FUEL_RADIUS,
    apex: Fe.apexHeight,
    mode: 'ferry',
  };
}

/** Horizontal and vertical launch speed to rise to `apex` and come back down through targetY at distance d. */
function ballistic(d: number, y0: number, targetY: number, apex: number) {
  const vy = Math.sqrt(2 * g() * Math.max(1, apex - y0));
  const t = vy / g() + Math.sqrt((2 * Math.max(0.1, apex - targetY)) / g());
  return { vh: d / t, vy };
}

/** Spin the flywheel up while shoot is held, coast it down otherwise. Returns whether it can fire. */
function spin(def: ShooterDef, robot: Robot, dt: number) {
  const rate = robot.command.shoot ? dt / def.spinUpTime : -dt / def.spinDownTime;
  robot.flywheel = THREE.MathUtils.clamp(robot.flywheel + rate, 0, 1);
  return robot.flywheel >= def.minFlywheel;
}

/** Launch velocity toward `yaw` at the given horizontal/vertical speed, with flywheel and random error. */
function launch(def: ShooterDef, robot: Robot, yaw: number, vh: number, vy: number) {
  const vel = new THREE.Vector3(Math.cos(yaw) * vh, vy, -Math.sin(yaw) * vh);
  if (vel.length() > def.maxLaunchSpeed) vel.setLength(def.maxLaunchSpeed);
  // A flywheel that's still spinning up throws a touch short.
  const wheel = (robot.flywheel - def.minFlywheel) / (1 - def.minFlywheel);
  vel.multiplyScalar(1 - 0.06 * (1 - THREE.MathUtils.clamp(wheel, 0, 1)));
  vel.applyAxisAngle(THREE.Object3D.DEFAULT_UP, deg(def.spreadYawDeg) * randn());
  vel.multiplyScalar(1 + (def.spreadSpeedPct / 100) * randn());
  return vel;
}

const mat = (color: number, metal = 0.3) => new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: 0.5 });
const addMesh = (parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
};
/** A roller across the robot (axis along z). */
const roller = (parent: THREE.Object3D, r: number, len: number, m: THREE.Material, x: number, y: number, z = 0) => {
  const c = addMesh(parent, new THREE.CylinderGeometry(r, r, len, 14), m, x, y, z);
  c.rotation.x = Math.PI / 2;
  return c;
};
/** Center of the rear shooter bay, robot-local x. */
const bayX = (robot: Robot) => (robot.hopperLayout.bayBack + robot.hopperLayout.back) / 2;
const plateMat = () => mat(0xc9ced6, 0.55);
const blackMat = () => mat(0x1b1d21, 0.2);

const turret: ShooterImpl<TurretShooterDef> = {
  // Like 971 and 1690: a flat turntable ring sunk into the rear of the frame, carrying a
  // compact shooter (side plates, flywheel, curved hood). Nothing rises above the hopper.
  buildVisual(_def, robot) {
    const H = robot.height, hop = robot.hopperLayout, g = robot.group;
    const ringY = H - 8, r = Math.min(6.4, (hop.back - hop.bayBack) / 2);
    // The turret sits on a deck spanning the whole bay (wider than the ring), held up by
    // corner posts, with the feed column from the hopper floor running up the middle.
    const bay = hop.back - hop.bayBack, deckY = ringY - 0.9, postH = deckY - hop.bottom;
    addMesh(g, new THREE.BoxGeometry(bay, 0.8, hop.width), plateMat(), bayX(robot), deckY, 0);
    for (const x of [hop.bayBack + 0.6, hop.back - 0.6]) for (const sz of [-1, 1]) {
      addMesh(g, new THREE.BoxGeometry(1.2, postH, 1.2), plateMat(), x, hop.bottom + postH / 2, sz * (hop.width / 2 - 0.6));
    }
    addMesh(g, new THREE.BoxGeometry(4, postH, 4), blackMat(), bayX(robot), hop.bottom + postH / 2, 0);
    const ring = addMesh(g, new THREE.TorusGeometry(r, 0.55, 8, 32), mat(0x6a4dd8, 0.3), bayX(robot), ringY, 0);
    ring.rotation.x = Math.PI / 2;
    const pivot = new THREE.Group();
    pivot.position.set(bayX(robot), ringY, 0);
    addMesh(pivot, new THREE.CylinderGeometry(r - 0.4, r - 0.4, 0.6, 28), plateMat(), 0, 0, 0); // turntable
    // Shooter head, aimed along the pivot's +x.
    for (const sz of [-1, 1]) addMesh(pivot, new THREE.BoxGeometry(9, 7, 0.5), plateMat(), 0.5, 3.8, sz * 3.4);
    roller(pivot, 2.1, 6.4, blackMat(), -0.5, 3.4);
    const hood = addMesh(pivot, new THREE.CylinderGeometry(3.7, 3.7, 6.6, 16, 1, true, Math.PI * 0.45, Math.PI * 0.75),
      new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.6, side: THREE.DoubleSide }), -0.5, 3.4, 0);
    hood.rotation.x = Math.PI / 2;
    robot.group.add(pivot);
    robot.mechanism = pivot;
  },

  aim(def, robot, dt, hub) {
    const ready = spin(def, robot, dt);
    const t = pickTarget(def, robot, hub);
    robot.aimMode = t.mode;
    const pivot = robot.localToWorld(bayX(robot), 0, 0);
    const dx = t.x - pivot.x, dz = t.z - pivot.z;

    // Slew the turret (robot-relative angle) toward the target.
    const err = wrapAngle(wrapAngle(Math.atan2(-dz, dx) - robot.yaw) - robot.turretYaw);
    robot.turretYaw = wrapAngle(robot.turretYaw + THREE.MathUtils.clamp(err, -def.slewRate * dt, def.slewRate * dt));
    if (robot.mechanism) robot.mechanism.rotation.y = robot.turretYaw;
    if (!ready || Math.abs(err) > deg(def.aimToleranceDeg)) return null;

    const exit = robot.localToWorld(bayX(robot), robot.height / 2 + def.exitAboveTop, 0);
    const { vh, vy } = ballistic(Math.hypot(dx, dz), exit.y, t.y, t.apex);
    // This is the ball's world velocity, so the turret already leads for the robot's
    // motion: that's what makes shooting on the move work.
    return [{ pos: exit, vel: launch(def, robot, robot.yaw + robot.turretYaw, vh, vy) }];
  },
};

const dumper: ShooterImpl<DumperShooterDef> = {
  // Like 7558 and 254: between two side plates across the rear, a bank of long rollers
  // on an arc carries Fuel from the hopper floor up and over the back. All within height.
  buildVisual(_def, robot) {
    const H = robot.height, hop = robot.hopperLayout, w = hop.width, g = robot.group;
    const bay = hop.back - hop.bayBack;
    for (const sz of [-1, 1]) addMesh(g, new THREE.BoxGeometry(bay, H - hop.bottom - 0.4, 0.5), plateMat(), bayX(robot), (H + hop.bottom) / 2 - 0.2, sz * (w / 2 + 0.3));
    const bank = new THREE.Group();
    const cx = bayX(robot) + 0.5, cy = H - 7.5, r = Math.min(5.6, bay / 2);
    const white = mat(0xeef0f2, 0.1);
    // Rollers from low at the front of the bay up to the top. The arc stops there so the
    // rear stays open: Fuel leaves up and backward with nothing in its way.
    for (const a of [-55, -15, 25, 65, 100]) {
      const rad = THREE.MathUtils.degToRad(a);
      roller(bank, 1.2, w - 0.4, white, cx + r * Math.cos(rad), cy + r * Math.sin(rad));
    }
    roller(bank, 2.2, w - 0.4, blackMat(), cx - 1, cy - 0.5); // main flywheel
    g.add(bank);
    robot.mechanism = bank;
  },

  aim(def, robot, dt, hub) {
    const ready = spin(def, robot, dt);
    if (robot.mechanism) for (const c of robot.mechanism.children) c.rotation.y += dt * 40 * robot.flywheel;
    const t = pickTarget(def, robot, hub);
    robot.aimMode = t.mode;
    robot.headingTarget = null;
    if (!robot.command.shoot) return null;

    // No turret: turn the robot so its back (the shooter) faces the target first.
    // Aim from where the robot is about to be, so the heading doesn't trail a moving bearing.
    const ahead = 0.12;
    const dx = t.x - (robot.position.x + robot.velocity.x * ahead), dz = t.z - (robot.position.z + robot.velocity.z * ahead);
    robot.headingTarget = wrapAngle(Math.atan2(-dz, dx) + Math.PI);
    if (!ready || Math.abs(wrapAngle(robot.headingTarget - robot.yaw)) > deg(def.alignToleranceDeg)) return null;

    // One ball from a random point along the flywheel: a stream, not a volley.
    const span = robot.hopperLayout.width - CONFIG.fuel.diameter - 1;
    const exit = robot.localToWorld(bayX(robot) - 3.5, robot.height / 2 + def.exitAboveTop, (Math.random() - 0.5) * span);
    const { vh, vy } = ballistic(Math.hypot(t.x - exit.x, t.z - exit.z), exit.y, t.y, t.apex);
    const vel = launch(def, robot, robot.yaw + Math.PI, vh, vy);
    // Partial lead: the shooter only corrects for part of the robot's motion, so shots
    // on the move drift a little (a turret corrects fully).
    vel.x += robot.velocity.x * (1 - def.moveLead);
    vel.z += robot.velocity.z * (1 - def.moveLead);
    return [{ pos: exit, vel }];
  },
};

export const SHOOTERS: { [K in ShooterKind]: ShooterImpl<Extract<ShooterDef, { kind: K }>> } = { turret, dumper };

export function wrapAngle(a: number) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
