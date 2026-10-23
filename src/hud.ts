import { CONFIG, Alliance } from './config';
import type { Game, GameSetup } from './game';
import { CAMERA_LABELS, CameraMode } from './camera';

const fmtClock = (s: number) => {
  const t = Math.ceil(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** In-match overlay. Built once; update() only touches text and classes. */
export class Hud {
  private el: Record<string, HTMLElement> = {};

  constructor(private root: HTMLElement) {
    root.innerHTML = `
      <div class="scorebar">
        <div class="side red">
          <div class="score" data-k="redScore">0</div>
          <div class="hubstate" data-k="redHub"></div>
        </div>
        <div class="clock">
          <div class="time" data-k="clock">2:40</div>
          <div class="period" data-k="period">Auto</div>
        </div>
        <div class="side blue">
          <div class="score" data-k="blueScore">0</div>
          <div class="hubstate" data-k="blueHub"></div>
        </div>
      </div>
      <div class="hopper">
        <div class="label"><span data-k="robotName"></span><span data-k="hopperText"></span></div>
        <div class="bar"><div class="fill" data-k="hopperFill"></div></div>
        <div class="sub" data-k="sub"></div>
      </div>
      <div class="help">
        <b>WASD</b> move · <b>Q/E</b> rotate · <b>Space</b> intake · <b>Shift/LMB</b> shoot<br/>
        <b>Tab</b> camera · <b>R</b> restart · <b>Esc</b> menu
      </div>
      <div class="fps" data-k="fps"></div>
      <div class="banner" data-k="banner"></div>
    `;
    root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
  }

  show(on: boolean) {
    this.root.style.display = on ? '' : 'none';
  }

  update(game: Game, camera: CameraMode, fps: number) {
    const m = game.match, e = this.el, p = game.player;
    e.clock.textContent = fmtClock(m.isAuto ? m.autoEnd - m.time : m.remaining);
    const period = m.periodAt(m.time);
    e.period.textContent = period ? period.label : m.isFinal ? 'Final' : 'Match Over';
    e.redScore.textContent = String(m.score.red);
    e.blueScore.textContent = String(m.score.blue);
    for (const a of ['red', 'blue'] as Alliance[]) {
      const el = a === 'red' ? e.redHub : e.blueHub;
      const active = m.hubActive(a);
      const next = m.nextSwitch(a);
      let sub = '';
      if (next !== null) sub = `${active ? 'off' : 'on'} in ${Math.ceil(next)}s`;
      else if (!m.firstInactive && !m.isOver) sub = 'order set by Auto';
      el.innerHTML = `<span class="dot"></span>${m.isOver ? 'HUB CLOSED' : active ? 'HUB ACTIVE' : 'HUB INACTIVE'}<small>${sub}</small>`;
      el.classList.toggle('active', active && !m.isOver);
    }
    e.robotName.textContent = `${p.type.name} · ${p.height} in`;
    e.hopperText.textContent = `${p.hopper} / ${p.capacity}`;
    e.hopperFill.style.width = `${(100 * p.hopper) / p.capacity}%`;
    e.sub.textContent = `Camera: ${CAMERA_LABELS[camera]}`;
    e.fps.textContent = `${fps.toFixed(0)} fps · ${CONFIG.fuel.total} fuel`;

    let banner = '';
    if (m.isAuto) banner = 'AUTO — robot is driving itself';
    else if (m.time < m.autoEnd + 2.5) banner = 'TELEOP — you have control';
    else if (m.firstInactive && m.time < m.autoEnd + CONFIG.match.transition) {
      const { red, blue } = m.autoFuel;
      banner = m.tieBroken
        ? `Auto tied ${red}–${blue}: ${m.firstInactive.toUpperCase()} Hub goes inactive first (random)`
        : `Auto ${red}–${blue}: ${m.firstInactive.toUpperCase()} Hub goes inactive first`;
    }
    e.banner.textContent = banner;
    e.banner.style.opacity = banner ? '1' : '0';
  }
}

/** Robot picker before the match, and the results screen after. */
export class Menu {
  private setup: GameSetup;

  constructor(private root: HTMLElement, initial: GameSetup, private onStart: (s: GameSetup) => void) {
    this.setup = { ...initial };
  }

  hide() {
    this.root.innerHTML = '';
    this.root.style.display = 'none';
  }

  showPicker() {
    const s = this.setup, H = CONFIG.robot.heights;
    const types = CONFIG.robotTypes
      .map((t) => `<button class="card ${s.typeId === t.id ? 'on' : ''}" data-type="${t.id}">
        <div class="title">${t.name}</div><div class="blurb">${t.blurb}</div></button>`)
      .join('');
    this.root.style.display = '';
    this.root.innerHTML = `
      <div class="panel">
        <h1>REBUILT <span>match sim</span></h1>
        <h2>Robot type</h2>
        <div class="row">${types}</div>
        <h2>Height</h2>
        <div class="row">
          <button class="card small ${s.height === H.short ? 'on' : ''}" data-height="${H.short}">
            <div class="title">${H.short} in</div><div class="blurb">Fits under the Trench</div></button>
          <button class="card small ${s.height === H.tall ? 'on' : ''}" data-height="${H.tall}">
            <div class="title">${H.tall} in</div><div class="blurb">Must drive over the Bump</div></button>
        </div>
        <h2>Alliance</h2>
        <div class="row">
          <button class="card small red ${s.alliance === 'red' ? 'on' : ''}" data-alliance="red"><div class="title">Red</div></button>
          <button class="card small blue ${s.alliance === 'blue' ? 'on' : ''}" data-alliance="blue"><div class="title">Blue</div></button>
        </div>
        <button class="start" data-start>Start match</button>
        <p class="hint">WASD move · Q/E rotate · Space intake · Shift / left mouse shoot · Tab camera · R restart · gamepad works too</p>
      </div>`;
    this.root.querySelectorAll<HTMLElement>('[data-type]').forEach((b) =>
      b.addEventListener('click', () => { s.typeId = b.dataset.type!; this.showPicker(); }));
    this.root.querySelectorAll<HTMLElement>('[data-height]').forEach((b) =>
      b.addEventListener('click', () => { s.height = Number(b.dataset.height); this.showPicker(); }));
    this.root.querySelectorAll<HTMLElement>('[data-alliance]').forEach((b) =>
      b.addEventListener('click', () => { s.alliance = b.dataset.alliance as Alliance; this.showPicker(); }));
    this.root.querySelector('[data-start]')!.addEventListener('click', () => this.onStart({ ...s }));
  }

  showResults(game: Game) {
    const m = game.match, mine = game.setup.alliance;
    const theirs = mine === 'red' ? 'blue' : 'red';
    const outcome = m.score[mine] > m.score[theirs] ? 'Win' : m.score[mine] < m.score[theirs] ? 'Loss' : 'Tie';
    this.root.style.display = '';
    this.root.innerHTML = `
      <div class="panel results">
        <h1>${outcome}</h1>
        <div class="final"><span class="red">${m.score.red}</span> – <span class="blue">${m.score.blue}</span></div>
        <p>Fuel scored: Red ${m.fuelScored.red}, Blue ${m.fuelScored.blue}. You shot ${game.player.shotsFired}.</p>
        <div class="row">
          <button class="start" data-again>Play again (R)</button>
          <button class="start ghost" data-menu>Change robot (Esc)</button>
        </div>
      </div>`;
    this.root.querySelector('[data-again]')!.addEventListener('click', () => this.onStart({ ...game.setup }));
    this.root.querySelector('[data-menu]')!.addEventListener('click', () => this.showPicker());
  }
}
