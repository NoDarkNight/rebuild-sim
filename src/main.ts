import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from './config';
import { Game, GameSetup, soloSetup, type SlotSetup } from './game';
import { lineupToSetup } from './lineup';
import { Input } from './input';
import { CameraRig } from './camera';
import { Hud } from './hud';
import { Menu } from './menu';
import { NetSession } from './net/session';
import { SnapshotBuffer, decodeCommand, decodeSnapshot, encodeCommand, encodeSnapshot, msgType, MsgType } from './net/protocol';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

await RAPIER.init();

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio));
renderer.shadowMap.enabled = CONFIG.render.shadows;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = CONFIG.render.exposure;

// Soft studio reflections for metal and plastic; built once, shared by every match.
const envMap = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, 8, 3000);
const rig = new CameraRig(camera);
const input = new Input(canvas);
const hud = new Hud(document.getElementById('hud')!);

type Screen = 'menu' | 'room' | 'playing' | 'results';
let screen: Screen = 'menu';
let setup: GameSetup = soloSetup(CONFIG.robotTypes[0].id, 'red');
let game = makeGame(setup, false);

// Online state.
let session: NetSession | null = null;
let snapshots: SnapshotBuffer | null = null;
let netClock = 0;

const menu = new Menu(document.getElementById('overlay')!, {
  solo: (lineup) => startMatch(lineupToSetup(lineup, 'solo', 'local')),
  host: (p) => connect(() => NetSession.host(p.name, p.typeId), 'Creating a room…'),
  join: (code, p) => connect(() => NetSession.join(code, p.name, p.typeId), `Joining ${code}…`),
  room: {
    setSelf: (change) => session?.setSelf(change),
    move: (from, to) => session?.moveSlot(from, to),
    kick: (slot) => session?.kick(slot),
    setStart: (slot, pose) => session?.setStart(slot, pose),
    start: () => session?.startMatch(),
  },
  leave: () => leaveSession(),
  again: () => (session ? session.startMatch() : startMatch(setup)),
  backToRoom: () => session?.endMatch(),
  toSolo: () => toMenu(),
});

function makeGame(s: GameSetup, live: boolean) {
  const g = new Game(s, live);
  g.scene.environment = envMap;
  g.scene.environmentIntensity = CONFIG.render.environmentIntensity;
  return g;
}

function replaceGame(next: Game) {
  game.dispose();
  game = next;
}

function startMatch(s: GameSetup) {
  setup = s;
  replaceGame(makeGame(s, true));
  snapshots = s.mode === 'client' ? new SnapshotBuffer(CONFIG.net.interpDelay) : null;
  screen = 'playing';
  menu.hide();
  hud.show(true);
}

/** Leave whatever is running and show an idle field behind a menu screen. */
function idleBackground() {
  if (game.live) replaceGame(makeGame(soloSetup(menu.profile.typeId, 'red'), false));
  snapshots = null;
  hud.show(false);
}

/** Back to singleplayer setup, or to the multiplayer screen with a reason after leaving a room. */
function toMenu(onlineMessage?: string) {
  idleBackground();
  screen = 'menu';
  if (onlineMessage === undefined) menu.showSolo();
  else menu.showOnline(onlineMessage);
}

function showRoom() {
  if (!session) return;
  idleBackground();
  screen = 'room';
  menu.showRoom({ code: session.code, isHost: session.isHost, selfId: session.selfId, hostId: session.hostId, slots: session.slots });
}

async function connect(open: () => Promise<NetSession>, status: string) {
  leaveSession(false);
  menu.showStatus(status);
  try {
    const s = await open();
    session = s;
    wire(s);
    showRoom();
  } catch (err) {
    toMenu((err as Error).message);
  }
}

function wire(s: NetSession) {
  s.onRoom = () => { if (screen === 'room') showRoom(); };
  s.onStart = (slots: SlotSetup[]) =>
    startMatch({ mode: s.role === 'host' ? 'host' : 'client', localId: s.selfId, slots });
  s.onEnd = () => showRoom();
  s.onSnapshot = (buf) => {
    if (game.mode === 'client' && snapshots && msgType(buf) === MsgType.Snapshot) snapshots.push(decodeSnapshot(buf), performance.now() / 1000);
  };
  s.onCommand = (id, buf) => {
    if (game.mode === 'host' && msgType(buf) === MsgType.Command) game.setRemoteCommand(id, decodeCommand(buf));
  };
  s.onClosed = (reason) => { session = null; toMenu(reason); };
}

function leaveSession(showMenu = true) {
  const s = session;
  session = null;
  if (s) { s.onClosed = () => {}; s.close(); }
  if (showMenu) toMenu('');
}

input.on((e) => {
  if (e === 'camera' && screen === 'playing') rig.cycle();
  else if (e === 'reset' && (screen === 'playing' || screen === 'results')) {
    // Only the host (or a solo player) can restart.
    if (!session) startMatch(setup);
    else if (session.role === 'host') session.startMatch();
  } else if (e === 'menu') {
    if (screen === 'menu') menu.back();
    else if (!session) toMenu();
    else if (session.isHost && screen !== 'room') session.endMatch();
  }
});
// Tell the room we're gone instead of leaving it to time out.
window.addEventListener('pagehide', () => session?.close());

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
// Invite links (?room=CODE) open the multiplayer screen with the code filled in.
const invite = new URLSearchParams(location.search).get('room');
idleBackground();
if (invite) {
  history.replaceState(null, '', location.pathname);
  menu.showOnline('', invite);
} else {
  menu.showTitle();
}

/** Host sends snapshots and joiners send commands, each on its own fixed rate. */
function netTick(dt: number) {
  if (!session || !game.live) return;
  netClock += dt;
  const rate = session.role === 'host' ? CONFIG.net.snapshotRate : CONFIG.net.commandRate;
  if (netClock < 1 / rate) return;
  netClock %= 1 / rate;
  if (session.role === 'host') session.broadcastSnapshot(encodeSnapshot(game));
  else session.sendCommand(encodeCommand(game.localCommand(rig)));
}

let last = performance.now();
let fps = 60, fpsFrames = 0, fpsTime = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) { fps = fpsFrames / fpsTime; fpsFrames = 0; fpsTime = 0; }

  game.setInput(input.read());
  if (snapshots) snapshots.apply(game, now / 1000);
  game.advance(dt, rig);
  game.updateHubVisuals();
  netTick(dt);

  if (screen === 'menu' || screen === 'room') {
    rig.updateMenu(dt);
  } else {
    rig.update(dt, game.player, game.alliance, game.field.occluders);
    game.player.setMarkerVisible(rig.mode === 'driverStation' || rig.mode === 'topDown');
    hud.update(game, rig.mode, fps);
    if (screen === 'playing' && game.match.isFinal) {
      screen = 'results';
      menu.showResults(game, session ? { isHost: session.role === 'host' } : null);
    }
  }
  renderer.render(game.scene, camera);
});

// Handy for tuning from the devtools console.
Object.assign(window, {
  sim: {
    get game() { return game; }, get session() { return session; }, get snapshots() { return snapshots; },
    net: { encodeSnapshot, decodeSnapshot, encodeCommand }, CONFIG, renderer, camera, rig,
  },
});
