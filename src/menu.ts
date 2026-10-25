import { CONFIG, Alliance } from './config';
import type { Game } from './game';
import { FieldMap } from './fieldMap';
import { allianceSlots, emptyLineup, slotLabel, type LineupSlot, type StartPose } from './lineup';

/** Line-art robot portraits for the picker, keyed by shooter kind. */
const ROBOT_ART: Record<string, string> = {
  turret: `<svg viewBox="0 0 120 72" aria-hidden="true">
    <rect class="bumper" x="8" y="50" width="88" height="12" rx="3"/>
    <rect class="shell" x="14" y="24" width="96" height="26" rx="2"/>
    <rect class="metal" x="46" y="12" width="26" height="12" rx="6"/>
    <path class="metal" d="M64 14 L90 4 L93 10 L68 20 Z"/></svg>`,
  dumper: `<svg viewBox="0 0 120 72" aria-hidden="true">
    <rect class="bumper" x="8" y="50" width="88" height="12" rx="3"/>
    <rect class="shell" x="14" y="24" width="96" height="26" rx="2"/>
    <circle class="metal" cx="92" cy="20" r="6"/>
    <path class="hood" d="M78 18 A16 16 0 0 1 108 12" /></svg>`,
};

/** What the player picked. Remembered between visits. */
export interface Profile {
  /** The robot. The robot builder will replace this with a design reference. */
  typeId: string;
  name: string;
  /** Singleplayer: which slot you drive and where each robot starts. */
  solo: { slot: number; starts: StartPose[] };
}

export interface RoomChange {
  typeId?: string;
  start?: StartPose;
  slot?: number;
}

export interface MenuActions {
  solo(lineup: LineupSlot[]): void;
  host(p: Profile): void;
  join(code: string, p: Profile): void;
  room: {
    /** Your own robot, start spot, or move to an open slot. */
    setSelf(change: RoomChange): void;
    /** Host only from here down. */
    move(from: number, to: number): void;
    kick(slot: number): void;
    setStart(slot: number, pose: StartPose): void;
    start(): void;
  };
  leave(): void;
  again(): void;
  backToRoom(): void;
  toSolo(): void;
}

export interface RoomView {
  code: string;
  isHost: boolean;
  selfId: string;
  hostId: string;
  slots: LineupSlot[];
}

type Screen = 'title' | 'solo' | 'online' | 'status' | 'room' | 'results' | 'hidden';

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const typeName = (id: string) => CONFIG.robotTypes.find((t) => t.id === id)?.name ?? id;
const short = (name: string) => (name.length > 10 ? name.slice(0, 9) + '…' : name);
const ARROW = '<span aria-hidden="true">→</span>';

function loadProfile(): Profile {
  const fallback: Profile = { typeId: CONFIG.robotTypes[0].id, name: '', solo: { slot: 0, starts: emptyLineup().map((s) => s.start) } };
  try {
    const saved = JSON.parse(localStorage.getItem('nml.profile') ?? 'null');
    if (!saved) return fallback;
    const p: Profile = { ...fallback, ...saved, solo: { ...fallback.solo, ...saved.solo } };
    if (!CONFIG.robotTypes.some((t) => t.id === p.typeId)) p.typeId = fallback.typeId;
    if (p.solo.starts.length !== fallback.solo.starts.length) p.solo.starts = fallback.solo.starts;
    return p;
  } catch {
    return fallback;
  }
}

/** Title, singleplayer setup, multiplayer, the room, and results. The 3D field idles behind them. */
export class Menu {
  readonly profile: Profile = loadProfile();
  private screen: Screen = 'hidden';
  private code = '';
  private map = new FieldMap();
  private soloSlots: LineupSlot[] = [];
  private room: RoomView | null = null;
  /** Host: the slot picked to move, or -1. */
  private picked = -1;

  constructor(private root: HTMLElement, private actions: MenuActions) {}

  private save() {
    try { localStorage.setItem('nml.profile', JSON.stringify(this.profile)); } catch { /* private mode: fine */ }
  }

  private show(screen: Screen, html: string) {
    this.screen = screen;
    this.root.style.display = '';
    this.root.innerHTML = html;
  }

