// Ikona domu do hlavičky e-mailu – stejný tvar jako lucide `House` v logu webu (mřížka 24×24,
// tah 2, kulaté konce). E-mailoví klienti SVG spolehlivě nezobrazí (Gmail, Outlook), proto se
// tvar rastruje do PNG (lib/png.ts) a vkládá jako inline příloha `cid:` stejně jako QR Platba.
// Pozadí je neprůhledné v barvě hlavičky, okraje jsou vyhlazené (16 odstínů palety).

import { bytesToBase64, palettePng, type Rgb } from '../../lib/png.ts';

type Point = readonly [number, number];

/** Obrys domu a dveře (lucide House, oblouky nahrazené krátkými úsečkami). */
const HOUSE: readonly (readonly Point[])[] = [
  [[3, 10], [3.71, 8.47], [10.71, 2.47], [12, 2], [13.29, 2.47], [20.29, 8.47], [21, 10], [21, 19], [20.41, 20.41], [19, 21], [5, 21], [3.59, 20.41], [3, 19], [3, 10]],
  [[15, 21], [15, 13], [14.71, 12.29], [14, 12], [10, 12], [9.29, 12.29], [9, 13], [9, 21]],
];
const STROKE_RADIUS = 1;
const GRID = 24;
const SAMPLES = 4;
const LEVELS = 16;

function distanceToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

const inStroke = (point: Point) =>
  HOUSE.some((line) => line.slice(1).some((end, i) => distanceToSegment(point, line[i], end) <= STROKE_RADIUS));

const mix = (from: Rgb, to: Rgb, amount: number): Rgb =>
  [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * amount)) as unknown as Rgb;

/** PNG ikony domu: `size` pixelů (čtverec), světlý tah na pozadí hlavičky. */
export function houseIconPng(background: Rgb, foreground: Rgb, size = 72): Uint8Array {
  const palette = Array.from({ length: LEVELS }, (_, level) => mix(background, foreground, level / (LEVELS - 1)));
  const unit = GRID / size;
  return palettePng({
    width: size,
    height: size,
    palette,
    bitDepth: 4,
    pixel: (x, y) => {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          if (inStroke([(x + (sx + 0.5) / SAMPLES) * unit, (y + (sy + 0.5) / SAMPLES) * unit])) covered++;
        }
      }
      return Math.round((covered / (SAMPLES * SAMPLES)) * (LEVELS - 1));
    },
  });
}

const cache = new Map<string, string>();

/** Base64 PNG ikony (pro přílohu e-mailu); výpočet jednou za běh Workeru pro dané barvy. */
export function houseIconBase64(background: Rgb, foreground: Rgb): string {
  const key = `${background.join()}|${foreground.join()}`;
  let value = cache.get(key);
  if (!value) {
    value = bytesToBase64(houseIconPng(background, foreground));
    cache.set(key, value);
  }
  return value;
}
