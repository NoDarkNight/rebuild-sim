import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { CONFIG, Alliance } from './config';
import { aprilTagTexture, carpetTexture, netTexture } from './textures';

const F = CONFIG.field;

/** Red's side is -X; Blue's mirrors it by a 180 degree rotation about the field center. */
export const allianceSign = (a: Alliance) => (a === 'red' ? -1 : 1);
/** True if field x is inside this alliance's Alliance Zone (wall to zone line). */
export const inAllianceZone = (a: Alliance, x: number) =>
  allianceSign(a) * x > CONFIG.field.length / 2 - CONFIG.field.allianceZoneDepth;
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
  /** Tall structures the camera can fade out when they hide the robot. Each owns its materials. */
  occluders: THREE.Object3D[];
}

const allianceHex = (a: Alliance) => (a === 'red' ? CONFIG.colors.red : CONFIG.colors.blue);

/** Flat decals (tape, tags, signs) sit on or against other surfaces; polygon offset keeps them from z-fighting. */
const decal = (params: THREE.MeshBasicMaterialParameters) =>
  new THREE.MeshBasicMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, ...params });

export function buildField(world: RAPIER.World, scene: THREE.Scene): Field {
  const shadows = CONFIG.render.shadows;
  const mats = {
    carpet: new THREE.MeshStandardMaterial({ map: carpetTexture(F.length / 48, F.width / 48), roughness: 0.95 }),
    alu: new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.75, roughness: 0.3 }),
    poly: new THREE.MeshStandardMaterial({ color: 0xd8e6f5, transparent: true, opacity: 0.14, roughness: 0.05, depthWrite: false }),
    hubBody: new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.55, metalness: 0.25 }),
    hubCap: new THREE.MeshStandardMaterial({ color: 0xeef0f2, roughness: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.7 }),
    white: decal({ color: 0xffffff }),
  };
  const allianceMats = {
    red: new THREE.MeshStandardMaterial({ color: CONFIG.colors.red, roughness: 0.55 }),
    blue: new THREE.MeshStandardMaterial({ color: CONFIG.colors.blue, roughness: 0.55 }),
  };
  const tape = { red: decal({ color: CONFIG.colors.red }), blue: decal({ color: CONFIG.colors.blue }) };

  // Meshes go into `parent`: the scene, or the occluder group being built.
  let parent: THREE.Object3D = scene;
  const occluders: THREE.Object3D[] = [];
  const beginOccluder = () => { parent = new THREE.Group(); scene.add(parent); };
  const endOccluder = () => { occluders.push(ownMaterials(parent)); parent = scene; };
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    const opaque = !(mat as THREE.MeshStandardMaterial).transparent;
    m.castShadow = shadows && opaque;
    m.receiveShadow = shadows && opaque;
    parent.add(m);
    return m;
  };
  /** Box by center and half-extents; optionally solid. */
  const box = (
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    mat: THREE.Material | null,
    collide = true,
  ) => {
    if (mat) mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat, cx, cy, cz);
    if (collide) world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setFriction(0.6));
  };
  /** A flat decal facing +x/-x/+z/-z, placed just off a surface. */
  const sign = (tex: THREE.Texture, size: number, x: number, y: number, z: number, facing: 'x' | '-x' | 'z' | '-z') => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), decal({ map: tex }));
    m.position.set(x, y, z);
    m.rotation.y = { z: 0, '-z': Math.PI, x: Math.PI / 2, '-x': -Math.PI / 2 }[facing];
    parent.add(m);
  };
  let tagId = 1;

  // Floor: a thick slab so nothing tunnels through. Carpet inside the walls, dark venue floor outside.
  const floor = mesh(new THREE.PlaneGeometry(F.length, F.width), mats.carpet, 0, 0, 0);
  floor.rotation.x = -Math.PI / 2;
  floor.castShadow = false;
  const venue = mesh(new THREE.PlaneGeometry(F.length * 5, F.width * 8), new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 1 }), 0, -1.5, 0);
  venue.rotation.x = -Math.PI / 2;
  venue.castShadow = false;
  world.createCollider(RAPIER.ColliderDesc.cuboid(F.length, 10, F.width).setTranslation(0, -10, 0).setFriction(0.8));

  // Perimeter: polycarbonate guardrail with an aluminum cap and posts; tall alliance walls.
  const hl = F.length / 2, hw = F.width / 2, t = F.wallThickness / 2;
  for (const s of [-1, 1]) {
    box(0, F.wallHeight / 2, s * (hw + t), hl + F.wallThickness, F.wallHeight / 2, t, mats.poly);
    box(0, F.wallHeight + F.railHeight / 2, s * (hw + t), hl + F.wallThickness, F.railHeight / 2, t + 0.6, mats.alu, false);
    box(0, 2, s * (hw + t), hl + F.wallThickness, 2, t + 0.3, mats.dark, false); // kick plate
    for (let x = -hl + 40; x < hl; x += 80) box(x, F.wallHeight / 2, s * (hw + t), 1, F.wallHeight / 2, t + 0.5, mats.alu, false);
  }
  for (const a of ['red', 'blue'] as Alliance[]) {
    const s = allianceSign(a);
    const wx = s * (hl + t);
    beginOccluder();
    box(wx, F.allianceWallHeight / 2, 0, t, F.allianceWallHeight / 2, hw, mats.poly);
    box(wx, 18, 0, t + 0.6, 18, hw, allianceMats[a], false); // driver station panels
    box(wx, F.allianceWallHeight + 1, 0, t + 0.6, 1, hw + 2, mats.alu, false);
    for (let z = -hw; z <= hw + 0.1; z += hw / 3) box(wx, F.allianceWallHeight / 2, z, t + 0.8, F.allianceWallHeight / 2, 1, mats.alu, false);
    endOccluder();
  }

  // Tape.
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
    const am = allianceMats[a];
    line(s * (hl - F.allianceZoneDepth), 0, F.lineWidth, F.width, tape[a]);

    // --- Hub ---
    const H = CONFIG.hub;
    const hubX = s * (hl - H.centerFromWall);
    const half = H.size / 2, wt = H.wallThickness;
    beginOccluder();
    // Solid walls (the opening is the hollow middle).
    for (const side of [-1, 1]) {
      box(hubX + side * (half - wt / 2), H.height / 2, 0, wt / 2, H.height / 2, half, mats.hubBody);
      box(hubX, H.height / 2, side * (half - wt / 2), half - wt, H.height / 2, wt / 2, mats.hubBody);
    }
    // Facade plates just outside each face: alliance panel low, white AprilTag cap high.
    // x-facing plates cover the corners; z-facing plates stop where they meet them.
    const plate = (y0: number, y1: number, mat: THREE.Material) => {
      const hy = (y1 - y0) / 2, cy = (y0 + y1) / 2;
      for (const side of [-1, 1]) {
        box(hubX + side * (half + 0.3), cy, 0, 0.2, hy, half + 0.5, mat, false);
        box(hubX, cy, side * (half + 0.3), half + 0.1, hy, 0.2, mat, false);
      }
    };
    plate(10, 30, am);
    plate(H.height - H.capHeight, H.height, mats.hubCap);
    const tagY = H.height - H.capHeight / 2, tagSize = H.capHeight - 4;
    for (const off of [-12, 12]) {
      sign(aprilTagTexture(tagId++), tagSize, hubX + half + 0.6, tagY, off, 'x');
      sign(aprilTagTexture(tagId++), tagSize, hubX - half - 0.6, tagY, off, '-x');
      sign(aprilTagTexture(tagId++), tagSize, hubX + off, tagY, half + 0.6, 'z');
      sign(aprilTagTexture(tagId++), tagSize, hubX + off, tagY, -half - 0.6, '-z');
    }
    // Top deck in the alliance color around a hexagonal opening; it lights up while the Hub is active.
    const ringMaterial = new THREE.MeshStandardMaterial({ color: allianceHex(a), emissive: allianceHex(a), emissiveIntensity: 1, roughness: 0.4 });
    const deckHalf = half + 0.5;
    const deckShape = new THREE.Shape();
    deckShape.moveTo(-deckHalf, -deckHalf);
    deckShape.lineTo(deckHalf, -deckHalf);
    deckShape.lineTo(deckHalf, deckHalf);
    deckShape.lineTo(-deckHalf, deckHalf);
    const hexR = H.guide.inradius / Math.cos(Math.PI / 6);
    const hole = new THREE.Path();
    for (let i = 0; i <= 6; i++) {
      // Vertices sit between the guide panels, whose normals point at i * 60 degrees.
      const ang = Math.PI / 6 + (i * Math.PI) / 3;
      if (i === 0) hole.moveTo(hexR * Math.cos(ang), hexR * Math.sin(ang));
      else hole.lineTo(hexR * Math.cos(ang), hexR * Math.sin(ang));
    }
    deckShape.holes.push(hole);
    const deck = mesh(new THREE.ExtrudeGeometry(deckShape, { depth: 1.2, bevelEnabled: false }), ringMaterial, hubX, H.height + 1.2, 0);
    // Extruded along +z in shape space; lay it flat (shape y -> world -z, depth -> down).
    deck.rotation.x = Math.PI / 2;
    deck.userData.ring = true;
    // Inside: a dark funnel, so looking in doesn't show bare carpet.
    const inner = half - wt;
    const funnel = mesh(
      new THREE.CylinderGeometry(inner * Math.SQRT2, 5, 26, 4, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9, side: THREE.DoubleSide }),
      hubX, H.height - 13, 0,
    );
    funnel.rotation.y = Math.PI / 4;
    funnel.castShadow = false;
    // Hexagonal guide: six clear panels leaning outward, solid, so Fuel can bounce off them.
    const G = H.guide;
    const tilt = THREE.MathUtils.degToRad(G.tiltDeg);
    const midR = G.inradius + (G.height / 2) * Math.sin(tilt);
    const panelW = 2 * midR * Math.tan(Math.PI / 6) + 0.6;
    const guideMat = new THREE.MeshStandardMaterial({
      color: 0xd9ecff, transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0.1, depthWrite: false, side: THREE.DoubleSide,
    });
    const guideEdge = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, metalness: 0.6, roughness: 0.3 });
    for (let i = 0; i < 6; i++) {
      const phi = (i * Math.PI) / 3; // outward normal direction in the floor plane
      const nx = Math.cos(phi), nz = Math.sin(phi);
      const cy = H.height + 1.2 + (G.height / 2) * Math.cos(tilt);
      const panel = mesh(new THREE.BoxGeometry(panelW, G.height, G.thickness), guideMat, hubX + nx * midR, cy, nz * midR);
      panel.rotation.set(tilt, Math.PI / 2 - phi, 0, 'YXZ');
      panel.castShadow = false;
      // Bright top edge so the shape reads at a distance.
      const lip = mesh(new THREE.BoxGeometry(panelW, 0.8, 0.8), guideEdge, 0, 0, 0);
      lip.position.set(0, G.height / 2, 0);
      panel.add(lip);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(panelW / 2, G.height / 2, G.thickness / 2)
          .setTranslation(panel.position.x, panel.position.y, panel.position.z)
          .setRotation(panel.quaternion)
          .setFriction(0.3),
      );
    }
    // Truss and net on the Neutral Zone side: Fuel lobbed from outside the Alliance Zone can't get in.
    const netSide = -s;
    const nx = hubX + netSide * (half + 1.2), netH = H.netHeight - H.height;
    for (const side of [-1, 1]) box(nx, H.height + netH / 2, side * (half + 1), 1, netH / 2, 1, mats.alu, false);
    box(nx, H.netHeight, 0, 1, 1, half + 2, mats.alu, false);
    box(nx, H.height + netH * 0.5, 0, 0.8, 0.8, half, mats.alu, false);
    for (const side of [-1, 1]) {
      // Diagonal truss braces from the mid bar up to the top corners.
      const brace = mesh(new THREE.BoxGeometry(1, Math.hypot(netH / 2, half), 1), mats.alu, nx, H.height + netH * 0.75, side * half / 2);
      brace.rotation.x = side * Math.atan2(half, netH / 2);
    }
    const net = mesh(new THREE.PlaneGeometry(H.size + 2, netH), new THREE.MeshStandardMaterial({
      map: netTexture((H.size + 2) / 6, netH / 6), transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.8,
    }), nx, H.height + netH / 2, 0);
    net.rotation.y = Math.PI / 2;
    net.castShadow = false;
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.6, netH / 2, half + 2).setTranslation(nx, H.height + netH / 2, 0).setFriction(0.2).setRestitution(0.1));
    // Fuel exit opening on the Neutral Zone side.
    const exitDir = -s;
    const chute = new THREE.Mesh(new THREE.PlaneGeometry(H.exitSpreadZ * 2 + 6, 9), decal({ color: 0x0c0d0f }));
    chute.position.set(hubX + exitDir * (half + 0.6), 5, 0);
    chute.rotation.y = exitDir * Math.PI / 2;
    parent.add(chute);
    const hubGroup = parent;
    endOccluder();
    // The rim's material was cloned with the group; keep the live one for the active glow.
    let liveRing = ringMaterial;
    hubGroup.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.userData.ring) liveRing = m.material as THREE.MeshStandardMaterial; });
    hubs[a] = { alliance: a, x: hubX, z: 0, interiorHalf: half - wt, exitDir, ringMaterial: liveRing };

    // --- Bumps flank the Hub; Trenches run from the Bumps to the side walls ---
    const B = CONFIG.bump;
    for (const side of [-1, 1]) buildBump(world, scene, hubX, side * (half + B.width / 2), am);
    const T = CONFIG.trench;
    for (const side of [-1, 1]) {
      beginOccluder();
      const innerZ = half + B.width; // edge of the bump
      const outerZ = hw;
      const postW = Math.max(2, outerZ - innerZ - T.openingWidth);
      const barTop = T.clearance + T.barThickness;
      // Post beside the bump: a wedge whose sloped faces carry on the Bump's ramp. It stands a
      // little proud of the bar so their tops never share a plane.
      const postTop = barTop + 1, z0 = side * innerZ, z1 = side * (innerZ + postW);
      const wedge: THREE.Vector3[] = [];
      for (const z of [z0, z1]) {
        wedge.push(
          new THREE.Vector3(-B.depth / 2, 0, z), new THREE.Vector3(B.depth / 2, 0, z),
          new THREE.Vector3(-T.depth / 2 - 1, postTop, z), new THREE.Vector3(T.depth / 2 + 1, postTop, z),
        );
      }
      mesh(new ConvexGeometry(wedge), am, hubX, 0, 0);
      const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(wedge.flatMap((v) => [v.x, v.y, v.z])));
      if (hull) world.createCollider(hull.setTranslation(hubX, 0, 0).setFriction(0.6));
      // Black bolted gusset plates where the beam meets the post.
      const gusset = new THREE.Shape();
      gusset.moveTo(0, 0);
      gusset.lineTo(10, 0);
      gusset.lineTo(0, -8);
      const gussetMat = new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.6, side: THREE.DoubleSide });
      for (const fx of [-1, 1]) {
        const plateMesh = mesh(new THREE.ShapeGeometry(gusset), gussetMat, hubX + fx * (T.depth / 2 + 1.05), barTop, side * (innerZ + postW));
        plateMesh.rotation.y = -side * Math.PI / 2; // shape x runs along the beam, away from the post
      }
      const barInner = innerZ + postW, barHz = (outerZ - barInner) / 2, barZ = side * (barInner + barHz);
      box(hubX, T.clearance + T.barThickness / 2, barZ, T.depth / 2, T.barThickness / 2, barHz, am, false);
      const slopHy = (T.barThickness - T.colliderSlop) / 2;
      box(hubX, T.clearance + T.colliderSlop + slopHy, barZ, T.depth / 2, slopHy, barHz, null);
      // AprilTag sign standing on top of the beam at mid-span, readable from both sides.
      const signSize = 10, signY = barTop + 0.6 + signSize / 2;
      box(hubX, barTop + 0.3, barZ, 2, 0.3, 3, mats.alu, false); // foot
      box(hubX, signY, barZ, 0.5, signSize / 2, signSize / 2, mats.alu, false); // frame
      sign(aprilTagTexture(tagId++), signSize - 1.4, hubX + 0.55, signY, barZ, 'x');
      sign(aprilTagTexture(tagId++), signSize - 1.4, hubX - 0.55, signY, barZ, '-x');
      endOccluder();
    }

    // --- Depot: a low rim against the alliance wall. Side rims stop at the back rim. ---
    const D = CONFIG.depot;
    const dc = rotateForAlliance(a, -hl + D.depth / 2, D.centerZ);
    const rim = D.rimHeight / 2;
    box(dc.x, rim, dc.z - D.width / 2, D.depth / 2 - 0.75, rim, 0.75, am);
    box(dc.x, rim, dc.z + D.width / 2, D.depth / 2 - 0.75, rim, 0.75, am);
    box(dc.x - s * D.depth / 2, rim, dc.z, 0.75, rim, D.width / 2 + 0.75, am);
    depots[a] = { alliance: a, x: dc.x, z: dc.z };
  }

  return { hubs, depots, occluders };
}

/** Give a group its own copies of its materials, so fading it leaves the rest of the field alone. */
function ownMaterials(group: THREE.Object3D) {
  const copies = new Map<THREE.Material, THREE.Material>();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material;
    if (!copies.has(mat)) {
      const c = mat.clone();
      c.userData.baseOpacity = c.opacity;
      c.userData.baseTransparent = c.transparent;
      c.userData.baseDepthWrite = c.depthWrite;
      copies.set(mat, c);
    }
    m.material = copies.get(mat)!;
  });
  return group;
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
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, 0, z);
  m.castShadow = m.receiveShadow = CONFIG.render.shadows;
  scene.add(m);
  const flat = new Float32Array(pts.flatMap((p) => [p.x, p.y, p.z]));
  const desc = RAPIER.ColliderDesc.convexHull(flat);
  if (desc) world.createCollider(desc.setTranslation(x, 0, z).setFriction(B.friction));
}
