import * as THREE from 'three';
import { CONFIG, Alliance } from './config';
import { allianceSign } from './field';
import type { Robot } from './robot';

export type CameraMode = 'follow' | 'driverStation' | 'topDown';
export const CAMERA_MODES: CameraMode[] = ['follow', 'driverStation', 'topDown'];
export const CAMERA_LABELS: Record<CameraMode, string> = {
  follow: 'Follow',
  driverStation: 'Driver Station',
  topDown: 'Top Down',
};

/** Positions the camera and tells the driver which way "forward" is on screen. */
export class CameraRig {
  mode: CameraMode = 'follow';
  /** Field-frame unit vector the driver's "forward" maps to. */
  readonly driveForward = new THREE.Vector3(1, 0, 0);
  private followYaw: number | null = null;
  private orbit = 0;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  cycle() {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.followYaw = null;
  }

  /** Slow orbit for the menu screen. */
  updateMenu(dt: number) {
    this.orbit += dt * 0.08;
    const c = this.camera;
    c.up.set(0, 1, 0);
    c.position.set(Math.cos(this.orbit) * 520, 260, Math.sin(this.orbit) * 380);
    c.lookAt(0, 0, 0);
  }

  update(dt: number, robot: Robot, alliance: Alliance) {
    const c = this.camera;
    const s = allianceSign(alliance);
    const F = CONFIG.field;
    c.up.set(0, 1, 0);

    if (this.mode === 'follow') {
      const P = CONFIG.camera.follow;
      if (this.followYaw === null) this.followYaw = robot.yaw;
      // Exponential smoothing toward the robot's heading, the short way round.
      let d = robot.yaw - this.followYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.followYaw += d * (1 - Math.exp(-P.smoothing * dt));
      const fx = Math.cos(this.followYaw), fz = -Math.sin(this.followYaw);
      const p = robot.position;
      c.position.set(p.x - fx * P.distance, P.height, p.z - fz * P.distance);
      c.lookAt(p.x + fx * P.lookAhead, 12, p.z + fz * P.lookAhead);
      this.driveForward.set(fx, 0, fz);
    } else if (this.mode === 'driverStation') {
      const P = CONFIG.camera.driverStation;
      c.position.set(s * (F.length / 2 + P.behindWall), P.height, 0);
      c.lookAt(-s * P.lookAtX, 0, 0); // lookAtX is given for Red; mirrored for Blue
      this.driveForward.set(-s, 0, 0);
    } else {
      const half = Math.tan(THREE.MathUtils.degToRad(c.fov / 2));
      const h = (Math.max(F.length / 2, F.width / 2 / c.aspect) * CONFIG.camera.topDown.margin) / half;
      c.position.set(0, h, 0);
      c.up.set(-s, 0, 0); // your alliance wall at the bottom of the screen
      c.lookAt(0, 0, 0);
      this.driveForward.set(-s, 0, 0);
    }
  }
}
