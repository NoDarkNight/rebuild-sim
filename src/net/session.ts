import Peer, { type DataConnection } from 'peerjs';
import { CONFIG, Alliance } from '../config';
import { parkedSlot, SLOTS_PER_ALLIANCE, type SlotSetup } from '../game';
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

export interface LobbyPlayer {
  id: string;
  name: string;
  alliance: Alliance;
  typeId: string;
}

type CtrlMsg =
  | { t: 'hello'; name: string; alliance: Alliance; typeId: string }
  | { t: 'set'; alliance?: Alliance; typeId?: string }
  | { t: 'lobby'; players: LobbyPlayer[]; hostId: string }
  | { t: 'start'; slots: SlotSetup[] }
  | { t: 'end' }
  | { t: 'full' };

const MAX_PLAYERS = SLOTS_PER_ALLIANCE * 2;
const ID_PREFIX = 'nomansland-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

const randomCode = () => Array.from({ length: CONFIG.net.codeLength }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

export class NetSession {
  players: LobbyPlayer[] = [];
  hostId = '';

  onLobby: (players: LobbyPlayer[]) => void = () => {};
  onStart: (slots: SlotSetup[]) => void = () => {};
  onEnd: () => void = () => {};
  onSnapshot: (buf: ArrayBuffer) => void = () => {};
  onCommand: (playerId: string, buf: ArrayBuffer) => void = () => {};
  onClosed: (reason: string) => void = () => {};

  private ctrl = new Map<string, DataConnection>();
  private state = new Map<string, DataConnection>();
  private closed = false;

  private constructor(readonly role: 'host' | 'client', readonly code: string, private peer: Peer) {}

  get selfId() {
    return this.peer.id;
  }
  get self() {
    return this.players.find((p) => p.id === this.selfId);
  }

  // ---------- setup ----------

  static async host(name: string, typeId: string, alliance: Alliance): Promise<NetSession> {
    const config = { iceServers: await iceServers() };
    return new Promise((resolve, reject) => {
      const tryCode = (attempt: number) => {
        const code = randomCode();
        const peer = new Peer(ID_PREFIX + code.toLowerCase(), { config });
        peer.once('open', () => {
          const s = new NetSession('host', code, peer);
          s.hostId = peer.id;
          s.players = [{ id: peer.id, name, alliance, typeId }];
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

  static async join(code: string, name: string, typeId: string, alliance: Alliance): Promise<NetSession> {
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
        const s = new NetSession('client', code.trim().toUpperCase(), peer);
        s.hostId = hostPeerId;
        const ctrl = peer.connect(hostPeerId, { label: 'ctrl', reliable: true, serialization: 'json' });
        ctrlConn = ctrl;
        const state = peer.connect(hostPeerId, { label: 'state', reliable: false, serialization: 'raw' });
        s.ctrl.set(hostPeerId, ctrl);
        s.state.set(hostPeerId, state);
        state.on('data', (d) => s.onSnapshot(d as ArrayBuffer));
        ctrl.on('iceStateChanged', (st) => { if (st === 'failed') fail(directFailure()); });
        let joined = false;
        ctrl.on('open', () => ctrl.send({ t: 'hello', name, alliance, typeId } satisfies CtrlMsg));
        ctrl.on('data', (d) => {
          const msg = d as CtrlMsg;
          if (msg.t === 'full') { fail('That room is full (6 players).'); return; }
          if (!joined && msg.t === 'lobby') { joined = true; clearTimeout(timer); resolve(s); }
          s.handleFromHost(msg);
        });
        ctrl.on('close', () => s.close('The host left the match.'));
        peer.on('disconnected', () => s.close('Lost connection to the host.'));
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
      if (this.players.length >= MAX_PLAYERS) { conn.send({ t: 'full' } satisfies CtrlMsg); setTimeout(() => conn.close(), 300); return; }
      this.ctrl.set(conn.peer, conn);
      this.players.push({ id: conn.peer, name: cleanName(msg.name), alliance: this.allianceWithRoom(msg.alliance), typeId: msg.typeId });
      this.broadcastLobby();
    } else if (msg.t === 'set') {
      this.updatePlayer(conn.peer, msg);
    }
  }

  private updatePlayer(id: string, change: { alliance?: Alliance; typeId?: string }) {
    const p = this.players.find((q) => q.id === id);
    if (!p) return;
    if (change.typeId) p.typeId = change.typeId;
    if (change.alliance && change.alliance !== p.alliance && this.count(change.alliance) < SLOTS_PER_ALLIANCE) p.alliance = change.alliance;
    this.broadcastLobby();
  }

  private count(a: Alliance) {
    return this.players.filter((p) => p.alliance === a).length;
  }

  private allianceWithRoom(wanted: Alliance): Alliance {
    if (this.count(wanted) < SLOTS_PER_ALLIANCE) return wanted;
    return wanted === 'red' ? 'blue' : 'red';
  }

  private dropPlayer(id: string) {
    this.ctrl.delete(id);
    this.state.get(id)?.close();
    this.state.delete(id);
    const before = this.players.length;
    this.players = this.players.filter((p) => p.id !== id);
    if (this.players.length !== before) this.broadcastLobby();
  }

  private broadcastLobby() {
    const msg: CtrlMsg = { t: 'lobby', players: this.players, hostId: this.hostId };
    for (const c of this.ctrl.values()) c.send(msg);
    this.onLobby(this.players);
  }

  /** Host: assign slots in join order per alliance, fill the rest with parked robots, and start everyone. */
  startMatch(): SlotSetup[] {
    const slots: SlotSetup[] = [];
    for (const [k, a] of (['red', 'blue'] as Alliance[]).entries()) {
      const team = this.players.filter((p) => p.alliance === a);
      for (let i = 0; i < SLOTS_PER_ALLIANCE; i++) {
        const idx = k * SLOTS_PER_ALLIANCE + i, p = team[i];
        slots.push(p ? { ...parkedSlot(idx), typeId: p.typeId, driver: p.id, name: p.name } : parkedSlot(idx));
      }
    }
    for (const c of this.ctrl.values()) c.send({ t: 'start', slots } satisfies CtrlMsg);
    this.onStart(slots);
    return slots;
  }

  /** Host: back to the lobby for everyone. */
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
    if (msg.t === 'lobby') { this.players = msg.players; this.hostId = msg.hostId; this.onLobby(this.players); }
    else if (msg.t === 'start') this.onStart(msg.slots);
    else if (msg.t === 'end') this.onEnd();
  }

  sendCommand(buf: ArrayBuffer) {
    const c = this.state.get(this.hostId);
    if (c?.open) c.send(buf);
  }

  // ---------- both ----------

  /** Change your own alliance or robot in the lobby. */
  setSelf(change: { alliance?: Alliance; typeId?: string }) {
    if (this.role === 'host') this.updatePlayer(this.selfId, change);
    else this.ctrl.get(this.hostId)?.send({ t: 'set', ...change } satisfies CtrlMsg);
  }

  close(reason = '') {
    if (this.closed) return;
    this.closed = true;
    this.peer.destroy();
    this.onClosed(reason);
  }
}

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
