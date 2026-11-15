import { createHash, createHmac, randomBytes, timingSafeEqual, createPublicKey, verify } from 'crypto';

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');
export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** JSON canonique : clés triées, BigInt en chaîne. Sert au digest d'opération et d'idempotence. */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
export const digestOf = (v: unknown) => sha256(canonicalJson(v));

/** Vérification Ed25519. La clé publique est fournie en SPKI DER base64 OU en clé brute 32 octets base64. */
export function ed25519PublicKey(b64: string) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length === 32) {
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
    return createPublicKey({ key: spki, format: 'der', type: 'spki' });
  }
  return createPublicKey({ key: raw, format: 'der', type: 'spki' });
}
export function verifyEd25519(publicKeyB64: string, message: string, signatureB64: string): boolean {
  try {
    return verify(null, Buffer.from(message), ed25519PublicKey(publicKeyB64), Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}
export function fingerprintOf(publicKeyB64: string) {
  const der = ed25519PublicKey(publicKeyB64).export({ format: 'der', type: 'spki' });
  return sha256(der as Buffer);
}