  hide() {
    this.screen = 'hidden';
    this.root.innerHTML = '';
    this.root.style.display = 'none';
  }

  /** Esc on a menu screen. */
  back() {
    if (this.screen === 'solo' || this.screen === 'online') this.showTitle();
  }

  // ---------- title ----------

  showTitle() {
    this.show('title', `
      <div class="screen title-screen">
        <header class="brand">
          <div class="badge">FRC 2026 · REBUILT</div>
          <h1>No Man's<br/><em>Land</em></h1>
          <p>Match simulator</p>
        </header>
        <nav class="modes">
          <button class="mode" data-go="solo"><b>Singleplayer</b>${ARROW}</button>
          <button class="mode" data-go="online"><b>Multiplayer</b>${ARROW}</button>
        </nav>
      </div>`);
    this.root.querySelector('[data-go="solo"]')!.addEventListener('click', () => this.showSolo());
    this.root.querySelector('[data-go="online"]')!.addEventListener('click', () => this.showOnline());
  }

  private head(title: string) {
    return `<header class="screen-head"><button class="back" data-back>← Back</button><h2>${title}</h2></header>`;
  }

  // ---------- singleplayer ----------

  showSolo() {
    const p = this.profile;
    this.soloSlots = emptyLineup().map((s, i) => ({ ...s, start: { ...p.solo.starts[i] } }));
    const me = this.soloSlots[p.solo.slot];
    me.occupant = { kind: 'player', id: 'local', name: p.name || 'You' };
    me.typeId = p.typeId;
    this.show('solo', `
      <div class="screen setup">
        ${this.head('Singleplayer')}
        <div class="setup-grid">
          <section class="card">
            <div class="field-label">Robot</div>
            <div class="robots" data-robots></div>
            <div class="field-label">Alliances</div>
            <div data-lineup></div>
            <div class="note">Click a slot to drive from there. Empty slots get parked robots.</div>
          </section>
          <section class="card map-card">
            <div class="field-label">Starting spots</div>
            <div data-map></div>
            <div class="note">Drag a robot to place it. Hold <kbd>J</kbd> or <kbd>L</kbd> to turn it.</div>
          </section>
        </div>
        <footer class="setup-foot"><span></span><button class="primary" data-start>Start match ${ARROW}</button></footer>
      </div>`);
    this.root.querySelector('[data-map]')!.append(this.map.el);
    this.map.onMove = (i, pose) => {
      this.soloSlots[i].start = pose;
      p.solo.starts[i] = pose;
      this.save();
    };
    this.root.querySelector('[data-back]')!.addEventListener('click', () => this.showTitle());
    this.root.querySelector('[data-start]')!.addEventListener('click', () => this.actions.solo(this.soloSlots));
    this.root.querySelector('[data-robots]')!.addEventListener('click', (e) => {
      const id = (e.target as Element).closest<HTMLElement>('[data-type]')?.dataset.type;
      if (!id) return;
      p.typeId = this.soloSlots[p.solo.slot].typeId = id;
      this.save();
      this.refreshSolo();
    });
    this.root.querySelector('[data-lineup]')!.addEventListener('click', (e) => {
      const i = slotOf(e);
      if (i < 0 || this.soloSlots[i].occupant) return;
      const from = p.solo.slot, a = this.soloSlots[from], b = this.soloSlots[i];
      this.soloSlots[from] = { ...a, occupant: null, typeId: b.typeId };
      this.soloSlots[i] = { ...b, occupant: a.occupant, typeId: a.typeId };
      p.solo.slot = i;
      this.save();
      this.refreshSolo();
    });
    this.refreshSolo();
  }

  private refreshSolo() {
    const self = this.profile.solo.slot;
    this.html('[data-robots]', this.robotCards(this.soloSlots[self].typeId));
    this.html('[data-lineup]', this.lineup(this.soloSlots, { self, isHost: false, hostId: '', solo: true }));
    this.map.update(this.soloSlots, { self, canMove: () => true, label: (i) => (i === self ? 'You' : slotLabel(i)) });
  }

  // ---------- multiplayer ----------

