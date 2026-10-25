import { CONFIG } from './config';
import { slotAlliance } from './game';
import { rotateForAlliance } from './field';
import { placeStart, type LineupSlot, type StartPose } from './lineup';

const NS = 'http://www.w3.org/2000/svg';
/** Turning speed while J or L is held, radians per second. */
const TURN_RATE = 2.4;

export interface MapOptions {
  /** Your slot (outlined in gold), or -1. */
  self: number;
  /** Robots this viewer may drag and turn. */
  canMove: (slot: number) => boolean;
  /** Text over each robot. */
  label: (slot: number) => string;
}

/** Top-down field with the six starting spots. Red is on the left. Drag a robot to
 *  move it; hold J or L to turn the selected one. One instance lives for the whole
 *  session and is moved between screens. */
export class FieldMap {
  readonly el: SVGSVGElement;
  /** Fires when a move or turn finishes. */
  onMove: (slot: number, pose: StartPose) => void = () => {};

  private robots: SVGGElement;
  private slots: LineupSlot[] = [];
  private opts: MapOptions = { self: -1, canMove: () => false, label: () => '' };
  private selected = -1;
  private dragging = false;
  private grab = { x: 0, z: 0 };
  private turn = new Set<string>();
  private lastFrame = 0;

  constructor() {
    const F = CONFIG.field, pad = 6;
    this.el = svg('svg', { class: 'field-map', viewBox: `${-F.length / 2 - pad} ${-F.width / 2 - pad} ${F.length + 2 * pad} ${F.width + 2 * pad}` }) as SVGSVGElement;
    this.el.append(svg('rect', { class: 'carpet', x: -F.length / 2, y: -F.width / 2, width: F.length, height: F.width, rx: 4 }));
    this.el.append(this.side('red'), this.side('blue'));
    this.el.append(svg('line', { class: 'center', x1: 0, y1: -F.width / 2, x2: 0, y2: F.width / 2 }));
    this.robots = svg('g', {}) as SVGGElement;
    this.el.append(this.robots);

    this.el.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.el.addEventListener('pointermove', (e) => this.pointerMove(e));
    this.el.addEventListener('pointerup', () => this.pointerUp());
    this.el.addEventListener('pointercancel', () => this.pointerUp());
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => this.endTurn());
  }

  update(slots: LineupSlot[], opts: MapOptions) {
    // Keep the robot being moved where the viewer has it until they let go.
    const busy = this.busy ? this.slots[this.selected]?.start : null;
    this.slots = slots.map((s) => ({ ...s, start: { ...s.start } }));
    if (busy) this.slots[this.selected].start = busy;
    // Selection follows you when you change slots.
    const moved = opts.self !== this.opts.self;
    this.opts = opts;
    if (moved || this.selected < 0 || !opts.canMove(this.selected)) this.selected = opts.canMove(opts.self) ? opts.self : -1;
    this.draw();
  }

  private get busy() {
    return this.dragging || this.turn.size > 0;
  }

  /** One alliance's half, drawn in Red's frame and rotated into place for Blue. */
  private side(a: 'red' | 'blue') {
    const F = CONFIG.field, H = CONFIG.hub, B = CONFIG.bump, T = CONFIG.trench, D = CONFIG.depot;
    const hl = F.length / 2, hw = F.width / 2, half = H.size / 2;
    const hubX = -(hl - H.centerFromWall);
    const g = svg('g', { class: `side ${a}`, transform: a === 'blue' ? 'rotate(180)' : '' });
    g.append(svg('rect', { class: 'zone', x: -hl, y: -hw, width: F.allianceZoneDepth, height: F.width }));
    for (const s of [-1, 1]) {
      g.append(svg('rect', { class: 'bump', x: hubX - B.depth / 2, y: s > 0 ? half : -half - B.width, width: B.depth, height: B.width }));
      const trenchIn = hw - T.openingWidth;
      g.append(svg('rect', { class: 'trench', x: hubX - T.depth / 2, y: s > 0 ? trenchIn : -hw, width: T.depth, height: T.openingWidth }));
      g.append(svg('rect', { class: 'post', x: hubX - T.depth / 2, y: s > 0 ? half + B.width : -trenchIn, width: T.depth, height: trenchIn - half - B.width }));
    }
    g.append(svg('rect', { class: 'hub', x: hubX - half, y: -half, width: H.size, height: H.size, rx: 2 }));
    g.append(svg('rect', { class: 'depot', x: -hl, y: D.centerZ - D.width / 2, width: D.depth, height: D.width }));
    g.append(svg('line', { class: 'wall', x1: -hl, y1: -hw, x2: -hl, y2: hw }));
    return g;
  }

  private draw() {
    const size = CONFIG.robot.length, r = size / 2;
    this.robots.replaceChildren();
    this.slots.forEach((slot, i) => {
      const a = slotAlliance(i), p = rotateForAlliance(a, slot.start.x, slot.start.z);
      const deg = (-(slot.start.yaw + (a === 'blue' ? Math.PI : 0)) * 180) / Math.PI;
      const cls = ['bot', a, slot.occupant ? '' : 'empty', i === this.opts.self ? 'mine' : '', i === this.selected ? 'selected' : '', this.opts.canMove(i) ? 'movable' : ''];
      const g = svg('g', { class: cls.join(' '), transform: `translate(${p.x} ${p.z})`, 'data-slot': i });
      const body = svg('g', { transform: `rotate(${deg})` });
      body.append(
        svg('rect', { class: 'body', x: -r, y: -r, width: size, height: size, rx: 3 }),
        svg('path', { class: 'nose', d: `M ${r - 9} -6 L ${r - 2} 0 L ${r - 9} 6 Z` }),
      );
      const label = svg('text', { class: 'tag', y: -r - 5 });
      label.textContent = this.opts.label(i);
      g.append(body, label);
      this.robots.append(g);
    });
  }

  private toField(e: PointerEvent) {
    const m = this.el.getScreenCTM();
    const pt = m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()) : new DOMPoint();
    return { x: pt.x, z: pt.y };
  }

  private pointerDown(e: PointerEvent) {
    const hit = (e.target as Element).closest?.('[data-slot]');
    const i = hit ? Number(hit.getAttribute('data-slot')) : -1;
    if (i < 0 || !this.opts.canMove(i)) return;
    e.preventDefault();
    this.selected = i;
    this.dragging = true;
    this.el.setPointerCapture(e.pointerId);
    const a = slotAlliance(i), f = this.toField(e), p = rotateForAlliance(a, this.slots[i].start.x, this.slots[i].start.z);
    this.grab = { x: f.x - p.x, z: f.z - p.z };
    this.draw();
  }

  private pointerMove(e: PointerEvent) {
    if (!this.dragging) return;
    const i = this.selected, f = this.toField(e);
    const p = rotateForAlliance(slotAlliance(i), f.x - this.grab.x, f.z - this.grab.z);
    this.slots[i].start = placeStart(this.slots, i, { ...this.slots[i].start, x: p.x, z: p.z });
    this.draw();
  }

  private pointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    this.onMove(this.selected, { ...this.slots[this.selected].start });
  }

  private key(e: KeyboardEvent, down: boolean) {
    if (e.code !== 'KeyJ' && e.code !== 'KeyL') return;
    if (!down) {
      if (!this.turn.has(e.code)) return;
      if (this.selected >= 0) this.advanceTurn(performance.now());
      this.turn.delete(e.code);
      if (this.turn.size === 0) this.commitTurn();
      return;
    }
    if (!this.el.isConnected || this.selected < 0 || isTyping(e)) return;
    if (this.turn.size === 0) {
      this.lastFrame = performance.now();
      requestAnimationFrame((t) => this.turnFrame(t));
    }
    this.turn.add(e.code);
  }

  private turnFrame(now: number) {
    if (this.turn.size === 0 || this.selected < 0) return;
    this.advanceTurn(now);
    requestAnimationFrame((t) => this.turnFrame(t));
  }

  /** Turn by the time since the last update, so a tap still turns when frames are slow. */
  private advanceTurn(now: number) {
    const dt = Math.min(0.5, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const dir = (this.turn.has('KeyJ') ? 1 : 0) - (this.turn.has('KeyL') ? 1 : 0);
    this.slots[this.selected].start.yaw += dir * TURN_RATE * dt;
    this.draw();
  }

  private endTurn() {
    if (this.turn.size > 0) { this.turn.clear(); this.commitTurn(); }
  }

  private commitTurn() {
    if (this.selected >= 0 && this.el.isConnected) this.onMove(this.selected, placeStart(this.slots, this.selected, this.slots[this.selected].start));
  }
}

const isTyping = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

function svg(tag: string, attrs: Record<string, string | number>) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== '') el.setAttribute(k, String(v));
  return el as SVGElement;
}
