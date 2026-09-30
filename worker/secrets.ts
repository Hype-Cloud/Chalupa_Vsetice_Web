// Porovnání přístupových tokenů bez úniku informace přes dobu odezvy.

export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Porovnání v konstantním čase (přes otisky stejné délky). Prázdný token nikdy neprojde. */
export async function secretEquals(presented: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 && presented.length > 0;
}
