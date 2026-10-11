import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const NONCE = 12;
const TAG = 16;

export function parseKek(b64: string): Buffer {
  const kek = Buffer.from(b64, 'base64');
  if (kek.length !== 32) throw new Error('KEK must be 32 bytes');
  return kek;
}

// The key id byte lets a rotation re-encrypt rows one at a time (SPEC 22).
export function encryptSecret(plain: string, kek: Buffer, keyId = 1): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION, keyId]), nonce, body, cipher.getAuthTag()]);
}

export function decryptSecret(record: Buffer, kek: Buffer, keyId = 1): string {
  if (record.length < 2 + NONCE + TAG || record[0] !== VERSION)
    throw new Error('unknown secret record');
  if (record[1] !== keyId) throw new Error(`secret record uses key id ${record[1]}`);
  const nonce = record.subarray(2, 2 + NONCE);
  const tag = record.subarray(record.length - TAG);
  const decipher = createDecipheriv('aes-256-gcm', kek, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(record.subarray(2 + NONCE, record.length - TAG)),
    decipher.final(),
  ]).toString('utf8');
}
