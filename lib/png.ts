// Minimální PNG enkodér pro obrázky s paletou (QR Platba, ikona v e-mailu). Bez <canvas>, bez DOM
// a bez závislostí: deterministický výstup, běží v prohlížeči, ve Workeru i v Node.
// Data jsou v nekomprimovaných („stored“) zlib blocích – obrázky jsou malé.

export type Rgb = readonly [number, number, number];

export interface PalettePngInput {
  width: number;
  height: number;
  /** Barvy palety (nejvýš 2^bitDepth). */
  palette: readonly Rgb[];
  bitDepth: 1 | 2 | 4 | 8;
  /** Index barvy v paletě pro pixel (x, y). */
  pixel: (x: number, y: number) => number;
}

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

/** Bajty PNG obrázku s paletou. */
export function palettePng({ width, height, palette, bitDepth, pixel }: PalettePngInput): Uint8Array {
  if (palette.length < 1 || palette.length > 2 ** bitDepth) throw new RangeError('png-palette-size');
  const rowBytes = Math.ceil((width * bitDepth) / 8);
  const raw = new Uint8Array((rowBytes + 1) * height);
  const perByte = 8 / bitDepth;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = pixel(x, y);
      if (!index) continue;
      // První bajt řádku = filtr 0; pixely zarovnané od nejvyššího bitu.
      const shift = 8 - bitDepth * ((x % perByte) + 1);
      raw[y * (rowBytes + 1) + 1 + Math.floor(x / perByte)] |= index << shift;
    }
  }
  const ihdr = new Uint8Array([...u32(width), ...u32(height), bitDepth, 3, 0, 0, 0]);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', new Uint8Array(palette.flat())),
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
