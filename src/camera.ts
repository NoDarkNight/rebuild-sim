import * as THREE from 'three';
import { CONFIG, Alliance } from './config';
import { allianceSign } from './field';
import type { Robot } from './robot';

export type CameraMode = 'birdseye' | 'follow' | 'driverStation' | 'topDown';
export const CAMERA_MODES: CameraMode[] = ['birdseye', 'follow', 'driverStation', 'topDown'];
export const CAMERA_LABELS: Record<CameraMode, string> = {
  birdseye: "Bird's-eye",
  follow: 'Chase',
  driverStation: 'Driver station',
  topDown: 'Top down',
};

/**
 * Positions the camera, tells the driver which way "forward" is on screen, and
 * fades field structures that would hide the robot.
 */
export class CameraRig {
  mode: CameraMode = 'birdseye';
  /** Field-frame unit vector the driver's "forward" maps to. */
  readonly driveForward = new THREE.Vector3(1, 0, 0);
  private followYaw: number | null = null;
  private focus: THREE.Vector3 | null = null;
  private orbit = 0;
  private raycaster = new THREE.Raycaster();
  private fade = new Map<THREE.Object3D, number>();
  private lastOccluders: THREE.Object3D[] = [];

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  cycle() {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.followYaw = null;
    this.focus = null;
  }

  /** Slow orbit for the menu screen. */
  updateMenu(dt: number) {
    this.orbit += dt * 0.08;
    const c = this.camera;
    c.up.set(0, 1, 0);
    c.position.set(Math.cos(this.orbit) * 520, 260, Math.sin(this.orbit) * 380);
    c.lookAt(0, 0, 0);
  }

  update(dt: number, robot: Robot, alliance: Alliance, occluders: THREE.Object3D[] = []) {
    const c = this.camera;
    const s = allianceSign(alliance);
    const F = CONFIG.field;
    // Toward the opponent's side of the field.
    const ox = -s;
    c.up.set(0, 1, 0);

    if (this.mode === 'birdseye') {
      // High and behind, always facing the opponent: field-oriented driving, and
      // the robot stays in view wherever it goes.
      const P = CONFIG.camera.birdseye;
      const goal = new THREE.Vector3(robot.position.x + ox * P.lookAhead, 0, robot.position.z);
      if (!this.focus) this.focus = goal.clone();
      this.focus.lerp(goal, 1 - Math.exp(-P.smoothing * dt));
      c.position.set(this.focus.x - ox * P.back, P.height, this.focus.z);
      c.lookAt(this.focus);
      this.driveForward.set(ox, 0, 0);
    } else if (this.mode === 'follow') {
      const P = CONFIG.camera.follow;
      if (this.followYaw === null || P.smoothing <= 0) this.followYaw = robot.yaw;
      // Exponential smoothing toward the robot's heading, the short way round.
      let d = robot.yaw - this.followYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.followYaw += d * (1 - Math.exp(-P.smoothing * dt));
      const fx = Math.cos(this.followYaw), fz = -Math.sin(this.followYaw);
      const p = robot.position;
      c.position.set(p.x - fx * P.distance, P.height, p.z - fz * P.distance);
      c.lookAt(p.x + fx * P.lookAhead, P.lookHeight, p.z + fz * P.lookAhead);
      this.driveForward.set(fx, 0, fz);
    } else if (this.mode === 'driverStation') {
      const P = CONFIG.camera.driverStation;
      c.position.set(s * (F.length / 2 + P.behindWall), P.height, 0);
      c.lookAt(-s * P.lookAtX, 0, 0); // lookAtX is given for Red; mirrored for Blue
      this.driveForward.set(ox, 0, 0);
    } else {
      const half = Math.tan(THREE.MathUtils.degToRad(c.fov / 2));
      const h = (Math.max(F.length / 2, F.width / 2 / c.aspect) * CONFIG.camera.topDown.margin) / half;
      c.position.set(0, h, 0);
      c.up.set(-s, 0, 0); // your alliance wall at the bottom of the screen
      c.lookAt(0, 0, 0);
      this.driveForward.set(ox, 0, 0);
    }
    this.fadeOccluders(dt, robot, occluders);
  }

  /** Fade any structure between the camera and the robot; bring it back once clear. */
  private fadeOccluders(dt: number, robot: Robot, occluders: THREE.Object3D[]) {
    const P = CONFIG.camera.occlusion;
    if (occluders !== this.lastOccluders) { this.fade.clear(); this.lastOccluders = occluders; }
    const blocking = new Set<THREE.Object3D>();
    if (this.mode !== 'topDown') {
      const from = this.camera.position;
      // Check the robot's base and top so a half-hidden robot still counts.
      for (const dy of [-robot.height / 2 + 2, robot.height / 2]) {
        const to = robot.position.clone().setY(robot.position.y + dy);
        const dir = to.clone().sub(from);
        const dist = dir.length();
        this.raycaster.set(from, dir.normalize());
        this.raycaster.far = dist - 2;
        for (const hit of this.raycaster.intersectObjects(occluders, true)) {
          let o: THREE.Object3D | null = hit.object;
          while (o && !occluders.includes(o)) o = o.parent;
          if (o) blocking.add(o);
        }
      }
    }
    const k = 1 - Math.exp(-P.speed * dt);
    for (const group of occluders) {
      const target = blocking.has(group) ? P.opacity : 1;
      const prev = this.fade.get(group) ?? 1;
      const cur = Math.abs(target - prev) < 0.01 ? target : prev + (target - prev) * k;
      if (cur === prev) continue;
      this.fade.set(group, cur);
      setGroupOpacity(group, cur);
    }
  }
}

/** Scale each material's own opacity; restore its original settings when fully visible. */
function setGroupOpacity(group: THREE.Object3D, f: number) {
  const faded = f < 0.999;
  const seen = new Set<THREE.Material>();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.userData.baseCast ??= m.castShadow;
    m.castShadow = !faded && m.userData.baseCast;
    const mat = m.material as THREE.Material;
    if (seen.has(mat)) return;
    seen.add(mat);
    const wantTransparent = faded || mat.userData.baseTransparent;
    if (mat.transparent !== wantTransparent) { mat.transparent = wantTransparent; mat.needsUpdate = true; }
    mat.depthWrite = faded ? false : mat.userData.baseDepthWrite ?? true;
    mat.opacity = (mat.userData.baseOpacity ?? 1) * f;
  });
}
