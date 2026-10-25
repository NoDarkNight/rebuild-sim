import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG, FUEL_RADIUS } from './config';

/**
 * A fixed pool of Fuel. Fuel is conserved: every ball is either on the field
 * (an enabled physics body) or "stored" (disabled, hidden), which covers both
 * hopper contents (robots just keep a count) and balls falling through a Hub.
 * Stored balls are interchangeable, so spawning just takes any free index.
 */
export class FuelSystem {
  readonly count: number;
  readonly bodies: RAPIER.RigidBody[] = [];
  readonly active: Uint8Array;
  readonly mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private dirty = true;
  private captures: { i: number; t: number; duration: number; start: THREE.Vector3;
    path: (u: number, start: THREE.Vector3) => THREE.Vector3 }[] = [];
  private readonly q = new THREE.Quaternion();
  private readonly sc = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(world: RAPIER.World, scene: THREE.Scene, count: number) {
    this.count = count;
    this.active = new Uint8Array(count);
    const F = CONFIG.fuel;
    const geo = new THREE.SphereGeometry(FUEL_RADIUS, F.sphereSegments, Math.max(6, F.sphereSegments * 0.66 | 0));
    const mat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.fuel, emissive: 0x2a2000, roughness: 0.55 });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = CONFIG.render.shadows;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    for (let i = 0; i < count; i++) {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(0, -100 - i, 0)
          .setLinearDamping(F.linearDamping)
          .setAngularDamping(F.angularDamping)
          .setCcdEnabled(F.ccd)
          .setEnabled(false),
      );
      world.createCollider(
        RAPIER.ColliderDesc.ball(FUEL_RADIUS).setMass(F.mass).setRestitution(F.restitution).setFriction(F.friction),
        body,
      );
      this.bodies.push(body);
      this.free.push(i);
    }
  }

  get freeCount() {
    return this.free.length;
  }

  /** Put a ball on the field. Returns the index, or -1 if the pool is empty. */
  spawn(x: number, y: number, z: number, vx = 0, vy = 0, vz = 0, sleeping = false): number {
    const i = this.free.pop();
    if (i === undefined) return -1;
    const b = this.bodies[i];
    b.setEnabled(true);
    b.setTranslation({ x, y, z }, true);
    b.setLinvel({ x: vx, y: vy, z: vz }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    if (sleeping) b.sleep();
    this.active[i] = 1;
    this.dirty = true;
    return i;
  }

  /** Take a ball off the field (intaken or scored). */
  despawn(i: number) {
    if (!this.active[i]) return;
    this.bodies[i].setEnabled(false);
    this.active[i] = 0;
    this.free.push(i);
    this.dirty = true;
  }

  /**
   * Take a ball off the field, but let it be seen going somewhere first (up an intake
   * into a hopper, down into a Hub). `path(u, start)` gives its world position for
   * u in 0..1; it shrinks out of sight near the end, then returns to the pool.
   */
  capture(i: number, path: (u: number, start: THREE.Vector3) => THREE.Vector3, duration: number) {
    if (!this.active[i]) return;
    const b = this.bodies[i];
    const p = b.translation();
    b.setEnabled(false);
    this.active[i] = 0;
    this.captures.push({ i, t: 0, duration, path, start: new THREE.Vector3(p.x, p.y, p.z) });
  }

  /** Advance capture animations. */
  update(dt: number) {
    if (!this.captures.length) return;
    this.captures = this.captures.filter((c) => {
      c.t += dt;
      if (c.t < c.duration) return true;
      this.free.push(c.i);
      this.dirty = true;
      return false;
    });
  }

  /** Client: place one ball's instance directly from a snapshot (scale 0 hides it). */
  setInstance(i: number, x: number, y: number, z: number, scale: number) {
    this.mesh.setMatrixAt(i, scale <= 0.001 ? this.hidden : this.m.compose(this.sc.set(x, y, z), this.q, new THREE.Vector3(scale, scale, scale)));
  }

  commitInstances() {
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Copy body positions into the instanced mesh. Sleeping balls are skipped. */
  syncMeshes() {
    let changed = this.dirty;
    for (let i = 0; i < this.count; i++) {
      if (!this.active[i]) continue;
      const b = this.bodies[i];
      if (!this.dirty && b.isSleeping()) continue;
      const p = b.translation();
      this.m.makeTranslation(p.x, p.y, p.z);
      this.mesh.setMatrixAt(i, this.m);
      changed = true;
    }
    if (this.dirty) {
      for (let i = 0; i < this.count; i++) if (!this.active[i]) this.mesh.setMatrixAt(i, this.hidden);
    }
    for (const c of this.captures) {
      const u = Math.min(1, c.t / c.duration);
      const s = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
      this.mesh.setMatrixAt(c.i, this.m.compose(c.path(u, c.start), this.q, this.sc.setScalar(Math.max(0.001, s))));
      changed = true;
    }
    this.dirty = false;
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
