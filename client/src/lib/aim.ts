// Client mirror of server/src/lib/aim.ts. eDPI and cm/360 are functions of both
// dpi and in-game sens; dpi defaults to MOUSE_DPI (1600) so callers that only
// know sens are unchanged. Blind trials vary dpi (the hidden variable) while
// holding sens frozen, so anything computing a blind match's scale passes dpi
// explicitly. cm/360 = centimeters of mouse travel per 360° turn — the
// device-independent scale we analyse against. Kept in sync by hand.
export const MOUSE_DPI = 1600;
export const eDPI = (sens: number, dpi: number = MOUSE_DPI): number => dpi * sens;
export const cm360 = (sens: number, dpi: number = MOUSE_DPI): number =>
  (360 * 2.54) / (0.0066 * sens * dpi);
