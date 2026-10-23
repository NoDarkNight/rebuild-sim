import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { CONFIG, Alliance } from './config';

const F = CONFIG.field;

/** Red's side is -X; Blue's mirrors it by a 180 degree rotation about the field center. */
export const allianceSign = (a: Alliance) => (a === 'red' ? -1 : 1);
export const rotateForAlliance = (a: Alliance, x: number, z: number) =>
  a === 'red' ? { x, z } : { x: -x, z: -z };

export interface HubInfo {
  alliance: Alliance;
  x: number;
  z: number;
  /** Half-width of the open interior, used for scoring. */
  interiorHalf: number;
  /** +1/-1: which way along X the Fuel exit faces (toward the Neutral Zone). */
  exitDir: number;
  ringMaterial: THREE.MeshStandardMaterial;
}

export interface DepotInfo {
  alliance: Alliance;
  x: number;
  z: number;
}

export interface Field {
  hubs: Record<Alliance, HubInfo>;
  depots: Record<Alliance, DepotInfo>;
}

export function buildField(world: RAPIER.World, scene: THREE.Scene): Field {
  const shadows = CONFIG.render.shadows;
  const mats = {
    carpet: new THREE.MeshStandardMaterial({ color: CONFIG.colors.carpet, roughness: 0.95 }),
    rail: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.5, metalness: 0.3 }),
    poly: new THREE.MeshStandardMaterial({ color: 0xcfe3ff, transparent: true, opacity: 0.18, roughness: 0.1 }),
    structure: new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.6, metalness: 0.2 }),
    bump: new THREE.MeshStandardMaterial({ color: 0x6f747c, roughness: 0.8 }),
    white: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    red: new THREE.MeshStandardMaterial({ color: CONFIG.colors.red, roughness: 0.6 }),
    blue: new THREE.MeshStandardMaterial({ color: CONFIG.colors.blue, roughness: 0.6 }),
  };
  const allianceMat = (a: Alliance) => (a === 'red' ? mats.red : mats.blue);

  const box = (
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    mat: THREE.Material | null,
    collide = true,
  ) => {
    if (mat) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
      m.position.set(cx, cy, cz);
      m.castShadow = shadows && !(mat as THREE.MeshStandardMaterial).transparent;
      m.receiveShadow = shadows;
      scene.add(m);
    }
    if (collide) {
      world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setFriction(0.6));
    }
  };

  // Floor: a thick slab so nothing tunnels through.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(F.length + 200, F.width + 200), mats.carpet);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = shadows;
  scene.add(floor);
  world.createCollider(RAPIER.ColliderDesc.cuboid(F.length, 10, F.width).setTranslation(0, -10, 0).setFriction(0.8));

  // Perimeter. Side walls (along X) are guardrail + polycarbonate; alliance walls are tall.
  const hl = F.length / 2, hw = F.width / 2, t = F.wallThickness / 2;
  for (const s of [-1, 1]) {
    box(0, F.wallHeight / 2, s * (hw + t), hl + F.wallThickness, F.wallHeight / 2, t, mats.poly);
    box(0, F.wallHeight, s * (hw + t), hl + F.wallThickness, 1, t + 0.5, mats.rail, false);
  }
  for (const a of ['red', 'blue'] as Alliance[]) {
    const s = allianceSign(a);
    box(s * (hl + t), F.allianceWallHeight / 2, 0, t, F.allianceWallHeight / 2, hw, mats.poly);
    box(s * (hl + t), 18, 0, t + 0.5, 18, hw, allianceMat(a), false);
  }

  // Tape lines.
  const line = (x: number, z: number, lx: number, lz: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(lx, lz), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.05, z);
    scene.add(m);
  };
  line(0, 0, F.lineWidth, F.width, mats.white);

  const hubs = {} as Record<Alliance, HubInfo>;
  const depots = {} as Record<Alliance, DepotInfo>;

  for (const a of ['red', 'blue'] as Alliance[]) {
    const s = allianceSign(a);
    const zoneLineX = s * (hl - F.allianceZoneDepth);
    line(zoneLineX, 0, F.lineWidth, F.width, allianceMat(a));

    // Hub
    const H = CONFIG.hub;
    const hubX = s * (hl - H.centerFromWall);
    const half = H.size / 2, wt = H.wallThickness;
    for (const side of [-1, 1]) {
      box(hubX + side * (half - wt / 2), H.height / 2, 0, wt / 2, H.height / 2, half, mats.structure);
      box(hubX, H.height / 2, side * (half - wt / 2), half - wt, H.height / 2, wt / 2, mats.structure);
    }
    // Colored base band and glowing top ring (lit when the Hub is active).
    box(hubX, 6, 0, half + 0.3, 6, half + 0.3, allianceMat(a), false);
    const ringMaterial = new THREE.MeshStandardMaterial({
      color: a === 'red' ? CONFIG.colors.red : CONFIG.colors.blue,
      emissive: a === 'red' ? CONFIG.colors.red : CONFIG.colors.blue,
      emissiveIntensity: 1,
    });
    for (const side of [-1, 1]) {
      box(hubX + side * (half - wt / 2), H.height + 1.5, 0, wt / 2 + 0.4, 1.5, half + 0.4, ringMaterial, false);
      box(hubX, H.height + 1.5, side * (half - wt / 2), half, 1.5, wt / 2 + 0.4, ringMaterial, false);
    }
    // Fuel exit chute marking on the Neutral Zone side.
    const exitDir = -s;
    const chute = new THREE.Mesh(new THREE.PlaneGeometry(H.exitSpreadZ * 2 + 6, 10), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    chute.position.set(hubX + exitDir * (half + 0.4), 7, 0);
    chute.rotation.y = exitDir * Math.PI / 2;
    scene.add(chute);
    hubs[a] = { alliance: a, x: hubX, z: 0, interiorHalf: half - wt, exitDir, ringMaterial };

    // Bumps flank the Hub; Trenches run from the Bumps to the side walls.
    const B = CONFIG.bump;
    for (const side of [-1, 1]) {
      const bz = side * (half + B.width / 2);
      buildBump(world, scene, hubX, bz, mats.bump);
      line(hubX, bz, B.depth, 1, allianceMat(a));
    }
    const T = CONFIG.trench;
    for (const side of [-1, 1]) {
      const innerZ = half + B.width; // edge of the bump
      const outerZ = hw;
      const pillarW = Math.max(2, outerZ - innerZ - T.openingWidth);
      const topY = T.clearance + T.barThickness;
      // Pillar next to the bump, bar overhead across the opening to the wall.
      box(hubX, topY / 2, side * (innerZ + pillarW / 2), T.depth / 2, topY / 2, pillarW / 2, mats.structure);
      const barZ = side * (innerZ + (outerZ - innerZ) / 2), barHz = (outerZ - innerZ) / 2;
      box(hubX, T.clearance + T.barThickness / 2, barZ, T.depth / 2, T.barThickness / 2, barHz, allianceMat(a), false);
      const slopHy = (T.barThickness - T.colliderSlop) / 2;
      box(hubX, T.clearance + T.colliderSlop + slopHy, barZ, T.depth / 2, slopHy, barHz, null);
    }

    // Depot: a low-rimmed floor area against the alliance wall.
    const D = CONFIG.depot;
    const dc = rotateForAlliance(a, -hl + D.depth / 2, D.centerZ);
    const rim = D.rimHeight / 2;
    box(dc.x, rim, dc.z - D.width / 2, D.depth / 2, rim, 0.75, allianceMat(a));
    box(dc.x, rim, dc.z + D.width / 2, D.depth / 2, rim, 0.75, allianceMat(a));
    box(dc.x - s * D.depth / 2, rim, dc.z, 0.75, rim, D.width / 2, allianceMat(a));
    depots[a] = { alliance: a, x: dc.x, z: dc.z };
  }

  return { hubs, depots };
}

function buildBump(world: RAPIER.World, scene: THREE.Scene, x: number, z: number, mat: THREE.Material) {
  const B = CONFIG.bump;
  const hd = B.depth / 2, ht = B.topDepth / 2, hw = B.width / 2;
  const pts: THREE.Vector3[] = [];
  for (const sz of [-hw, hw]) {
    pts.push(
      new THREE.Vector3(-hd, 0, sz), new THREE.Vector3(hd, 0, sz),
      new THREE.Vector3(-ht, B.height, sz), new THREE.Vector3(ht, B.height, sz),
    );
  }
  const geo = new ConvexGeometry(pts);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 0, z);
  mesh.castShadow = mesh.receiveShadow = CONFIG.render.shadows;
  scene.add(mesh);
  const flat = new Float32Array(pts.flatMap((p) => [p.x, p.y, p.z]));
  const desc = RAPIER.ColliderDesc.convexHull(flat);
  if (desc) world.createCollider(desc.setTranslation(x, 0, z).setFriction(0.9));
}
