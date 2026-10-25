import Peer, { type DataConnection } from 'peerjs';
import { CONFIG } from '../config';
import type { SlotSetup } from '../game';
import { emptyLineup, findPlayer, firstOpenSlot, lineupToSetup, placeStart, type LineupSlot, type StartPose } from '../lineup';
import { hasRelay, iceServers } from './ice';

/**
 * Online play: one player hosts in their browser and runs the match; others join
 * with a room code. Connections are peer-to-peer WebRTC. The free PeerJS cloud
 * service only introduces the peers; no game data goes through it.
 *
 * Each joiner opens two data channels to the host: "ctrl" (reliable, JSON) for the
 * lobby and match flow, and "state" (unreliable, binary) for snapshots and driving
 * commands, where a late packet is worse than a lost one.
 */

type CtrlMsg =
  | { t: 'hello'; name: string; typeId: string }
  /** Change your own robot or start, or move yourself to an open slot. */
  | { t: 'set'; typeId?: string; start?: StartPose; slot?: number }
  | { t: 'room'; slots: LineupSlot[]; hostId: string }
  | { t: 'start'; slots: SlotSetup[] }
  | { t: 'end' }
  | { t: 'full' }
  | { t: 'kicked' }
  | { t: 'ping' }
  | { t: 'bye' };

const ID_PREFIX = 'nomansland-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
/** Browsers often never report a closed tab or a dropped network, so both sides ping
 *  and treat a quiet peer as gone. */
const PING_MS = 2000;
const TIMEOUT_MS = 8000;

