import { encode } from 'uqr';
import { palettePng, type Rgb } from '../png.ts';

export { bytesToBase64 } from '../png.ts';

// QR Platba z SPAYD – sdílené jádro pro web (components/booking/paymentQr.ts) i Worker
// (potvrzovací e-mail). Matice z knihovny uqr, PNG z vlastního enkodéru (lib/png.ts) bez <canvas>
// a bez DOM: deterministický výstup, běží v prohlížeči, ve Workeru i v Node. Žádná externí služba.

/** Matice QR kódu: true = tmavý modul. */
export interface QrMatrix {
  size: number;
  data: boolean[][];
}

/** Okraj kolem QR (v modulech) – stejný vzhled jako dosud. */
export const QR_QUIET_MODULES = 2;
const DARK: Rgb = [0x0b, 0x1f, 0x19];
const LIGHT: Rgb = [0xff, 0xff, 0xff];

/** SPAYD → matice (úroveň korekce M podle doporučení pro QR Platbu), nebo null. */
export function qrMatrix(spayd: string): QrMatrix | null {
  try {
    const qr = encode(spayd, { ecc: 'M', border: 0 });
    return qr.size > 0 && qr.data.some((row) => row.includes(true)) ? { size: qr.size, data: qr.data } : null;
  } catch {
    return null;
  }
}

/** SVG path tmavých modulů (záložní vykreslení). */
export function qrSvgPath(matrix: QrMatrix): string {
  let d = '';
  matrix.data.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) d += `M${x} ${y}h1v1h-1z`;
  }));
  return d;
}

/** Bajty PNG obrázku QR (`scale` pixelů na modul, bílý okraj QR_QUIET_MODULES). */
export function qrPngBytes(matrix: QrMatrix, scale = 8): Uint8Array {
  const width = (matrix.size + 2 * QR_QUIET_MODULES) * scale;
  const module = (n: number) => Math.floor(n / scale) - QR_QUIET_MODULES;
  // Index 1 = tmavá barva palety.
  return palettePng({ width, height: width, palette: [LIGHT, DARK], bitDepth: 1, pixel: (x, y) => (matrix.data[module(y)]?.[module(x)] ? 1 : 0) });
}
