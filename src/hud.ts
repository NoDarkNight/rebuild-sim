import type { Alliance } from './config';
import type { Game } from './game';
import { CAMERA_LABELS, CameraMode } from './camera';

const fmtClock = (s: number) => {
  const t = Math.ceil(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const AIM_LABEL = { score: 'Score', ferry: 'Ferry', none: 'No shot' } as const;

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
