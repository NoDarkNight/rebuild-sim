import * as THREE from 'three';
import type { Alliance } from '../config';
import type { Game } from '../game';
import type { AimMode, DriveCommand } from '../robot';

/**
 * Binary wire formats. Snapshots go host -> clients many times a second over an
 * unreliable channel; commands go client -> host the same way. Everything else
 * (lobby, start, end) is small JSON on a reliable channel.
 */

// ---------- driving commands (client -> host) ----------

const i8 = (v: number) => Math.max(-127, Math.min(127, Math.round(v * 127)));

export function encodeCommand(c: DriveCommand): ArrayBuffer {
  const b = new ArrayBuffer(5);
  const v = new DataView(b);
  v.setUint8(0, MsgType.Command);
  v.setInt8(1, i8(c.moveX));
  v.setInt8(2, i8(c.moveZ));
  v.setInt8(3, i8(c.turn));
  v.setUint8(4, (c.intake ? 1 : 0) | (c.shoot ? 2 : 0));
  return b;
}

export function decodeCommand(b: ArrayBuffer): DriveCommand {
  const v = new DataView(b);
  const f = v.getUint8(4);
  return { moveX: v.getInt8(1) / 127, moveZ: v.getInt8(2) / 127, turn: v.getInt8(3) / 127, intake: !!(f & 1), shoot: !!(f & 2) };
}

export const enum MsgType {
  Command = 1,
  Snapshot = 2,
}

export const msgType = (b: ArrayBuffer) => new DataView(b).getUint8(0);

// ---------- snapshots (host -> clients) ----------

export interface RobotState {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  turretYaw: number;
  flywheel: number;
  hopper: number;
  intake: boolean;
  shoot: boolean;
  aimMode: AimMode;
  shotsFired: number;
}

export interface MatchState {
  time: number;
  score: Record<Alliance, number>;
  fuelScored: Record<Alliance, number>;
  autoFuel: Record<Alliance, number>;
  firstInactive: Alliance | null;
  tieBroken: boolean;
}

export interface Snapshot {
  /** Host simulation time when it was taken. */
  t: number;
  match: MatchState;
  robots: RobotState[];
  /** Per ball: x, y, z, scale (scale 0 = hidden). */
  fuel: Float32Array;
}

const AIM: AimMode[] = ['score', 'ferry', 'none'];
const ROBOT_BYTES = 4 * 8 + 1 + 1 + 1 + 1 + 2;
const BALL_BYTES = 7;
const HEADER_BYTES = 1 + 4 + 4 + 2 * 6 + 1 + 1 + 1 + 2;
const FUEL_SCALE = 10; // positions in tenths of an inch

export function encodeSnapshot(game: Game): ArrayBuffer {
  const robots = game.robots, nFuel = game.fuel.count;
  const buf = new ArrayBuffer(HEADER_BYTES + robots.length * ROBOT_BYTES + nFuel * BALL_BYTES);
  const v = new DataView(buf);
  let o = 0;
  const m = game.match;
  v.setUint8(o, MsgType.Snapshot); o += 1;
  v.setFloat32(o, game.time); o += 4;
  v.setFloat32(o, m.time); o += 4;
  for (const n of [m.score.red, m.score.blue, m.fuelScored.red, m.fuelScored.blue, m.autoFuel.red, m.autoFuel.blue]) {
    v.setUint16(o, n); o += 2;
  }
  v.setUint8(o, m.firstInactive === 'red' ? 1 : m.firstInactive === 'blue' ? 2 : 0); o += 1;
  v.setUint8(o, m.tieBroken ? 1 : 0); o += 1;
  v.setUint8(o, robots.length); o += 1;
  v.setUint16(o, nFuel); o += 2;

  for (const r of robots) {
    const t = r.body.translation(), q = r.body.rotation();
    for (const x of [t.x, t.y, t.z, q.x, q.y, q.z, q.w, r.turretYaw]) { v.setFloat32(o, x); o += 4; }
    v.setUint8(o, Math.round(r.flywheel * 255)); o += 1;
    v.setUint8(o, r.hopper); o += 1;
    v.setUint8(o, (r.intaking ? 1 : 0) | (r.command.shoot ? 2 : 0)); o += 1;
    v.setUint8(o, AIM.indexOf(r.aimMode)); o += 1;
    v.setUint16(o, r.shotsFired); o += 2;
  }

  // Fuel straight from the instanced mesh, so capture animations (into hoppers, down
  // into Hubs) travel too.
  const arr = game.fuel.mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < nFuel; i++) {
    const e = i * 16;
    const scale = Math.hypot(arr[e], arr[e + 1], arr[e + 2]);
    v.setInt16(o, Math.round(arr[e + 12] * FUEL_SCALE)); o += 2;
    v.setInt16(o, Math.round(arr[e + 13] * FUEL_SCALE)); o += 2;
    v.setInt16(o, Math.round(arr[e + 14] * FUEL_SCALE)); o += 2;
    v.setUint8(o, Math.round(Math.min(1, scale) * 255)); o += 1;
  }
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): Snapshot {
  const v = new DataView(buf);
  let o = 1;
  const t = v.getFloat32(o); o += 4;
  const time = v.getFloat32(o); o += 4;
  const n: number[] = [];
  for (let k = 0; k < 6; k++) { n.push(v.getUint16(o)); o += 2; }
  const fi = v.getUint8(o); o += 1;
  const tie = v.getUint8(o) === 1; o += 1;
  const nRobots = v.getUint8(o); o += 1;
  const nFuel = v.getUint16(o); o += 2;
  const robots: RobotState[] = [];
  for (let i = 0; i < nRobots; i++) {
    const f: number[] = [];
    for (let k = 0; k < 8; k++) { f.push(v.getFloat32(o)); o += 4; }
    const flywheel = v.getUint8(o) / 255; o += 1;
    const hopper = v.getUint8(o); o += 1;
    const flags = v.getUint8(o); o += 1;
    const aimMode = AIM[v.getUint8(o)] ?? 'none'; o += 1;
    const shotsFired = v.getUint16(o); o += 2;
    robots.push({
      pos: new THREE.Vector3(f[0], f[1], f[2]), quat: new THREE.Quaternion(f[3], f[4], f[5], f[6]),
      turretYaw: f[7], flywheel, hopper, intake: !!(flags & 1), shoot: !!(flags & 2), aimMode, shotsFired,
    });
  }
  const fuel = new Float32Array(nFuel * 4);
  for (let i = 0; i < nFuel; i++) {
    fuel[i * 4] = v.getInt16(o) / FUEL_SCALE; o += 2;
    fuel[i * 4 + 1] = v.getInt16(o) / FUEL_SCALE; o += 2;
    fuel[i * 4 + 2] = v.getInt16(o) / FUEL_SCALE; o += 2;
    fuel[i * 4 + 3] = v.getUint8(o) / 255; o += 1;
  }
  return {
    t,
    match: {
      time,
      score: { red: n[0], blue: n[1] },
      fuelScored: { red: n[2], blue: n[3] },
      autoFuel: { red: n[4], blue: n[5] },
      firstInactive: fi === 1 ? 'red' : fi === 2 ? 'blue' : null,
      tieBroken: tie,
    },
    robots,
    fuel,
  };
}

