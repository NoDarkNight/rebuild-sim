import * as THREE from 'three';

/** Procedural textures drawn on a canvas, so the game ships with no image assets. */

/** Speckled carpet tile; repeat it across the floor. */
export function carpetTexture(repeatX: number, repeatY: number): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5d626a';
  g.fillRect(0, 0, size, size);
  // Fibers: many tiny light/dark specks.
  for (let i = 0; i < 9000; i++) {
    const v = Math.random();
    g.fillStyle = v < 0.5 ? `rgba(30,32,38,${0.25 * Math.random()})` : `rgba(200,205,215,${0.12 * Math.random()})`;
    g.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random(), 1 + Math.random());
  }
  // Faint pile direction rows, like a real carpet roll.
  for (let y = 0; y < size; y += 8) {
    g.fillStyle = 'rgba(0,0,0,0.035)';
    g.fillRect(0, y, size, 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Conveyor belt: dark rubber with chevron cleats. Scroll `offset.x` to run it. */
export function beltTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1c1e22';
  g.fillRect(0, 0, 128, 64);
  g.strokeStyle = '#3d424b';
  g.lineWidth = 6;
  for (let x = -32; x < 160; x += 32) {
    g.beginPath();
    g.moveTo(x + 14, 4);
    g.lineTo(x, 32);
    g.lineTo(x + 14, 60);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Black netting: a square mesh of thin cords on a transparent background. */
export function netTexture(repeatX: number, repeatY: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(20, 22, 26, 0.85)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 30, 30);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 4;
  return tex;
}

/** An AprilTag-style fiducial: black border around a seeded 6x6 bit grid, on a white margin. */
export function aprilTagTexture(seed: number): THREE.CanvasTexture {
  const cells = 10; // 1 white margin + 1 black border + 6 data + 1 black + 1 white
  const px = 16;
  const c = document.createElement('canvas');
  c.width = c.height = cells * px;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#111';
  g.fillRect(px, px, 8 * px, 8 * px);
  let s = seed * 9301 + 49297;
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
    s = (s * 9301 + 49297) % 233280;
    if (s / 233280 < 0.5) {
      g.fillStyle = '#fff';
      g.fillRect((x + 2) * px, (y + 2) * px, px, px);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Painted floor lettering: white text on a transparent background. */
export function textTexture(text: string, width = 1024, height = 160): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d')!;
  g.font = `900 ${Math.floor(height * 0.72)}px system-ui, "Segoe UI", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillText(text, width / 2, height / 2 + height * 0.04, width * 0.96);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