const randomCode = () => Array.from({ length: CONFIG.net.codeLength }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

export class NetSession {
  /** The room's six positions. The host owns this; joiners get copies. */
  slots: LineupSlot[] = emptyLineup();
  hostId = '';

  onRoom: () => void = () => {};
  onStart: (slots: SlotSetup[]) => void = () => {};
  onEnd: () => void = () => {};
  onSnapshot: (buf: ArrayBuffer) => void = () => {};
  onCommand: (playerId: string, buf: ArrayBuffer) => void = () => {};
  onClosed: (reason: string) => void = () => {};

  private ctrl = new Map<string, DataConnection>();
  private state = new Map<string, DataConnection>();
  private lastHeard = new Map<string, number>();
  private pinger = 0;
  private closed = false;

  private constructor(readonly role: 'host' | 'client', readonly code: string, private peer: Peer) {
    this.pinger = window.setInterval(() => this.heartbeat(), PING_MS);
  }

  get selfId() {
    return this.peer.id;
  }
  get isHost() {
    return this.role === 'host';
  }
  /** Your slot index, or -1. */
  get selfSlot() {
    return findPlayer(this.slots, this.selfId);
  }

  // ---------- setup ----------

  static async host(name: string, typeId: string): Promise<NetSession> {
    const config = { iceServers: await iceServers() };
    return new Promise((resolve, reject) => {
      const tryCode = (attempt: number) => {
        const code = randomCode();
        const peer = new Peer(ID_PREFIX + code.toLowerCase(), { config });
        peer.once('open', () => {
          const s = new NetSession('host', code, peer);
          s.hostId = peer.id;
          s.seat(peer.id, name, typeId);
          s.listen();
          resolve(s);
        });
        peer.once('error', (err) => {
          peer.destroy();
          // Someone else has this code; pick another.
          if ((err as { type?: string }).type === 'unavailable-id' && attempt < 4) tryCode(attempt + 1);
          else reject(new Error(describe(err)));
        });
      };
      tryCode(0);
    });
  }

  static async join(code: string, name: string, typeId: string): Promise<NetSession> {
    const config = { iceServers: await iceServers() };
    return new Promise((resolve, reject) => {
      const peer = new Peer({ config });
      const hostPeerId = ID_PREFIX + code.trim().toLowerCase();
      let ctrlConn: DataConnection | null = null;
      // If the host's answer came back through matchmaking, the room exists and only the
      // direct link failed; say that instead of a generic timeout.
      const hostAnswered = () => !!ctrlConn?.peerConnection?.remoteDescription;
      const fail = (msg: string) => { clearTimeout(timer); peer.destroy(); reject(new Error(msg)); };
      const timer = setTimeout(() => fail(hostAnswered() ? directFailure() : 'Timed out reaching that room.'), 12000);
      peer.once('error', (err) => fail(describe(err)));
      peer.once('open', () => {
        const ctrl = peer.connect(hostPeerId, { label: 'ctrl', reliable: true, serialization: 'json' });
        ctrlConn = ctrl;
        const state = peer.connect(hostPeerId, { label: 'state', reliable: false, serialization: 'raw' });
        let s: NetSession | null = null;
        ctrl.on('iceStateChanged', (st) => { if (st === 'failed' && !s) fail(directFailure()); });
        ctrl.on('open', () => ctrl.send({ t: 'hello', name, typeId } satisfies CtrlMsg));
        ctrl.on('data', (d) => {
          const msg = d as CtrlMsg;
          if (!s) {
            if (msg.t === 'full') { fail('That room is full.'); return; }
            if (msg.t !== 'room') return;
            // Only now does the session exist, so its heartbeat can't fire before we're in.
            clearTimeout(timer);
            s = new NetSession('client', code.trim().toUpperCase(), peer);
            s.hostId = hostPeerId;
            s.ctrl.set(hostPeerId, ctrl);
            s.state.set(hostPeerId, state);
            const session = s;
            state.on('data', (b) => session.onSnapshot(b as ArrayBuffer));
            ctrl.on('close', () => session.close('The host left the room.'));
            peer.on('disconnected', () => session.close('Lost connection to the host.'));
            resolve(s);
          }
          s.lastHeard.set(hostPeerId, Date.now());
          s.handleFromHost(msg);
        });
      });
    });
  }

  // ---------- host ----------

  private listen() {
    this.peer.on('connection', (conn) => {
      if (conn.label === 'state') {
        this.state.set(conn.peer, conn);
        conn.on('data', (d) => this.onCommand(conn.peer, d as ArrayBuffer));
        return;
      }
      conn.on('data', (d) => this.handleFromClient(conn, d as CtrlMsg));
      conn.on('close', () => this.dropPlayer(conn.peer));
      conn.on('error', () => this.dropPlayer(conn.peer));
    });
    this.peer.on('disconnected', () => this.peer.reconnect());
  }

  private handleFromClient(conn: DataConnection, msg: CtrlMsg) {
    if (msg.t === 'hello') {
      if (findPlayer(this.slots, conn.peer) >= 0) return;
      if (!this.seat(conn.peer, msg.name, msg.typeId)) {
        conn.send({ t: 'full' } satisfies CtrlMsg);
        setTimeout(() => conn.close(), 300);
        return;
      }
      this.ctrl.set(conn.peer, conn);
      this.broadcastRoom();
      return;
    }
    if (findPlayer(this.slots, conn.peer) < 0) return; // kicked or timed out
    this.lastHeard.set(conn.peer, Date.now());
    if (msg.t === 'set') this.updatePlayer(conn.peer, msg);
    else if (msg.t === 'bye') this.dropPlayer(conn.peer);
  }

  /** Put a player in the next open slot. False if the room is full. */
  private seat(id: string, name: string, typeId: string) {
    const i = firstOpenSlot(this.slots);
    if (i < 0) return false;
    this.slots[i] = { ...this.slots[i], occupant: { kind: 'player', id, name: cleanName(name) }, typeId: validType(typeId) };
    if (id !== this.selfId) this.lastHeard.set(id, Date.now());
    return true;
  }

  private updatePlayer(id: string, change: { typeId?: string; start?: StartPose; slot?: number }) {
    let i = findPlayer(this.slots, id);
    if (i < 0) return;
    if (change.slot !== undefined && this.slots[change.slot] && !this.slots[change.slot].occupant) {
      this.swap(i, change.slot);
      i = change.slot;
    }
    if (change.typeId) this.slots[i].typeId = validType(change.typeId);
    if (change.start) this.slots[i].start = placeStart(this.slots, i, change.start);
    this.broadcastRoom();
  }

  /** Swap who sits in two slots. Each player keeps their robot; start spots stay with the slot. */
  private swap(a: number, b: number) {
    const A = this.slots[a], B = this.slots[b];
    this.slots[a] = { ...A, occupant: B.occupant, typeId: B.typeId };
    this.slots[b] = { ...B, occupant: A.occupant, typeId: A.typeId };
  }

  /** Host: move whoever is in one slot to another, swapping if it's taken. */
  moveSlot(from: number, to: number) {
    if (!this.isHost || from === to || !this.slots[from] || !this.slots[to]) return;
    this.swap(from, to);
    this.broadcastRoom();
  }

  /** Host: set any slot's start spot (players set their own through setSelf). */
  setStart(i: number, pose: StartPose) {
    if (!this.isHost || !this.slots[i]) return;
    this.slots[i].start = placeStart(this.slots, i, pose);
    this.broadcastRoom();
  }

  /** Host: remove a player from the room. */
  kick(i: number) {
    const o = this.slots[i]?.occupant;
    if (!this.isHost || o?.kind !== 'player' || o.id === this.selfId) return;
    const conn = this.ctrl.get(o.id);
    conn?.send({ t: 'kicked' } satisfies CtrlMsg);
    this.dropPlayer(o.id);
    setTimeout(() => conn?.close(), 300);
  }

  private dropPlayer(id: string) {
    this.ctrl.delete(id);
    this.state.get(id)?.close();
    this.state.delete(id);
    this.lastHeard.delete(id);
    const i = findPlayer(this.slots, id);
    if (i < 0) return;
    this.slots[i] = { ...this.slots[i], occupant: null };
    this.broadcastRoom();
  }

  private broadcastRoom() {
    const msg: CtrlMsg = { t: 'room', slots: this.slots, hostId: this.hostId };
    for (const c of this.ctrl.values()) c.send(msg);
    this.onRoom();
  }

  /** Host: start everyone. Empty slots get parked robots. */
  startMatch(): SlotSetup[] {
    const { slots } = lineupToSetup(this.slots, 'host', this.selfId);
    for (const c of this.ctrl.values()) c.send({ t: 'start', slots } satisfies CtrlMsg);
    this.onStart(slots);
    return slots;
  }

  /** Host: back to the room for everyone. */
  endMatch() {
    for (const c of this.ctrl.values()) c.send({ t: 'end' } satisfies CtrlMsg);
    this.onEnd();
  }

  /** Host: send a snapshot to every joiner, skipping anyone whose channel is backed up. */
  broadcastSnapshot(buf: ArrayBuffer) {
    for (const c of this.state.values()) {
      if (!c.open) continue;
      if ((c.dataChannel?.bufferedAmount ?? 0) > CONFIG.net.maxBufferedBytes) continue;
      c.send(buf);
    }
  }

  // ---------- client ----------

  private handleFromHost(msg: CtrlMsg) {
    if (msg.t === 'room') { this.slots = msg.slots; this.hostId = msg.hostId; this.onRoom(); }
    else if (msg.t === 'start') this.onStart(msg.slots);
    else if (msg.t === 'end') this.onEnd();
    else if (msg.t === 'kicked') this.close('The host removed you from the room.');
    else if (msg.t === 'bye') this.close('The host closed the room.');
  }

  sendCommand(buf: ArrayBuffer) {
    const c = this.state.get(this.hostId);
    if (c?.open) c.send(buf);
  }

  // ---------- both ----------

  /** Change your own robot or start spot, or move to an open slot. */
  setSelf(change: { typeId?: string; start?: StartPose; slot?: number }) {
    if (this.isHost) this.updatePlayer(this.selfId, change);
    else this.ctrl.get(this.hostId)?.send({ t: 'set', ...change } satisfies CtrlMsg);
  }

  private heartbeat() {
    const now = Date.now();
    for (const c of this.ctrl.values()) if (c.open) c.send({ t: 'ping' } satisfies CtrlMsg);
    for (const [id, t] of this.lastHeard) {
      if (now - t < TIMEOUT_MS) continue;
      if (this.isHost) this.dropPlayer(id);
      else this.close('Lost connection to the host.');
    }
  }

  close(reason = '') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    // Best effort: tell the others now rather than leaving them to time out.
    for (const c of this.ctrl.values()) if (c.open) c.send({ t: 'bye' } satisfies CtrlMsg);
    setTimeout(() => this.peer.destroy(), 100);
    this.onClosed(reason);
  }
}

const validType = (id: string) => (CONFIG.robotTypes.some((t) => t.id === id) ? id : CONFIG.robotTypes[0].id);

/** The room exists, but the two networks couldn't open a direct link and there's no relay to fall back on. */
const directFailure = () =>
  hasRelay()
    ? 'Found the room, but could not connect, even through the relay. Try another network.'
    : 'Found the room, but your network and the host’s can’t connect directly. Online play across these networks needs a TURN relay (see README).';

const cleanName = (n: string) => (n || 'Player').replace(/[<>&"]/g, '').slice(0, 16) || 'Player';

function describe(err: unknown): string {
  const type = (err as { type?: string })?.type;
  if (type === 'peer-unavailable') return 'No room with that code.';
  if (type === 'network' || type === 'server-error' || type === 'socket-error') return 'Could not reach the matchmaking service. Check your connection.';
  if (type === 'browser-incompatible') return 'This browser does not support WebRTC.';
  return (err as Error)?.message || 'Connection failed.';
}
