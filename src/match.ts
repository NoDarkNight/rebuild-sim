import { CONFIG, Alliance } from './config';

export interface Period {
  id: string;
  label: string;
  start: number;
  end: number;
  /** Index 0..n-1 for alternating shifts, otherwise -1 (both Hubs active). */
  shift: number;
}

export const other = (a: Alliance): Alliance => (a === 'red' ? 'blue' : 'red');

/**
 * Match clock, periods, Hub activity, and scoring. Time is seconds since the
 * match started; the timeline is built from config so lengths are tunable.
 */
export class Match {
  readonly periods: Period[] = [];
  readonly total: number;
  time = 0;
  score: Record<Alliance, number> = { red: 0, blue: 0 };
  fuelScored: Record<Alliance, number> = { red: 0, blue: 0 };
  autoFuel: Record<Alliance, number> = { red: 0, blue: 0 };
  /** Alliance whose Hub is inactive in Shift 1; decided once Auto scoring settles. */
  firstInactive: Alliance | null = null;
  tieBroken = false;

  constructor() {
    const M = CONFIG.match;
    let t = 0;
    const push = (id: string, label: string, len: number, shift = -1) => {
      this.periods.push({ id, label, start: t, end: t + len, shift });
      t += len;
    };
    push('auto', 'Auto', M.auto);
    push('transition', 'Transition Shift', M.transition);
    for (let i = 0; i < M.shiftCount; i++) push(`shift${i + 1}`, `Shift ${i + 1}`, M.shiftLength, i);
    push('endgame', 'End Game', M.endGame);
    this.total = t;
  }

  get autoEnd() {
    return CONFIG.match.auto;
  }
  get isAuto() {
    return this.time < this.autoEnd;
  }
  get isOver() {
    return this.time >= this.total;
  }
  /** Scoring is final once the post-match grace window has passed. */
  get isFinal() {
    return this.time >= this.total + CONFIG.match.scoringGrace;
  }
  get remaining() {
    return Math.max(0, this.total - this.time);
  }

  update(dt: number) {
    this.time += dt;
    if (!this.firstInactive && this.time >= this.autoEnd + CONFIG.match.scoringGrace) {
      const { red, blue } = this.autoFuel;
      if (red === blue) {
        this.tieBroken = true;
        this.firstInactive = Math.random() < 0.5 ? 'red' : 'blue';
      } else {
        // The alliance that scored more in Auto has its Hub inactive first.
        this.firstInactive = red > blue ? 'red' : 'blue';
      }
    }
  }

  periodAt(t: number): Period | null {
    for (const p of this.periods) if (t >= p.start && t < p.end) return p;
    return null;
  }

  hubActive(a: Alliance, t = this.time): boolean {
    const p = this.periodAt(t);
    if (!p) return false;
    if (p.shift < 0) return true;
    if (!this.firstInactive) return true;
    const inactive = p.shift % 2 === 0 ? this.firstInactive : other(this.firstInactive);
    return a !== inactive;
  }

  /** Fuel entered a Hub. Counts if it was active now or within the grace window. */
  recordScore(hub: Alliance) {
    const t = this.time;
    if (t < 0 || this.isFinal) return;
    this.fuelScored[hub]++;
    if (t < this.autoEnd + CONFIG.match.scoringGrace) this.autoFuel[hub]++;
    const counts = this.hubActive(hub, t) || this.hubActive(hub, t - CONFIG.match.scoringGrace);
    if (counts) this.score[hub]++;
  }

  /** Seconds until this Hub flips active/inactive, or null if it won't (or isn't known yet). */
  nextSwitch(a: Alliance): number | null {
    if (!this.firstInactive || this.isOver) return null;
    const now = this.hubActive(a);
    for (const p of this.periods) {
      if (p.start <= this.time) continue;
      if (this.hubActive(a, p.start) !== now) return p.start - this.time;
    }
    return null;
  }
}
