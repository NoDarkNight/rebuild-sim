import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from './config';
import { Game, GameSetup } from './game';
import { Input } from './input';
import { CameraRig } from './camera';
import { Hud, Menu } from './hud';

await RAPIER.init();

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio));
renderer.shadowMap.enabled = CONFIG.render.shadows;
renderer.shadowMap.type = THREE.PCFShadowMap;

const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, 5, 4000);
const rig = new CameraRig(camera);
const input = new Input(canvas);
const hud = new Hud(document.getElementById('hud')!);

type Screen = 'menu' | 'playing' | 'results';
let screen: Screen = 'menu';
let setup: GameSetup = { typeId: CONFIG.robotTypes[0].id, height: CONFIG.robot.heights.short, alliance: 'red' };
let game = new Game(setup, false);

const menu = new Menu(document.getElementById('overlay')!, setup, (s) => startMatch(s));

function replaceGame(next: Game) {
  game.dispose();
  game = next;
}

function startMatch(s: GameSetup) {
  setup = s;
  replaceGame(new Game(s, true));
  screen = 'playing';
  menu.hide();
  hud.show(true);
}

function toMenu() {
  if (screen !== 'menu') replaceGame(new Game(setup, false));
  screen = 'menu';
  hud.show(false);
  menu.showPicker();
}

input.on((e) => {
  if (e === 'reset' && screen !== 'menu') startMatch(setup);
  else if (e === 'camera' && screen === 'playing') rig.cycle();
  else if (e === 'menu') toMenu();
});

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
toMenu();

let last = performance.now();
let fps = 60, fpsFrames = 0, fpsTime = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) { fps = fpsFrames / fpsTime; fpsFrames = 0; fpsTime = 0; }

  game.setInput(input.read());
  game.advance(dt, rig);
  game.updateHubVisuals();

  if (screen === 'menu') {
    rig.updateMenu(dt);
  } else {
    rig.update(dt, game.player, setup.alliance);
    hud.update(game, rig.mode, fps);
    if (screen === 'playing' && game.match.isFinal) {
      screen = 'results';
      menu.showResults(game);
    }
  }
  renderer.render(game.scene, camera);
});

// Handy for tuning from the devtools console.
Object.assign(window, { sim: { get game() { return game; }, CONFIG, renderer, camera, rig } });
