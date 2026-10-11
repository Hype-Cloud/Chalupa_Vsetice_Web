// Ikony do e-mailu jako PNG (inline přílohy `cid:`). E-mailoví klienti SVG spolehlivě nezobrazí
// (Gmail, Outlook), proto se tahy ikon lucide (mřížka 24×24, tah 2, kulaté konce) rastrují
// vlastním kódem do PNG (lib/png.ts) – bez závislostí, deterministicky, ve Workeru i v Node.
//
// - Značka v hlavičce: plochá čtvercová dlaždice s vlastními barvami (domek + pozadí), bez
//   průhlednosti – vypadá stejně v light i dark mode a nezávisí na barvě okolí.
// - Sluchátko v tlačítku: průhledné pozadí, barva tahu podle varianty tlačítka.

import { bytesToBase64, palettePng, type Rgb } from '../../lib/png.ts';

type Point = readonly [number, number];
type Polyline = Point[];

/** lucide `House` (stejná ikona jako logo webu). */
const HOUSE_PATHS = [
  'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8',
  'M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
];
/** lucide `Phone` – telefonní sluchátko. */
const PHONE_PATHS = [
  'M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384',
];

const GRID = 24;
const STROKE_RADIUS = 1;
const SAMPLES = 4;
const LEVELS = 16;

/** Oblouk SVG (koncové body) → body lomené čáry (SVG 1.1, F.6.5). */
function arcPoints([x1, y1]: Point, rx: number, ry: number, rotation: number, largeArc: boolean, sweep: boolean, [x2, y2]: Point): Point[] {
  if (rx === 0 || ry === 0) return [[x2, y2]];
  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const factor = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
  const cxp = (factor * rx * y1p) / ry;
  const cyp = (-factor * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil((Math.abs(delta) * Math.max(rx, ry)) / 0.25));
  return Array.from({ length: steps }, (_, i) => {
    const t = start + (delta * (i + 1)) / steps;
    return [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos] as Point;
  });
}

/** Podmnožina SVG path (M, L, H, V, A, Z – absolutně i relativně), jak ji používají ikony lucide. */
export function pathToPolylines(d: string): Polyline[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const lines: Polyline[] = [];
  let current: Polyline = [];
  let point: Point = [0, 0];
  let start: Point = [0, 0];
  let command = '';
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) command = tokens[i++];
    const relative = command === command.toLowerCase();
    const base = (x: number, y: number): Point => (relative ? [point[0] + x, point[1] + y] : [x, y]);
    switch (command.toUpperCase()) {
      case 'M':
        if (current.length > 1) lines.push(current);
        point = base(num(), num());
        start = point;
        current = [point];
        command = relative ? 'l' : 'L'; // další dvojice za M jsou úsečky
        break;
      case 'L':
        point = base(num(), num());
        current.push(point);
        break;
      case 'H':
        point = [relative ? point[0] + num() : num(), point[1]];
        current.push(point);
        break;
      case 'V':
        point = [point[0], relative ? point[1] + num() : num()];
        current.push(point);
        break;
      case 'A': {
        const [rx, ry, rotation, large, sweep] = [num(), num(), num(), num(), num()];
        const end = base(num(), num());
        current.push(...arcPoints(point, rx, ry, rotation, large === 1, sweep === 1, end));
        point = end;
        break;
      }
      case 'Z':
        current.push(start);
        point = start;
        break;
      default:
        throw new RangeError(`icon-path-command-${command}`);
    }
  }
  if (current.length > 1) lines.push(current);
  return lines;
}

function distanceToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Pokrytí pixelů tahem (0–LEVELS-1). Ikona 24×24 se vykreslí do čtverce `inner` px posunutého o `offset`. */
function strokeCoverage(paths: string[], size: number, inner: number, offset: number): number[][] {
  const lines = paths.flatMap(pathToPolylines);
  const unit = GRID / inner;
  const inStroke = (p: Point) => lines.some((line) => line.slice(1).some((end, k) => distanceToSegment(p, line[k], end) <= STROKE_RADIUS));
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          if (inStroke([(x - offset + (sx + 0.5) / SAMPLES) * unit, (y - offset + (sy + 0.5) / SAMPLES) * unit])) covered++;
        }
      }
      return Math.round((covered / (SAMPLES * SAMPLES)) * (LEVELS - 1));
    }),
  );
}

const mix = (from: Rgb, to: Rgb, amount: number): Rgb =>
  [0, 1, 2].map((k) => Math.round(from[k] + (to[k] - from[k]) * amount)) as unknown as Rgb;

/** Značka: plná čtvercová dlaždice `tile` s domkem v barvě `stroke`, bez průhlednosti. */
export function brandMarkPng(tile: Rgb, stroke: Rgb, size = 84): Uint8Array {
  const inner = Math.round(size * 0.68);
  const coverage = strokeCoverage(HOUSE_PATHS, size, inner, Math.round((size - inner) / 2));
  return palettePng({
    width: size,
    height: size,
    palette: Array.from({ length: LEVELS }, (_, level) => mix(tile, stroke, level / (LEVELS - 1))),
    bitDepth: 4,
    pixel: (x, y) => coverage[y][x],
  });
}

/** Sluchátko: tah v barvě `stroke` na průhledném pozadí (vyhlazení přes alfa kanál palety). */
export function phoneIconPng(stroke: Rgb, size = 54): Uint8Array {
  const coverage = strokeCoverage(PHONE_PATHS, size, size, 0);
  return palettePng({
    width: size,
    height: size,
    palette: Array.from({ length: LEVELS }, () => stroke),
    alpha: Array.from({ length: LEVELS }, (_, level) => Math.round((255 * level) / (LEVELS - 1))),
    bitDepth: 4,
    pixel: (x, y) => coverage[y][x],
  });
}

const cache = new Map<string, string>();

/** Base64 PNG; výpočet jednou za běh Workeru pro daný klíč. */
export function cachedBase64(key: string, render: () => Uint8Array): string {
  let value = cache.get(key);
  if (value === undefined) {
    value = bytesToBase64(render());
    cache.set(key, value);
  }
  return value;
}
