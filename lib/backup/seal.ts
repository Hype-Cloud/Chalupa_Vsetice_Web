// Komprese a šifrování snapshotu: SQL → gzip → age (veřejný klíč příjemce).
//
// - age (https://age-encryption.org, knihovna age-encryption od autora formátu): soubor
//   rozšifruje jen držitel soukromého klíče; záloha (CI, Worker) zná jen veřejný klíč.
// - Před šifrováním se ověří, že gzip jde rozbalit zpět na stejné SQL (SHA-256).
// - Výsledek se ověří: začíná hlavičkou age v1 a jde ho přečíst jako age soubor; rozšifrování
//   bez soukromého klíče ověřit nejde (záměrně) – ověřuje se při stažení/obnově.
// Funguje v Node.js i Cloudflare Workers (CompressionStream, WebCrypto).

import { Decrypter, Encrypter } from 'age-encryption';
import { BackupError, sha256Hex } from './core.ts';

const AGE_HEADER = new TextEncoder().encode('age-encryption.org/v1\n');

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const output = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

export const gzip = (bytes: Uint8Array) => transform(bytes, new CompressionStream('gzip'));
export const gunzip = (bytes: Uint8Array) => transform(bytes, new DecompressionStream('gzip'));

export const isAgeFile = (bytes: Uint8Array) => bytes.length > AGE_HEADER.length && AGE_HEADER.every((b, i) => bytes[i] === b);

export interface SealedSnapshot {
  bytes: Uint8Array;
  sha256: string;
  compression: 'gzip';
  encryption: 'age' | 'none';
  extension: '.sql.gz.age' | '.sql.gz';
}

/** SQL → gzip (ověřený zpět) → age pro všechny příjemce (nebo bez šifrování, jen mimo produkci). */
export async function sealSnapshot(sql: Uint8Array, encryption: { mode: 'age' | 'none'; recipients: readonly string[] }): Promise<SealedSnapshot> {
  let compressed: Uint8Array;
  try {
    compressed = await gzip(sql);
    if ((await sha256Hex(await gunzip(compressed))) !== (await sha256Hex(sql))) throw new Error('roundtrip');
  } catch {
    throw new BackupError('compression-failed');
  }
  if (encryption.mode === 'none') return { bytes: compressed, sha256: await sha256Hex(compressed), compression: 'gzip', encryption: 'none', extension: '.sql.gz' };
  if (encryption.recipients.length === 0) throw new BackupError('encryption-not-configured');
  let encrypted: Uint8Array;
  try {
    const encrypter = new Encrypter();
    for (const recipient of encryption.recipients) encrypter.addRecipient(recipient);
    encrypted = await encrypter.encrypt(compressed);
  } catch {
    // Neplatný veřejný klíč nebo chyba knihovny – nikdy nenahrát nešifrovaně.
    throw new BackupError('encryption-failed');
  }
  if (!isAgeFile(encrypted) || encrypted.length <= compressed.length) throw new BackupError('encryption-failed');
  return { bytes: encrypted, sha256: await sha256Hex(encrypted), compression: 'gzip', encryption: 'age', extension: '.sql.gz.age' };
}

/**
 * Soubor snapshotu → SQL. `identity` = soukromý klíč (AGE-SECRET-KEY-1…) jen pro šifrované
 * soubory; používá se výhradně lokálně (CLI uživatele), nikdy v CI ani ve Workeru.
 */
export async function openSnapshot(bytes: Uint8Array, options: { encryption: 'age' | 'none'; compression: 'gzip' | 'none'; identity?: string }): Promise<Uint8Array> {
  let compressed = bytes;
  if (options.encryption === 'age') {
    if (!options.identity) throw new BackupError('identity-required');
    try {
      const decrypter = new Decrypter();
      decrypter.addIdentity(options.identity);
      compressed = await decrypter.decrypt(bytes);
    } catch {
      throw new BackupError('decryption-failed');
    }
  }
  if (options.compression === 'none') return compressed;
  try {
    return await gunzip(compressed);
  } catch {
    throw new BackupError('decompression-failed');
  }
}

/** Soukromý klíč ze souboru age-keygen (řádky s komentáři); jen první klíč. */
export function parseIdentityFile(text: string): string {
  const key = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('AGE-SECRET-KEY-'));
  if (!key) throw new BackupError('identity-invalid');
  return key;
}