// ---------- client-side smoothing ----------

/**
 * Holds recent snapshots and shows the world a little in the past (interpDelay),
 * blending between the two snapshots around that moment, so 20 Hz updates look smooth.
 */
export class SnapshotBuffer {
  private snaps: Snapshot[] = [];
  /** Host time minus local clock, estimated from arrivals. */
  private offset: number | null = null;

  constructor(private delay: number) {}

  push(s: Snapshot, now: number) {
    if (this.snaps.length && s.t <= this.snaps[this.snaps.length - 1].t) return; // late or duplicate
    this.snaps.push(s);
    if (this.snaps.length > 30) this.snaps.shift();
    // Track the smallest observed offset (least network delay), easing toward new values.
    const off = s.t - now;
    this.offset = this.offset === null ? off : Math.min(off, this.offset + 0.002);
  }

  get empty() {
    return this.snaps.length === 0;
  }

  /** Apply the interpolated state at local time `now` to the client's Game. */
  apply(game: Game, now: number) {
    if (!this.snaps.length || this.offset === null) return;
    const target = now + this.offset - this.delay;
    let a = this.snaps[0], b = a;
    for (let i = 1; i < this.snaps.length; i++) {
      if (this.snaps[i].t >= target) { a = this.snaps[i - 1]; b = this.snaps[i]; break; }
      a = b = this.snaps[i];
    }
    const u = b.t > a.t ? THREE.MathUtils.clamp((target - a.t) / (b.t - a.t), 0, 1) : 1;
    applyState(game, a, b, u);
  }
}

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

function applyState(game: Game, a: Snapshot, b: Snapshot, u: number) {
  const m = game.match, s = b.match;
  m.time = a.match.time + (s.time - a.match.time) * u;
  m.score = { ...s.score };
  m.fuelScored = { ...s.fuelScored };
  m.autoFuel = { ...s.autoFuel };
  m.firstInactive = s.firstInactive;
  m.tieBroken = s.tieBroken;

  game.robots.forEach((r, i) => {
    const ra = a.robots[i], rb = b.robots[i];
    if (!ra || !rb) return;
    tmpPos.copy(ra.pos).lerp(rb.pos, u);
    tmpQuat.copy(ra.quat).slerp(rb.quat, u);
    r.applyNetState(tmpPos, tmpQuat, {
      ...rb,
      turretYaw: ra.turretYaw + wrap(rb.turretYaw - ra.turretYaw) * u,
    });
  });

  const fa = a.fuel, fb = b.fuel, n = Math.min(fa.length, fb.length) / 4;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    // Blend only when the ball is visible in both; otherwise take the newer state, so
    // balls that respawn elsewhere don't streak across the field.
    const blend = fa[k + 3] > 0 && fb[k + 3] > 0 && Math.abs(fa[k] - fb[k]) + Math.abs(fa[k + 2] - fb[k + 2]) < 60;
    const w = blend ? u : 1;
    game.fuel.setInstance(i,
      fa[k] + (fb[k] - fa[k]) * w, fa[k + 1] + (fb[k + 1] - fa[k + 1]) * w, fa[k + 2] + (fb[k + 2] - fa[k + 2]) * w,
      fa[k + 3] + (fb[k + 3] - fa[k + 3]) * w);
  }
  game.fuel.commitInstances();
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
