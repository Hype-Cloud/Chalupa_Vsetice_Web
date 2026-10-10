import { encode } from 'uqr';

// QR Platba z SPAYD – sdílené jádro pro web (components/booking/paymentQr.ts) i Worker
// (potvrzovací e-mail). Matice z knihovny uqr, vlastní minimální PNG enkodér bez <canvas>
// a bez DOM: deterministický výstup, běží v prohlížeči, ve Workeru i v Node. Žádná externí služba.

/** Matice QR kódu: true = tmavý modul. */
export interface QrMatrix {
  size: number;
  data: boolean[][];
}

/** Okraj kolem QR (v modulech) – stejný vzhled jako dosud. */
export const QR_QUIET_MODULES = 2;
const DARK: [number, number, number] = [0x0b, 0x1f, 0x19];
const LIGHT: [number, number, number] = [0xff, 0xff, 0xff];

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

// --- minimální PNG enkodér (paleta 2 barvy, 1 bit/pixel, zlib „stored“ bloky) ---

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = new Uint8Array(4 + data.length);
  typed.set(Array.from(type, (c) => c.charCodeAt(0)));
  typed.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length));
  out.set(typed, 4);
  out.set(u32(crc32(typed)), 8 + data.length);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** zlib proud z nekomprimovaných („stored“) deflate bloků. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x01];
  for (let offset = 0; offset < raw.length || offset === 0; offset += 65535) {
    const block = raw.subarray(offset, offset + 65535);
    const final = offset + 65535 >= raw.length ? 1 : 0;
    out.push(final, block.length & 0xff, block.length >>> 8, ~block.length & 0xff, (~block.length >>> 8) & 0xff);
    for (const byte of block) out.push(byte);
    if (final) break;
  }
  out.push(...u32(adler32(raw)));
  return new Uint8Array(out);
}

/** Bajty PNG obrázku QR (`scale` pixelů na modul, bílý okraj QR_QUIET_MODULES). */
export function qrPngBytes(matrix: QrMatrix, scale = 8): Uint8Array {
  const modules = matrix.size + 2 * QR_QUIET_MODULES;
  const width = modules * scale;
  const rowBytes = Math.ceil(width / 8);
  const raw = new Uint8Array((rowBytes + 1) * width);
  for (let y = 0; y < width; y++) {
    const my = Math.floor(y / scale) - QR_QUIET_MODULES;
    for (let x = 0; x < width; x++) {
      const mx = Math.floor(x / scale) - QR_QUIET_MODULES;
      // Index 1 = tmavá barva palety; první bajt řádku = filtr 0.
      if (matrix.data[my]?.[mx]) raw[y * (rowBytes + 1) + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const ihdr = new Uint8Array([...u32(width), ...u32(width), 1, 3, 0, 0, 0]); // 1 bit, paleta
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', new Uint8Array([...LIGHT, ...DARK])),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** Bajty → base64 (bez Node Bufferu; btoa je v prohlížeči i ve Workeru). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
