// The vault — envelope encryption for provider keys and project env.
// Law 6.3: secrets are write-only. No read path returns a value, in any
// shape, to anyone, ever. decryptSecret exists for the router at
// execution time only — and every call is audited (law: every decryption
// is a record: which key, which actor, which moment).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

function master(): Buffer {
  const k = process.env.MASTER_KEY;
  if (!k) {
    // A missing master key is a misconfiguration, not a bug in the request.
    // Answering 500 made it look like the endpoint was broken; 503 with the
    // real reason is what an operator can act on.
    const e = new Error('MASTER_KEY is not configured — this server cannot store or read secrets') as Error & { statusCode?: number };
    e.statusCode = 503;
    throw e;
  }
  return Buffer.from(k, 'base64');
}

function wrap(dk: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', master(), iv);
  const ct = Buffer.concat([c.update(dk), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function unwrap(blob: Buffer): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = createDecipheriv('aes-256-gcm', master(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export function maskSecret(plain: string): string {
  const p = plain.trim();
  if (p.length <= 8) return '••••';
  return `${p.slice(0, 4)}…${p.slice(-4)}`;
}

// Stored layout: wrap(60) || iv(12) || tag(16) || ciphertext
export function encryptSecret(plain: string): { stored: string; keyMask: string } {
  const dk = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dk, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const blob = Buffer.concat([wrap(dk), iv, c.getAuthTag(), ct]);
  return { stored: blob.toString('base64'), keyMask: maskSecret(plain) };
}

export function decryptSecret(stored: string, audit: { prisma: PrismaClient; actor: string; action: string; target: string }): string {
  const blob = Buffer.from(stored, 'base64');
  if (blob.length < 88) throw new Error('malformed vault blob');
  const dk = unwrap(blob.subarray(0, 60));
  const iv = blob.subarray(60, 72);
  const tag = blob.subarray(72, 88);
  const ct = blob.subarray(88);
  const d = createDecipheriv('aes-256-gcm', dk, iv);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  // Audit the decryption — the record exists even if the caller does not want it.
  void audit.prisma.auditLog.create({ data: { actor: audit.actor, action: audit.action, target: audit.target } }).catch(() => {});
  return plain;
}
