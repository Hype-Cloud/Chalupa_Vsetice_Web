import { encode } from 'uqr';

/**
 * QR Platba z SPAYD ze serveru jako SVG path (lokálně, knihovna uqr – žádná externí služba,
 * bankovní údaje neopouštějí stránku). Úroveň korekce M podle doporučení pro QR Platbu.
 * Selže-li kódování, vrací null a host použije ruční platební údaje.
 */
export function qrPath(spayd: string): { size: number; d: string } | null {
  try {
    const qr = encode(spayd, { ecc: 'M', border: 0 });
    let d = '';
    qr.data.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    }));
    return d ? { size: qr.size, d } : null;
  } catch {
    return null;
  }
}
