import { CONFIG, Alliance } from './config';
import type { Game } from './game';
import type { LobbyPlayer } from './net/session';
import { CAMERA_LABELS, CameraMode } from './camera';

const fmtClock = (s: number) => {
  const t = Math.ceil(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const AIM_LABEL = { score: 'Score', ferry: 'Ferry', none: 'No shot' } as const;

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

/** In-match overlay. Built once; update() only touches text and classes. */
export class Hud {
  private el: Record<string, HTMLElement> = {};
  private lastPeriod = '';
  private toastUntil = 0;

  constructor(private root: HTMLElement) {
    root.innerHTML = `
      <div class="scoreboard glass">
        <div class="team red">
          <div class="score" data-k="redScore">0</div>
          <div class="hub" data-k="redHub"></div>
        </div>
        <div class="clock">
          <div class="period" data-k="period">Auto</div>
          <div class="time" data-k="clock">0:20</div>
          <div class="progress"><span data-k="progress"></span></div>
        </div>
        <div class="team blue">
          <div class="score" data-k="blueScore">0</div>
          <div class="hub" data-k="blueHub"></div>
        </div>
      </div>
      <div class="toast" data-k="toast"></div>
      <div class="hopper glass">
        <div class="hop-top">
          <div>
            <div class="label">Hopper</div>
            <div class="count"><b data-k="hopperText">0</b><span data-k="hopperCap">/50</span></div>
          </div>
          <span class="aim" data-k="aim">Score</span>
        </div>
        <div class="meter"><span data-k="meter"></span></div>
        <div class="hop-foot"><span data-k="robotName"></span><span data-k="cam"></span></div>
      </div>
      <div class="keys glass">
        <div class="keys-title">Controls</div>
        <dl>
          <dt><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dt><dd>Drive</dd>
          <dt><kbd>J</kbd><kbd>L</kbd></dt><dd>Turn</dd>
          <dt><kbd>Shift</kbd></dt><dd>Intake</dd>
          <dt><kbd>Space</kbd></dt><dd>Shoot</dd>
          <dt><kbd>Tab</kbd></dt><dd>Camera</dd>
          <dt><kbd>R</kbd> <kbd>Esc</kbd></dt><dd>Restart · Menu</dd>
        </dl>
      </div>
      <div class="fps" data-k="fps"></div>
    `;
    root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
  }

  show(on: boolean) {
    this.root.style.display = on ? '' : 'none';
    this.lastPeriod = '';
  }

  update(game: Game, camera: CameraMode, fps: number) {
    const m = game.match, e = this.el, p = game.player;
    e.clock.textContent = fmtClock(m.isAuto ? m.autoEnd - m.time : m.remaining);
    const period = m.periodAt(m.time);
    const label = period ? period.label : m.isFinal ? 'Final' : 'Match over';
    e.period.textContent = label;
    e.progress.style.width = period ? `${(100 * (m.time - period.start)) / (period.end - period.start)}%` : '100%';
    e.redScore.textContent = String(m.score.red);
    e.blueScore.textContent = String(m.score.blue);
    for (const a of ['red', 'blue'] as Alliance[]) {
      const el = a === 'red' ? e.redHub : e.blueHub;
      const active = m.hubActive(a) && !m.isOver;
      const next = m.nextSwitch(a);
      const text = active ? 'Active' : 'Inactive';
      const timer = next !== null ? `${Math.ceil(next)}s` : '';
      if (el.dataset.text !== text + timer) {
        el.innerHTML = `<i></i>${text}${timer ? `<small>${timer}</small>` : ''}`;
        el.dataset.text = text + timer;
      }
      el.classList.toggle('on', active);
    }

    // A short toast when the period changes; nothing else needs announcing.
    if (label !== this.lastPeriod) {
      if (this.lastPeriod) this.toastUntil = performance.now() + 1800;
      e.toast.textContent = label === 'Transition Shift' ? 'Teleop' : label;
      this.lastPeriod = label;
    }
    e.toast.classList.toggle('on', performance.now() < this.toastUntil);

    e.hopperText.textContent = String(p.hopper);
    e.hopperCap.textContent = `/${p.capacity}`;
    e.meter.style.width = `${(100 * p.hopper) / p.capacity}%`;
    e.aim.textContent = AIM_LABEL[p.aimMode];
    e.aim.dataset.mode = p.aimMode;
    e.robotName.textContent = p.type.name;
    e.cam.textContent = `${CAMERA_LABELS[camera]} cam`;
    e.fps.textContent = `${fps.toFixed(0)} fps`;
  }
}

/** What the player picked on the menu. Remembered between visits. */
export interface Choice {
  typeId: string;
  alliance: Alliance;
  name: string;
}

export interface MenuActions {
  solo(c: Choice): void;
  host(c: Choice): void;
  join(code: string, c: Choice): void;
  /** In a lobby: change your own robot or alliance. */
  lobbyChange(change: { typeId?: string; alliance?: Alliance }): void;
  lobbyStart(): void;
  leave(): void;
  again(): void;
  backToLobby(): void;
  toMenu(): void;
}

export interface LobbyView {
  code: string;
  isHost: boolean;
  selfId: string;
  players: LobbyPlayer[];
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const typeName = (id: string) => CONFIG.robotTypes.find((t) => t.id === id)?.name ?? id;

function loadChoice(): Choice {
  const fallback: Choice = { typeId: CONFIG.robotTypes[0].id, alliance: 'red', name: '' };
  try {
    const saved = JSON.parse(localStorage.getItem('nml.choice') ?? 'null');
    return saved ? { ...fallback, ...saved } : fallback;
  } catch {
    return fallback;
  }
}

function saveChoice(c: Choice) {
  try { localStorage.setItem('nml.choice', JSON.stringify(c)); } catch { /* private mode: fine */ }
}

/** Robot picker and play options, the online lobby, and the results screen. */
export class Menu {
  readonly choice: Choice = loadChoice();
  private code = '';

  constructor(private root: HTMLElement, private actions: MenuActions) {}

  hide() {
    this.root.innerHTML = '';
    this.root.style.display = 'none';
  }

  private robotCards(selected: string) {
    return CONFIG.robotTypes
      .map((t) => `<button class="robot ${selected === t.id ? 'on' : ''}" data-type="${t.id}">
        <span class="art">${ROBOT_ART[t.shooter.kind] ?? ''}</span>
        <span class="name">${t.name}</span><span class="blurb">${t.blurb}</span></button>`)
      .join('');
  }

  private allianceToggle(selected: Alliance) {
    return `<div class="segmented">
      <button class="red ${selected === 'red' ? 'on' : ''}" data-alliance="red">Red</button>
      <button class="blue ${selected === 'blue' ? 'on' : ''}" data-alliance="blue">Blue</button>
    </div>`;
  }

  private brand() {
    return `<header class="brand">
      <div class="badge">FRC 2026 · REBUILT</div>
      <h1>No Man's<br/><em>Land</em></h1>
      <p>Match simulator</p>
    </header>`;
  }

  /** Main menu. `message` shows a status or error line (e.g. "No room with that code"). */
  showPicker(message = '') {
    const c = this.choice;
    this.root.style.display = '';
    this.root.innerHTML = `
      <div class="menu">
        ${this.brand()}
        <section class="card glass">
          <div class="field-label">Robot</div>
          <div class="robots">${this.robotCards(c.typeId)}</div>
          <div class="field-label">Alliance</div>
          ${this.allianceToggle(c.alliance)}
          <button class="primary" data-solo>Start solo match <span aria-hidden="true">→</span></button>
          <div class="field-label">Play online</div>
          <div class="online">
            <input class="text" data-name maxlength="16" placeholder="Your name" value="${esc(c.name)}" aria-label="Your name" />
            <button class="ghost" data-host>Host a room</button>
            <div class="join">
              <input class="text code" data-code maxlength="${CONFIG.net.codeLength}" placeholder="CODE" value="${esc(this.code)}" aria-label="Room code" />
              <button class="ghost" data-join>Join</button>
            </div>
          </div>
          <div class="status ${message ? 'on' : ''}" role="status">${esc(message)}</div>
          <div class="hint"><kbd>WASD</kbd> drive <kbd>J</kbd><kbd>L</kbd> turn <kbd>Shift</kbd> intake <kbd>Space</kbd> shoot · gamepad supported</div>
        </section>
      </div>`;
    const name = this.root.querySelector<HTMLInputElement>('[data-name]')!;
    const code = this.root.querySelector<HTMLInputElement>('[data-code]')!;
    const remember = () => { c.name = name.value.trim(); this.code = code.value.trim().toUpperCase(); saveChoice(c); };
    name.addEventListener('input', remember);
    code.addEventListener('input', () => { code.value = code.value.toUpperCase(); remember(); });
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { remember(); this.actions.join(this.code, { ...c }); } });
    this.root.querySelectorAll<HTMLElement>('[data-type]').forEach((b) =>
      b.addEventListener('click', () => { remember(); c.typeId = b.dataset.type!; saveChoice(c); this.showPicker(); }));
    this.root.querySelectorAll<HTMLElement>('[data-alliance]').forEach((b) =>
      b.addEventListener('click', () => { remember(); c.alliance = b.dataset.alliance as Alliance; saveChoice(c); this.showPicker(); }));
    this.root.querySelector('[data-solo]')!.addEventListener('click', () => { remember(); this.actions.solo({ ...c }); });
    this.root.querySelector('[data-host]')!.addEventListener('click', () => { remember(); this.actions.host({ ...c }); });
    this.root.querySelector('[data-join]')!.addEventListener('click', () => {
      remember();
      if (this.code.length < CONFIG.net.codeLength) { this.showPicker('Enter the room code from the host.'); return; }
      this.actions.join(this.code, { ...c });
    });
  }

  /** A full-screen "Connecting..." card. */
  showStatus(text: string) {
    this.root.style.display = '';
    this.root.innerHTML = `
      <div class="menu results">
        <section class="card glass"><div class="field-label">Online</div><div class="connecting">${esc(text)}</div>
          <button class="ghost" data-cancel>Cancel</button></section>
      </div>`;
    this.root.querySelector('[data-cancel]')!.addEventListener('click', () => this.actions.leave());
  }

  showLobby(v: LobbyView) {
    const me = v.players.find((p) => p.id === v.selfId);
    const list = (a: Alliance) => {
      const team = v.players.filter((p) => p.alliance === a);
      const rows = [0, 1, 2].map((i) => {
        const p = team[i];
        if (!p) return `<li class="empty">Open · parked robot</li>`;
        const tags = `${p.id === v.selfId ? '<b>You</b>' : ''}${p.id === v.players[0]?.id ? '<b>Host</b>' : ''}`;
        return `<li><span>${esc(p.name)}</span>${tags}<i>${typeName(p.typeId)}</i></li>`;
      });
      return `<div class="team-list ${a}"><div class="team-head">${a === 'red' ? 'Red' : 'Blue'} alliance</div><ol>${rows.join('')}</ol></div>`;
    };
    this.root.style.display = '';
    this.root.innerHTML = `
      <div class="menu">
        <header class="brand lobby-brand">
          <div class="badge">Room code</div>
          <h1 class="room-code">${esc(v.code)}</h1>
          <p>${v.isHost ? 'Share this code. Friends join from the main menu.' : 'Waiting for the host to start the match.'}</p>
          <button class="ghost copy" data-copy>Copy code</button>
        </header>
        <section class="card glass">
          <div class="teams">${list('red')}${list('blue')}</div>
          <div class="field-label">Your robot</div>
          <div class="robots">${this.robotCards(me?.typeId ?? this.choice.typeId)}</div>
          <div class="field-label">Your alliance</div>
          ${this.allianceToggle(me?.alliance ?? this.choice.alliance)}
          ${v.isHost
            ? '<button class="primary" data-start>Start match <span aria-hidden="true">→</span></button>'
            : '<div class="connecting waiting">Waiting for the host…</div>'}
          <button class="ghost leave" data-leave>Leave room</button>
        </section>
      </div>`;
    this.root.querySelectorAll<HTMLElement>('[data-type]').forEach((b) =>
      b.addEventListener('click', () => { this.choice.typeId = b.dataset.type!; saveChoice(this.choice); this.actions.lobbyChange({ typeId: b.dataset.type! }); }));
    this.root.querySelectorAll<HTMLElement>('[data-alliance]').forEach((b) =>
      b.addEventListener('click', () => { this.choice.alliance = b.dataset.alliance as Alliance; saveChoice(this.choice); this.actions.lobbyChange({ alliance: b.dataset.alliance as Alliance }); }));
    this.root.querySelector('[data-start]')?.addEventListener('click', () => this.actions.lobbyStart());
    this.root.querySelector('[data-leave]')!.addEventListener('click', () => this.actions.leave());
    const copy = this.root.querySelector<HTMLButtonElement>('[data-copy]')!;
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(v.code).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = v.code; });
    });
  }

  /** online: null for solo; otherwise whether this player hosts (only the host restarts). */
  showResults(game: Game, online: { isHost: boolean } | null) {
    const m = game.match, mine = game.alliance;
    const theirs = mine === 'red' ? 'blue' : 'red';
    const outcome = m.score[mine] > m.score[theirs] ? 'Victory' : m.score[mine] < m.score[theirs] ? 'Defeat' : 'Draw';
    const buttons = !online
      ? `<button class="primary" data-again>Play again <kbd>R</kbd></button>
         <button class="ghost" data-menu>Change robot <kbd>Esc</kbd></button>`
      : online.isHost
        ? `<button class="primary" data-again>Play again <kbd>R</kbd></button>
           <button class="ghost" data-lobby>Back to lobby <kbd>Esc</kbd></button>`
        : `<div class="connecting waiting">Waiting for the host…</div>
           <button class="ghost" data-leave>Leave room</button>`;
    this.root.style.display = '';
    this.root.innerHTML = `
      <div class="menu results">
        <section class="card glass">
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
      </div>`;
    this.root.querySelector('[data-again]')?.addEventListener('click', () => this.actions.again());
    this.root.querySelector('[data-menu]')?.addEventListener('click', () => this.actions.toMenu());
    this.root.querySelector('[data-lobby]')?.addEventListener('click', () => this.actions.backToLobby());
    this.root.querySelector('[data-leave]')?.addEventListener('click', () => this.actions.leave());
  }
}
