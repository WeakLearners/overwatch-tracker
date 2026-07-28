// Slot → LED color mapping, in the order the mouse config app assigns them.
// Shared by the Sens blind-loop setup and the Match Tracker's Blind Trial HUD so
// the color shown for a stage is identical in both places. An accidental DPI-
// button press can be resolved to a slot by LED color without revealing DPI.
export const SLOT_COLORS = [
  { name: 'Red', border: 'border-red-500', text: 'text-red-400', dot: 'bg-red-500' },
  { name: 'Blue', border: 'border-blue-500', text: 'text-blue-400', dot: 'bg-blue-500' },
  { name: 'Green', border: 'border-green-500', text: 'text-green-400', dot: 'bg-green-500' },
] as const;

// Where the blind test started, keyed by set id. Blind-start pins cur_rel = 0,
// so recording the LED color you landed on (its slot) lets us always compute the
// color you *should* be on now: expected slot = ((cur_rel + startSlot - 1) % n) + 1.
export const startSlotKey = (setId: number) => `blindStartSlot:${setId}`;

export const readStartSlot = (setId: number): number | null => {
  const v = Number(localStorage.getItem(startSlotKey(setId)));
  return v >= 1 ? v : null;
};

export const expectedColor = (curRel: number, startSlot: number, n: number) =>
  SLOT_COLORS[(((curRel + startSlot - 1) % n) + n) % n % SLOT_COLORS.length];