  /** `message` shows a status or error line, such as "No room with that code." */
  showOnline(message = '', code?: string) {
    if (code !== undefined) this.code = code.toUpperCase();
    const p = this.profile;
    this.show('online', `
      <div class="screen narrow">
        ${this.head('Multiplayer')}
        <section class="card">
          <div class="field-label">Your name</div>
          <input class="text" data-name maxlength="16" placeholder="Player" value="${esc(p.name)}" aria-label="Your name" />
          <button class="primary" data-host>Create private room ${ARROW}</button>
          <div class="divider"><span>or join one</span></div>
          <div class="join">
            <input class="text code" data-code maxlength="${CONFIG.net.codeLength}" placeholder="CODE" value="${esc(this.code)}" aria-label="Room code" />
            <button class="ghost" data-join>Join</button>
          </div>
          <div class="status ${message ? 'on' : ''}" role="status">${esc(message)}</div>
        </section>
      </div>`);
    const name = this.root.querySelector<HTMLInputElement>('[data-name]')!;
    const codeIn = this.root.querySelector<HTMLInputElement>('[data-code]')!;
    const remember = () => { p.name = name.value.trim(); this.code = codeIn.value.trim().toUpperCase(); this.save(); };
    const join = () => {
      remember();
      if (this.code.length < CONFIG.net.codeLength) { this.showOnline('Enter the room code from the host.'); return; }
      this.actions.join(this.code, { ...p });
    };
    name.addEventListener('input', remember);
    codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.toUpperCase(); remember(); });
    codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    this.root.querySelector('[data-back]')!.addEventListener('click', () => this.showTitle());
    this.root.querySelector('[data-host]')!.addEventListener('click', () => { remember(); this.actions.host({ ...p }); });
    this.root.querySelector('[data-join]')!.addEventListener('click', join);
    (this.code ? codeIn : name).focus();
  }

  /** A full-screen "Connecting..." card. */
  showStatus(text: string) {
    this.show('status', `
      <div class="screen narrow">
        <section class="card"><div class="field-label">Online</div><div class="connecting">${esc(text)}</div>
          <button class="ghost" data-cancel>Cancel</button></section>
      </div>`);
    this.root.querySelector('[data-cancel]')!.addEventListener('click', () => this.actions.leave());
  }

  // ---------- room ----------

  showRoom(v: RoomView) {
    const fresh = this.screen !== 'room' || this.room?.code !== v.code;
    this.room = v;
    if (!fresh) { this.refreshRoom(); return; }
    this.picked = -1;
    this.show('room', `
      <div class="screen setup">
        <header class="screen-head room-head">
          <button class="back" data-leave>← Leave</button>
          <div class="room-id"><span class="field-label">Room</span><b class="room-code">${esc(v.code)}</b></div>
          <div class="room-tools">
            <button class="ghost small" data-copy>Copy code</button>
            <button class="ghost small" data-link>Copy invite link</button>
          </div>
        </header>
        <div class="setup-grid">
          <section class="card">
            <div class="field-label">Alliances</div>
            <div data-lineup></div>
            <div class="note" data-note></div>
            <div class="field-label">Your robot</div>
            <div class="robots" data-robots></div>
          </section>
          <section class="card map-card">
            <div class="field-label">Starting spots</div>
            <div data-map></div>
            <div class="note">Drag your robot to place it. Hold <kbd>J</kbd> or <kbd>L</kbd> to turn it.</div>
          </section>
        </div>
        <footer class="setup-foot"><span></span><div data-startbox></div></footer>
      </div>`);
    this.root.querySelector('[data-map]')!.append(this.map.el);
    this.map.onMove = (i, pose) => {
      const r = this.room!;
      if (i === selfSlot(r)) this.actions.room.setSelf({ start: pose });
      else if (r.isHost) this.actions.room.setStart(i, pose);
    };
    this.root.querySelector('[data-leave]')!.addEventListener('click', () => this.actions.leave());
    this.copyButton('[data-copy]', () => v.code);
    this.copyButton('[data-link]', () => `${location.origin}${location.pathname}?room=${v.code}`);
    this.root.querySelector('[data-robots]')!.addEventListener('click', (e) => {
      const id = (e.target as Element).closest<HTMLElement>('[data-type]')?.dataset.type;
      if (!id) return;
      this.profile.typeId = id;
      this.save();
      this.actions.room.setSelf({ typeId: id });
    });
    const lineup = this.root.querySelector<HTMLElement>('[data-lineup]')!;
    lineup.addEventListener('click', (e) => this.roomClick(e));
    lineup.addEventListener('dragstart', (e) => { this.picked = slotOf(e); e.dataTransfer?.setData('text/plain', String(this.picked)); });
    lineup.addEventListener('dragover', (e) => { if (this.picked >= 0) e.preventDefault(); });
    lineup.addEventListener('drop', (e) => {
      e.preventDefault();
      const to = slotOf(e);
      if (this.picked >= 0 && to >= 0) this.actions.room.move(this.picked, to);
      this.picked = -1;
      this.refreshRoom();
    });
    this.root.querySelector('[data-startbox]')!.addEventListener('click', (e) => {
      if ((e.target as Element).closest('[data-start]')) this.actions.room.start();
    });
    this.refreshRoom();
  }

  private roomClick(e: Event) {
    const r = this.room!, t = e.target as Element;
    const kick = t.closest<HTMLElement>('[data-kick]');
    if (kick) { this.actions.room.kick(Number(kick.dataset.kick)); return; }
    const i = slotOf(e);
    if (i < 0) return;
    const occupied = !!r.slots[i].occupant;
    if (r.isHost && this.picked >= 0) {
      if (i !== this.picked) this.actions.room.move(this.picked, i);
      this.picked = -1;
    } else if (r.isHost && occupied) {
      this.picked = i;
    } else if (!occupied) {
      this.actions.room.setSelf({ slot: i });
    }
    this.refreshRoom();
  }

  private refreshRoom() {
    const r = this.room!, self = selfSlot(r);
    if (this.picked >= 0 && !r.slots[this.picked]?.occupant) this.picked = -1;
    this.html('[data-lineup]', this.lineup(r.slots, { self, isHost: r.isHost, hostId: r.hostId, solo: false }));
    this.html('[data-robots]', this.robotCards(r.slots[self]?.typeId ?? this.profile.typeId));
    const picked = r.slots[this.picked]?.occupant;
    this.html('[data-note]', !r.isHost
      ? 'Click an open slot to switch.'
      : picked?.kind === 'player'
        ? `Now click where ${esc(picked.name)} should go.`
        : 'Click a player, then a slot, to move them.');
    this.html('[data-startbox]', r.isHost
      ? `<button class="primary" data-start>Start match ${ARROW}</button>`
      : '<div class="waiting">Waiting for the host to start…</div>');
    this.map.update(r.slots, {
      self,
      canMove: (i) => i === self || r.isHost,
      label: (i) => {
        const o = r.slots[i].occupant;
        return i === self ? 'You' : o?.kind === 'player' ? short(o.name) : slotLabel(i);
      },
    });
  }

  // ---------- shared pieces ----------

  private html(sel: string, html: string) {
    const el = this.root.querySelector(sel);
    if (el) el.innerHTML = html;
  }

  private copyButton(sel: string, text: () => string) {
    const b = this.root.querySelector<HTMLButtonElement>(sel)!;
    const label = b.textContent;
    b.addEventListener('click', () => {
      navigator.clipboard?.writeText(text()).then(() => {
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = label), 1400);
      }, () => { b.textContent = text(); });
    });
  }

  /** Robot choice. The robot builder will replace this panel; everything after it only sees a typeId. */
  private robotCards(selected: string) {
    return CONFIG.robotTypes
      .map((t) => `<button class="robot ${selected === t.id ? 'on' : ''}" data-type="${t.id}">
        <span class="art">${ROBOT_ART[t.shooter.kind] ?? ''}</span>
        <span class="name">${t.name}</span><span class="blurb">${t.blurb}</span></button>`)
      .join('');
  }

  /** Both alliances' three slots. Bot rows are ready for AI drivers; nothing creates them yet. */
  private lineup(slots: LineupSlot[], o: { self: number; isHost: boolean; hostId: string; solo: boolean }) {
    const row = (i: number) => {
      const s = slots[i], occ = s.occupant, me = i === o.self;
      const cls = ['slot', occ ? '' : 'open', me ? 'me' : '', i === this.picked ? 'picked' : '', occ || !me ? 'clickable' : ''];
      let who: string, tags = '', extra = '';
      if (occ?.kind === 'player') {
        who = esc(me && o.solo ? 'You' : occ.name);
        if (me && !o.solo) tags += '<b>You</b>';
        if (!o.solo && occ.id === o.hostId) tags += '<b>Host</b>';
        if (o.isHost && !me) extra = `<button class="kick" data-kick="${i}" title="Remove from room" aria-label="Remove ${esc(occ.name)}">×</button>`;
      } else if (occ?.kind === 'bot') {
        who = 'AI';
        tags = '<b>Bot</b>';
      } else {
        who = o.solo ? 'Parked' : 'Open';
        if (o.isHost || o.solo) extra = '<button class="add-ai" disabled title="AI drivers are coming">+ AI</button>';
      }
      const drag = o.isHost && occ ? 'draggable="true"' : '';
      return `<li class="${cls.filter(Boolean).join(' ')}" data-slot="${i}" ${drag}>
        <span class="pos">${(i % 3) + 1}</span><span class="who">${who}</span>${tags}
        <i>${occ ? typeName(s.typeId) : ''}</i>${extra}</li>`;
    };
    const team = (a: Alliance) => `<div class="alliance ${a}"><div class="alliance-head">${a === 'red' ? 'Red' : 'Blue'}</div>
      <ol>${allianceSlots(a).map(row).join('')}</ol></div>`;
    return `<div class="alliances">${team('red')}${team('blue')}</div>`;
  }

  // ---------- results ----------

  /** online: null for solo; otherwise whether this player hosts (only the host restarts). */
  showResults(game: Game, online: { isHost: boolean } | null) {
    const m = game.match, mine = game.alliance;
    const theirs = mine === 'red' ? 'blue' : 'red';
    const outcome = m.score[mine] > m.score[theirs] ? 'Victory' : m.score[mine] < m.score[theirs] ? 'Defeat' : 'Draw';
    const buttons = !online
      ? `<button class="primary" data-again>Play again <kbd>R</kbd></button>
         <button class="ghost" data-solo>Change setup <kbd>Esc</kbd></button>`
      : online.isHost
        ? `<button class="primary" data-again>Play again <kbd>R</kbd></button>
           <button class="ghost" data-room>Back to room <kbd>Esc</kbd></button>`
        : `<div class="waiting">Waiting for the host…</div>
           <button class="ghost" data-leave>Leave room</button>`;
    this.show('results', `
      <div class="screen narrow results">
        <section class="card">
          <div class="field-label">Final</div>
          <div class="outcome ${outcome.toLowerCase()}">${outcome}</div>
          <div class="final"><span class="red">${m.score.red}</span><i>:</i><span class="blue">${m.score.blue}</span></div>
          <dl class="stats">
            <div><dt>Red Fuel</dt><dd>${m.fuelScored.red}</dd></div>
            <div><dt>Blue Fuel</dt><dd>${m.fuelScored.blue}</dd></div>
            <div><dt>You shot</dt><dd>${game.player.shotsFired}</dd></div>
          </dl>
          <div class="actions">${buttons}</div>
        </section>
      </div>`);
    this.root.querySelector('[data-again]')?.addEventListener('click', () => this.actions.again());
    this.root.querySelector('[data-solo]')?.addEventListener('click', () => this.actions.toSolo());
    this.root.querySelector('[data-room]')?.addEventListener('click', () => this.actions.backToRoom());
    this.root.querySelector('[data-leave]')?.addEventListener('click', () => this.actions.leave());
  }
}

const slotOf = (e: Event) => {
  const el = (e.target as Element).closest?.('[data-slot]');
  return el ? Number(el.getAttribute('data-slot')) : -1;
};

const selfSlot = (r: RoomView) => r.slots.findIndex((s) => s.occupant?.kind === 'player' && s.occupant.id === r.selfId);
