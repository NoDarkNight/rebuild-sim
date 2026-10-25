import { CONFIG } from './config';

/** Driver intent in the camera's frame: forward/right are -1..1. */
export interface DriverInput {
  forward: number;
  right: number;
  turn: number;
  intake: boolean;
  shoot: boolean;
}

export type InputEvent = 'reset' | 'camera' | 'menu';

/** Keyboard, mouse, and (standard-mapping) gamepad. */
export class Input {
  private keys = new Set<string>();
  private mouseDown = false;
  private listeners: ((e: InputEvent) => void)[] = [];
  private padButtons: boolean[] = [];

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.emit('reset');
      if (e.code === 'Tab') this.emit('camera');
      if (e.code === 'Escape') this.emit('menu');
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseDown = false; });
    // A release outside the window never fires mouseup here; don't keep shooting.
    window.addEventListener('mousemove', (e) => { if (!(e.buttons & 1)) this.mouseDown = false; });
    canvas.addEventListener('mousedown', (e) => { if (e.button === 0) this.mouseDown = true; });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouseDown = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  on(fn: (e: InputEvent) => void) {
    this.listeners.push(fn);
  }

  private emit(e: InputEvent) {
    for (const fn of this.listeners) fn(e);
  }

  read(): DriverInput {
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    const out: DriverInput = {
      forward: k('KeyW') - k('KeyS'),
      right: k('KeyD') - k('KeyA'),
      turn: k('KeyJ') - k('KeyL'),
      intake: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      shoot: this.keys.has('Space') || this.mouseDown,
    };

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const dz = CONFIG.input.gamepadDeadzone;
      const ax = (i: number) => {
        const v = pad.axes[i] ?? 0;
        return Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz);
      };
      const btn = (i: number) => !!pad.buttons[i]?.pressed;
      out.forward = clamp1(out.forward - ax(1));
      out.right = clamp1(out.right + ax(0));
      out.turn = clamp1(out.turn - ax(2));
      out.intake ||= btn(6) || btn(4) || btn(0); // LT, LB, A
      out.shoot ||= btn(7) || btn(5); // RT, RB
      // Edge-triggered buttons: Y = camera, Start = reset, Back = menu.
      const edges: [number, InputEvent][] = [[3, 'camera'], [9, 'reset'], [8, 'menu']];
      for (const [i, ev] of edges) {
        if (btn(i) && !this.padButtons[i]) this.emit(ev);
        this.padButtons[i] = btn(i);
      }
    }
    return out;
  }
}

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
