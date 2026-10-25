import { CONFIG, Alliance } from './config';
import { SLOTS_PER_ALLIANCE, slotAlliance, type GameMode, type GameSetup, type SlotSetup } from './game';

/** Where a robot starts, in Red's frame (Blue's is the same rotated 180 degrees):
 *  x toward the field, z across it, yaw 0 facing the field. */
export interface StartPose {
  x: number;
  z: number;
  yaw: number;
}

/** Who fills a slot. Bots are reserved for AI drivers: until those exist, a bot's
 *  robot stays parked like an empty slot's. */
export type Occupant = { kind: 'player'; id: string; name: string } | { kind: 'bot'; botId: string };

/** One of the six positions as the menus and rooms see it. typeId names the robot;
 *  the robot builder will put a design reference here instead. */
export interface LineupSlot {
  occupant: Occupant | null;
  typeId: string;
  start: StartPose;
}

export const SLOT_COUNT = SLOTS_PER_ALLIANCE * 2;
/** Joiners fill Red 1, Blue 1, Red 2, Blue 2, Red 3, Blue 3. */
export const FILL_ORDER = [0, 3, 1, 4, 2, 5];

export const slotLabel = (i: number) => `${slotAlliance(i) === 'red' ? 'Red' : 'Blue'} ${(i % SLOTS_PER_ALLIANCE) + 1}`;
export const allianceSlots = (a: Alliance) => [0, 1, 2].map((k) => k + (a === 'red' ? 0 : SLOTS_PER_ALLIANCE));

export function defaultStart(i: number): StartPose {
  const s = CONFIG.startSlots[i % SLOTS_PER_ALLIANCE];
  return { x: s.x, z: s.z, yaw: 0 };
}

export function emptyLineup(): LineupSlot[] {
  const types = CONFIG.robotTypes;
  return Array.from({ length: SLOT_COUNT }, (_, i) => ({ occupant: null, typeId: types[i % types.length].id, start: defaultStart(i) }));
}

export const isPlayer = (slot: LineupSlot, id: string) => slot.occupant?.kind === 'player' && slot.occupant.id === id;
export const findPlayer = (slots: LineupSlot[], id: string) => slots.findIndex((s) => isPlayer(s, id));
export const firstOpenSlot = (slots: LineupSlot[]) => FILL_ORDER.find((i) => !slots[i].occupant) ?? -1;

/** Robots start inside their Alliance Zone, clear of the walls. */
const HALF = CONFIG.robot.length / 2;
/** Closest two teammates may start, center to center. */
const SPACING = 32;
export const START_AREA = {
  minX: -CONFIG.field.length / 2 + CONFIG.field.wallThickness / 2 + HALF,
  maxX: -CONFIG.field.length / 2 + CONFIG.field.allianceZoneDepth - HALF,
  maxZ: CONFIG.field.width / 2 - CONFIG.field.wallThickness / 2 - HALF,
};

/** Move slot i's start toward `want`, kept inside the start area. Returns the old pose if
 *  the new one would overlap a teammate. */
export function placeStart(slots: LineupSlot[], i: number, want: StartPose): StartPose {
  const A = START_AREA;
  const p: StartPose = {
    x: Math.min(A.maxX, Math.max(A.minX, want.x)),
    z: Math.min(A.maxZ, Math.max(-A.maxZ, want.z)),
    yaw: Math.atan2(Math.sin(want.yaw), Math.cos(want.yaw)),
  };
  const blocked = allianceSlots(slotAlliance(i)).some((j) => j !== i && Math.hypot(slots[j].start.x - p.x, slots[j].start.z - p.z) < SPACING);
  return blocked ? { ...slots[i].start, yaw: p.yaw } : p;
}

const randomTeamNumber = () => 100 + Math.floor(Math.random() * 9800);

export function lineupToSetup(slots: LineupSlot[], mode: GameMode, localId: string): GameSetup {
  return {
    mode,
    localId,
    slots: slots.map((s): SlotSetup => ({
      typeId: s.typeId,
      teamNumber: randomTeamNumber(),
      driver: s.occupant?.kind === 'player' ? s.occupant.id : null,
      name: s.occupant?.kind === 'player' ? s.occupant.name : undefined,
      ai: s.occupant?.kind === 'bot' ? s.occupant.botId : undefined,
      start: s.start,
    })),
  };
}
