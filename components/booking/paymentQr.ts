// QR Platba v potvrzení na webu: výběr vykreslení (PNG <img>, záložně SVG, jinak nic). Jádro
// (matice, PNG) je sdílené s potvrzovacím e-mailem v lib/booking/qr.ts.
import { bytesToBase64, qrMatrix, qrPngBytes, qrSvgPath, type QrMatrix } from '../../lib/booking/qr.ts';

export { qrMatrix, qrPngBytes, qrSvgPath, QR_QUIET_MODULES, type QrMatrix } from '../../lib/booking/qr.ts';

/** PNG jako data URL pro `<img>` (dlouhým podržením jde na mobilu uložit). Při chybě vyhodí. */
export function qrPngDataUrl(matrix: QrMatrix): string {
  return `data:image/png;base64,${bytesToBase64(qrPngBytes(matrix))}`;
}

/**
 * Jak QR zobrazit: primárně skutečný obrázek (PNG), při selhání převodu na obrázek SVG ze stejné
 * matice, při selhání samotného kódování nic (host použije ruční platební údaje).
 */
export type QrRendering =
  | { kind: 'img'; src: string }
  | { kind: 'svg'; size: number; d: string }
  | { kind: 'none' };

export function qrRendering(spayd: string, toPng: (matrix: QrMatrix) => string = qrPngDataUrl): QrRendering {
  const matrix = qrMatrix(spayd);
  if (!matrix) return { kind: 'none' };
  try {
    return { kind: 'img', src: toPng(matrix) };
  } catch {
    return { kind: 'svg', size: matrix.size, d: qrSvgPath(matrix) };
  }
}
